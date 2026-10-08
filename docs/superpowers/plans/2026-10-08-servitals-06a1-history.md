# servitals History in the Hub (sub-project 6a-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub keeps every node's history (spec 7) and answers it through `GET /__ctl/history`. Each series has 1-minute points for 24 h, 10-minute points for 7 days and hourly points for 90 days. Every point holds average, low and high. The page's charts (6a-2) build on this.

**Why:** today the page shows only a sparkline of the last hour (the agent's 60-sample trend). Spec 7 asks for 24 h, 7 d and 90 d of history. Alerts (6b) will need the same series to judge "for N minutes".

**Architecture:**
- **`hub/lib/history.js`:**
  - `seriesOf(view)` turns a snapshot's view into named numbers:
    - `cpu`, `iowait`, `load1`, `mem` %, `swap` %, `temp`;
    - `psi.cpu|mem|io`;
    - `net.rx|tx` (B/s, from the view's rates);
    - `disk.<mount>.used` %;
    - `io.<device>.read|write` (B/s);
    - `ctr.<name>.cpu|mem`.
  - `createHistory(dir, {now})` keeps each node's open minute in memory (sum, count, low, high). Rolling into the next minute, or a `flush()`, writes the minute to the series' ring file.
  - Each ring file is `<dir>/<node>/<percent-encoded name>.ring`:
    - a 32-byte header: "SVH1", tiers, fields, and each tier's last index;
    - Float32 points written in place;
    - for containers, T1 only and averages only (about 6 KB), otherwise about 54 KB.
  - Writing minute m first fills the slots since the tier's last index with NaN (gaps). It then recomputes the 10-minute and hourly points for m's buckets from T1's minutes, so those tiers keep no state of their own.
  - `query(node, series, range)` returns `{step, points: [[t, avg, min, max]]}` over the range. It uses NaN → null, ignores ring slots older than the tier's length, and includes the minute in progress from memory.
  - `series(node)`, `remove(node)` and `sweep(knownIds)` are also provided. The sweep drops series silent for 90 days and nodes no longer known (for example, revoked with `servitals-ctl` while the hub was down).
- **`hub/server.js`:**
  - Adds every push's view to the history.
  - Flushes every minute and on SIGTERM.
  - Sweeps at start and daily.
  - Removes a node's history when the page revokes it.
  - Serves `GET /__ctl/history?node=&series=&range=1h|24h|7d|30d|90d` (logged in; node defaults to the hub's own), and `series=list`.

**Tech Stack:** Node.js ≥ 18 built-ins only (`fs` positional reads and writes, `Buffer` floats).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- section 7 (series, tiers, storage, gaps, flush, sweep, API);
- section 18 (hub RssAnon ≤ 40 MB with 10 nodes);
- section 13 (state lives under the state directory, which backups include).

**Scope:** 6a-1 of sub-project 6. The page's history graph (6a-2) comes next, then alerts (6b), channels (6c) and Web Push (6d). Additions to spec 7's list: `iowait` and `psi.*` (sub-project 5's metrics).

**Proven before writing:** every code block was built and run in a scratch copy of `main` (0813f7b) on 2026-10-08:
- node suite 347 tests;
- the budget: gateway RssAnon 13 MB idle, agent tick 226 ms.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers, the strict CSP; everything from sub-projects 1-5 still holds.
- Untrusted names never leave the history directory: node ids must match `[a-z2-7]{12}`, and series names are percent-encoded, dots included, into file names.
- A restart loses no minute that was flushed. SIGTERM flushes the minute in progress.
- Memory stays flat: only each series' open minute is kept, and files are read on query and written in place.
- History failures never break a push: errors are logged.
- Work in a worktree `.claude/worktrees/servitals-history` on branch `feat/history` from `main` (0813f7b).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Gaps and the ring's wrap**: a quiet hour, a day-long outage, and a slot reused after 24 h must never show old data as today's. Tests: "a minute is the average… a missing minute is a gap", "the 1-minute ring keeps 24 hours…".
2. **Restarts**: a flushed minute is read back, SIGTERM flushes, and the minute in progress shows before it is written. Tests: "history survives a restart…", "the minute in progress shows…", and the agentapi test "history: … outlive a restart".
3. **Hostile names**: a mount like `/` or `../x`, a container name with `/`, a node id from a query string. They stay inside the directory, and an unknown one answers 404. Tests: "unknown nodes, series and ranges answer null…", "history survives a restart…" (no "/" in file names).
4. **The 10-minute and hourly points**: correct averages, lows and highs from their minutes. Test: "the 10-minute and hourly points come from the minutes in them".
5. **Growth**: a revoked node, a removed disk or container, and nodes revoked while the hub was down. Test: "a revoked node's history goes; a series silent for 90 days is swept".

---

### Task 1: The history rings

**Files:**
- Create: `hub/lib/history.js`, `test/history.test.js`

**Interfaces:**
- Produces: `createHistory(dir, {now})` → `{add(node, values), flush(), query(node, series, range), series(node), remove(node), sweep(knownIds), dir}`; `seriesOf(view)` → `{name: number}`; `RANGES`; `TIERS`. Task 2 wires these into the hub.

- [ ] **Step 1: Write the failing tests**

Create `test/history.test.js`:

```js
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/history.test.js`
Expected: FAIL, the file as a whole (`Cannot find module '../hub/lib/history'`).

- [ ] **Step 3: The rings**

Create `hub/lib/history.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * History (spec 7): each snapshot becomes named series (cpu, mem, net.rx, ...);
 * each series is one ring file under <dir>/<node-id>/ of Float32 points:
 *   T1  1 minute,   24 h (1,440)    avg, min, max
 *   T2 10 minutes,   7 d (1,008)    avg, min, max
 *   T3  1 hour,     90 d (2,160)    avg, min, max
 * Container series (ctr.*) keep T1 averages only. A point no data reached is
 * NaN: a gap. The current minute stays in memory; flush() writes it (every
 * minute, and on SIGTERM). T2 and T3 points are recomputed from T1's minutes
 * each time a minute is written, so they need no state of their own.
 *
 * File: a 32-byte header ("SVH1", tiers, fields, then each tier's last written
 * index as a 32-bit integer, -1 for none), then each tier's points.
 *   createHistory(dir, { now }) → { add(node, values), flush(), query(node, series, range),
 *                                   series(node), remove(node), sweep(knownIds), dir }
 *   seriesOf(view) → { name: number } for the series a snapshot's view gives
 */
const fs = require("fs");
const path = require("path");

const MIN = 60000;
const TIERS = [{ step: 1, len: 1440 }, { step: 10, len: 1008 }, { step: 60, len: 2160 }];   // steps in minutes
const RANGES = { "1h": [0, 60], "24h": [0, 1440], "7d": [1, 1008], "30d": [2, 720], "90d": [2, 2160] };
const HEADER = 32;
const SWEEP_MIN = 90 * 1440;
const NODE_RE = /^[a-z2-7]{12}$/;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

function seriesOf(v) {
  const out = {};
  const put = (k, x) => { if (finite(x)) out[k] = x; };
  const c = v.cpu || {}, m = v.mem || {};
  put("cpu", c.usage); put("iowait", c.iowait);
  put("load1", Array.isArray(c.load) ? c.load[0] : undefined);
  if (finite(m.total) && m.total > 0) put("mem", Math.round((m.used * 1000) / m.total) / 10);
  if (finite(m.swapTotal) && m.swapTotal > 0) put("swap", Math.round((m.swapUsed * 1000) / m.swapTotal) / 10);
  put("temp", v.temp && v.temp.package);
  for (const r of ["cpu", "mem", "io"]) put("psi." + r, v.pressure && v.pressure[r] && v.pressure[r].some);
  if (v.net) { put("net.rx", v.net.rateRx); put("net.tx", v.net.rateTx); }
  for (const d of v.disks || []) if (d.mounted !== false) put(`disk.${d.mount}.used`, d.pct);
  for (const d of v.io || []) { put(`io.${d.device}.read`, d.readRate); put(`io.${d.device}.write`, d.writeRate); }
  for (const d of v.docker || []) { put(`ctr.${d.name}.cpu`, d.cpu); put(`ctr.${d.name}.mem`, d.mem); }
  return out;
}

// a series' file name: the name percent-encoded, so "/" and ".." never leave the directory
const fileOf = (name) => encodeURIComponent(name).replace(/\./g, "%2E") + ".ring";
const nameOf = (file) => decodeURIComponent(file.slice(0, -5));
const shapeOf = (name) => (name.startsWith("ctr.") ? { tiers: 1, fields: 1 } : { tiers: 3, fields: 3 });

function createHistory(dir, { now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const open = new Map();   // "node series" -> current minute { minute, sum, n, min, max }
  const nodeDir = (node) => path.join(dir, node);

  function offsets(shape) {
    const out = []; let at = HEADER;
    for (let t = 0; t < shape.tiers; t++) { out.push(at); at += TIERS[t].len * shape.fields * 4; }
    return { at: out, size: at };
  }
  function create(file, shape) {
    const { size } = offsets(shape);
    const buf = Buffer.alloc(size);
    buf.write("SVH1", 0, "latin1"); buf.writeUInt8(shape.tiers, 4); buf.writeUInt8(shape.fields, 5);
    for (let t = 0; t < 3; t++) buf.writeInt32LE(-1, 8 + 4 * t);
    new Float32Array(buf.buffer, buf.byteOffset + HEADER, (size - HEADER) / 4).fill(NaN);
    fs.writeFileSync(file, buf);
  }
  // one point of a tier: [avg, min, max] (fields 1: [avg, avg, avg])
  function readPoint(fd, shape, off, tier, idx) {
    const f = shape.fields, b = Buffer.alloc(4 * f);
    fs.readSync(fd, b, 0, b.length, off.at[tier] + ((idx % TIERS[tier].len) * f) * 4);
    const p = [b.readFloatLE(0)];
    return f === 3 ? [p[0], b.readFloatLE(4), b.readFloatLE(8)] : [p[0], p[0], p[0]];
  }
  function writePoint(fd, shape, off, tier, idx, p) {
    const f = shape.fields, b = Buffer.alloc(4 * f);
    for (let i = 0; i < f; i++) b.writeFloatLE(p[i], 4 * i);
    fs.writeSync(fd, b, 0, b.length, off.at[tier] + ((idx % TIERS[tier].len) * f) * 4);
  }
  // write index idx of a tier: the points between the last one and it become gaps
  function put(fd, shape, off, hdr, tier, idx, p) {
    const len = TIERS[tier].len, last = hdr.readInt32LE(8 + 4 * tier);
    if (last >= 0 && idx > last + 1) {
      for (let i = Math.max(last + 1, idx - len + 1); i < idx; i++) writePoint(fd, shape, off, tier, i, [NaN, NaN, NaN]);
    }
    writePoint(fd, shape, off, tier, idx, p);
    if (idx > last) { hdr.writeInt32LE(idx, 8 + 4 * tier); fs.writeSync(fd, hdr, 8 + 4 * tier, 4, 8 + 4 * tier); }
  }
  // a minute's point into T1, then T2 and T3 recomputed from T1's minutes in their buckets
  function writeMinute(node, name, minute, p) {
    fs.mkdirSync(nodeDir(node), { recursive: true });
    const file = path.join(nodeDir(node), fileOf(name)), shape = shapeOf(name), off = offsets(shape);
    if (!fs.existsSync(file)) create(file, shape);
    const fd = fs.openSync(file, "r+");
    try {
      const hdr = Buffer.alloc(HEADER); fs.readSync(fd, hdr, 0, HEADER, 0);
      put(fd, shape, off, hdr, 0, minute, p);
      const last1 = hdr.readInt32LE(8);
      for (let t = 1; t < shape.tiers; t++) {
        const step = TIERS[t].step, b = Math.floor(minute / step);
        let sum = 0, n = 0, lo = Infinity, hi = -Infinity;
        for (let m = b * step; m < (b + 1) * step; m++) {
          if (m > last1 || m <= last1 - TIERS[0].len) continue;
          const q = readPoint(fd, shape, off, 0, m);
          if (Number.isNaN(q[0])) continue;
          sum += q[0]; n++; lo = Math.min(lo, q[1]); hi = Math.max(hi, q[2]);
        }
        put(fd, shape, off, hdr, t, b, n ? [sum / n, lo, hi] : [NaN, NaN, NaN]);
      }
    } finally { fs.closeSync(fd); }
  }
  function close(key, cur) {
    const [node, name] = [key.slice(0, 12), key.slice(13)];
    writeMinute(node, name, cur.minute, [cur.sum / cur.n, cur.min, cur.max]);
  }

  return {
    dir,
    add(node, values) {
      if (!NODE_RE.test(node)) return;
      const minute = Math.floor(now() / MIN);
      for (const [name, v] of Object.entries(values)) {
        if (!finite(v)) continue;
        const key = node + " " + name;
        let cur = open.get(key);
        if (cur && cur.minute !== minute) { close(key, cur); cur = null; }
        if (!cur) { cur = { minute, sum: 0, n: 0, min: v, max: v }; open.set(key, cur); }
        cur.sum += v; cur.n++; cur.min = Math.min(cur.min, v); cur.max = Math.max(cur.max, v);
      }
    },
    // write every open minute: the closed ones for good, the current one as it stands
    flush() {
      const minute = Math.floor(now() / MIN);
      for (const [key, cur] of open) {
        close(key, cur);
        if (cur.minute < minute) open.delete(key);
      }
    },
    query(node, name, range) {
      if (!NODE_RE.test(node) || !Object.prototype.hasOwnProperty.call(RANGES, range)) return null;
      const [tier, count] = RANGES[range], shape = shapeOf(name);
      if (tier >= shape.tiers) return null;
      const cur = open.get(node + " " + name);
      let buf = null;
      try { buf = fs.readFileSync(path.join(nodeDir(node), fileOf(name))); } catch (_) { if (!cur) return null; }
      if (buf && (buf.length < HEADER || buf.toString("latin1", 0, 4) !== "SVH1")) return null;
      const off = offsets(shape), step = TIERS[tier].step, len = TIERS[tier].len, f = shape.fields;
      const last = buf ? buf.readInt32LE(8 + 4 * tier) : -1, end = Math.floor(now() / MIN / step);
      const points = [];
      for (let i = end - count + 1; i <= end; i++) {
        let p = [null, null, null];
        // the minute in progress, from memory (1-minute ranges)
        if (tier === 0 && cur && cur.minute === i) {
          const avg = cur.sum / cur.n;
          p = f === 3 ? [avg, cur.min, cur.max] : [avg, avg, avg];   // a container series keeps averages
        }
        else if (last >= 0 && i <= last && i > last - len) {
          const at = off.at[tier] + ((i % len) * f) * 4, a = buf.readFloatLE(at);
          if (!Number.isNaN(a)) p = f === 3 ? [a, buf.readFloatLE(at + 4), buf.readFloatLE(at + 8)] : [a, a, a];
        }
        points.push([(i * step * MIN) / 1000, ...p.map((x) => (x === null ? null : Math.round(x * 1000) / 1000))]);
      }
      return { step: step * 60, points };
    },
    series(node) {
      if (!NODE_RE.test(node)) return [];
      const names = new Set();
      try { for (const f of fs.readdirSync(nodeDir(node))) if (f.endsWith(".ring")) names.add(nameOf(f)); } catch (_) { /* none written yet */ }
      for (const key of open.keys()) if (key.startsWith(node + " ")) names.add(key.slice(13));
      return [...names];
    },
    remove(node) {
      if (!NODE_RE.test(node)) return;
      for (const key of open.keys()) if (key.startsWith(node + " ")) open.delete(key);
      fs.rmSync(nodeDir(node), { recursive: true, force: true });
    },
    // a series no data reached for 90 days goes (a removed disk or container), and so
    // does the history of a node no longer known (revoked with servitals-ctl)
    sweep(known) {
      const minute = Math.floor(now() / MIN);
      let nodes = [];
      try { nodes = fs.readdirSync(dir).filter((n) => NODE_RE.test(n)); } catch (_) { return; }
      for (const node of nodes) {
        if (known && !known.has(node)) { this.remove(node); continue; }
        for (const f of fs.readdirSync(nodeDir(node)).filter((x) => x.endsWith(".ring"))) {
          const file = path.join(nodeDir(node), f), hdr = Buffer.alloc(HEADER);
          const fd = fs.openSync(file, "r");
          try { fs.readSync(fd, hdr, 0, HEADER, 0); } finally { fs.closeSync(fd); }
          if (minute - hdr.readInt32LE(8) > SWEEP_MIN) fs.rmSync(file, { force: true });
        }
      }
    },
  };
}

module.exports = { createHistory, seriesOf, RANGES, TIERS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 346 tests (9 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/history.js test/history.test.js
git commit -m "feat(hub): history rings: per-node series in 1-minute, 10-minute and hourly points"
```

---

### Task 2: Every push feeds the history; the API answers it

**Files:**
- Modify: `hub/server.js`, `test/agentapi.test.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `createHistory`, `seriesOf` (Task 1).
- Produces: `GET /__ctl/history?node=<id>&series=<name>&range=<1h|24h|7d|30d|90d>` → 200 `{step, points}`, 400 (range) or 404 (node or series). `series=list` → `{series: [names]}`. Logged in only. 6a-2 draws from it.

- [ ] **Step 1: Write the failing test**

In `test/agentapi.test.js`:

1. Replace

```js
    assert.strictEqual(count(), 2, "after a clean push, it is news again");
  });
});

