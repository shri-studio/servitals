// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LIB = path.join(__dirname, "..", "agent", "lib");

// A fake host tree: { "relative/path": "contents" }
function fakeHost(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-host-"));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (text !== null) fs.writeFileSync(f, text);
  }
  return root;
}

const BASE = {
  "etc/hostname": "fixture-host\n",
  "etc/os-release": 'PRETTY_NAME="Fixture Linux 1.0"\n',
  "proc/sys/kernel/osrelease": "6.1.0-test\n",
  "proc/sys/kernel/hostname": "container-id\n",
  "proc/uptime": "12345.67 999.00\n",
  "proc/loadavg": "0.50 0.40 0.30 1/100 1234\n",
  "proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\nintr 1\n",
  "proc/meminfo": [
    "MemTotal:       1000 kB", "MemFree:         100 kB", "MemAvailable:    600 kB",
    "Buffers:          50 kB", "Cached:          150 kB", "SwapCached:        0 kB",
    "SwapTotal:       200 kB", "SwapFree:        150 kB", "SReclaimable:     20 kB", "",
  ].join("\n"),
  "proc/1/mountinfo": [
    "25 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
    "36 25 8:17 / /srv rw,relatime shared:2 - ext4 /dev/sdb1 rw", "",
  ].join("\n"),
  "sys/class/hwmon/hwmon0/name": "coretemp\n",
  "sys/class/hwmon/hwmon0/temp1_input": "46000\n",
  "sys/class/hwmon/hwmon0/temp1_label": "Package id 0\n",
  "sys/class/hwmon/hwmon0/temp2_input": "51000\n",
  "sys/class/hwmon/hwmon0/temp2_label": "Core 0\n",
  "srv/data.txt": "x",
};

function runGroup(host, script, env = {}) {
  const state = env.STATE || fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  return spawnSync("bash", ["-c", `set -uo pipefail; for f in "$AGENT_LIB"/*.sh; do . "$f"; done; ${script}`], {
    env: { PATH: process.env.PATH, AGENT_LIB: LIB, HOST: host, STATE: state, NCPU: "2",
           DISKS: "/", IFACE_ENV: "", VNSTAT_DB: path.join(host, "var/lib/vnstat"), ...env },
    encoding: "utf8", timeout: 30000,
  });
}
const json = (r) => { assert.strictEqual(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test("host_json reads the host's files, not the UTS namespace", () => {
  assert.deepStrictEqual(json(runGroup(fakeHost(BASE), "host_json")),
    { name: "fixture-host", distro: "Fixture Linux 1.0", kernel: "6.1.0-test", uptime: 12345 });
});

test("mem_json in bytes", () => {
  assert.deepStrictEqual(json(runGroup(fakeHost(BASE), "mem_json")), {
    total: 1024000, used: 409600, available: 614400, free: 102400,
    cache: 225280, swapTotal: 204800, swapUsed: 51200,
  });
});

test("cpu_json is 0 on the first tick and a delta afterwards", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  assert.deepStrictEqual(json(runGroup(host, "cpu_json", { STATE: state })),
    { usage: 0, cores: 2, per: [0, 0], load: [0.5, 0.4, 0.3] });
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1600 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\ncpu1 100 0 100 800 0 0 0 0 0 0\n");
  const second = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(second.usage, 20);
  assert.deepStrictEqual(second.per, [20, 20]);
});

test("temp_json picks the package sensor", () => {
  const t = json(runGroup(fakeHost(BASE), "temp_json"));
  assert.strictEqual(t.package, 46);
  assert.strictEqual(t.max, 51);
  assert.strictEqual(t.sensors.length, 2);
});

test("disks_json reports each DISKS entry with its mountinfo source", () => {
  const d = json(runGroup(fakeHost(BASE), "disks_json", { DISKS: "/, /srv" }));
  assert.deepStrictEqual(d.map((x) => [x.mount, x.source, x.fstype]),
    [["/", "/dev/sda2", "ext4"], ["/srv", "/dev/sdb1", "ext4"]]);
  assert.ok(d[0].size > 0 && d[0].pct >= 0 && d[0].pct <= 100);
});

test("net_json without an interface is null", () => {
  assert.strictEqual(runGroup(fakeHost(BASE), 'net_json ""').stdout.trim(), "null");
});

module.exports = { fakeHost, runGroup, BASE, json };
