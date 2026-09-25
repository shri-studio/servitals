// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Who is the client? Forwarding headers are forgeable, so they are honoured
 * only when the TCP peer is a trusted proxy (TRUSTED_PROXIES). The client is
 * the rightmost X-Forwarded-For entry, the one our proxy appended; anything
 * left of it came from the client. A trusted proxy's own address is never
 * whitelisted: a request from it without a usable header is "proxyOnly".
 */
const net = require("node:net");

function normalizeIp(raw) {
  if (typeof raw !== "string") return null;
  let ip = raw.trim();
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function v4ToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function parseCidrList(input) {
  const items = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
  const out = [];
  for (const raw of items) {
    const s = String(raw).trim();
    if (!s || s.startsWith("#")) continue;
    const [addr, bitsStr] = s.split("/");
    const ip = normalizeIp(addr);
    if (!ip) continue;
    if (net.isIPv4(ip)) {
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      out.push({ v: 4, net: (v4ToInt(ip) & mask) >>> 0, mask });
    } else if (bitsStr === undefined || bitsStr === "128") {
      out.push({ v: 6, ip });   // IPv6 entries match exact addresses only
    }
  }
  return out;
}

function matchesAny(ip, entries) {
  if (!ip) return false;
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return entries.some((e) => e.v === 4 && ((n & e.mask) >>> 0) === e.net);
  }
  return entries.some((e) => e.v === 6 && e.ip === ip);
}

function forwardedIp(req, header) {
  if (header === "cf-connecting-ip") return normalizeIp(req.headers["cf-connecting-ip"]);
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return null;
  const parts = String(xff).split(",");
  return normalizeIp(parts[parts.length - 1]);
}

function createClientResolver({ trustedProxies = "127.0.0.1,::1", proxyHeader = "x-forwarded-for" } = {}) {
  const trusted = parseCidrList(trustedProxies);
  const header = proxyHeader === "cf-connecting-ip" ? "cf-connecting-ip" : "x-forwarded-for";
  return function resolveClient(req) {
    const peer = normalizeIp(req.socket && req.socket.remoteAddress);
    if (peer && matchesAny(peer, trusted)) {
      const fwd = forwardedIp(req, header);
      if (fwd) return { ip: fwd, peer, peerTrusted: true, viaProxy: true, proxyOnly: false };
      return { ip: peer, peer, peerTrusted: true, viaProxy: false, proxyOnly: true };
    }
    return { ip: peer, peer, peerTrusted: false, viaProxy: false, proxyOnly: false };
  };
}

function isWhitelisted(client, entries) {
  return !!client && !client.proxyOnly && matchesAny(client.ip, entries);
}

module.exports = { normalizeIp, parseCidrList, matchesAny, createClientResolver, isWhitelisted };
