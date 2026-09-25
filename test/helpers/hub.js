// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
// Start a real gateway (hub/server.js) as a child process for tests.
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER = path.join(__dirname, "..", "..", "hub", "server.js");
const DEFAULT_PASS = "correct horse battery";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok " + req.url);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(port, logs) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request(port, { path: "/__auth/health" });
      if (r.status === 200) return;
    } catch (_) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not become healthy:\n" + logs());
}

function baseEnv(port, dataDir, upstreamPort) {
  return {
    PATH: process.env.PATH,
    PORT: String(port),
    DATA_DIR: dataDir,
    UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    AUTH_USER: "admin",
    AUTH_PASS: DEFAULT_PASS,
    LOG_LEVEL: "debug",
  };
}

async function startHub(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));
  const upstream = await startUpstream();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...baseEnv(port, dataDir, upstream.address().port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const logs = () => output;
  try {
    await waitForHealth(port, logs);
  } catch (e) {
    child.kill("SIGKILL");
    upstream.close();
    throw e;
  }
  return {
    port,
    dataDir,
    logs,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      upstream.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Run a gateway that is expected to exit on its own (bad configuration).
async function runHubUntilExit(env = {}, timeoutMs = 5000) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...baseEnv(port, dataDir, 9), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
    child.once("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return { code, logs: output };
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

async function login(port, { user = "admin", pass = DEFAULT_PASS, headers = {}, origin } = {}) {
  const body = formBody({ username: user, password: pass });
  const h = {
    "content-type": "application/x-www-form-urlencoded",
    "content-length": Buffer.byteLength(body),
    ...headers,
  };
  if (origin !== null) h.origin = origin || `http://127.0.0.1:${port}`;
  return request(port, { method: "POST", path: "/__auth/login", headers: h, body });
}

function cookieFrom(res) {
  const set = res.headers["set-cookie"] || [];
  for (const c of set) {
    const m = /^sv_session=([^;]*)/.exec(c);
    if (m && m[1]) return `sv_session=${m[1]}`;
  }
  return null;
}

// POST to a /__ctl route as the logged-in browser would (session + same Origin)
function ctlPost(port, cookie, p, body) {
  const headers = { cookie, origin: `http://127.0.0.1:${port}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return request(port, { method: "POST", path: p, headers, body });
}

module.exports = { startHub, runHubUntilExit, request, login, cookieFrom, formBody, DEFAULT_PASS, ctlPost };
