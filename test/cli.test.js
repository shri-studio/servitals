// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyPassword } = require("../hub/lib/password");

const BIN = path.join(__dirname, "..", "bin");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-cli-"));
const run = (cmd, args, env = {}) => spawnSync("bash", [path.join(BIN, cmd), ...args], {
  env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 30000,
});

test("servitals-agent test prints one snapshot and sends nothing", () => {
  const r = run("servitals-agent", ["test"], {
    AGENT_ENV: "/nonexistent", HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent",
    CREDENTIALS_FILE: "/nonexistent",
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.ok(d.host.name.length > 0);
  assert.strictEqual(d.disks[0].mount, "/");
});

for (const [cmd, unit] of [["servitals-agent", "servitals-agent.service"], ["servitals-ctl", "servitals.service"]]) {
  test(`${cmd} docker enable/disable manages a drop-in`, () => {
    const root = tmp();
    const calls = path.join(root, "calls");
    const stub = path.join(root, "systemctl");
    fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 });
    const env = { DROPIN_ROOT: root, SYSTEMCTL: stub, GETENT: "true" };
    const on = run(cmd, ["docker", "enable"], env);
    assert.strictEqual(on.status, 0, on.stderr);
    assert.match(on.stderr, /root/i, "warns that the docker group is root-equivalent");
    const dropin = path.join(root, `${unit}.d`, "docker.conf");
    assert.match(fs.readFileSync(dropin, "utf8"), /^\[Service\]\nSupplementaryGroups=docker$/m);
    assert.strictEqual(run(cmd, ["docker", "disable"], env).status, 0);
    assert.ok(!fs.existsSync(dropin));
    assert.deepStrictEqual(fs.readFileSync(calls, "utf8").trim().split("\n"),
      ["daemon-reload", `try-restart ${unit}`, "daemon-reload", `try-restart ${unit}`]);
    assert.notStrictEqual(run(cmd, ["docker", "sideways"], env).status, 0);
  });
}

test("servitals-ctl uses STATE_DIR", () => {
  const state = tmp();
  const r = run("servitals-ctl", ["whitelist", "10.9.8.7"], { STATE_DIR: state });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(state, "whitelist.txt"), "utf8"), /^10\.9\.8\.7$/m);
});

function dockerInstall() {
  const d = tmp();
  fs.mkdirSync(path.join(d, "www"));
  fs.mkdirSync(path.join(d, "data"));
  fs.writeFileSync(path.join(d, ".env"), [
    "# old Docker install", 'AUTH_USER="rishabha"', "AUTH_PASS='s3cret pass!'", "AUTH_PASS_HASH=",
    "MAX_FAILS=5", "SITE_NAME=lab", "DISKS=/,/srv", "NET_IFACE=eno1", "CTL_LAN_ONLY=0", "PORT=20002", "",
  ].join("\r\n"));
  fs.writeFileSync(path.join(d, "www", "config.json"), '{"title":"old"}\n');
  fs.writeFileSync(path.join(d, "data", "whitelist.txt"), "10.1.2.3\n");
  fs.writeFileSync(path.join(d, "data", "bans.json"), "{}\n");
  return d;
}
function nativeInstall() {
  const state = tmp();
  const etc = tmp();
  for (const f of ["hub.env", "agent.env"]) {
    fs.copyFileSync(path.join(__dirname, "..", "packaging", "etc", f), path.join(etc, f));
  }
  return { state, etc };
}
const envValue = (file, key) => (new RegExp(`^${key}=(.*)$`, "m").exec(fs.readFileSync(file, "utf8")) || [])[1];

