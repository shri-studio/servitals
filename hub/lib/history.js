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
