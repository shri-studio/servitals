// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * History (spec 7): series from each snapshot, one ring file per series with
 * 1-minute (24 h), 10-minute (7 d) and 1-hour (90 d) points of avg, min, max.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHistory, seriesOf, RANGES } = require("../hub/lib/history");

const MIN = 60000;
function clock(t = 1790000000000) {
  const c = { t: Math.floor(t / 3600000) * 3600000, now: () => c.t, at: (m) => { c.t = c.base + m * MIN; }, base: 0 };
  c.base = c.t;
  return c;
}
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-hist-"));
const pts = (r) => r.points.map(([, a, lo, hi]) => [a, lo, hi]);

test("seriesOf: the numbers a snapshot's view gives, by name; what is missing is left out", () => {
  assert.deepStrictEqual(seriesOf({
    cpu: { usage: 12, iowait: 30, load: [1.5, 1, 0.5] }, mem: { total: 200, used: 50, swapTotal: 100, swapUsed: 25 },
    temp: { package: 46 }, pressure: { cpu: { some: 0.4 }, mem: null, io: { some: 14.9 } },
    net: { rateRx: 1000, rateTx: null },
    disks: [{ mount: "/", pct: 40 }, { mount: "/mnt/nas", mounted: false }],
    io: [{ device: "sda1", readRate: 4000, writeRate: 0 }],
    docker: [{ name: "web", cpu: 2.5, mem: 1e6 }, { name: "db", cpu: null, mem: null }],
  }), {
    cpu: 12, iowait: 30, load1: 1.5, mem: 25, swap: 25, temp: 46, "psi.cpu": 0.4, "psi.io": 14.9,
    "net.rx": 1000, "disk./.used": 40, "io.sda1.read": 4000, "io.sda1.write": 0,
    "ctr.web.cpu": 2.5, "ctr.web.mem": 1e6,
  });
  assert.deepStrictEqual(seriesOf({ mem: { total: 0, used: 0 }, cpu: { usage: NaN } }), {}, "no total, no number: nothing");
});

test("a minute is the average, low and high of what arrived in it; a missing minute is a gap", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  c.at(0); h.add("nodeaaaaaaaa", { cpu: 10 }); c.at(0.5); h.add("nodeaaaaaaaa", { cpu: 20 });
  c.at(1); h.add("nodeaaaaaaaa", { cpu: 30 });           // minute 0 closes
  c.at(4); h.add("nodeaaaaaaaa", { cpu: 50 });           // minutes 2 and 3 never came
  h.flush();                                               // minute 4 is written as it stands
  const r = h.query("nodeaaaaaaaa", "cpu", "1h");
  assert.strictEqual(r.step, 60);
  assert.strictEqual(r.points.length, 60);
  assert.deepStrictEqual(pts(r).slice(-5), [[15, 10, 20], [30, 30, 30], [null, null, null], [null, null, null], [50, 50, 50]]);
  assert.strictEqual(r.points.at(-1)[0], (c.base + 4 * MIN) / 1000, "t is the minute's start, in seconds");
});

test("the 10-minute and hourly points come from the minutes in them", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  for (let m = 0; m < 12; m++) { c.at(m); h.add("nodeaaaaaaaa", { cpu: m }); }
  c.at(12); h.flush();
  const week = pts(h.query("nodeaaaaaaaa", "cpu", "7d"));
  assert.strictEqual(week.length, 1008);
  assert.deepStrictEqual(week.slice(-2), [[4.5, 0, 9], [10.5, 10, 11]]);
  const month = pts(h.query("nodeaaaaaaaa", "cpu", "30d"));
  assert.strictEqual(month.length, 720);
  assert.deepStrictEqual(month.at(-1), [5.5, 0, 11]);
  assert.strictEqual(h.query("nodeaaaaaaaa", "cpu", "90d").points.length, 2160);
});

test("the 1-minute ring keeps 24 hours: an older minute is gone, never shown as today", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  c.at(0); h.add("nodeaaaaaaaa", { cpu: 99 }); c.at(1); h.add("nodeaaaaaaaa", { cpu: 1 });
  c.at(1440 + 1); h.add("nodeaaaaaaaa", { cpu: 2 });      // a day later, same slot as minute 1
  h.flush();
  const day = pts(h.query("nodeaaaaaaaa", "cpu", "24h"));
  assert.deepStrictEqual(day.at(-1), [2, 2, 2]);
  assert.ok(day.slice(0, -1).every(([a]) => a === null), "nothing else in the last 24 h");
});