test("import-docker brings over settings, login and disks", async () => {
  const old = dockerInstall();
  const { state, etc } = nativeInstall();
  const r = run("servitals-ctl", ["import-docker", old], { STATE_DIR: state, ETC_DIR: etc });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes("s3cret"), "the password is never printed");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")).title, "old");
  assert.strictEqual(fs.readFileSync(path.join(state, "whitelist.txt"), "utf8"), "10.1.2.3\n");
  assert.ok(fs.existsSync(path.join(state, "bans.json")));
  const hub = path.join(etc, "hub.env");
  assert.strictEqual(envValue(hub, "AUTH_USER"), "rishabha");
  assert.strictEqual(envValue(hub, "MAX_FAILS"), "5");
  assert.strictEqual(envValue(hub, "SITE_NAME"), "lab");
  assert.strictEqual(envValue(hub, "PORT"), "20002", "the native port is not taken from Docker");
  assert.strictEqual(envValue(hub, "CTL_LAN_ONLY"), "1", "container controls stay LAN-only");
  assert.match(r.stdout, /CTL_LAN_ONLY/);
  const hash = envValue(hub, "AUTH_PASS_HASH");
  assert.match(hash, /^scrypt:/);
  assert.strictEqual(await verifyPassword("s3cret pass!", hash), true);
  assert.ok(!fs.readFileSync(hub, "utf8").includes("s3cret"));
  assert.strictEqual(envValue(path.join(etc, "agent.env"), "DISKS"), "/,/srv");
  assert.strictEqual(envValue(path.join(etc, "agent.env"), "NET_IFACE"), "eno1");
});

test("import-docker prefers data/config.json and keeps an existing hash", () => {
  const old = dockerInstall();
  fs.writeFileSync(path.join(old, "data", "config.json"), '{"title":"newer"}\n');
  const env = fs.readFileSync(path.join(old, ".env"), "utf8")
    .replace("AUTH_PASS_HASH=", "AUTH_PASS_HASH='scrypt:32768:8:1:c2FsdA==:aGFzaA=='");
  fs.writeFileSync(path.join(old, ".env"), env);
  const { state, etc } = nativeInstall();
  assert.strictEqual(run("servitals-ctl", ["import-docker", old], { STATE_DIR: state, ETC_DIR: etc }).status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")).title, "newer");
  assert.strictEqual(envValue(path.join(etc, "hub.env"), "AUTH_PASS_HASH"), "scrypt:32768:8:1:c2FsdA==:aGFzaA==");
});

test("import-docker refuses a directory that is not a Docker install", () => {
  const { state, etc } = nativeInstall();
  const r = run("servitals-ctl", ["import-docker", tmp()], { STATE_DIR: state, ETC_DIR: etc });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /not a servitals Docker install/);
});

test("servitals-ctl passwd writes admin.json and ends sessions", async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, "initial-password"), "old\n");
  const first = spawnSync("bash", [path.join(BIN, "servitals-ctl"), "passwd", "--user", "owner"],
    { env: { PATH: process.env.PATH, STATE_DIR: state }, input: "first-pass-1\n", encoding: "utf8" });
  assert.strictEqual(first.status, 0, first.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(state, "admin.json"), "utf8"));
  assert.strictEqual(a.user, "owner");
  assert.strictEqual(a.gen, 1);
  assert.strictEqual(await verifyPassword("first-pass-1", a.hash), true);
  assert.strictEqual(fs.statSync(path.join(state, "admin.json")).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(state, "initial-password")), "the first password is gone");
  const second = spawnSync("bash", [path.join(BIN, "servitals-ctl"), "passwd"],
    { env: { PATH: process.env.PATH, STATE_DIR: state }, input: "second-pass-2\n", encoding: "utf8" });
  assert.strictEqual(second.status, 0, second.stderr);
  const b = JSON.parse(fs.readFileSync(path.join(state, "admin.json"), "utf8"));
  assert.deepStrictEqual([b.user, b.gen], ["owner", 2], "keeps the name, raises the generation");
  for (const [args, input] of [[["passwd", "--user", "bad name"], "long-enough-1\n"], [["passwd"], "short\n"]]) {
    const r = spawnSync("bash", [path.join(BIN, "servitals-ctl"), ...args],
      { env: { PATH: process.env.PATH, STATE_DIR: state }, input, encoding: "utf8" });
    assert.notStrictEqual(r.status, 0, args.join(" "));
  }
});

