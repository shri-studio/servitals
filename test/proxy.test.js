// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The agent reaches an HTTPS hub through an HTTP proxy (CONNECT, with
 * Proxy-Authorization), sends HUB_HEADERS, trusts HUB_CA_FILE, and never
 * sends the hub host's own agent through the proxy (spec 5.2, 19).
 * The proxy and a TLS front for the hub run in this process, so the agent
 * runs asynchronously.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { startHub, request, login, cookieFrom } = require("./helpers/hub");

const AGENT = path.join(__dirname, "..", "agent", "collect.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-proxy-"));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

function certFor(dir, host) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { stdio: "ignore" });
  return { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")), ca: path.join(dir, "cert.pem") };
}

// TLS in front of the hub, like a reverse proxy; remembers the headers it saw
async function tlsFront(tls, hubPort) {
  const seen = [];
  const srv = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    seen.push(req.headers);
    req.on("error", () => {});
    const up = http.request({ host: "127.0.0.1", port: hubPort, method: req.method, path: req.url, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  srv.on("tlsClientError", () => {});   // an agent that does not trust the certificate
  return { port: await listen(srv), seen, close: () => { srv.close(); srv.closeAllConnections(); } };
}

// an HTTP proxy that only tunnels (CONNECT) and wants user:pw
async function connectProxy(target) {
  const log = [];
  const open = new Set();   // tunnels outlive the HTTP server's own connection list
  const srv = http.createServer((req, res) => { log.push(`plain ${req.url}`); res.writeHead(405); res.end(); });
  srv.on("connect", (req, socket) => {
    open.add(socket);
    socket.on("error", () => {});   // the agent may hang up first
    socket.on("close", () => open.delete(socket));
    const auth = req.headers["proxy-authorization"] || "";
    log.push(`CONNECT ${req.url} ${auth}`);
    if (auth !== "Basic " + Buffer.from("user:pw").toString("base64")) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const up = net.connect(target(req.url), "127.0.0.1", () => {
      open.add(up);
      up.on("close", () => { open.delete(up); socket.destroy(); });
      socket.on("close", () => up.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(socket); socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
  });
  return { port: await listen(srv), log, close: () => { for (const s of open) s.destroy(); srv.close(); } };
}

function agentOnce(env) {
  return new Promise((resolve) => execFile("bash", [AGENT], {
    env: { PATH: process.env.PATH, HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent", COLLECT_NET: "0",
           STATE_DIR: tmp(), ONCE: "1", ...env }, timeout: 30000,
  }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: stdout + stderr })));
}

test("the agent pushes to an HTTPS hub through an authenticating proxy", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const dir = tmp();
  const tls = certFor(dir, "hub.test");
  const front = await tlsFront(tls, hub.port);
  const proxy = await connectProxy(() => front.port);   // the proxy resolves hub.test
  try {
    const local = fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8");
    const creds = path.join(dir, "creds.env");
    fs.writeFileSync(creds, local.replace(/^HUB_URL=.*$/m, `HUB_URL=https://hub.test:${front.port}`));
    const r = await agentOnce({
      CREDENTIALS_FILE: creds, HUB_CA_FILE: tls.ca, HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}`,
      HUB_HEADERS: "CF-Access-Client-Id: abc.access; CF-Access-Client-Secret: s3cr3t-token",
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(proxy.log.some((l) => l.startsWith(`CONNECT hub.test:${front.port} Basic `)), proxy.log.join("\n"));
    assert.strictEqual(front.seen[0]["cf-access-client-id"], "abc.access");
    assert.strictEqual(front.seen[0]["cf-access-client-secret"], "s3cr3t-token");
    assert.ok(!r.out.includes("pw@") && !r.out.includes("s3cr3t-token"), "no credentials in the agent's output");
    const cookie = cookieFrom(await login(hub.port));
    const d = JSON.parse((await request(hub.port, { path: "/data.json", headers: { cookie } })).body);
    assert.ok(d.host.name.length > 0, "the push landed");
  } finally { proxy.close(); front.close(); await hub.stop(); }
});

test("a wrong proxy password or an untrusted certificate fails the push", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const dir = tmp();
  const tls = certFor(dir, "hub.test");
  const front = await tlsFront(tls, hub.port);
  const proxy = await connectProxy(() => front.port);
  try {
    const creds = path.join(dir, "creds.env");
    fs.writeFileSync(creds, fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8")
      .replace(/^HUB_URL=.*$/m, `HUB_URL=https://hub.test:${front.port}`));
    const wrongPw = await agentOnce({ CREDENTIALS_FILE: creds, HUB_CA_FILE: tls.ca, HTTPS_PROXY: `http://user:nope@127.0.0.1:${proxy.port}` });
    assert.notStrictEqual(wrongPw.code, 0);
    assert.match(wrongPw.out, /status=000/);
    const noCa = await agentOnce({ CREDENTIALS_FILE: creds, HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}` });
    assert.notStrictEqual(noCa.code, 0, "a self-signed hub needs HUB_CA_FILE");
  } finally { proxy.close(); front.close(); await hub.stop(); }
});

test("the hub host's own agent never goes through the proxy", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const proxy = await connectProxy(() => 9);
  try {
    const r = await agentOnce({
      CREDENTIALS_FILE: path.join(hub.dataDir, "local-agent.env"),
      HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://user:pw@127.0.0.1:${proxy.port}`,
      http_proxy: `http://user:pw@127.0.0.1:${proxy.port}`, NO_PROXY: "example.org",
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(proxy.log, [], "127.0.0.1 is always in NO_PROXY");
  } finally { proxy.close(); await hub.stop(); }
});