test("history survives a restart: flushed minutes are read back from the files", () => {
  const d = dir(), c = clock();
  const a = createHistory(d, { now: c.now });
  c.at(0); a.add("nodeaaaaaaaa", { cpu: 7, "disk./.used": 40 }); a.flush();
  const b = createHistory(d, { now: c.now });
  assert.deepStrictEqual(pts(b.query("nodeaaaaaaaa", "cpu", "1h")).at(-1), [7, 7, 7]);
  assert.deepStrictEqual(b.series("nodeaaaaaaaa").sort(), ["cpu", "disk./.used"]);
  assert.ok(fs.readdirSync(path.join(d, "nodeaaaaaaaa")).every((f) => !f.includes("/")), "file names stay in the directory");
});

test("container series keep 1-minute averages only; longer ranges give nothing for them", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  c.at(0); h.add("nodeaaaaaaaa", { "ctr.web.cpu": 2 }); c.at(0.5); h.add("nodeaaaaaaaa", { "ctr.web.cpu": 4 });
  h.flush();
  assert.deepStrictEqual(pts(h.query("nodeaaaaaaaa", "ctr.web.cpu", "1h")).at(-1), [3, 3, 3]);
  assert.strictEqual(h.query("nodeaaaaaaaa", "ctr.web.cpu", "7d"), null);
  const f = fs.readdirSync(path.join(h.dir, "nodeaaaaaaaa"))[0];
  assert.ok(fs.statSync(path.join(h.dir, "nodeaaaaaaaa", f)).size < 6 * 1024, "about 1440 floats");
});

test("unknown nodes, series and ranges answer null; names that could leave the directory are refused", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  c.at(0); h.add("nodeaaaaaaaa", { cpu: 1 }); h.flush();
  assert.strictEqual(h.query("nodebbbbbbbb", "cpu", "1h"), null);
  assert.strictEqual(h.query("nodeaaaaaaaa", "mem", "1h"), null);
  assert.strictEqual(h.query("nodeaaaaaaaa", "cpu", "2h"), null);
  assert.strictEqual(h.query("../etc", "cpu", "1h"), null);
  assert.deepStrictEqual(Object.keys(RANGES), ["1h", "24h", "7d", "30d", "90d"]);
});

test("a revoked node's history goes; a series silent for 90 days is swept", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  c.at(0); h.add("nodeaaaaaaaa", { cpu: 1, "disk./old.used": 5 }); h.add("nodebbbbbbbb", { cpu: 1 }); h.flush();
  h.remove("nodebbbbbbbb");
  assert.strictEqual(fs.existsSync(path.join(h.dir, "nodebbbbbbbb")), false);
  c.at(91 * 1440); h.add("nodeaaaaaaaa", { cpu: 2 }); h.flush();
  h.sweep(new Set(["nodeaaaaaaaa"]));
  assert.deepStrictEqual(h.series("nodeaaaaaaaa"), ["cpu"]);
  h.add("nodecccccccc", { cpu: 1 }); h.flush();
  h.sweep(new Set(["nodeaaaaaaaa"]));   // revoked with servitals-ctl while the hub was down
  assert.strictEqual(fs.existsSync(path.join(h.dir, "nodecccccccc")), false);
});

test("the minute in progress shows in a query before it is written", () => {
  const c = clock(), h = createHistory(dir(), { now: c.now });
  c.at(0); h.add("nodeaaaaaaaa", { cpu: 8 }); h.flush();
  c.at(1); h.add("nodeaaaaaaaa", { cpu: 4 }); c.at(1.5); h.add("nodeaaaaaaaa", { cpu: 6 });
  assert.deepStrictEqual(pts(h.query("nodeaaaaaaaa", "cpu", "1h")).slice(-2), [[8, 8, 8], [5, 4, 6]]);
  const fresh = createHistory(dir(), { now: c.now });
  c.at(2); fresh.add("nodeaaaaaaaa", { mem: 1 });
  assert.deepStrictEqual(pts(fresh.query("nodeaaaaaaaa", "mem", "1h")).at(-1), [1, 1, 1], "a series with no file yet");
});