test("node rename and revoke", () => {
  const state = tmp();
  const add = run("servitals-ctl", ["node", "add", "old name"], { STATE_DIR: state, ETC_DIR: "/nonexistent" });
  const id = /node ([a-z2-7]{12})/.exec(add.stdout)[1];
  assert.strictEqual(run("servitals-ctl", ["node", "rename", id, "new name"], { STATE_DIR: state }).status, 0);
  assert.match(run("servitals-ctl", ["node", "list"], { STATE_DIR: state }).stdout, /new name/);
  assert.strictEqual(run("servitals-ctl", ["node", "revoke", id], { STATE_DIR: state }).status, 0);
  assert.doesNotMatch(run("servitals-ctl", ["node", "list"], { STATE_DIR: state }).stdout, new RegExp(id));
  assert.strictEqual(fs.statSync(path.join(state, "nodes.json")).mode & 0o777, 0o600);
  assert.notStrictEqual(run("servitals-ctl", ["node", "add", ""], { STATE_DIR: state }).status, 0);
});

test("node add takes tags with --tag", () => {
  const state = tmp();
  const r = run("servitals-ctl", ["node", "add", "nas", "--tag", "home", "--tag", "lab"], { STATE_DIR: state, ETC_DIR: "/nonexistent" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run("servitals-ctl", ["node", "list"], { STATE_DIR: state }).stdout, / nas +remote +home,lab /);
  assert.notStrictEqual(run("servitals-ctl", ["node", "add", "x", "--tag"], { STATE_DIR: state }).status, 0);
  assert.notStrictEqual(run("servitals-ctl", ["node", "add", "x", "--tag", "Bad Tag"], { STATE_DIR: state }).status, 0);
});

const { startHub, request, login, cookieFrom } = require("./helpers/hub");

function joinEnv(extra = {}) {
  return { AGENT_ENV: "/nonexistent", HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent", COLLECT_NET: "0",
           SYSTEMCTL: "true", ...extra };
}
function addNodeWithCtl(hub, name) {
  const etc = tmp();
  fs.writeFileSync(path.join(etc, "hub.env"), `PUBLIC_URL=http://127.0.0.1:${hub.port}/\n`);
  const r = run("servitals-ctl", ["node", "add", name], { STATE_DIR: hub.dataDir, ETC_DIR: etc });
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /servitals-agent join (\S+) ([a-z2-7]{12}):([0-9a-f]{64})/.exec(r.stdout);
  assert.ok(m, r.stdout);
  return { url: m[1], id: m[2], secret: m[3], out: r.stdout };
}

test("node add prints a join command; join tests the push and saves the credentials", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    assert.strictEqual(n.url, `http://127.0.0.1:${hub.port}`, "PUBLIC_URL without its trailing slash");
    const creds = path.join(tmp(), "agent-credentials.env");
    const r = run("servitals-agent", ["join", "--no-start", n.url, `${n.id}:${n.secret}`], joinEnv({ CREDENTIALS_FILE: creds }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok$/m);
    assert.ok(!r.stdout.includes(n.secret) && !r.stderr.includes(n.secret), "the secret is not echoed");
    assert.strictEqual(fs.statSync(creds).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(creds, "utf8"), new RegExp(`^NODE_ID=${n.id}$`, "m"));
    const cookie = cookieFrom(await login(hub.port));
    const list = JSON.parse((await request(hub.port, { path: "/__ctl/nodes", headers: { cookie } })).body);
    assert.strictEqual(list.find((x) => x.id === n.id).status, "online", "the test push landed");
    const listed = run("servitals-ctl", ["node", "list"], { STATE_DIR: hub.dataDir });
    assert.match(listed.stdout, new RegExp(`^${n.id} +nas +remote +- +\\d{4}-`, "m"));
  } finally { await hub.stop(); }
});