```

   with

```js
    assert.strictEqual(count(), 2, "after a clean push, it is news again");
  });
});

test("history: a push becomes series the page can ask for, and they outlive a restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));   // kept across the restart
  const hub = await startHub({}, { dataDir });
  const c = creds(hub);
  try {
    const cookie = cookieFrom(await login(hub.port));
    const get = async (q) => request(hub.port, { path: "/__ctl/history?" + q, headers: { cookie } });
    assert.strictEqual((await signed(hub, c, { body: snap({ cpu: { usage: 12, cores: 2 }, mem: { total: 200, used: 50 },
      disks: [{ mount: "/", pct: 40 }] }) })).status, 200);
    const list = JSON.parse((await get("series=list")).body);
    assert.deepStrictEqual(list.series.sort(), ["cpu", "disk./.used", "mem"]);
    const r = await get("series=cpu&range=1h");
    assert.strictEqual(r.status, 200);
    const h = JSON.parse(r.body);
    assert.strictEqual(h.step, 60);
    assert.deepStrictEqual(h.points.at(-1).slice(1), [12, 12, 12]);
    assert.deepStrictEqual(JSON.parse((await get(`node=${c.id}&series=mem&range=24h`)).body).points.at(-1).slice(1), [25, 25, 25]);
    assert.strictEqual((await get("series=load1&range=1h")).status, 404);
    assert.strictEqual((await get("series=cpu&range=2h")).status, 400);
    assert.strictEqual((await get("node=bbbbbbbbbbbb&series=cpu&range=1h")).status, 404);
    assert.strictEqual((await request(hub.port, { path: "/__ctl/history?series=cpu&range=1h" })).status, 401, "logged in only");
    await hub.stop();
    const again = await startHub({}, { dataDir });
    try {
      const cookie2 = cookieFrom(await login(again.port));
      const back = JSON.parse((await request(again.port, { path: "/__ctl/history?series=cpu&range=1h", headers: { cookie: cookie2 } })).body);
      assert.deepStrictEqual(back.points.at(-1).slice(1), [12, 12, 12], "flushed on SIGTERM");
    } finally { await again.stop(); }
  } finally { await hub.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentapi.test.js`
Expected: FAIL, 1 test: "history: a push becomes series…" (`TypeError: Cannot read properties of undefined (reading 'sort')`; the route does not exist yet, so the login page answers).

- [ ] **Step 3: The wiring and the route**

In `hub/server.js`:

1. Replace

```js
const { createAgentApi } = require("./lib/agentapi");
const { view: snapshotView } = require("./lib/snapshot");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

   with

```js
const { createAgentApi } = require("./lib/agentapi");
const { view: snapshotView } = require("./lib/snapshot");
const { createHistory, seriesOf } = require("./lib/history");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

2. Replace

```js
  } catch (_) { /* no snapshot yet */ }
}
const agentApi = createAgentApi({
  nodes, log,
```

   with

```js
  } catch (_) { /* no snapshot yet */ }
}
// history (spec 7): ring files per node and series; the current minute in memory
const history = createHistory(path.join(DATA, "history"));
const historyFlush = () => {
  try { history.flush(); } catch (e) { log.warn("history.flush_failed", { error: e.code || String(e) }); }
};
const historySweep = () => {
  try { history.sweep(new Set(nodes.list().map((n) => n.id))); } catch (e) { log.warn("history.sweep_failed", { error: e.code || String(e) }); }
};
setInterval(historyFlush, 60000).unref();
setInterval(historySweep, 86400000).unref();
historySweep();
const agentApi = createAgentApi({
  nodes, log,
```

3. Replace

```js
    const rec = { snap, view: snapshotView(snap, prev && prev.snap, prev ? prev.view.trend : []), at: Date.now() };
    latest.set(id, rec);
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
```

   with

```js
    const rec = { snap, view: snapshotView(snap, prev && prev.snap, prev ? prev.view.trend : []), at: Date.now() };
    latest.set(id, rec);
    try { history.add(id, seriesOf(rec.view)); } catch (e) { log.warn("history.add_failed", { node: id, error: e.code || String(e) }); }
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
```

4. Replace

```js
    }

    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
```

   with

```js
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
      const q = new URL(req.url, "http://x").searchParams;
      const id = q.get("node") || nodes.localId();
      if (!id || !nodes.get(id)) return json(404, { error: "no such node" });
      const series = q.get("series") || "";
      if (series === "list") return json(200, { series: history.series(id) });
      const range = q.get("range") || "24h";
      if (!/^(1h|24h|7d|30d|90d)$/.test(range)) return json(400, { error: "range is 1h, 24h, 7d, 30d or 90d" });
      const r = history.query(id, series, range);
      return r ? json(200, r) : json(404, { error: "no such series" });
    }

    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
