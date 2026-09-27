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

test("the first bad value names its path", () => {
  const cases = [
    [null, "$"], [[1], "$"], [{ ...base(), schema: 2 }, "$.schema"], [{ ...base(), ts: -1 }, "$.ts"],
    [{ ...base(), ts: 1.5 }, "$.ts"], [{ ...base(), interval: 4 }, "$.interval"], [{ ...base(), host: {} }, "$.host.name"],
    [{ ...base(), host: { name: "x", os: "plan9" } }, "$.host.os"],
    [base({ cpu: { usage: 101 } }), "$.cpu.usage"], [base({ cpu: { usage: Infinity } }), "$.cpu.usage"],
    [base({ mem: { total: "1" } }), "$.mem.total"], [base({ temp: { package: 900 } }), "$.temp.package"],
    [base({ disks: [{ mount: "/", pct: 150 }] }), "$.disks[0].pct"], [base({ disks: "x" }), "$.disks"],
    [base({ docker: [{ name: "a", cpuUsec: -1 }] }), "$.docker[0].cpuUsec"],
    [base({ net: { rxBytes: 2 ** 60 } }), "$.net.rxBytes"],
  ];
  for (const [s, path] of cases) assert.deepStrictEqual(validate(s), { ok: false, path }, JSON.stringify(s));
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
