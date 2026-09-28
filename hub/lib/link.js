// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Code-based linking (spec 6.1.1, docs/protocol.md 5.3), after the OAuth
 * device authorization pattern (RFC 8628). An agent sends the secret it made
 * itself and gets a long device code to poll with and a short user code for a
 * person, who approves it on /link. Requests live in memory only: a hub
 * restart expires them, and the agent says so and can start again.
 *
 * Both codes are kept only as SHA-256 hashes and found by hash, so a guess is
 * never compared byte by byte against a stored code.
 */
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L look-alikes
const TTL_MS = 600e3;
const INTERVAL_S = 5;
const KEEP_MS = 2 * TTL_MS;          // answer "expired" (not "unknown") for a while after
const MAX_PENDING = 100;
const START_LIMIT = 5, START_WINDOW_MS = 3600e3;
const ENTRY_LIMIT = 10, ENTRY_WINDOW_MS = 600e3;

const SECRET_RE = /^[0-9a-f]{64}$/;
const HOST_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const OS_RE = /^[a-z0-9._-]{1,32}$/i;
const AGENT_RE = /^[A-Za-z0-9._/+-]{1,32}$/;

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const normalizeCode = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const newUserCode = () => [...crypto.randomBytes(8)].map((b) => ALPHABET[b & 31]).join("");

function createLinks({ now = Date.now } = {}) {
  const byDevice = new Map();   // hash(device code) -> request
  const byUser = new Map();     // hash(user code) -> request, while it can still be decided
  const starts = new Map();     // ip -> [times]
  const entries = new Map();    // "ip:<ip>" or "account:<name>" -> [times]

  // true when this attempt is within the limit (and records it)
  function allow(map, key, limit, windowMs) {
    const t = now();
    const recent = (map.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= limit) { map.set(key, recent); return false; }
    recent.push(t);
    map.set(key, recent);
    return true;
  }

  function sweep() {
    const t = now();
    for (const [k, r] of byDevice) {
      if (t > r.expires + KEEP_MS) byDevice.delete(k);
      if (t > r.expires || r.status !== "pending") byUser.delete(r.userHash);
    }
    for (const map of [starts, entries]) for (const [k, v] of map) if (!v.some((x) => t - x < START_WINDOW_MS)) map.delete(k);
  }

  function start({ secret, host, os, agent, ip }) {
    if (typeof secret !== "string" || !SECRET_RE.test(secret) || typeof host !== "string" || !HOST_RE.test(host) ||
        typeof os !== "string" || !OS_RE.test(os) || typeof agent !== "string" || !AGENT_RE.test(agent)) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    sweep();
    if (!allow(starts, ip || "?", START_LIMIT, START_WINDOW_MS)) {
      return { status: 429, body: { error: "rate_limited" }, retryAfter: START_WINDOW_MS / 1000 };
    }
    if (byUser.size >= MAX_PENDING) return { status: 503, body: { error: "busy" }, retryAfter: 60 };
    const device = crypto.randomBytes(32).toString("base64url");
    let code;
    do { code = newUserCode(); } while (byUser.has(hash(code)));
    const t = now();
    const req = { deviceHash: hash(device), userHash: hash(code), code, secret, host, os, agent, ip: ip || "",
                  started: t, expires: t + TTL_MS, status: "pending", lastPoll: 0, result: null };
    byDevice.set(req.deviceHash, req);
    byUser.set(req.userHash, req);
    return { status: 200, body: { device_code: device, user_code: showCode(code), expires_in: TTL_MS / 1000, interval: INTERVAL_S } };
  }

  function poll(device) {
    if (typeof device !== "string" || device.length > 64) return { status: 400, body: { error: "invalid_request" } };
    sweep();
    const r = byDevice.get(hash(device));
    if (!r || r.status === "spent") return { status: 410, body: { error: "expired" } };
    if (r.status === "denied") return { status: 410, body: { error: "denied" } };
    if (r.status === "approved") {
      r.status = "spent";
      r.secret = "";
      return { status: 200, body: r.result };
    }
    const t = now();
    if (t > r.expires) return { status: 410, body: { error: "expired" } };
    const early = t - r.lastPoll < (INTERVAL_S - 1) * 1000;
    r.lastPoll = t;
    if (early) return { status: 429, body: { error: "slow_down" } };
    return { status: 202, body: { status: "pending" } };
  }

  // a person typed a code: what would they approve? Counted against both limits.
  function find(code, { ip, account }) {
    const okIp = allow(entries, "ip:" + (ip || "?"), ENTRY_LIMIT, ENTRY_WINDOW_MS);
    const okAccount = allow(entries, "account:" + (account || "?"), ENTRY_LIMIT, ENTRY_WINDOW_MS);
    if (!okIp || !okAccount) return { error: "too_many" };
    sweep();
    const c = normalizeCode(code);
    const r = c.length === 8 ? byUser.get(hash(c)) : null;
    if (!r || r.status !== "pending" || now() > r.expires) return { error: "unknown" };
    return { r };
  }

  function lookup(code, who) {
    const f = find(code, who);
    if (f.error) return { ok: false, error: f.error };
    const r = f.r;
    return { ok: true, request: { code: showCode(r.code), host: r.host, os: r.os, agent: r.agent, ip: r.ip,
                                  started: r.started, expires: r.expires } };
  }

  // approve: onApprove(request with the secret) returns what the agent gets
  function decide(code, approve, who, onApprove) {
    const f = find(code, who);
    if (f.error) return { ok: false, error: f.error };
    const r = f.r;
    byUser.delete(r.userHash);   // single use, whatever the outcome
    if (!approve) { r.status = "denied"; r.secret = ""; return { ok: true, host: r.host, from: r.ip }; }
    r.result = onApprove({ host: r.host, os: r.os, agent: r.agent, ip: r.ip, secret: r.secret });
    r.status = "approved";
    return { ok: true, host: r.host, from: r.ip, result: r.result };
  }

  return { start, poll, lookup, decide };
}

module.exports = { createLinks, normalizeCode, TTL_MS, INTERVAL_S };
