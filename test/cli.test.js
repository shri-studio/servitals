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
