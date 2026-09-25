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

test("a stacked mount reports the top of the stack (cifs on autofs)", () => {
  const host = fakeHost({
    ...BASE,
    "proc/1/mountinfo": BASE["proc/1/mountinfo"] +
      "40 25 0:40 / /mnt/share rw,relatime shared:20 - autofs systemd-1 rw,fd=50\n" +
      "41 40 0:50 / /mnt/share rw,relatime shared:21 - cifs //nas/share rw\n",
    "mnt/share/file": "x",
  });
  const d = json(runGroup(host, "disks_json", { DISKS: "/mnt/share" }));
  assert.deepStrictEqual([d[0].fstype, d[0].source, d[0].mounted], ["cifs", "//nas/share", true]);
});

test("DISKS entries that are not mountpoints say so", () => {
  const host = fakeHost({ ...BASE, "mnt/none/file": "x" });
  const d = json(runGroup(host, "disks_json", { DISKS: "/srv,/mnt/none,/mnt/gone" }));
  assert.deepStrictEqual(d.map((x) => [x.mount, x.mounted]), [["/srv", true], ["/mnt/none", false], ["/mnt/gone", false]]);
  assert.deepStrictEqual(Object.keys(d[1]).sort(), ["mount", "mounted"]);
});

test("a hung statvfs is cut off", () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "sv-stub-"));
  // exec, so `timeout` kills the sleeping process itself and the pipe closes
  fs.writeFileSync(path.join(stub, "stat"), "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 });
  const started = Date.now();
  const r = runGroup(fakeHost(BASE), "disks_json", {
    DISKS: "/srv", STAT_TIMEOUT: "1", PATH: `${stub}:${process.env.PATH}`,
  });
  assert.ok(Date.now() - started < 5000, "finished within the timeout, not after 10 s");
  assert.deepStrictEqual(json(r), []);
});


test("a statvfs that ignores SIGTERM is killed", () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "sv-stub-"));
  fs.writeFileSync(path.join(stub, "stat"), "#!/bin/bash\ntrap '' TERM\nsleep 10 & wait\n", { mode: 0o755 });
  const started = Date.now();
  const r = runGroup(fakeHost(BASE), "disks_json", {
    DISKS: "/srv", STAT_TIMEOUT: "1", PATH: `${stub}:${process.env.PATH}`,
  });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.deepStrictEqual(json(r), []);
});

test("a STAT_TIMEOUT that is not a number falls back to 5 s", () => {
  const d = json(runGroup(fakeHost(BASE), "disks_json", { DISKS: "/srv", STAT_TIMEOUT: "soon" }));
  assert.strictEqual(d.length, 1);
});


test("DISKS=auto finds real filesystems and skips system, pseudo and bind mounts", () => {
  const host = fakeHost({
    ...BASE,
    "proc/1/mountinfo": [
      "25 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
      "26 25 0:5 / /dev rw,nosuid shared:2 - devtmpfs udev rw",
      "27 25 0:25 / /run rw,nosuid shared:3 - tmpfs tmpfs rw",
      "28 25 8:1 / /boot/efi rw,relatime shared:4 - vfat /dev/sda1 rw",
      "29 25 7:3 / /snap/core/17 ro,relatime shared:5 - squashfs /dev/loop3 ro",
      "36 25 8:17 / /srv rw,relatime shared:6 - ext4 /dev/sdb1 rw",
      "37 25 8:17 /media /home/me/media rw,relatime shared:6 - ext4 /dev/sdb1 rw",
      "40 25 0:40 / /mnt/share rw,relatime shared:20 - autofs systemd-1 rw,fd=50",
      "41 40 0:50 / /mnt/share rw,relatime shared:21 - cifs //nas/share rw",
      "45 25 8:33 / /mnt/elements rw,relatime shared:22 - fuseblk /dev/sdc1 rw",
      "50 25 0:60 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw",
      "",
    ].join("\n"),
    "mnt/share/f": "x", "mnt/elements/f": "x",
  });
  const d = json(runGroup(host, "disks_json", { DISKS: "auto" }));
  assert.deepStrictEqual(d.map((x) => x.mount), ["/", "/srv", "/mnt/share", "/mnt/elements"]);
});

module.exports = { fakeHost, runGroup, BASE, json };
