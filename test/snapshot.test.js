// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { validate, view } = require("../hub/lib/snapshot");

const base = (extra = {}) => ({ schema: 1, ts: 1790000000000, interval: 60, host: { name: "nas", os: "linux" }, ...extra });

test("a full snapshot passes and unknown keys are dropped", () => {
  const r = validate(base({
    extra: "dropped",
    mem: { total: 100, used: 40, available: 60, free: 10, cache: 20, swapTotal: 0, swapUsed: 0, junk: 1 },
    cpu: { usage: 12.5, cores: 4, per: [10, 15], load: [0.5, 0.4, 0.3] },
    temp: { package: 46, max: 51, sensors: [{ label: "Package id 0", value: 46 }] },
    disks: [{ mount: "/", mounted: true, source: "/dev/sda1", fstype: "ext4", size: 10, used: 5, avail: 5, pct: 50 }],
    net: { iface: "eno1", rxBytes: 1000, txBytes: 2000, vnstat: { today: { rx: 1, tx: 2, avgRx: 0.5, avgTx: 1 }, days: [], hours: [] } },
    docker: [{ name: "web", id: "abc", state: "running", status: "Up", health: null, cpuUsec: 5, mem: 7 }],
  }));
  assert.strictEqual(r.ok, true, r.path);
  assert.strictEqual(r.value.extra, undefined);
  assert.strictEqual(r.value.mem.junk, undefined);
  assert.strictEqual(r.value.docker[0].cpuUsec, 5);
});

test("iowait, steal and pressure pass; a pressure resource the kernel lacks may be null", () => {
  const pressure = { cpu: { some: 0.43, full: null }, mem: { some: 0, full: 0 }, io: { some: 14.85, full: 13.29 } };
  const r = validate(base({ cpu: { usage: 11, iowait: 34, steal: 0, cores: 4 }, pressure }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.value.cpu.iowait, r.value.cpu.steal], [34, 0]);
  assert.deepStrictEqual(r.value.pressure, pressure);
  assert.deepStrictEqual(validate(base({ pressure: { cpu: null, mem: null, io: { some: 1, full: 1 } } })).value.pressure,
    { cpu: null, mem: null, io: { some: 1, full: 1 } });
  assert.strictEqual(validate(base({ pressure: null })).value.pressure, null, "no PSI: the group is null");
});

