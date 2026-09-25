// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFile } = require("node:child_process");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");

const AGENT = path.join(__dirname, "..", "agent", "collect.sh");
const LIB = path.join(__dirname, "..", "agent", "lib");
const SECRET = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-push-"));

function agentEnv(extra) {
  return { PATH: process.env.PATH, HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent",
           COLLECT_NET: "0", STATE_DIR: tmp(), ...extra };
}
async function snapshotTs(hub, cookie) {
  const r = await request(hub.port, { path: "/data.json", headers: { cookie } });
  return r.status === 200 ? JSON.parse(r.body).ts : 0;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(250);
  }
}

test("bash HMAC matches the protocol vectors", () => {
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const r = spawnSync("bash", ["-c", '. "$AGENT_LIB/hmac.sh"; hmac_init "$K"; hmac_hex "$M1"; hmac_hex "$M2"; hmac_hex "$M3"'], {
    env: {
      PATH: process.env.PATH, AGENT_LIB: LIB, K: SECRET,
      M1: `POST\n/api/v1/agent/push\n1790000000123\n${sha('{"schema":1,"ts":1790000000000,"host":{"name":"nas","os":"linux"}}')}`,
      M2: `GET\n/api/v1/agent/wait\n1790000000456\n${sha("")}`,
      M3: `reply\n1790000000123\n${sha('{"ok":true}')}`,
    },
    encoding: "utf8",
  });
  assert.deepStrictEqual(r.stdout.trim().split("\n"), [
    "a2ca87da11ec97e2133ebdae553a888ae899fe9ea32fc4798a626b3eb3331f03",
    "194b6dc9c936d5c7b8c8802d22836053af2cc8ef63e93d497f09506bd3ba9293",
    "11e9e5a365260ee327629ca9ada7e6afeeb357ad09b9f7810f1052ba9da0dc57",
  ]);
});

test("credentials are parsed, never sourced", () => {
  const dir = tmp();
  const marker = path.join(dir, "pwned");
  const f = path.join(dir, "creds.env");
  fs.writeFileSync(f, `# local agent\r\nHUB_URL=http://127.0.0.1:1/\r\nNODE_ID=abcdefghijkl\r\n` +
    `NODE_SECRET=${"ab".repeat(32)}\r\nEVIL=$(touch ${marker})\r\n`);
  const run = (file) => spawnSync("bash", ["-c", '. "$AGENT_LIB/api.sh"; load_credentials "$F" && echo "$HUB_URL $NODE_ID"'],
    { env: { PATH: process.env.PATH, AGENT_LIB: LIB, F: file }, encoding: "utf8" });
  assert.strictEqual(run(f).stdout.trim(), "http://127.0.0.1:1 abcdefghijkl");
  assert.ok(!fs.existsSync(marker), "nothing in the file is executed");
  fs.writeFileSync(f, "HUB_URL=http://x\nNODE_ID=abcdefghijkl\nNODE_SECRET=short\n");
  assert.notStrictEqual(run(f).status, 0, "a malformed secret is refused");
  assert.notStrictEqual(run(path.join(dir, "missing")).status, 0);
});

test("ONCE=1 pushes one snapshot that the hub serves", async () => {
  const hub = await startHub();
  try {
    const r = spawnSync("bash", [AGENT], {
      env: agentEnv({ ONCE: "1", CREDENTIALS_FILE: path.join(hub.dataDir, "local-agent.env") }),
      encoding: "utf8", timeout: 30000,
    });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /event=agent\.start .*mode=push/);
    const cookie = cookieFrom(await login(hub.port));
    const d = JSON.parse((await request(hub.port, { path: "/data.json", headers: { cookie } })).body);
    assert.ok(d.host.name.length > 0);
    assert.strictEqual(d.disks[0].mounted, true);
    assert.strictEqual(d.interval, 60);
  } finally { await hub.stop(); }
});

