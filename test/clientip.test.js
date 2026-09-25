// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { normalizeIp, parseCidrList, matchesAny, createClientResolver, isWhitelisted } =
  require("../hub/lib/clientip");

const fakeReq = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const LAN = parseCidrList("127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16");

test("normalizeIp accepts IPv4, IPv6 and v4-mapped v6; rejects junk", () => {
  assert.strictEqual(normalizeIp(" 192.0.2.1 "), "192.0.2.1");
  assert.strictEqual(normalizeIp("::ffff:192.0.2.1"), "192.0.2.1");
  assert.strictEqual(normalizeIp("2001:DB8::1"), "2001:db8::1");
  for (const bad of ["", "localhost", "<script>", "300.1.1.1", null, undefined, 42]) {
    assert.strictEqual(normalizeIp(bad), null, String(bad));
  }
});

test("CIDR matching", () => {
  assert.ok(matchesAny("192.168.1.5", LAN));
  assert.ok(matchesAny("172.31.250.1", LAN));
  assert.ok(matchesAny("::1", LAN));
  assert.ok(!matchesAny("203.0.113.7", LAN));
  assert.ok(!matchesAny("172.32.0.1", LAN));
  assert.ok(!matchesAny(null, LAN));
  assert.ok(matchesAny("198.51.100.9", parseCidrList(["198.51.100.0/24"])));
  assert.ok(matchesAny("8.8.8.8", parseCidrList("0.0.0.0/0")));
  assert.deepStrictEqual(parseCidrList("# comment, 10.0.0.0/33, bogus"), []);
});

test("untrusted peer: headers ignored", () => {
  const resolve = createClientResolver({ trustedProxies: "127.0.0.1,::1" });
  const c = resolve(fakeReq("203.0.113.7", { "x-forwarded-for": "192.168.1.5" }));
  assert.deepStrictEqual(c, { ip: "203.0.113.7", peer: "203.0.113.7", peerTrusted: false, viaProxy: false, proxyOnly: false });
  assert.strictEqual(isWhitelisted(c, LAN), false);
});

test("trusted peer: rightmost X-Forwarded-For wins", () => {
  const resolve = createClientResolver({ trustedProxies: "127.0.0.1" });
  const c = resolve(fakeReq("::ffff:127.0.0.1", { "x-forwarded-for": "192.168.1.5, 203.0.113.9" }));
  assert.strictEqual(c.ip, "203.0.113.9");
  assert.strictEqual(c.viaProxy, true);
  assert.strictEqual(isWhitelisted(c, LAN), false);
  const lan = resolve(fakeReq("127.0.0.1", { "x-forwarded-for": "192.168.1.5" }));
  assert.strictEqual(lan.ip, "192.168.1.5");
  assert.strictEqual(isWhitelisted(lan, LAN), true);
});

test("trusted peer without a forwarding header is never whitelisted", () => {
  const resolve = createClientResolver({ trustedProxies: "172.31.250.1" });
  const c = resolve(fakeReq("172.31.250.1"));
  assert.deepStrictEqual(c, { ip: "172.31.250.1", peer: "172.31.250.1", peerTrusted: true, viaProxy: false, proxyOnly: true });
  assert.strictEqual(isWhitelisted(c, LAN), false);
});

test("trusted peer with an unparseable header falls back to proxyOnly", () => {
  const resolve = createClientResolver({ trustedProxies: "127.0.0.1" });
  const c = resolve(fakeReq("127.0.0.1", { "x-forwarded-for": "<script>" }));
  assert.strictEqual(c.proxyOnly, true);
  assert.strictEqual(isWhitelisted(c, LAN), false);
});

test("Cf-Connecting-Ip is used only when PROXY_HEADER selects it", () => {
  const xff = createClientResolver({ trustedProxies: "127.0.0.1" });
  const cf = createClientResolver({ trustedProxies: "127.0.0.1", proxyHeader: "cf-connecting-ip" });
  const req = fakeReq("127.0.0.1", { "cf-connecting-ip": "192.168.1.9", "x-forwarded-for": "203.0.113.4" });
  assert.strictEqual(xff(req).ip, "203.0.113.4");
  assert.strictEqual(cf(req).ip, "192.168.1.9");
});
