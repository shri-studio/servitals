// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lines = (text) => text.split("\n").map((l) => l.trim());

// spec section 13.2, plus the tightening from sub-project 3 (systemd-analyze
// security rates both units 2.0 or lower; debian/tests/smoke checks that)
const HARDENING = [
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=read-only", "PrivateTmp=yes",
  "ProtectKernelTunables=yes", "ProtectControlGroups=yes", "RestrictSUIDSGID=yes",
  "LockPersonality=yes", "Restart=on-failure",
  "PrivateDevices=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectClock=yes",
  "ProtectHostname=yes", "RestrictNamespaces=yes", "RestrictRealtime=yes", "CapabilityBoundingSet=",
  "AmbientCapabilities=", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "SystemCallArchitectures=native", "SystemCallFilter=@system-service",
];

for (const [unit, user, state] of [["servitals.service", "_servitals", "servitals"],
                                   ["servitals-agent.service", "_servitals-agent", "servitals-agent"]]) {
  test(`${unit} carries the hardening set`, () => {
    const l = lines(read(`debian/${unit}`));
    for (const want of [...HARDENING, `User=${user}`, `StateDirectory=${state}`]) {
      assert.ok(l.includes(want), `${unit}: missing ${want}`);
    }
  });
}

test("the hub keeps writable code pages for Node's JIT; the bash agent does not need them", () => {
  assert.ok(!lines(read("debian/servitals.service")).some((x) => x.startsWith("MemoryDenyWriteExecute")));
  assert.ok(lines(read("debian/servitals-agent.service")).includes("MemoryDenyWriteExecute=yes"));
});

test("the hub unit may write only its state directory and hides other processes", () => {
  const l = lines(read("debian/servitals.service"));
  for (const want of ["ReadWritePaths=/var/lib/servitals", "ProtectProc=invisible", "ProcSubset=pid"]) {
    assert.ok(l.includes(want), want);
  }
});

test("the agent unit waits for credentials and never loads them into its environment", () => {
  const l = lines(read("debian/servitals-agent.service"));
  assert.ok(l.includes("ConditionPathExists=/etc/servitals/agent-credentials.env"));
  assert.ok(!l.some((x) => x.startsWith("EnvironmentFile=") && x.includes("credentials")));
  assert.ok(!l.some((x) => x.startsWith("ProtectProc") || x.startsWith("ProcSubset")),
    "the agent reads /proc/1/mountinfo and /proc/stat");
});

test("sysusers files declare the two system users", () => {
  assert.match(read("debian/servitals.sysusers"), /^u _servitals - "servitals hub" \/var\/lib\/servitals$/m);
  assert.match(read("debian/servitals-agent.sysusers"), /^u _servitals-agent - "servitals agent" \/var\/lib\/servitals-agent$/m);
});

test("default env files", () => {
  assert.match(read("packaging/etc/hub.env"), /^PORT=20002$/m);
  assert.match(read("packaging/etc/hub.env"), /^# AUTH_PASS_HASH=/m);
  assert.match(read("packaging/etc/agent.env"), /^INTERVAL=60$/m);
});