test("processes pass with a cpu share still unknown; names are cut to 64 and lists to five", () => {
  const p = (pid, extra = {}) => ({ pid, name: "n" + pid, cpuPct: null, rss: pid, ...extra });
  const r = validate(base({ processes: { cpu: [p(1, { cpuPct: 250.5 })], mem: [1, 2, 3, 4, 5, 6, 7].map((i) => p(i, { name: "x".repeat(99) })) } }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.processes.cpu[0].cpuPct, 250.5, "a multi-threaded process may pass 100 %");
  assert.strictEqual(r.value.processes.mem.length, 5);
  assert.strictEqual(r.value.processes.mem[0].name.length, 64);
  assert.strictEqual(r.value.processes.mem[0].cpuPct, null);
  assert.deepStrictEqual(validate(base({ processes: { cpu: [p(1, { rss: -1 })] } })).dropped, ["$.processes.cpu[0].rss"]);
});

test("voltages pass with their label; fans and the battery as before", () => {
  const r = validate(base({ voltages: [{ label: "Vcore", value: 1.216 }, { label: "-12V", value: -11.9 }],
    fans: [{ label: "CPU fan", rpm: 1200 }], battery: { capacity: 87, status: "Discharging" } }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.value.voltages, [{ label: "Vcore", value: 1.216 }, { label: "-12V", value: -11.9 }]);
  assert.deepStrictEqual(validate(base({ voltages: [{ label: "x", value: 5000 }] })).dropped, ["$.voltages[0].value"]);
  assert.deepStrictEqual(validate(base({ voltages: [{ label: "x" }] })).dropped, ["$.voltages[0].value"]);
  assert.strictEqual(validate(base({ voltages: Array.from({ length: 40 }, () => ({ label: "v", value: 1 })) })).value.voltages.length, 32);
});

test("a bad required value refuses the snapshot and names its path", () => {
  const cases = [
    [null, "$"], [[1], "$"], [{ ...base(), schema: 2 }, "$.schema"], [{ ...base(), ts: -1 }, "$.ts"],
    [{ ...base(), ts: 1.5 }, "$.ts"], [{ ...base(), interval: 4 }, "$.interval"], [{ ...base(), host: {} }, "$.host.name"],
    [{ ...base(), host: { name: "x", os: "plan9" } }, "$.host.os"], [{ ...base(), host: "x" }, "$.host"],
  ];
  for (const [s, path] of cases) assert.deepStrictEqual(validate(s), { ok: false, path }, JSON.stringify(s));
});

test("a bad value in an optional group drops that group only; the rest is kept and the paths are named", () => {
  const cases = [
    [base({ cpu: { usage: 101 } }), "$.cpu.usage"], [base({ cpu: { usage: Infinity } }), "$.cpu.usage"],
    [base({ cpu: { iowait: 101 } }), "$.cpu.iowait"], [base({ cpu: { steal: -1 } }), "$.cpu.steal"],
    [base({ pressure: { io: { some: 100.5 } } }), "$.pressure.io.some"], [base({ pressure: { mem: { full: "9" } } }), "$.pressure.mem.full"],
    [base({ pressure: { cpu: [] } }), "$.pressure.cpu"],
    [base({ mem: { total: "1" } }), "$.mem.total"], [base({ temp: { package: 900 } }), "$.temp.package"],
    [base({ disks: [{ mount: "/", pct: 150 }] }), "$.disks[0].pct"], [base({ disks: "x" }), "$.disks"],
    [base({ docker: [{ name: "a", cpuUsec: -1 }] }), "$.docker[0].cpuUsec"],
    [base({ net: { rxBytes: 2 ** 60 } }), "$.net.rxBytes"], [base({ agent: 7 }), "$.agent"],
  ];
  for (const [s, path] of cases) {
    const r = validate({ ...s, mem: s.mem || { total: 100, used: 50 } });
    const group = path.split(/[.[]/)[1];
    assert.ok(r.ok, JSON.stringify(s));
    assert.deepStrictEqual(r.dropped, [path], JSON.stringify(s));
    assert.strictEqual(r.value[group], undefined, `${group} is dropped`);
    if (group !== "mem") assert.deepStrictEqual(r.value.mem, { total: 100, used: 50 }, "the other groups stay");
  }
  const two = validate(base({ fans: [{ label: "f", rpm: -5 }], battery: { capacity: 101 }, cpu: { usage: 5 } }));
  assert.deepStrictEqual([two.ok, two.dropped, two.value.cpu], [true, ["$.fans[0].rpm", "$.battery.capacity"], { usage: 5 }]);
  assert.deepStrictEqual(validate(base({ cpu: { usage: 5 } })).dropped, [], "nothing dropped: an empty list");
});

test("strings lose control characters and are cut; lists are cut", () => {
  const r = validate(base({
    host: { name: "a\u0000b\nc" + "x".repeat(100), os: "linux" },
    disks: Array.from({ length: 40 }, (_, i) => ({ mount: "/m" + i })),
    docker: Array.from({ length: 250 }, (_, i) => ({ name: "<script>" + i })),
  }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.host.name.length, 64);
  assert.ok(r.value.host.name.startsWith("a b c"));
  assert.strictEqual(r.value.disks.length, 32);
  assert.strictEqual(r.value.docker.length, 200);
  assert.strictEqual(r.value.docker[0].name, "<script>0", "escaping is the page's job; the hub only limits");
});

test("the view derives rates and container CPU from two snapshots", () => {
  const a = validate(base({ cpu: { usage: 10, cores: 2 }, mem: { total: 200, used: 50 },
    net: { iface: "eno1", rxBytes: 1000, txBytes: 5000, vnstat: { today: { rx: 1, tx: 2 } } },
    docker: [{ name: "web", id: "abc", cpuUsec: 1000000, mem: 1 }] })).value;
  const b = validate(base({ ts: a.ts + 10000, cpu: { usage: 20, cores: 2 }, mem: { total: 200, used: 100 },
    net: { iface: "eno1", rxBytes: 11000, txBytes: 5000, vnstat: { today: { rx: 3, tx: 4 } } },
    docker: [{ name: "web", id: "abc", cpuUsec: 3000000, mem: 1 }] })).value;
  const first = view(a, null, []);
  assert.deepStrictEqual([first.net.rateRx, first.docker[0].cpu], [null, null], "nothing to compare yet");
  const v = view(b, a, first.trend);
  assert.strictEqual(v.net.rateRx, 1000);
  assert.strictEqual(v.net.rateTx, 0);
  assert.deepStrictEqual(v.net.today, { rx: 3, tx: 4 });
  assert.strictEqual(v.docker[0].cpu, 10, "2 s of CPU over 10 s on 2 cores");
  assert.strictEqual(v.docker[0].cpuUsec, undefined);
  assert.deepStrictEqual(v.trend.map((p) => [p.cpu, p.mem]), [[10, 25], [20, 50]]);
});

test("the view turns each disk device's byte counters into read and write rates", () => {
  const a = validate(base({ disks: [{ mount: "/srv", device: "sdb1" }],
    io: [{ device: "sdb1", readBytes: 1000, writeBytes: 0 }, { device: "sda2", readBytes: 5, writeBytes: 5 }] })).value;
  assert.strictEqual(a.disks[0].device, "sdb1");
  const b = validate(base({ ts: a.ts + 2000, disks: [{ mount: "/srv", device: "sdb1" }],
    io: [{ device: "sdb1", readBytes: 9000, writeBytes: 4000 }, { device: "sda2", readBytes: 1, writeBytes: 5 },
         { device: "sdc1", readBytes: 7, writeBytes: 7 }] })).value;
  assert.deepStrictEqual(view(a, null, []).io, [{ device: "sdb1", readRate: null, writeRate: null },
    { device: "sda2", readRate: null, writeRate: null }], "nothing to compare yet");
  assert.deepStrictEqual(view(b, a, []).io, [
    { device: "sdb1", readRate: 4000, writeRate: 2000 },
    { device: "sda2", readRate: null, writeRate: 0 },   // a counter that went back (a reboot)
    { device: "sdc1", readRate: null, writeRate: null },   // new since the last snapshot
  ]);
  assert.deepStrictEqual(validate(base({ disks: [{ mount: "/", device: "x".repeat(200) }] })).value.disks[0].device.length, 128);
});

test("a counter that went backwards (reboot, new interface) gives no rate", () => {
  const a = validate(base({ net: { iface: "eno1", rxBytes: 5000, txBytes: 0 } })).value;
  const b = validate(base({ ts: a.ts + 1000, net: { iface: "eno1", rxBytes: 10, txBytes: 0 } })).value;
  const c = validate(base({ ts: a.ts + 1000, net: { iface: "wlan0", rxBytes: 9000, txBytes: 0 } })).value;
  assert.strictEqual(view(b, a).net.rateRx, null);
  assert.strictEqual(view(c, a).net.rateRx, null);
});

test("the trend keeps the last 60 points", () => {
  const s = validate(base({ cpu: { usage: 1 } })).value;
  const long = Array.from({ length: 70 }, () => ({ cpu: 0, mem: 0, temp: null }));
  assert.strictEqual(view(s, null, long).trend.length, 60);
});