```

5. Replace

```js
        latest.delete(id);
        try { fs.unlinkSync(path.join(SNAP_DIR, id + ".json")); } catch (_) { /* never pushed */ }
        log.audit("node.revoked", { ip, node: id });
        return json(200, { ok: true });
```

   with

```js
        latest.delete(id);
        try { fs.unlinkSync(path.join(SNAP_DIR, id + ".json")); } catch (_) { /* never pushed */ }
        try { history.remove(id); } catch (_) { /* swept later */ }
        log.audit("node.revoked", { ip, node: id });
        return json(200, { ok: true });
```

6. Replace

```js
process.on("uncaughtException",  (e) => log.error("process.uncaught_exception", { error: String(e && e.stack || e) }));
process.on("SIGTERM", () => {
  agentApi.close();   // answer open long polls so close() is not held up by them
  server.close(() => process.exit(0));
```

   with

```js
process.on("uncaughtException",  (e) => log.error("process.uncaught_exception", { error: String(e && e.stack || e) }));
process.on("SIGTERM", () => {
  historyFlush();     // a clean restart loses no minute (spec 7)
  agentApi.close();   // answer open long polls so close() is not held up by them
  server.close(() => process.exit(0));
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Hardware (spec 9): a new panel shows fan speeds (a named fan that stopped
  in red), voltages and the battery, from hwmon and
```

   with

```markdown

### Added
- History (spec 7): the hub keeps every node's series (cpu, memory, swap,
  temperature, load, iowait, pressure, network, each disk's use and I/O,
  each container) in ring files under the state directory's `history/`:
  1-minute points for 24 h, 10-minute for 7 days and hourly for 90 days,
  each with average, low and high (containers: 1-minute averages). About
  2 MB per node; written every minute and on stop, so a restart loses
  nothing. `GET /__ctl/history?node=&series=&range=1h|24h|7d|30d|90d`
  answers the page; `series=list` names a node's series. A revoked node's
  history goes, and a series silent for 90 days is swept.
- Hardware (spec 9): a new panel shows fan speeds (a named fan that stopped
  in red), voltages and the battery, from hwmon and
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 347 tests. The budget passes: `ok    gateway RssAnon (idle)` well below 40960 kB.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge. The purge test removes the state directory, `history/` included.

- [ ] **Step 5: Commit**

```bash
git add hub/server.js test/agentapi.test.js CHANGELOG.md
git commit -m "feat(hub): every push feeds the history; GET /__ctl/history answers it"
```