test("join explains what went wrong and saves nothing", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    const creds = path.join(tmp(), "agent-credentials.env");
    const cases = [
      [[n.url, `${n.id}:${"ab".repeat(32)}`], /^bad secret: copy the whole join string again$/m],
      [[n.url, `aaaaaaaaaaaa:${n.secret}`], /^bad secret: the hub does not know this node id/m],
      [["http://127.0.0.1:9", `${n.id}:${n.secret}`], /^unreachable: /m],
    ];
    for (const [args, want] of cases) {
      const r = run("servitals-agent", ["join", "--no-start", ...args], joinEnv({ CREDENTIALS_FILE: creds }));
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stdout, want, args.join(" "));
      assert.doesNotMatch(r.stderr, /No such file/, "no shell noise next to the answer");
      assert.ok(!fs.existsSync(creds));
    }
    const bad = run("servitals-agent", ["join", n.url, "nonsense"], joinEnv({ CREDENTIALS_FILE: creds }));
    assert.match(bad.stderr, /join string/);
  } finally { await hub.stop(); }
});

test("status shows the hub, the node and the last push", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    const dir = tmp();
    const creds = path.join(dir, "credentials.env");
    fs.writeFileSync(creds, `HUB_URL=${n.url}\nNODE_ID=${n.id}\nNODE_SECRET=${n.secret}\n`);
    fs.writeFileSync(path.join(dir, "last-push"), `${Math.floor(Date.now() / 1000)} 200 -\n`);
    const r = run("servitals-agent", ["status"], { CREDENTIALS_FILE: creds, STATE_DIR: dir, SYSTEMCTL: "true" });
    assert.match(r.stdout, new RegExp(`^hub: +${n.url.replace(/[.]/g, "\\.")}$`, "m"));
    assert.match(r.stdout, new RegExp(`^node: +${n.id}$`, "m"));
    assert.match(r.stdout, /^last push: \d{4}-\d\d-\d\d .* ok$/m);
    assert.ok(!r.stdout.includes(n.secret));
    // the service's files are root-only: say so instead of "not paired" (root reads them anyway)
    if (process.getuid() !== 0) {
      fs.chmodSync(creds, 0o000);
      const lockedState = tmp();
      fs.chmodSync(lockedState, 0o600);
      const locked = run("servitals-agent", ["status"], { CREDENTIALS_FILE: creds, STATE_DIR: lockedState, SYSTEMCTL: "true" });
      fs.chmodSync(lockedState, 0o700);
      assert.match(locked.stdout, /^hub: +\(run with sudo to read /m);
      assert.match(locked.stdout, /^last push: \(run with sudo to read /m);
    }
  } finally { await hub.stop(); }
});

test("join reads agent.env without running it, HUB_HEADERS included", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    const dir = tmp();
    const marker = path.join(dir, "pwned");
    const env = path.join(dir, "agent.env");
    fs.writeFileSync(env, `# agent settings\nHUB_HEADERS=CF-Access-Client-Id: abc.access; CF-Access-Client-Secret: s3cr3t\n` +
      `DISKS=/\nEVIL=$(touch ${marker})\n`);
    const creds = path.join(dir, "creds.env");
    const r = run("servitals-agent", ["join", "--no-start", n.url, `${n.id}:${n.secret}`], joinEnv({ CREDENTIALS_FILE: creds, AGENT_ENV: env }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok$/m);
    assert.ok(!fs.existsSync(marker), "nothing in agent.env is executed");
    assert.ok(!(r.stdout + r.stderr).includes("s3cr3t"));
    const t = run("servitals-agent", ["test"], joinEnv({ AGENT_ENV: env }));
    assert.strictEqual(t.status, 0, t.stderr);
    assert.ok(!fs.existsSync(marker));
  } finally { await hub.stop(); }
});

