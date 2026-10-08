// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The hub's outbound calls (spec 8.4): direct, or through an HTTP proxy from HTTPS_PROXY /
 * HTTP_PROXY with NO_PROXY; https through a CONNECT tunnel with the destination's
 * certificate checked; credentials never shown. The proxy and the destinations run in
 * this process.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createOutbound, noProxy, parseProxy } = require("../hub/lib/proxy");

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (...srvs) => Promise.all(srvs.map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); })));

function certFor(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-out-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { stdio: "ignore" });
  const c = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

// a destination that answers with what it was sent
const echo = (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(201, { "content-type": "application/json", "x-seen": "yes" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
};

// an HTTP proxy: absolute-form requests and CONNECT tunnels, every name to 127.0.0.1;
// remembers what it saw; answers 407 without the right credentials when asked to
async function startProxy({ auth = null } = {}) {
  const seen = [];
  const ok = (req) => !auth || req.headers["proxy-authorization"] === "Basic " + Buffer.from(auth).toString("base64");
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (!ok(req)) { res.writeHead(407); res.end(); return; }
    const u = new URL(req.url);
    const up = http.request({ host: "127.0.0.1", port: u.port, method: req.method, path: u.pathname + u.search, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  srv.on("connect", (req, sock) => {
    seen.push({ method: "CONNECT", url: req.url, headers: req.headers });
    if (!ok(req)) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
    const port = Number(req.url.split(":").pop());
    const up = net.connect(port, "127.0.0.1", () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
    up.on("close", () => sock.destroy());
    sock.on("close", () => up.destroy());
  });
  const port = await listen(srv);
  return { srv, port, seen };
}

test("NO_PROXY: names, suffixes, CIDRs, IPv6, *; this host is always direct", () => {
  const list = ".corp.example, example.org:443, 10.0.0.0/8, [fd00::1], intranet";
  const cases = { "localhost": true, "127.0.0.1": true, "::1": true, "a.corp.example": true, "corp.example": true,
    "example.org": true, "www.example.org": true, "notexample.org": false, "10.4.5.6": true, "11.0.0.1": false,
    "fd00::1": true, "fd00::2": false, "intranet": true, "ntfy.sh": false, "A.CORP.EXAMPLE": true };
  for (const [host, want] of Object.entries(cases)) assert.strictEqual(noProxy(list, host), want, host);
  assert.strictEqual(noProxy("*", "ntfy.sh"), true);
  assert.strictEqual(noProxy("", "ntfy.sh"), false);
  assert.strictEqual(noProxy("10.0.0.0/33, 1.2.3/8", "1.2.3.4"), false, "a CIDR that is not one matches nothing");
});

test("only http:// proxy URLs are used; credentials become Basic; a missing port is 80", () => {
  assert.strictEqual(parseProxy("https://p.example:3128"), null);
  assert.strictEqual(parseProxy("socks5://p.example:1080"), null);
  assert.strictEqual(parseProxy("not a url"), null);
  assert.deepStrictEqual(parseProxy("http://p.example"), { host: "p.example", port: 80, auth: null });
  assert.deepStrictEqual(parseProxy("http://us%40er:p%3Ass@p.example:3128"),
    { host: "p.example", port: 3128, auth: "Basic " + Buffer.from("us@er:p:ss").toString("base64") });
  const o = createOutbound({ env: { https_proxy: "http://u:secret@p.example:3128", HTTP_PROXY: "http://q.example:8080", NO_PROXY: ".lan" } });
  assert.strictEqual(o.proxyFor("https://ntfy.sh/x").host, "p.example", "lower case works too");
  assert.strictEqual(o.proxyFor("http://hooks.example/x").host, "q.example");
  assert.strictEqual(o.proxyFor("https://nas.lan/x"), null);
  assert.deepStrictEqual(o.describe(), { https: "p.example:3128", http: "q.example:8080" });
  assert.doesNotMatch(JSON.stringify(o.describe()), /secret/, "never the credentials");
  assert.deepStrictEqual(createOutbound({ env: {} }).describe(), { https: "direct", http: "direct" });
});

test("a direct call: method, headers and body go out; status, headers and body come back", async () => {
  const dest = http.createServer(echo);
  const port = await listen(dest);
  try {
    const r = await createOutbound({ env: {} }).request(`http://127.0.0.1:${port}/a?b=1`, { method: "POST", headers: { "x-k": "v" }, body: "héllo" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.headers["x-seen"], "yes");
    const got = JSON.parse(r.body);
    assert.deepStrictEqual([got.method, got.url, got.headers["x-k"], got.headers["content-length"], got.body], ["POST", "/a?b=1", "v", "6", "héllo"]);
  } finally { await close(dest); }
});

test("http through the proxy: an absolute-form request with Proxy-Authorization", async () => {
  const dest = http.createServer(echo);
  const dport = await listen(dest);
  const p = await startProxy({ auth: "u:pw" });
  try {
    const o = createOutbound({ env: { HTTP_PROXY: `http://u:pw@127.0.0.1:${p.port}` } });
    const r = await o.request(`http://hooks.test:${dport}/hook`, { method: "POST", body: "{}" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(p.seen[0].url, `http://hooks.test:${dport}/hook`);
    assert.strictEqual(p.seen[0].headers.host, `hooks.test:${dport}`);
    assert.strictEqual(JSON.parse(r.body).url, "/hook");
  } finally { await close(dest, p.srv); }
});

test("https through the proxy: a CONNECT tunnel, then TLS with the destination's certificate checked", async () => {
  const c = certFor("svc.test");
  const dest = https.createServer(c, echo);
  const dport = await listen(dest);
  const p = await startProxy({ auth: "u:pw" });
  try {
    const o = createOutbound({ env: { HTTPS_PROXY: `http://u:pw@127.0.0.1:${p.port}` } });
    const r = await o.request(`https://svc.test:${dport}/push`, { method: "POST", body: "x", ca: c.cert });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([p.seen[0].method, p.seen[0].url], ["CONNECT", `svc.test:${dport}`]);
    assert.strictEqual(p.seen[0].headers["proxy-authorization"], "Basic " + Buffer.from("u:pw").toString("base64"));
    assert.strictEqual(JSON.parse(r.body).headers["proxy-authorization"], undefined, "the destination never sees the proxy's credentials");
    await assert.rejects(o.request(`https://svc.test:${dport}/push`), (e) => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code), "a certificate nobody vouches for");
    await assert.rejects(o.request(`https://other.test:${dport}/push`, { ca: c.cert }), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID", "a certificate for another name");
  } finally { await close(dest, p.srv); }
});

test("a proxy that refuses, a destination too slow or too talkative: an error that says which", async () => {
  const p = await startProxy({ auth: "u:pw" });
  const slow = http.createServer(() => {});
  const big = http.createServer((req, res) => { res.end(Buffer.alloc(3000, 97)); });
  const [sport, bport] = [await listen(slow), await listen(big)];
  try {
    const wrong = createOutbound({ env: { HTTPS_PROXY: `http://u:nope@127.0.0.1:${p.port}` } });
    await assert.rejects(wrong.request("https://svc.test/x"), (e) => e.code === "EPROXY" && /407/.test(e.message));
    const o = createOutbound({ env: {} });
    await assert.rejects(o.request(`http://127.0.0.1:${sport}/`, { timeoutMs: 200 }), (e) => e.code === "ETIMEDOUT");
    await assert.rejects(o.request(`http://127.0.0.1:${bport}/`, { maxBytes: 1000 }), (e) => e.code === "ETOOBIG");
    await assert.rejects(o.request("ftp://x.test/"), (e) => e.code === "EURL");
    await assert.rejects(o.request("::"), (e) => e.code === "EURL");
    const down = createOutbound({ env: { HTTP_PROXY: "http://127.0.0.1:1" } });
    await assert.rejects(down.request("http://hooks.test/"), (e) => e.code === "ECONNREFUSED");
  } finally { await close(p.srv, slow, big); }
});

test("an IP address through the proxy is checked against the IP; a % in a proxy password does not stop the hub; a bad header is an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-out-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", path.join(dir, "k"), "-out", path.join(dir, "c"),
    "-subj", "/CN=ip", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const c = { key: fs.readFileSync(path.join(dir, "k")), cert: fs.readFileSync(path.join(dir, "c")) };
  fs.rmSync(dir, { recursive: true, force: true });
  const local = certFor("localhost");
  const dest = https.createServer(c, echo), fake = https.createServer(local, echo);
  const [dport, fport] = [await listen(dest), await listen(fake)];
  const p = await startProxy();
  try {
    const o = createOutbound({ env: { HTTPS_PROXY: `http://127.0.0.1:${p.port}`, NO_PROXY: "" } });
    // 127.0.0.1 is always direct, so the proxy is asked through a name that NO_PROXY cannot know: the tunnel test uses the IP form
    const viaProxy = createOutbound({ env: { HTTPS_PROXY: `http://127.0.0.1:${p.port}` } });
    assert.ok(o.proxyFor(`https://127.0.0.2:${dport}/`), "another loopback address goes through the proxy");
    const r = await viaProxy.request(`https://127.0.0.2:${dport}/x`, { ca: c.cert }).catch((e) => e);
    assert.strictEqual(r.code, "ERR_TLS_CERT_ALTNAME_INVALID", "a certificate for 127.0.0.1 is not one for 127.0.0.2");
    await assert.rejects(viaProxy.request(`https://127.0.0.2:${fport}/x`, { ca: local.cert }), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID",
      "never checked against localhost");
    assert.strictEqual(parseProxy("http://u:pa%ss@px.test:3128").auth, "Basic " + Buffer.from("u:pa%ss").toString("base64"));
    await assert.rejects(o.request(`https://127.0.0.2:${dport}/x`, { ca: c.cert, headers: { authorization: "Bearer t€k" } }), (e) => e.code === "ERR_INVALID_CHAR");
    await assert.rejects(createOutbound({ env: {} }).request(`https://127.0.0.1:${dport}/x`, { ca: c.cert, headers: { authorization: "t€k" } }), (e) => e.code === "ERR_INVALID_CHAR");
  } finally { await close(dest, fake, p.srv); }
});
