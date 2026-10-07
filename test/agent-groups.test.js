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

test("a source that is missing or denied gives null for its group, never an error (Android denies /proc/stat)", () => {
  const bare = { ...BASE };
  delete bare["proc/stat"]; delete bare["proc/meminfo"];
  const host = fakeHost(bare);
  for (const g of ["cpu_json", "mem_json"]) {
    const r = runGroup(host, g);
    assert.strictEqual(r.status, 0, `${g}: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), "null", g);
  }
  // a file that exists but cannot be read (permission denied); root reads everything
  if (process.getuid && process.getuid() !== 0) {
    const denied = fakeHost(BASE);
    for (const f of ["proc/stat", "proc/meminfo"]) fs.chmodSync(path.join(denied, f), 0);
    for (const g of ["cpu_json", "mem_json"]) {
      const r = runGroup(denied, g);
      assert.strictEqual(r.status, 0, `${g}: ${r.stderr}`);
      assert.strictEqual(r.stdout.trim(), "null", g);
    }
  }
  const odd = fakeHost({ ...BASE, "proc/stat": "intr 1\n", "proc/meminfo": "Nothing: 1 kB\n" });
  for (const g of ["cpu_json", "mem_json"]) assert.strictEqual(runGroup(odd, g).stdout.trim(), "null", `${g}: no usable line`);
});

test("cpu_json is 0 on the first tick and a delta afterwards", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  assert.deepStrictEqual(json(runGroup(host, "cpu_json", { STATE: state })),
    { usage: 0, iowait: 0, steal: 0, cores: 2, per: [0, 0], load: [0.5, 0.4, 0.3] });
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1600 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\ncpu1 100 0 100 800 0 0 0 0 0 0\n");
  const second = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(second.usage, 20);
  assert.deepStrictEqual(second.per, [20, 20]);
});

test("cpu_json: time waiting on disk (iowait) and taken by the hypervisor (steal) are their own numbers", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  runGroup(host, "cpu_json", { STATE: state });
  // of 1000 more ticks: 100 user, 100 system, 500 idle, 250 iowait, 50 steal
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1300 250 0 0 50 0 0\ncpu0 100 0 100 650 125 0 0 25 0 0\ncpu1 100 0 100 650 125 0 0 25 0 0\n");
  const d = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(d.usage, 25, "busy: user, system and steal; iowait is idle time the CPU could not use");
  assert.strictEqual(d.iowait, 25);
  assert.strictEqual(d.steal, 5);
});

test("cpu_json after an upgrade: a state file from the older agent gives 0, not an error", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  fs.writeFileSync(path.join(state, "cpu"), "1000 800\n");   // total idle, as the older agent wrote it
  const d = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(d.iowait, 0);
  assert.strictEqual(d.steal, 0);
  assert.strictEqual(fs.readFileSync(path.join(state, "cpu"), "utf8").trim().split(" ").length, 2, "the older agent's file keeps its shape");
});

test("cpu_json leaves a state file the older agent can still read (a rollback keeps working)", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  json(runGroup(host, "cpu_json", { STATE: state }));
  // the older cpu.sh: read -r pt pi < "$STATE/cpu"; di=$((idle - pi))
  const old = spawnSync("bash", ["-c", 'set -u; read -r pt pi < "$1/cpu"; echo $(( 800 - pi + pt * 0 ))', "_", state], { encoding: "utf8" });
  assert.strictEqual(old.status, 0, old.stderr);
  assert.match(fs.readFileSync(path.join(state, "cpu-wait"), "utf8"), /^\d+ \d+\n$/, "iowait and steal live beside it");
});

const PRESSURE = {
  "proc/pressure/cpu": "some avg10=0.43 avg60=0.18 avg300=0.05 total=10361151074\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  "proc/pressure/memory": "some avg10=0.04 avg60=0.15 avg300=0.20 total=8494872319\nfull avg10=0.04 avg60=0.15 avg300=0.18 total=8074947564\n",
  "proc/pressure/io": "some avg10=14.85 avg60=17.50 avg300=18.90 total=140135240655\nfull avg10=13.29 avg60=15.99 avg300=17.46 total=130849769659\n",
};

test("pressure_json: the share of the last 10 s that some (or all) tasks waited for cpu, memory or disk", () => {
  const host = fakeHost({ ...BASE, ...PRESSURE });
  assert.deepStrictEqual(json(runGroup(host, "pressure_json")), {
    cpu: { some: 0.43, full: 0 }, mem: { some: 0.04, full: 0.04 }, io: { some: 14.85, full: 13.29 },
  });
});

test("pressure_json: a kernel without cpu 'full' (before 5.13) gives null there; without PSI, null", () => {
  const host = fakeHost({ ...BASE, ...PRESSURE, "proc/pressure/cpu": "some avg10=1.50 avg60=0.18 avg300=0.05 total=1\n" });
  assert.deepStrictEqual(json(runGroup(host, "pressure_json")).cpu, { some: 1.5, full: null });
  assert.strictEqual(runGroup(fakeHost(BASE), "pressure_json").stdout.trim(), "null");
  const partial = fakeHost({ ...BASE, "proc/pressure/io": PRESSURE["proc/pressure/io"] });
  assert.deepStrictEqual(json(runGroup(partial, "pressure_json")), { cpu: null, mem: null, io: { some: 14.85, full: 13.29 } });
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

// /proc/diskstats: major minor name, then reads ... ($6 sectors read) ... ($10 sectors written)
const DISKSTATS = [
  "   8       0 sda 100 0 4000 0 50 0 2000 0 0 0 0 0 0 0 0 0 0",
  "   8       2 sda2 90 0 3000 0 40 0 1000 0 0 0 0 0 0 0 0 0 0",
  "   8      17 sdb1 10 0 200 0 5 0 100 0 0 0 0 0 0 0 0 0 0",
  " 253       0 dm-0 7 0 70 0 7 0 70 0 0 0 0 0 0 0 0 0 0", "",
].join("\n");
// the kernel's own link from a device number to its block device
function linkDevices(host, links) {
  for (const [majmin, target] of Object.entries(links)) {
    fs.mkdirSync(path.join(host, "sys/dev/block"), { recursive: true });
    fs.symlinkSync(target, path.join(host, "sys/dev/block", majmin));
  }
}

test("disks_json names each disk's block device, through its device number (LVM and dm too)", () => {
  const host = fakeHost({ ...BASE, "proc/1/mountinfo": BASE["proc/1/mountinfo"] + "37 25 253:0 / /data rw - xfs /dev/mapper/vg-data rw\n",
    "data/x": "x" });
  linkDevices(host, { "8:2": "../../block/sda/sda2", "8:17": "../../block/sdb/sdb1", "253:0": "../../block/dm-0" });
  const d = json(runGroup(host, "disks_json", { DISKS: "/,/srv,/data" }));
  assert.deepStrictEqual(d.map((x) => [x.mount, x.device]), [["/", "sda2"], ["/srv", "sdb1"], ["/data", "dm-0"]]);
  const plain = json(runGroup(fakeHost(BASE), "disks_json", { DISKS: "/" }));
  assert.strictEqual(plain[0].device, undefined, "no link, no device (and no guess)");
});

test("io_json: bytes read and written by the devices behind the reported disks, each once", () => {
  const host = fakeHost({ ...BASE, "proc/diskstats": DISKSTATS,
    "proc/1/mountinfo": BASE["proc/1/mountinfo"] + "38 25 8:17 /sub /srv2 rw - ext4 /dev/sdb1 rw\n" +
      "39 25 0:50 / /mnt/nas rw - cifs //nas/share rw\n" });
  assert.deepStrictEqual(json(runGroup(host, "io_json", { DISKS: "/, /srv,/srv2,/mnt/nas" })), [
    { device: "sda2", readBytes: 3000 * 512, writeBytes: 1000 * 512 },
    { device: "sdb1", readBytes: 200 * 512, writeBytes: 100 * 512 },
  ], "a network share has no block device; a device mounted twice counts once");
  assert.strictEqual(runGroup(fakeHost(BASE), "io_json", { DISKS: "/" }).stdout.trim(), "null", "no /proc/diskstats: null");
  const noMounts = fakeHost({ ...BASE, "proc/diskstats": DISKSTATS });
  fs.rmSync(path.join(noMounts, "proc/1/mountinfo"));
  assert.deepStrictEqual(json(runGroup(noMounts, "io_json", { DISKS: "/" })), [], "no mountinfo (Android): nothing to match");
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


test("temperatures outside -50..150 °C (unconnected sensor inputs) are dropped", () => {
  const host = fakeHost({ ...BASE, "sys/class/hwmon/hwmon1/name": "it8728\n", "sys/class/hwmon/hwmon1/temp1_input": "-128000\n",
    "sys/class/hwmon/hwmon1/temp2_input": "255000\n", "sys/class/hwmon/hwmon1/temp3_input": "38000\n" });
  const t = json(runGroup(host, "temp_json"));
  assert.deepStrictEqual(t.sensors.map((x) => x.value).sort((a, b) => a - b), [38, 46, 51]);
  assert.strictEqual(t.max, 51);
});


test("without vnStat or NET_IFACE the interface comes from the host's default route", () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "sv-stub-"));
  fs.writeFileSync(path.join(stub, "vnstat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const host = fakeHost({ ...BASE,
    "proc/1/net/route": "Iface\tDestination\tGateway\tFlags\nlo\t0000007F\t00000000\t0001\ndocker0\t000011AC\t00000000\t0001\neth9\t00000000\t0101A8C0\t0003\n" });
  const r = runGroup(host, "pick_iface", { PATH: `${stub}:${process.env.PATH}` });
  assert.strictEqual(r.stdout.trim(), "eth9");
  const pinned = runGroup(host, "pick_iface", { IFACE_ENV: "wlan0", PATH: `${stub}:${process.env.PATH}` });
  assert.strictEqual(pinned.stdout.trim(), "wlan0", "NET_IFACE still wins");
});

test("without vnStat the network group still has counters", () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "sv-stub-"));
  fs.writeFileSync(path.join(stub, "vnstat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const host = fakeHost({ ...BASE, "sys/class/net/eth9/statistics/rx_bytes": "1234\n", "sys/class/net/eth9/statistics/tx_bytes": "99\n" });
  const n = json(runGroup(host, 'net_json eth9', { PATH: `${stub}:${process.env.PATH}` }));
  assert.deepStrictEqual(n, { iface: "eth9", rxBytes: 1234, txBytes: 99, vnstat: null });
});

test("every hwmon chip is read; the CPU sensor, not a disk, is the headline", () => {
  const host = fakeHost({ ...BASE,
    "sys/class/hwmon/hwmon1/name": "nvme\n", "sys/class/hwmon/hwmon1/temp1_input": "60000\n", "sys/class/hwmon/hwmon1/temp1_label": "Composite\n",
    "sys/class/hwmon/hwmon2/name": "drivetemp\n", "sys/class/hwmon/hwmon2/temp1_input": "35000\n" });
  const t = json(runGroup(host, "temp_json"));
  assert.strictEqual(t.package, 46, "coretemp's package sensor, not the NVMe Composite");
  assert.strictEqual(t.max, 60);
  assert.deepStrictEqual(t.sensors.map((x) => x.label).sort(), ["Core 0", "Package id 0", "drivetemp", "nvme Composite"]);
});

test("a laptop or VM with only acpitz still reports a temperature", () => {
  const files = { ...BASE };
  for (const k of Object.keys(files)) if (k.startsWith("sys/class/hwmon/")) delete files[k];
  Object.assign(files, { "sys/class/hwmon/hwmon0/name": "acpitz\n", "sys/class/hwmon/hwmon0/temp1_input": "41000\n" });
  const t = json(runGroup(fakeHost(files), "temp_json"));
  assert.deepStrictEqual([t.package, t.max, t.sensors.length], [41, 41, 1]);
});

module.exports = { fakeHost, runGroup, BASE, json };

// /proc/[pid]/stat: pid (comm) state ppid ... utime(14) stime(15) ... starttime(22) vsize rss(24) ...
const stat = (pid, comm, utime, stime, start, rss) =>
  `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 1000 ${rss} 0 0 0 0\n`;

test("processes_json: the five busiest by cpu (share of one core since the last tick) and the five largest by memory", () => {
  const procs = {
    "proc/uptime": "100.00 50.00\n",
    "proc/10/stat": stat(10, "postgres", 1000, 500, 111, 2000),
    "proc/20/stat": stat(20, "web (worker) x", 100, 0, 222, 500),   // a name may hold ") "
    "proc/30/stat": stat(30, "kworker/0:1", 50, 50, 333, 0),
    "proc/40/stat": stat(40, "gone", 10, 10, 444, 100),
  };
  const host = fakeHost({ ...BASE, ...procs });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  const first = json(runGroup(host, "processes_json", { STATE: state }));
  assert.deepStrictEqual(first.cpu, [], "nothing to compare on the first tick");
  assert.deepStrictEqual(first.mem.map((p) => [p.pid, p.name, p.rss]),
    [[10, "postgres", 2000 * 4096], [20, "web (worker) x", 500 * 4096], [40, "gone", 100 * 4096]], "largest first; no kernel threads");
  // 10 s later: postgres used 5 s of cpu, the kworker 1 s; pid 40 exited and a new process took pid 20
  fs.writeFileSync(path.join(host, "proc/uptime"), "110.00 50.00\n");
  fs.writeFileSync(path.join(host, "proc/10/stat"), stat(10, "postgres", 1300, 700, 111, 2100));
  fs.writeFileSync(path.join(host, "proc/20/stat"), stat(20, "newcomer", 900, 0, 999, 10));
  fs.writeFileSync(path.join(host, "proc/30/stat"), stat(30, "kworker/0:1", 100, 100, 333, 0));
  fs.rmSync(path.join(host, "proc/40"), { recursive: true });
  const second = json(runGroup(host, "processes_json", { STATE: state }));
  assert.deepStrictEqual(second.cpu, [
    { pid: 10, name: "postgres", cpuPct: 50, rss: 2100 * 4096 },
    { pid: 30, name: "kworker/0:1", cpuPct: 10, rss: 0 },
  ], "a reused pid (new start time) is not compared with the old process");
  assert.strictEqual(second.mem[0].cpuPct, 50);
  assert.strictEqual(second.mem.find((p) => p.pid === 20).cpuPct, null);
});

test("processes_json: more than five, a name with quotes, no /proc/uptime, and a process the agent may not read", () => {
  const many = { "proc/uptime": "100.00 50.00\n" };
  for (let i = 1; i <= 8; i++) many[`proc/${i}/stat`] = stat(i, i === 3 ? 'say "hi"\\' : `p${i}`, 0, 0, i, i * 10);
  const host = fakeHost({ ...BASE, ...many });
  const d = json(runGroup(host, "processes_json"));
  assert.deepStrictEqual(d.mem.map((p) => p.pid), [8, 7, 6, 5, 4], "the top five");
  const quoted = fakeHost({ ...BASE, ...many, "proc/8/stat": stat(8, 'say "hi"\\', 0, 0, 8, 999) });
  assert.strictEqual(json(runGroup(quoted, "processes_json")).mem[0].name, 'say "hi"\\');
  const noUptime = fakeHost({ ...BASE, ...many });
  fs.rmSync(path.join(noUptime, "proc/uptime"));
  assert.strictEqual(runGroup(noUptime, "processes_json").stdout.trim(), "null");
  if (process.getuid && process.getuid() !== 0) {
    // another user's process the agent may not read (Android hides them): skipped, the rest still counts.
    // mawk (Ubuntu's default awk) stops at a file it cannot open, so the agent must not hand it one.
    const denied = fakeHost({ ...BASE, ...many });
    fs.chmodSync(path.join(denied, "proc/1/stat"), 0);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sv-bin-"));
    const mawk = spawnSync("bash", ["-c", "command -v mawk"], { encoding: "utf8" }).stdout.trim();
    if (mawk) fs.symlinkSync(mawk, path.join(bin, "awk"));
    const r = runGroup(denied, "processes_json", { PATH: `${bin}:${process.env.PATH}` });
    assert.deepStrictEqual(json(r).mem.map((p) => p.pid), [8, 7, 6, 5, 4]);
  }
});

test("processes_json: a name with a newline cannot pose as another pid (comm is the process's own to set)", () => {
  const host = fakeHost({ ...BASE, "proc/uptime": "100.00 50.00\n",
    // a process named "x\n1 (systemd": its stat line splits in two after cat
    "proc/3358320/stat": stat(3358320, "x\n1 (systemd", 0, 0, 77, 9000),
    "proc/1/stat": stat(1, "systemd", 0, 0, 1, 10) });
  const d = json(runGroup(host, "processes_json"));
  assert.deepStrictEqual(d.mem.map((p) => [p.pid, p.name]), [[3358320, "x 1 (systemd"], [1, "systemd"]],
    "the pid comes from the path; the split name is joined back");
});

test("processes_json: a comma-decimal locale (de_DE) does not break the cpu shares, also with mawk", () => {
  assert.match(fs.readFileSync(path.join(LIB, "processes.sh"), "utf8"), /\| LC_ALL=C awk /, "awk prints numbers the C way");
  const loc = spawnSync("bash", ["-c", "locale -a 2>/dev/null | grep -i -m1 -E '^(de_DE|fr_FR)[.]utf-?8$'"], { encoding: "utf8" }).stdout.trim();
  const mawk = spawnSync("bash", ["-c", "command -v mawk"], { encoding: "utf8" }).stdout.trim();
  if (!loc || !mawk) return;   // the source check above still holds
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sv-bin-"));
  fs.symlinkSync(mawk, path.join(bin, "awk"));
  const host = fakeHost({ ...BASE, "proc/uptime": "100.00 50.00\n", "proc/10/stat": stat(10, "postgres", 1000, 0, 1, 5) });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  const env = { STATE: state, PATH: `${bin}:${process.env.PATH}`, LC_ALL: loc };
  json(runGroup(host, "processes_json", env));
  fs.writeFileSync(path.join(host, "proc/uptime"), "110.00 50.00\n");
  fs.writeFileSync(path.join(host, "proc/10/stat"), stat(10, "postgres", 1500, 0, 1, 5));
  assert.strictEqual(json(runGroup(host, "processes_json", env)).cpu[0].cpuPct, 50);
});

const NOTIFIER = "var/lib/update-notifier/updates-available";

test("ubuntu_json: pending updates, security updates and a reboot with the packages that ask for it", () => {
  const host = fakeHost({ ...BASE, "var/lib/dpkg/status": "",
    [NOTIFIER]: "\nExpanded Security Maintenance for Applications is not enabled.\n\n12 updates can be applied immediately.\n" +
      "5 of these updates are standard security updates.\nTo see these additional updates run: apt list --upgradable\n",
    "run/reboot-required": "*** System restart required ***\n",
    "run/reboot-required.pkgs": "linux-image-7.0.0-38-generic\nlinux-base\nlinux-image-7.0.0-38-generic\n" });
  assert.deepStrictEqual(json(runGroup(host, "ubuntu_json")),
    { updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-image-7.0.0-38-generic", "linux-base"] });
});

test("ubuntu_json: the other wordings, nothing pending, no update-notifier, and a host without dpkg or systemd", () => {
  const run = (text) => json(runGroup(fakeHost({ ...BASE, "var/lib/dpkg/status": "", ...(text === null ? {} : { [NOTIFIER]: text }) }), "ubuntu_json"));
  assert.deepStrictEqual(run("0 updates can be applied immediately.\n"), { updates: 0, security: 0, rebootRequired: false, rebootPkgs: [] });
  assert.deepStrictEqual(run("1 update can be applied immediately.\n1 of these updates is a standard security update.\n"),
    { updates: 1, security: 1, rebootRequired: false, rebootPkgs: [] });
  // Ubuntu 20.04 and older
  assert.deepStrictEqual(run("7 packages can be updated.\n2 updates are security updates.\n"),
    { updates: 7, security: 2, rebootRequired: false, rebootPkgs: [] });
  assert.deepStrictEqual(run("Mises à jour : 3\n"), { rebootRequired: false, rebootPkgs: [] }, "a wording it does not know: no counts, no guess");
  assert.deepStrictEqual(run(null), { rebootRequired: false, rebootPkgs: [] }, "no update-notifier: no counts");
  assert.strictEqual(runGroup(fakeHost(BASE), "ubuntu_json").stdout.trim(), "null", "no dpkg, not this host's systemd: null");
});

test("failed_units: the names of systemd's failed units, at most 32", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sv-bin-"));
  const units = Array.from({ length: 40 }, (_, i) => `unit${i}.service loaded failed failed Something ${i}`).join("\n");
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\n[ "$*" = "--failed --no-legend --plain" ] || exit 9\ncat <<'X'\n${units}\nX\n`, { mode: 0o755 });
  const r = runGroup(fakeHost(BASE), "failed_units", { PATH: `${bin}:${process.env.PATH}` });
  assert.strictEqual(r.status, 0, r.stderr);
  const names = r.stdout.trim().split("\n");
  assert.strictEqual(names.length, 32);
  assert.deepStrictEqual(names.slice(0, 2), ["unit0.service", "unit1.service"]);
});
