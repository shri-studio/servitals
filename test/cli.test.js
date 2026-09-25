// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
