// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Agent API v1 (docs/protocol.md): POST /api/v1/agent/push and the
 * GET /api/v1/agent/wait long poll. Checks run in the protocol's order, and
 * the last accepted TS is stored only after every check passed.
 * The last accepted TS per node and endpoint is saved to `replayFile`, so a
 * restart does not reopen the 120 s window for captured requests. A client
 * address that keeps failing authentication is slowed down (429) before the
 * hub reads anything else.
 */
const fs = require("fs");
const { verifyRequest, signReply } = require("./agentsig");
const { validate } = require("./snapshot");
const { writeFileAtomic } = require("./fsutil");

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

const FAIL_LIMIT = 30;          // failed authentications per client address ...
const FAIL_WINDOW_MS = 60000;   // ... per minute, then 429 until the minute is over

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

function createAgentApi({ nodes, log, onSnapshot, maxBody = 256 * 1024, now = Date.now,
                          replayFile = null, clientIp = (req) => req.socket.remoteAddress }) {
  const lastTs = new Map();     // "<id> <endpoint>" -> last accepted TS
  if (replayFile) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(replayFile, "utf8")))) {
        if (typeof v === "number") lastTs.set(k, v);
      }
    } catch (_) { /* first start, or an unreadable file: the skew window still bounds replays */ }
  }
  function acceptTs(key, ts) {
    lastTs.set(key, ts);
    if (!replayFile) return;
    try { writeFileAtomic(replayFile, JSON.stringify(Object.fromEntries(lastTs)), 0o600); }
    catch (e) { log.warn("api.replay_write_failed", { error: e.code || String(e) }); }
  }
  const failures = new Map();   // client address -> { n, until }
  function failed(ip) {
    const t = now();
    const f = failures.get(ip);
    if (!f || f.until < t) failures.set(ip, { n: 1, until: t + FAIL_WINDOW_MS });
    else f.n++;
    if (failures.size > 10000) failures.clear();   // bounded memory under a flood
  }
  const blocked = (ip) => { const f = failures.get(ip); return !!f && f.until >= now() && f.n >= FAIL_LIMIT; };
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

    const ip = clientIp(req) || "?";
    const slowDown = () => fail(res, 429, "rate_limited", { headers: { "retry-after": String(Math.ceil(FAIL_WINDOW_MS / 1000)) } });
    const h = req.headers;
    if (h["x-servitals-proto"] !== "1") return fail(res, 426, "unsupported_protocol");
    const id = h["x-servitals-node"] || "";
    const node = NODE_ID.test(id) ? nodes.get(id) : null;
    // failures are counted per address for unknown ids, and per address and
    // node otherwise: a broken or revoked agent never locks out a healthy one
    // behind the same NAT, proxy or tunnel
    if (!node) {
      if (blocked(ip)) return slowDown();
      failed(ip);
      log.warn("api.refused", { error: "unknown_node" });
      return fail(res, 401, "unknown_node");
    }
    const who = `${ip} ${id}`;
    if (blocked(who)) return slowDown();
    const tsRaw = h["x-servitals-ts"] || "";
    const ts = /^\d{1,16}$/.test(tsRaw) ? Number(tsRaw) : NaN;
    const hubMs = now();
    if (!Number.isFinite(ts) || Math.abs(hubMs - ts) > MAX_SKEW_MS) {
      failed(who);
      log.warn("api.refused", { node: id, error: "clock_skew" });
      return fail(res, 401, "clock_skew", { body: { hub_ms: hubMs } });
    }
    const key = `${id} ${endpoint}`;
    if (ts <= (lastTs.get(key) || 0)) return fail(res, 401, "replay");   // agents retry these; not a failure
    const tooLarge = () => fail(res, 413, "too_large", { headers: { connection: "close" } });
    if (Number(h["content-length"] || 0) > maxBody) { req.resume(); return tooLarge(); }
    const body = await readLimited(req, maxBody);
    if (body === null) return tooLarge();
    if (!verifyRequest(node.secret, req.method, pathname, tsRaw, body, h["x-servitals-sig"])) {
      failed(who);
      log.warn("api.refused", { node: id, error: "bad_signature" });
      return fail(res, 401, "bad_signature");
    }

    if (endpoint === "push") {
      const since = hubMs - (lastPush.get(id) || 0);
      if (since < PUSH_MIN_MS) {
        return fail(res, 429, "rate_limited", { headers: { "retry-after": String(Math.ceil((PUSH_MIN_MS - since) / 1000)) } });
      }
      let raw;
      try { raw = JSON.parse(body.toString("utf8")); } catch (_) { raw = undefined; }
      const checked = validate(raw);
      if (!checked.ok) return fail(res, 422, "invalid_snapshot", { body: { path: checked.path } });
      acceptTs(key, ts);
      lastPush.set(id, hubMs);
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, checked.value);
      return reply(res, 200, node.secret, tsRaw, { ok: true });
    }

    acceptTs(key, ts);
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

module.exports = { createAgentApi, clampWait, FAIL_LIMIT };
