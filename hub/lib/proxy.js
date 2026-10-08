// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Every outbound call the hub makes (alert channels, Web Push, the relay) goes through
 * here (spec 8.4): Node's http and https modules, not fetch, and an HTTP proxy when
 * hub.env sets one, since Node 18 and 22 ignore HTTPS_PROXY.
 *   - HTTPS_PROXY for https:// destinations, HTTP_PROXY for http:// ones (either case);
 *     only http:// proxy URLs, with optional user:password@ sent as Proxy-Authorization.
 *   - https:// goes through a CONNECT tunnel, then TLS to the destination with the usual
 *     certificate checks: the proxy never sees the content. http:// is an absolute-form
 *     request through the proxy.
 *   - NO_PROXY: host names and domain suffixes (.example.com; example.com also matches its
 *     subdomains), IPv4 CIDRs, exact IPv6 addresses, and *. localhost, 127.0.0.1 and ::1
 *     are always direct.
 *   - Credentials are never logged: describe() shows the proxy's host only.
 *   createOutbound({ env }) → { request(url, { method, headers, body, timeoutMs, maxBytes, ca }),
 *     proxyFor(url), describe() }
 *   request resolves { status, headers, body } (body a string, at most maxBytes) or rejects
 *   with an Error whose code says what failed (ETIMEDOUT, EPROXY, ETOOBIG, or the socket's).
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const ALWAYS_DIRECT = new Set(["localhost", "127.0.0.1", "::1"]);

const pick = (env, name) => env[name] || env[name.toLowerCase()] || "";

// an http:// proxy URL, or null (anything else is not used)
function parseProxy(s) {
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== "http:" || !u.hostname) return null;
  const auth = u.username ? "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64") : null;
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 80, auth };
}

const ipv4 = (s) => (net.isIPv4(s) ? s.split(".").reduce((n, o) => n * 256 + Number(o), 0) : null);
function inCidr(host, cidr) {
  const [base, bits] = cidr.split("/");
  const h = ipv4(host), b = ipv4(base), n = Number(bits);
  if (h === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((h & mask) >>> 0) === ((b & mask) >>> 0);
}

// does NO_PROXY send this host direct?
function noProxy(list, host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (ALWAYS_DIRECT.has(host)) return true;
  for (let e of list.split(",")) {
    e = e.trim().toLowerCase();
    if (!e) continue;
    if (e === "*") return true;
    if (e.includes("/")) { if (inCidr(host, e)) return true; continue; }
    e = e.replace(/^\[|\]$/g, "");
    if (net.isIP(e)) { if (e === host) return true; continue; }
    e = e.replace(/:\d+$/, "");
    if (e.startsWith(".") ? host.endsWith(e) || host === e.slice(1) : host === e || host.endsWith("." + e)) return true;
  }
  return false;
}

function createOutbound({ env = process.env } = {}) {
  const proxies = { "https:": parseProxy(pick(env, "HTTPS_PROXY")), "http:": parseProxy(pick(env, "HTTP_PROXY")) };
  const skip = pick(env, "NO_PROXY");

  function proxyFor(url) {
    const u = typeof url === "string" ? new URL(url) : url;
    const p = proxies[u.protocol];
    return p && !noProxy(skip, u.hostname) ? p : null;
  }

  function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000, maxBytes = 1048576, ca } = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (_) { const e = new Error("invalid url"); e.code = "EURL"; reject(e); return; }
      if (u.protocol !== "https:" && u.protocol !== "http:") { const e = new Error("only http and https"); e.code = "EURL"; reject(e); return; }
      const secure = u.protocol === "https:";
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const port = Number(u.port) || (secure ? 443 : 80);
      const data = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      const hdrs = { ...headers, ...(data ? { "content-length": String(data.length) } : {}) };
      const proxy = proxyFor(u);
      let done = false, sockets = [];
      const fail = (err, code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const s of sockets) s.destroy();
        if (code && !err.code) err.code = code;
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("timed out"), "ETIMEDOUT"), timeoutMs);
      const onResponse = (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) { fail(new Error("answer too big"), "ETOOBIG"); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          for (const s of sockets) s.destroy();   // one call, one connection: nothing kept open
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (e) => fail(e));
      };
      const send = (req) => {
        req.on("socket", (s) => sockets.push(s));
        req.on("error", (e) => fail(e));
        if (data) req.write(data);
        req.end();
      };

      if (!proxy) {
        send((secure ? https : http).request({ host, port, method, path: u.pathname + u.search, headers: hdrs, servername: net.isIP(host) ? undefined : host, ca, agent: false }, onResponse));
        return;
      }
      const pauth = proxy.auth ? { "proxy-authorization": proxy.auth } : {};
      if (!secure) {
        send(http.request({ host: proxy.host, port: proxy.port, method, path: u.href, headers: { host: u.host, ...hdrs, ...pauth }, agent: false }, onResponse));
        return;
      }
      // https: a CONNECT tunnel, then TLS end to end with the destination
      const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
      const tunnel = http.request({ host: proxy.host, port: proxy.port, method: "CONNECT", path: target, headers: { host: target, ...pauth }, agent: false });
      tunnel.on("socket", (s) => sockets.push(s));
      tunnel.on("error", (e) => fail(e, "EPROXY"));
      tunnel.on("connect", (res, socket) => {
        sockets.push(socket);
        if (res.statusCode !== 200) { fail(new Error(`proxy answered ${res.statusCode} to CONNECT`), "EPROXY"); return; }
        const secured = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ca });
        sockets.push(secured);
        secured.on("error", (e) => fail(e));
        // an agent that hands over the tunnel's TLS socket (agent: false would dial again)
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => secured;
        send(https.request({ host, port, method, path: u.pathname + u.search, headers: hdrs, agent }, onResponse));
      });
      tunnel.end();
    });
  }

  // for the log: where calls go, never the credentials
  function describe() {
    const d = (p) => (p ? `${p.host}:${p.port}` : "direct");
    return { https: d(proxies["https:"]), http: d(proxies["http:"]) };
  }

  return { request, proxyFor, describe };
}

module.exports = { createOutbound, noProxy, parseProxy };