// servitals-agent link against a test hub: returns the process, its output so far and the code it printed
const { spawn } = require("node:child_process");
const { formBody } = require("./helpers/hub");
function startLink(url, env) {
  const child = spawn("bash", [path.join(BIN, "servitals-agent"), "link", "--no-start", url],
    { env: { PATH: process.env.PATH, ...env } });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { out.stdout += d; });
  child.stderr.on("data", (d) => { out.stderr += d; });
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  const code = (async () => {
    for (let i = 0; i < 100; i++) {
      const m = /enter: +([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out.stdout);
      if (m) return m[1];
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no code printed: " + out.stdout + out.stderr);
  })();
  code.catch(() => {});   // tests that expect no code never await it
  return { child, out, exited, code };
}
async function decideOnPage(hub, code, action) {
  const cookie = cookieFrom(await login(hub.port));
  const body = formBody({ step: "decide", code, action, name: "linked-box", tags: "lab" });
  return request(hub.port, { method: "POST", path: "/link", body, headers: {
    "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), cookie,
    origin: `http://127.0.0.1:${hub.port}` } });
}

test("link: shows a code, waits for approval, saves the credentials and pushes", async () => {
  const hub = await startHub({ LINK_ALLOW_LOOPBACK: "1" });
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    // a proxy for the internet must not catch a link to this machine itself
    const agentEnv = path.join(tmp(), "agent.env");
    fs.writeFileSync(agentEnv, "http_proxy=http://127.0.0.1:9\nHTTPS_PROXY=http://127.0.0.1:9\n");
    const l = startLink(`http://127.0.0.1:${hub.port}/`, joinEnv({ CREDENTIALS_FILE: creds, AGENT_ENV: agentEnv }));
    const code = await l.code;
    assert.match(l.out.stdout, new RegExp(`Open http://127\\.0\\.0\\.1:${hub.port}/link and enter: +${code}`));
    assert.match(l.out.stdout, /Only enter this code on that site/);
    assert.ok(!fs.existsSync(creds), "nothing saved before approval");
    assert.match((await decideOnPage(hub, code, "approve")).body, /Linked "linked-box"/);
    assert.strictEqual(await l.exited, 0, l.out.stdout + l.out.stderr);
    assert.match(l.out.stdout, /^ok$/m, "the test push landed");
    assert.match(l.out.stdout, new RegExp(`Linked as "linked-box" to a\\*\\*\\*n on 127\\.0\\.0\\.1:${hub.port}\\.`));
    assert.strictEqual(fs.statSync(creds).mode & 0o777, 0o600);
    const saved = fs.readFileSync(creds, "utf8");
    const secret = /^NODE_SECRET=([0-9a-f]{64})$/m.exec(saved)[1];
    assert.ok(!l.out.stdout.includes(secret) && !l.out.stderr.includes(secret), "the secret is never printed");
    const id = /^NODE_ID=([a-z2-7]{12})$/m.exec(saved)[1];
    const cookie = cookieFrom(await login(hub.port));
    const list = JSON.parse((await request(hub.port, { path: "/__ctl/nodes", headers: { cookie } })).body);
    assert.strictEqual(list.find((x) => x.id === id).status, "online");
  } finally { await hub.stop(); }
});

test("link: a denied code saves nothing; a plain-http hub elsewhere is refused", async () => {
  const hub = await startHub({ LINK_ALLOW_LOOPBACK: "1" });
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    const l = startLink(`http://127.0.0.1:${hub.port}`, joinEnv({ CREDENTIALS_FILE: creds }));
    await decideOnPage(hub, await l.code, "deny");
    assert.strictEqual(await l.exited, 1);
    assert.match(l.out.stderr, /denied on the hub; nothing was saved/);
    assert.ok(!fs.existsSync(creds));
  } finally { await hub.stop(); }
  for (const url of ["http://hub.example", "http://192.168.1.5:20002", "ftp://hub.example", "https://user:pw@hub.example"]) {
    const r = run("servitals-agent", ["link", url], joinEnv({ CREDENTIALS_FILE: path.join(tmp(), "c.env") }));
    assert.strictEqual(r.status, 1, url);
    assert.match(r.stderr, /https:\/\/ hub address/, url);
  }
  const down = run("servitals-agent", ["link", "https://127.0.0.1:9"], joinEnv({ CREDENTIALS_FILE: path.join(tmp(), "c.env") }));
  assert.match(down.stderr, /^servitals-agent: unreachable: /m);
});

