// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { status, summary } = require("../hub/lib/fleet");

test("liveness follows the node's own heartbeat", () => {
  const now = 10_000_000;
  assert.strictEqual(status(null, 60, now), "waiting");
  assert.strictEqual(status(now - 170_000, 60, now), "online");
  assert.strictEqual(status(now - 190_000, 60, now), "stale");
  assert.strictEqual(status(now - 590_000, 60, now), "stale", "stale for at least 10 minutes");
  assert.strictEqual(status(now - 610_000, 60, now), "offline");
  assert.strictEqual(status(now - 1_400_000, 300, now), "stale", "5 x interval when that is longer");
  assert.strictEqual(status(now - 1_600_000, 300, now), "offline");
});

test("a card's numbers come from the view", () => {
  const s = summary({
    host: { name: "nas", distro: "Ubuntu" }, cpu: { usage: 12.4, iowait: 31 }, mem: { total: 200, used: 50 }, temp: { package: 46 },
    disks: [{ mount: "/", pct: 40 }, { mount: "/srv", pct: 93 }, { mount: "/mnt/x", mounted: false }],
    docker: [{ state: "running" }, { state: "exited" }], trend: Array.from({ length: 30 }, (_, i) => ({ cpu: i })),
  });
  assert.deepStrictEqual(s.disk, { mount: "/srv", pct: 93 });
  assert.deepStrictEqual([s.cpu, s.iowait, s.mem, s.temp, s.containers, s.running], [12.4, 31, 25, 46, 2, 1]);
  assert.strictEqual(summary({ cpu: { usage: 5 } }).iowait, null, "an older agent sends no iowait");
  assert.deepStrictEqual([summary({ ubuntu: { updates: 3, rebootRequired: true } }).updates, summary({ ubuntu: { updates: 3, rebootRequired: true } }).reboot], [3, true]);
  assert.deepStrictEqual([summary({}).updates, summary({}).reboot], [null, false]);
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
});
