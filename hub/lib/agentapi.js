// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Agent API v1 (docs/protocol.md): POST /api/v1/agent/push and the
 * GET /api/v1/agent/wait long poll. Checks run in the protocol's order, and
 * the last accepted TS is stored only after every check passed.
 * Replay counters are in memory: after a restart the 120 s skew window
 * bounds replays (persisting them is sub-project 4 work).
 */
const { verifyRequest, signReply } = require("./agentsig");

const MAX_SKEW_MS = 120000;
const PUSH_MIN_MS = 5000;
const WAIT_MAX_S = 55;
const WAIT_MIN_S = 5;
const NODE_ID = /^[a-z2-7]{12}$/;
const MESSAGES = {
  not_found: "no such endpoint",
  method_not_allowed: "wrong method for this endpoint",
  query_not_allowed: "agent requests carry no query string",
  unsupported_protocol: "this hub speaks protocol 1",
  unknown_node: "unknown or revoked node",
  clock_skew: "clock differs from the hub by more than 120 s",
  replay: "timestamp not newer than the last accepted one",
  too_large: "request body too large",
  bad_signature: "signature does not match",
  invalid_snapshot: "snapshot failed validation",
  rate_limited: "pushing too often",
};

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Minimal checks for sub-project 2; the full schema (protocol section 6) comes with multi-node.
function checkSnapshot(s) {
  if (!isObj(s)) return "$";
  if (typeof s.ts !== "number" || !Number.isFinite(s.ts)) return "$.ts";
  if (!isObj(s.host)) return "$.host";
  if (s.interval !== undefined &&
      !(typeof s.interval === "number" && s.interval >= 5 && s.interval <= 3600)) return "$.interval";
  return null;
}

function clampWait(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(WAIT_MAX_S, Math.max(WAIT_MIN_S, n)) : WAIT_MAX_S;
}

// Resolves with the body, or null past `max` bytes. Past the limit the rest is
// drained and dropped, never buffered.
function readLimited(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function createAgentApi({ nodes, log, onSnapshot, maxBody = 256 * 1024, now = Date.now }) {
  const lastTs = new Map();     // "<id> <endpoint>" -> last accepted TS
  const lastPush = new Map();   // id -> hub time of the last stored push
  const lastWake = new Map();   // id -> hub time of the last wake sent
  const waiters = new Map();    // id -> { res, secret, ts, timer }
  const seen = new Set();       // ids that pushed since this process started

  function fail(res, code, error, { headers = {}, body = {} } = {}) {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ error, message: MESSAGES[error] || error, ...body }));
  }

  function reply(res, code, secret, ts, obj) {
    const body = obj === undefined ? "" : JSON.stringify(obj);
    const headers = { "x-servitals-sig": signReply(secret, ts, body) };
    if (body) headers["content-type"] = "application/json";
    res.writeHead(code, headers);
    res.end(body);
  }

  function finishWait(id, w, code) {
    clearTimeout(w.timer);
    if (waiters.get(id) === w) waiters.delete(id);
    if (!w.res.writableEnded) reply(w.res, code, w.secret, w.ts, code === 200 ? { sample: true } : undefined);
  }

  async function handle(req, res) {
    const url = req.url || "";
    const q = url.indexOf("?");
    const pathname = q < 0 ? url : url.slice(0, q);
    let endpoint;
    if (pathname === "/api/v1/agent/push") endpoint = "push";
    else if (pathname === "/api/v1/agent/wait") endpoint = "wait";
    else return fail(res, 404, "not_found");
    if (req.method !== (endpoint === "push" ? "POST" : "GET")) return fail(res, 405, "method_not_allowed");
    if (q >= 0) return fail(res, 400, "query_not_allowed");

    const h = req.headers;
    if (h["x-servitals-proto"] !== "1") return fail(res, 426, "unsupported_protocol");
    const id = h["x-servitals-node"] || "";
    const node = NODE_ID.test(id) ? nodes.get(id) : null;
    if (!node) { log.warn("api.refused", { error: "unknown_node" }); return fail(res, 401, "unknown_node"); }
    const tsRaw = h["x-servitals-ts"] || "";
    const ts = /^\d{1,16}$/.test(tsRaw) ? Number(tsRaw) : NaN;
    const hubMs = now();
    if (!Number.isFinite(ts) || Math.abs(hubMs - ts) > MAX_SKEW_MS) {
      log.warn("api.refused", { node: id, error: "clock_skew" });
      return fail(res, 401, "clock_skew", { body: { hub_ms: hubMs } });
    }
    const key = `${id} ${endpoint}`;
    if (ts <= (lastTs.get(key) || 0)) return fail(res, 401, "replay");
    const tooLarge = () => fail(res, 413, "too_large", { headers: { connection: "close" } });
    if (Number(h["content-length"] || 0) > maxBody) { req.resume(); return tooLarge(); }
    const body = await readLimited(req, maxBody);
    if (body === null) return tooLarge();
    if (!verifyRequest(node.secret, req.method, pathname, tsRaw, body, h["x-servitals-sig"])) {
      log.warn("api.refused", { node: id, error: "bad_signature" });
      return fail(res, 401, "bad_signature");
    }

    if (endpoint === "push") {
      const since = hubMs - (lastPush.get(id) || 0);
      if (since < PUSH_MIN_MS) {
        return fail(res, 429, "rate_limited", { headers: { "retry-after": String(Math.ceil((PUSH_MIN_MS - since) / 1000)) } });
      }
      let snap;
      try { snap = JSON.parse(body.toString("utf8")); } catch (_) { snap = undefined; }
      const bad = checkSnapshot(snap);
      if (bad) return fail(res, 422, "invalid_snapshot", { body: { path: bad } });
      lastTs.set(key, ts);
      lastPush.set(id, hubMs);
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, snap, body);
      return reply(res, 200, node.secret, tsRaw, { ok: true });
    }

    lastTs.set(key, ts);
    const prev = waiters.get(id);
    if (prev) finishWait(id, prev, 204);   // a reconnecting agent is never locked out
    const w = { res, secret: node.secret, ts: tsRaw };
    w.timer = setTimeout(() => finishWait(id, w, 204), clampWait(h["x-servitals-wait"]) * 1000);
    waiters.set(id, w);
    res.on("close", () => { clearTimeout(w.timer); if (waiters.get(id) === w) waiters.delete(id); });
  }

  function wake(id) {
    const w = waiters.get(id);
    if (!w) return false;
    lastWake.set(id, now());
    finishWait(id, w, 200);
    return true;
  }

  return {
    handle,
    wake,
    lastPushAt: (id) => lastPush.get(id) || 0,
    lastWakeAt: (id) => lastWake.get(id) || 0,
    close() { for (const [id, w] of [...waiters]) finishWait(id, w, 204); },
  };
}

module.exports = { createAgentApi, checkSnapshot, clampWait };