test("link prints what a hostile hub sends without terminal escapes", async () => {
  const http = require("node:http");
  const { signReply } = require("../hub/lib/agentsig");
  let secret = "";
  const ESC = "\u001b";
  const hub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/v1/link/start") {
        secret = JSON.parse(body).secret;
        return send(200, { device_code: "d".repeat(43), user_code: "ABCD-EFGH", expires_in: 60, interval: 1,
                           verify_url: `http://127.0.0.1/${ESC}[2Jlink` });
      }
      if (req.url === "/api/v1/link/poll") {
        return send(200, { node_id: "abcdefghijkm", name: `evil${ESC}[31mname`, account: `${ESC}]0;pwned\u0007acct` });
      }
      // the test push: a correctly signed empty answer
      const reply = "{}", ts = req.headers["x-servitals-ts"];
      return send(200, {}, { "x-servitals-sig": signReply(secret, ts, reply) });
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    const l = startLink(`http://127.0.0.1:${hub.address().port}`, joinEnv({ CREDENTIALS_FILE: creds }));
    assert.strictEqual(await l.exited, 0, l.out.stdout + l.out.stderr);
    assert.ok(!l.out.stdout.includes(ESC) && !l.out.stdout.includes("\u0007"), JSON.stringify(l.out.stdout));
    assert.match(l.out.stdout, /Linked as "evil\[31mname" to \]0;pwnedacct\./);
  } finally { hub.close(); }
});

test("link approved but the test push fails: says which node the hub now lists and saves nothing", async () => {
  const http = require("node:http");
  const hub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/v1/link/start") return send(200, { device_code: "d".repeat(43), user_code: "ABCD-EFGH", expires_in: 60, interval: 1 });
      if (req.url === "/api/v1/link/poll") return send(200, { node_id: "abcdefghijkm", name: "nas", account: "a***n on hub" });
      return send(401, { error: "clock_skew" });
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    const l = startLink(`http://127.0.0.1:${hub.address().port}`, joinEnv({ CREDENTIALS_FILE: creds }));
    assert.strictEqual(await l.exited, 1);
    assert.match(l.out.stdout, /^clock skew: /m);
    assert.match(l.out.stdout, /The hub now lists this server as node abcdefghijkm.*servitals-ctl node revoke abcdefghijkm/s);
    assert.ok(!fs.existsSync(creds));
  } finally { hub.close(); }
});

test("link says so when the address answers with a web page instead of servitals", async () => {
  const http = require("node:http");
  const site = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><p>welcome"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  try {
    // async: the fake site answers from this same process
    const l = startLink(`http://127.0.0.1:${site.address().port}`, joinEnv({ CREDENTIALS_FILE: path.join(tmp(), "c.env") }));
    assert.strictEqual(await l.exited, 1, l.out.stdout + l.out.stderr);
    assert.match(l.out.stderr, /the hub's answer does not look like servitals/);
  } finally { site.close(); }
});

test("unlink removes the credentials, stops the agent and says how to revoke on the hub", () => {
  const dir = tmp();
  const creds = path.join(dir, "agent-credentials.env");
  fs.writeFileSync(creds, `HUB_URL=https://hub.example\nNODE_ID=abcdefghijkm\nNODE_SECRET=${"ab".repeat(32)}\n`, { mode: 0o600 });
  const calls = path.join(dir, "calls");
  const stub = path.join(dir, "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
  const r = run("servitals-agent", ["unlink"], { CREDENTIALS_FILE: creds, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(creds));
  assert.match(fs.readFileSync(calls, "utf8"), /^disable --now servitals-agent\.service$/m);
  assert.match(r.stdout, /servitals-ctl node revoke abcdefghijkm/);
  const again = run("servitals-agent", ["unlink"], { CREDENTIALS_FILE: creds, SYSTEMCTL: stub });
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /not paired/);
});

test("servitals-ctl config check reads ETC_DIR/conf.d and fails on a bad file", () => {
  const etc = tmp();
  fs.mkdirSync(path.join(etc, "conf.d"));
  fs.writeFileSync(path.join(etc, "conf.d", "10-site.json"), JSON.stringify({ settings: { title: "lab" } }));
  let r = run("servitals-ctl", ["config", "check"], { ETC_DIR: etc });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok +10-site\.json$/m);
  fs.writeFileSync(path.join(etc, "conf.d", "20-bad.json"), "{ nope");
  r = run("servitals-ctl", ["config", "check"], { ETC_DIR: etc });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error +20-bad\.json: not valid JSON/m);
  const other = run("servitals-ctl", ["config", "check", path.join(etc, "conf.d")], {});
  assert.strictEqual(other.status, 1, "a directory can be named");
  assert.notStrictEqual(run("servitals-ctl", ["config"], {}).status, 0);
});