test("a wrong secret fails with bad_signature and is never printed", async () => {
  const hub = await startHub();
  try {
    const real = fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8");
    const wrong = "cd".repeat(32);
    const f = path.join(tmp(), "creds.env");
    fs.writeFileSync(f, real.replace(/^NODE_SECRET=.*$/m, `NODE_SECRET=${wrong}`));
    const r = spawnSync("bash", [AGENT], { env: agentEnv({ ONCE: "1", CREDENTIALS_FILE: f }), encoding: "utf8", timeout: 30000 });
    const out = r.stdout + r.stderr;
    assert.notStrictEqual(r.status, 0);
    assert.match(out, /event=agent\.push_failed status=401 error=bad_signature/);
    assert.ok(!out.includes(wrong) && !out.includes(/^NODE_SECRET=(.*)$/m.exec(real)[1]));
  } finally { await hub.stop(); }
});

test("a reply with a bad signature is refused", async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-servitals-sig": "0".repeat(64) });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const f = path.join(tmp(), "creds.env");
  fs.writeFileSync(f, `HUB_URL=http://127.0.0.1:${srv.address().port}\nNODE_ID=abcdefghijkl\nNODE_SECRET=${SECRET}\n`);
  try {
    const result = await new Promise((resolve) => execFile("bash", [AGENT],
      { env: agentEnv({ ONCE: "1", CREDENTIALS_FILE: f }), timeout: 30000 },
      (e, stdout) => resolve({ code: e ? e.code : 0, stdout })));
    assert.strictEqual(result.code, 1);
    assert.match(result.stdout, /status=bad_reply_signature/);
  } finally { srv.close(); }
});

function startAgent(credFile, extra = {}) {
  const child = spawn("bash", [AGENT], {
    env: agentEnv({ INTERVAL: "3600", CREDENTIALS_FILE: credFile, ...extra }),
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { logs: () => out, stop: () => { try { process.kill(-child.pid, "SIGTERM"); } catch (_) {} } };
}

test("the hub wakes a running agent", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const agent = startAgent(path.join(hub.dataDir, "local-agent.env"));
  try {
    const cookie = cookieFrom(await login(hub.port));
    const first = await until(() => snapshotTs(hub, cookie), 15000, "the first push");
    await sleep(5500);   // past the 5 s push limit
    await until(async () => JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/refresh")).body).woke, 5000, "a wake");
    await until(async () => (await snapshotTs(hub, cookie)) > first, 8000, "a newer snapshot");
  } catch (e) { e.message += "\nagent log:\n" + agent.logs(); throw e; }
  finally { agent.stop(); await hub.stop(); }
});

test("the agent reconnects after a hub restart", { timeout: 90000 }, async () => {
  const dir = tmp();
  const a = await startHub({}, { dataDir: dir });
  const agent = startAgent(path.join(dir, "local-agent.env"));
  let b;
  let aStopped = false;
  try {
    const cookieA = cookieFrom(await login(a.port));
    const first = await until(() => snapshotTs(a, cookieA), 15000, "the first push");
    await a.stop();
    aStopped = true;
    b = await startHub({}, { dataDir: dir, port: a.port });
    const cookie = cookieFrom(await login(b.port));
    assert.strictEqual(await snapshotTs(b, cookie), first, "last snapshot served at once after the restart");
    await sleep(5500);
    await until(async () => JSON.parse((await ctlPost(b.port, cookie, "/__ctl/refresh")).body).woke, 30000, "the agent to reconnect");
    await until(async () => (await snapshotTs(b, cookie)) > first, 8000, "a newer snapshot");
  } catch (e) { e.message += "\nagent log:\n" + agent.logs(); throw e; }
  finally {
    agent.stop();
    if (!aStopped) await a.stop();   // a failure before the restart must not leave hub A running
    if (b) await b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a push inside the hub's 5 s limit waits it out instead of failing", { timeout: 60000 }, async () => {
  const hub = await startHub();
  try {
    const env = agentEnv({ ONCE: "1", CREDENTIALS_FILE: path.join(hub.dataDir, "local-agent.env") });
    const run = () => spawnSync("bash", [AGENT], { env: { ...env, STATE_DIR: tmp() }, encoding: "utf8", timeout: 30000 });
    assert.strictEqual(run().status, 0);
    const second = run();   // e.g. the agent restarted right after a push
    assert.strictEqual(second.status, 0, second.stdout + second.stderr);
    assert.doesNotMatch(second.stdout, /push_failed/);
  } finally { await hub.stop(); }
});
