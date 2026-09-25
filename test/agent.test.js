// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("ONCE=1 writes one snapshot of this host and exits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  const out = path.join(dir, "data.json");
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, ONCE: "1", DISKS: "/", DOCKER_SOCK: "/nonexistent", STATE_DIR: dir },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /^servitals agent: .*INTERVAL=60s/m);
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(d.host.name.length > 0);
  assert.ok(d.mem.total > 0);
  assert.ok(d.cpu.cores >= 1);
  assert.strictEqual(d.disks[0].mount, "/");
  assert.strictEqual(d.disks[0].mounted, true);
  assert.deepStrictEqual(d.docker, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("COLLECT_<GROUP>=0 turns a group off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  const out = path.join(dir, "data.json");
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0" },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(d.docker, null);
  assert.strictEqual(d.temp, null);
  assert.strictEqual(d.net, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