test("servitals-ctl node rotate prints new join lines; the hub's own agent is updated in place", () => {
  const state = tmp(), etc = tmp();
  fs.writeFileSync(path.join(etc, "hub.env"), "PUBLIC_URL=https://hub.example\n");
  const node = (args) => JSON.parse(spawnSync(process.execPath, [path.join(__dirname, "..", "hub", "lib", "nodes.js"),
    path.join(state, "nodes.json"), ...args], { encoding: "utf8" }).stdout);
  const nas = node(["add", "nas"]);
  // the hub's own node, as the hub creates it
  const all = JSON.parse(fs.readFileSync(path.join(state, "nodes.json"), "utf8"));
  all.localnodeid2 = { name: "hub", secret: "11".repeat(32), local: true, created: 1 };
  fs.writeFileSync(path.join(state, "nodes.json"), JSON.stringify(all));
  fs.writeFileSync(path.join(etc, "agent-credentials.env"), `HUB_URL=http://127.0.0.1:20002\nNODE_ID=localnodeid2\nNODE_SECRET=${"11".repeat(32)}\n`, { mode: 0o600 });
  const calls = path.join(state, "calls");
  const stub = path.join(state, "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });

  let r = run("servitals-ctl", ["node", "rotate", nas.id], { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /sudo servitals-agent join https:\/\/hub\.example ([a-z2-7]{12}):([0-9a-f]{64})/.exec(r.stdout);
  assert.ok(m && m[1] === nas.id && m[2] !== nas.secret, r.stdout);
  assert.match(r.stdout, /old secret keeps working for 24 hours/);

  r = run("servitals-ctl", ["node", "rotate", "--all"], { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  const creds = fs.readFileSync(path.join(etc, "agent-credentials.env"), "utf8");
  const secret = /^NODE_SECRET=([0-9a-f]{64})$/m.exec(creds)[1];
  assert.notStrictEqual(secret, "11".repeat(32));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, "nodes.json"), "utf8")).localnodeid2.secret, secret);
  assert.strictEqual(fs.statSync(path.join(etc, "agent-credentials.env")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(calls, "utf8"), /^try-restart servitals-agent\.service$/m);
  assert.match(r.stdout, /the hub's own agent was updated/);
  assert.strictEqual((r.stdout.match(/sudo servitals-agent join/g) || []).length, 1, "a join line for the remote node only");
  assert.notStrictEqual(run("servitals-ctl", ["node", "rotate", "aaaaaaaaaaaa"], { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub }).status, 0);
});

test("servitals-ctl rotate session-key: a new key, same owner and mode, the hub restarts, every session ends", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));   // kept across the two hubs
  const hub = await startHub({}, { dataDir });
  const port = hub.port;
  const cookie = cookieFrom(await login(port));
  assert.strictEqual((await request(port, { path: "/__ctl/whoami", headers: { cookie } })).status, 200);
  await hub.stop();
  const key = path.join(dataDir, "secret");
  const before = fs.readFileSync(key, "utf8");
  const calls = path.join(tmp(), "calls");
  const stub = path.join(path.dirname(calls), "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
  const r = run("servitals-ctl", ["rotate", "session-key"], { STATE_DIR: dataDir, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /every session ends/);
  const after = fs.readFileSync(key, "utf8");
  assert.match(after, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(after, before);
  assert.strictEqual(fs.statSync(key).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(calls, "utf8"), /^try-restart servitals\.service$/m);
  const again = await startHub({}, { dataDir, port });
  try {
    assert.strictEqual((await request(port, { path: "/__ctl/whoami", headers: { cookie } })).status, 401, "the old session is gone");
  } finally { await again.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.notStrictEqual(run("servitals-ctl", ["rotate", "vapid"], { STATE_DIR: dataDir }).status, 0);
});
