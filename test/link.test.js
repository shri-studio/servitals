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

test("rate limits: 5 waiting per address, 20 starts an hour; only wrong codes count against the entry limit", () => {
  const t = clock(), links = createLinks({ now: t });
  for (let i = 0; i < 5; i++) assert.strictEqual(ask(links).status, 200);
  assert.deepStrictEqual(ask(links), { status: 429, body: { error: "rate_limited" }, retryAfter: 600 }, "5 already waiting");
  assert.strictEqual(ask(links, { ip: "203.0.113.8" }).status, 200, "another address is not affected");
  t.add(601e3);   // those 5 expired: 15 more this hour
  for (let i = 0; i < 3; i++) { for (let k = 0; k < 5; k++) assert.strictEqual(ask(links).status, 200); t.add(601e3); }
  assert.deepStrictEqual(ask(links), { status: 429, body: { error: "rate_limited" }, retryAfter: 600 }, "20 in an hour");

  // a person linking eight servers in a row is never slowed down
  const who = { ip: "10.0.0.2", account: "admin" };
  const fresh = createLinks({ now: t });
  for (let i = 0; i < 8; i++) {
    const code = ask(fresh, { ip: `198.51.100.${i}` }).body.user_code;
    assert.strictEqual(fresh.lookup(code, who).ok, true, `lookup ${i}`);
    assert.strictEqual(fresh.decide(code, true, who, () => ({})).ok, true, `decide ${i}`);
  }
  // guessing is: 10 wrong codes per address and per account in 10 minutes
  for (let i = 0; i < 10; i++) assert.strictEqual(fresh.lookup("AAAA-AAAA", who).error, "unknown");
  assert.strictEqual(fresh.lookup("AAAA-AAAA", who).error, "too_many");
  assert.strictEqual(fresh.lookup("AAAA-AAAA", { ip: "10.0.0.3", account: "admin" }).error, "too_many", "per account too");
  t.add(600e3);
  assert.strictEqual(fresh.lookup("AAAA-AAAA", who).error, "unknown");
});

test("IPv6 addresses count per /64, IPv4-mapped addresses as IPv4", () => {
  const links = createLinks();
  for (let i = 1; i <= 5; i++) assert.strictEqual(ask(links, { ip: `2001:db8:1:2::${i}` }).status, 200);
  assert.strictEqual(ask(links, { ip: "2001:db8:1:2:ffff:ffff:ffff:ffff" }).status, 429, "same /64");
  assert.strictEqual(ask(links, { ip: "2001:db8:1:3::1" }).status, 200, "another /64");
  for (let i = 1; i <= 5; i++) assert.strictEqual(ask(links, { ip: "::ffff:192.0.2.1" }).status, i <= 5 ? 200 : 429);
  assert.strictEqual(ask(links, { ip: "192.0.2.1" }).status, 429, "::ffff:192.0.2.1 is 192.0.2.1");
});

test("a busy hub answers without counting the start, and the address table stays bounded", () => {
  const t = clock(), links = createLinks({ now: t });
  for (let i = 0; i < 100; i++) assert.strictEqual(ask(links, { ip: `198.51.100.${i}` }).status, 200);
  for (let i = 0; i < 30; i++) assert.strictEqual(ask(links, { ip: "203.0.113.50" }).status, 503);
  t.add(601e3);
  assert.strictEqual(ask(links, { ip: "203.0.113.50" }).status, 200, "the 503s did not use up its starts");
  assert.ok(links.tracked() <= 102, `tracked ${links.tracked()}`);
});

test("at most 100 requests wait at once", () => {
  const links = createLinks();
  for (let i = 0; i < 100; i++) assert.strictEqual(ask(links, { ip: `198.51.100.${i}` }).status, 200);
  assert.deepStrictEqual(ask(links, { ip: "198.51.100.200" }), { status: 503, body: { error: "busy" }, retryAfter: 60 });
});

test("a flood of starts from rotating addresses stays cheap", () => {
  const t = clock(), links = createLinks({ now: t });
  const begin = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) {
    ask(links, { ip: `2001:db8:${(i >> 16) & 0xffff}:${i & 0xffff}::1` });
    if (i % 100 === 0) t.add(1000);
  }
  const ms = Number(process.hrtime.bigint() - begin) / 1e6;
  assert.ok(ms < 3000, `20000 starts took ${Math.round(ms)} ms`);
  assert.ok(links.tracked() <= 10000);
});
