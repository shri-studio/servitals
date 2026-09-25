// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const P = path.join(__dirname, "..", "packaging");
const read = (rel) => fs.readFileSync(path.join(P, rel), "utf8");
const lines = (text) => text.split("\n").map((l) => l.trim());

// spec section 13.2, verbatim
const HARDENING = [
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=read-only", "PrivateTmp=yes",
  "ProtectKernelTunables=yes", "ProtectControlGroups=yes", "RestrictSUIDSGID=yes",
  "LockPersonality=yes", "Restart=on-failure",
];

for (const [unit, user, state] of [["servitals.service", "_servitals", "servitals"],
                                   ["servitals-agent.service", "_servitals-agent", "servitals-agent"]]) {
  test(`${unit} carries the hardening set`, () => {
    const l = lines(read(`systemd/${unit}`));
    for (const want of [...HARDENING, `User=${user}`, `StateDirectory=${state}`]) {
      assert.ok(l.includes(want), `${unit}: missing ${want}`);
    }
    assert.ok(!l.some((x) => x.startsWith("MemoryDenyWriteExecute")), "left off for Node's JIT");
  });
}

test("the hub unit may write only its state directory", () => {
  assert.ok(lines(read("systemd/servitals.service")).includes("ReadWritePaths=/var/lib/servitals"));
});

test("the agent unit waits for credentials and never loads them into its environment", () => {
  const l = lines(read("systemd/servitals-agent.service"));
  assert.ok(l.includes("ConditionPathExists=/etc/servitals/agent-credentials.env"));
  assert.ok(!l.some((x) => x.startsWith("EnvironmentFile=") && x.includes("credentials")));
});

test("sysusers files declare the two system users", () => {
  assert.match(read("sysusers/servitals.conf"), /^u _servitals - "servitals hub" \/var\/lib\/servitals$/m);
  assert.match(read("sysusers/servitals-agent.conf"), /^u _servitals-agent - "servitals agent" \/var\/lib\/servitals-agent$/m);
});

test("default env files", () => {
  assert.match(read("etc/hub.env"), /^PORT=20002$/m);
  assert.match(read("etc/hub.env"), /^# AUTH_PASS_HASH=/m);
  assert.match(read("etc/agent.env"), /^INTERVAL=60$/m);
});

test("install-local.sh parses", () => {
  const r = spawnSync("bash", ["-n", path.join(P, "install-local.sh")], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
});
