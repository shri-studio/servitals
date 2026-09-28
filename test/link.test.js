// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createLinks, normalizeCode } = require("../hub/lib/link");

const SECRET = "ab".repeat(32);
const ask = (links, over = {}) => links.start({ secret: SECRET, host: "nas", os: "linux", agent: "bash/0.1.0", ip: "203.0.113.7", ...over });
function clock(t = 1e12) { const c = () => t; c.add = (ms) => { t += ms; }; return c; }

test("start hands out a long device code and a short user code without look-alikes", () => {
  const r = ask(createLinks());
  assert.strictEqual(r.status, 200);
  assert.match(r.body.device_code, /^[A-Za-z0-9_-]{43}$/);
  assert.match(r.body.user_code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.strictEqual(r.body.expires_in, 600);
  assert.strictEqual(r.body.interval, 5);
});

test("start refuses a bad secret, host, os or agent", () => {
  const links = createLinks();
  for (const bad of [{ secret: "xyz" }, { secret: SECRET.toUpperCase() }, { host: "" }, { host: "a\u0007b" }, { host: "x".repeat(65) },
                     { os: "linux; rm" }, { agent: "" }, { agent: "a".repeat(33) }, { secret: undefined }]) {
    const r = ask(links, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual(r.body.error, "invalid_request");
  }
});

test("the code is typed in any case, with or without the dash; lookup shows what is being approved", () => {
  const links = createLinks();
  const code = ask(links).body.user_code;
  assert.strictEqual(normalizeCode(" " + code.toLowerCase().replace("-", " ") + " "), code.replace("-", ""));
  const r = links.lookup(code.toLowerCase().replace("-", ""), { ip: "10.0.0.2", account: "admin" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual({ host: r.request.host, os: r.request.os, agent: r.request.agent, ip: r.request.ip },
                         { host: "nas", os: "linux", agent: "bash/0.1.0", ip: "203.0.113.7" });
  assert.strictEqual(r.request.code, code);
  assert.strictEqual(r.request.secret, undefined, "the secret never reaches the page");
});

test("poll: pending, then the node id once, then expired", () => {
  const t = clock(), links = createLinks({ now: t });
  const s = ask(links).body;
  assert.deepStrictEqual(links.poll(s.device_code), { status: 202, body: { status: "pending" } });
  t.add(5000);
  const d = links.decide(s.user_code, true, { ip: "10.0.0.2", account: "admin" }, (req) => {
    assert.strictEqual(req.secret, SECRET, "approval gets the agent's secret");
    return { node_id: "abcdefghijkm", account: "a***n on hub.lan", name: "nas" };
  });
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(links.poll(s.device_code), { status: 200, body: { node_id: "abcdefghijkm", account: "a***n on hub.lan", name: "nas" } });
  t.add(5000);
  assert.deepStrictEqual(links.poll(s.device_code), { status: 410, body: { error: "expired" } }, "the device code is spent");
  assert.strictEqual(links.lookup(s.user_code, { ip: "10.0.0.2", account: "admin" }).ok, false, "the user code is single use");
});

test("deny, expiry, unknown codes and polling too fast", () => {
  const t = clock(), links = createLinks({ now: t });
  const a = ask(links).body;
  assert.strictEqual(links.decide(a.user_code, false, { ip: "10.0.0.2", account: "admin" }).ok, true);
  assert.deepStrictEqual(links.poll(a.device_code), { status: 410, body: { error: "denied" } });
  const b = ask(links).body;
  links.poll(b.device_code);
  assert.deepStrictEqual(links.poll(b.device_code), { status: 429, body: { error: "slow_down" } });
  t.add(601e3);
  assert.deepStrictEqual(links.poll(b.device_code), { status: 410, body: { error: "expired" } });
  assert.strictEqual(links.lookup(b.user_code, { ip: "10.0.0.2", account: "admin" }).ok, false, "an expired code cannot be approved");
  assert.deepStrictEqual(links.poll("x".repeat(43)), { status: 410, body: { error: "expired" } });
  assert.deepStrictEqual(links.poll(undefined), { status: 400, body: { error: "invalid_request" } });
});

test("rate limits: 5 starts per address per hour, 10 code entries per address and per account per 10 minutes", () => {
  const t = clock(), links = createLinks({ now: t });
  for (let i = 0; i < 5; i++) assert.strictEqual(ask(links).status, 200);
  assert.deepStrictEqual(ask(links), { status: 429, body: { error: "rate_limited" }, retryAfter: 3600 });
  assert.strictEqual(ask(links, { ip: "203.0.113.8" }).status, 200, "another address is not affected");
  t.add(3600e3);
  assert.strictEqual(ask(links).status, 200);

  const who = { ip: "10.0.0.2", account: "admin" };
  for (let i = 0; i < 10; i++) assert.strictEqual(links.lookup("AAAA-AAAA", who).error, "unknown");
  assert.strictEqual(links.lookup("AAAA-AAAA", who).error, "too_many");
  assert.strictEqual(links.lookup("AAAA-AAAA", { ip: "10.0.0.3", account: "admin" }).error, "too_many", "per account too");
  t.add(600e3);
  assert.strictEqual(links.lookup("AAAA-AAAA", who).error, "unknown");
});

test("at most 100 requests wait at once", () => {
  const links = createLinks();
  for (let i = 0; i < 100; i++) assert.strictEqual(ask(links, { ip: `198.51.100.${i}` }).status, 200);
  assert.deepStrictEqual(ask(links, { ip: "198.51.100.200" }), { status: 503, body: { error: "busy" }, retryAfter: 60 });
});
