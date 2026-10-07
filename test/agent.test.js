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
  assert.match(r.stdout.toString(), /event=agent\.start .*interval=60 .*mode=file/);
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
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0",
           COLLECT_PROCESSES: "0", COLLECT_UBUNTU: "0" },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(d.docker, null);
  assert.strictEqual(d.temp, null);
  assert.strictEqual(d.net, null);
  assert.strictEqual(d.pressure, null);
  assert.strictEqual(d.disks, null);
  assert.strictEqual(d.io, null, "io follows COLLECT_DISKS");
  assert.strictEqual(d.processes, null);
  assert.strictEqual(d.ubuntu, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a host that denies the cpu and memory files still reports what it can (a phone under Termux)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-root-"));
  for (const [f, text] of Object.entries({ "etc/hostname": "phone\n", "proc/uptime": "100.0 50.0\n",
    "proc/1/mountinfo": "25 1 8:2 / / rw - ext4 /dev/root rw\n" })) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  const out = path.join(dir, "data.json");
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: root, OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/", COLLECT_DOCKER: "0" },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(d.host.name, "phone");
  assert.strictEqual(d.cpu, null);
  assert.strictEqual(d.mem, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
