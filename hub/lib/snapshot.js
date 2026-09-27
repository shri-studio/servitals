// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Snapshots are untrusted input (spec 6.3, docs/protocol.md section 6).
 *   validate(obj) → { ok: true, value } | { ok: false, path }
 *     Numbers must be finite and in range, else the snapshot is refused with
 *     the first failing path. Strings lose control characters and are cut to
 *     their limit; arrays are cut to theirs; unknown keys are dropped.
 *   view(cur, prev, trend) → what the page reads: the validated snapshot plus
 *     values only the hub derives (network rates, container CPU %, the trend).
 */
const MAX_INT = 2 ** 53;

class Invalid extends Error { constructor(path) { super(path); this.path = path; } }

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function str(v, max, path, { optional = true } = {}) {
  if (v === undefined || v === null) { if (optional) return undefined; throw new Invalid(path); }
  if (typeof v !== "string") throw new Invalid(path);
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}
function num(v, lo, hi, path, { optional = true, int = false, nullable = false } = {}) {
  if (v === undefined) { if (optional) return undefined; throw new Invalid(path); }
  if (v === null) { if (nullable || optional) return null; throw new Invalid(path); }
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Invalid(path);
  if (int && !Number.isInteger(v)) throw new Invalid(path);
  return v;
}
function oneOf(v, allowed, path) {
  if (v === undefined || v === null) return undefined;
  if (!allowed.includes(v)) throw new Invalid(path);
  return v;
}
const counter = (v, path, opts) => num(v, 0, MAX_INT, path, { int: true, ...opts });
function bool(v, path) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Invalid(path);
  return v;
}
function list(v, max, path, each) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Invalid(path);
  return v.slice(0, max).map((x, i) => each(x, `${path}[${i}]`));
}
function obj(v, path, build, { optional = true } = {}) {
  if (v === undefined || v === null) { if (optional) return v === null ? null : undefined; throw new Invalid(path); }
  if (!isObj(v)) throw new Invalid(path);
  return build(v, path);
}
// drop undefined members so the stored copy holds only known, present keys
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

const traffic = (t, p) => clean({
  rx: counter(t.rx, `${p}.rx`), tx: counter(t.tx, `${p}.tx`),
  avgRx: num(t.avgRx, 0, MAX_INT, `${p}.avgRx`), avgTx: num(t.avgTx, 0, MAX_INT, `${p}.avgTx`),
});
const bar = (b, p) => obj(b, p, (x) => clean({
  label: str(x.label, 32, `${p}.label`), title: str(x.title, 32, `${p}.title`),
  rx: counter(x.rx, `${p}.rx`), tx: counter(x.tx, `${p}.tx`),
}), { optional: false });
const proc = (x, p) => obj(x, p, (o) => clean({
  pid: num(o.pid, 0, 2 ** 32, `${p}.pid`, { int: true }), name: str(o.name, 64, `${p}.name`),
  cpuPct: num(o.cpuPct, 0, 1e5, `${p}.cpuPct`), rss: counter(o.rss, `${p}.rss`),
}), { optional: false });

function build(s) {
  if (!isObj(s)) throw new Invalid("$");
  const schema = num(s.schema, 1, 1, "$.schema", { optional: false, int: true });
  return clean({
    schema,
    ts: counter(s.ts, "$.ts", { optional: false }),
    interval: num(s.interval, 5, 3600, "$.interval", { optional: false, int: true }),
    agent: str(s.agent, 32, "$.agent"),
    host: obj(s.host, "$.host", (h, p) => clean({
      name: str(h.name, 64, `${p}.name`, { optional: false }),
      os: oneOf(h.os, ["linux", "darwin", "windows", "freebsd"], `${p}.os`),
      distro: str(h.distro, 64, `${p}.distro`), kernel: str(h.kernel, 64, `${p}.kernel`),
      uptime: counter(h.uptime, `${p}.uptime`),
    }), { optional: false }),
    mem: obj(s.mem, "$.mem", (m, p) => clean(Object.fromEntries(
      ["total", "used", "available", "free", "cache", "swapTotal", "swapUsed"].map((k) => [k, counter(m[k], `${p}.${k}`)])))),
    cpu: obj(s.cpu, "$.cpu", (c, p) => clean({
      usage: num(c.usage, 0, 100, `${p}.usage`), cores: num(c.cores, 1, 4096, `${p}.cores`, { int: true }),
      per: list(c.per, 1024, `${p}.per`, (v, q) => num(v, 0, 100, q, { optional: false })),
      load: list(c.load, 3, `${p}.load`, (v, q) => num(v, 0, 1e6, q, { optional: false })),
    })),
    temp: obj(s.temp, "$.temp", (t, p) => clean({
      package: num(t.package, -50, 150, `${p}.package`, { nullable: true }),
      max: num(t.max, -50, 150, `${p}.max`, { nullable: true }),
      sensors: list(t.sensors, 64, `${p}.sensors`, (x, q) => obj(x, q, (o) => clean({
        label: str(o.label, 128, `${q}.label`), value: num(o.value, -50, 150, `${q}.value`, { optional: false }),
      }), { optional: false })),
    })),
    fans: list(s.fans, 32, "$.fans", (x, q) => obj(x, q, (o) => clean({
      label: str(o.label, 128, `${q}.label`), rpm: num(o.rpm, 0, 1e6, `${q}.rpm`, { optional: false }),
    }), { optional: false })),
    battery: obj(s.battery, "$.battery", (b, p) => clean({
      capacity: num(b.capacity, 0, 100, `${p}.capacity`), status: str(b.status, 16, `${p}.status`),
    })),
    disks: list(s.disks, 32, "$.disks", (x, q) => obj(x, q, (d) => clean({
      mount: str(d.mount, 128, `${q}.mount`, { optional: false }), mounted: bool(d.mounted, `${q}.mounted`),
      source: str(d.source, 128, `${q}.source`), model: str(d.model, 128, `${q}.model`),
      fstype: str(d.fstype, 128, `${q}.fstype`), rotational: bool(d.rotational, `${q}.rotational`),
      size: counter(d.size, `${q}.size`), used: counter(d.used, `${q}.used`), avail: counter(d.avail, `${q}.avail`),
      pct: num(d.pct, 0, 100, `${q}.pct`),
    }), { optional: false })),
    io: list(s.io, 32, "$.io", (x, q) => obj(x, q, (d) => clean({
      device: str(d.device, 128, `${q}.device`, { optional: false }),
      readBytes: counter(d.readBytes, `${q}.readBytes`), writeBytes: counter(d.writeBytes, `${q}.writeBytes`),
    }), { optional: false })),
    net: obj(s.net, "$.net", (n, p) => clean({
      iface: str(n.iface, 128, `${p}.iface`), rxBytes: counter(n.rxBytes, `${p}.rxBytes`), txBytes: counter(n.txBytes, `${p}.txBytes`),
      vnstat: obj(n.vnstat, `${p}.vnstat`, (v, q) => clean({
        today: obj(v.today, `${q}.today`, traffic), month: obj(v.month, `${q}.month`, traffic),
        total: obj(v.total, `${q}.total`, traffic),
        days: list(v.days, 31, `${q}.days`, bar), hours: list(v.hours, 24, `${q}.hours`, bar),
      })),
    })),
    docker: list(s.docker, 200, "$.docker", (x, q) => obj(x, q, (c) => clean({
      name: str(c.name, 128, `${q}.name`, { optional: false }), id: str(c.id, 128, `${q}.id`),
      state: str(c.state, 32, `${q}.state`), status: str(c.status, 128, `${q}.status`),
      health: c.health === null ? null : str(c.health, 32, `${q}.health`),
      cpuUsec: counter(c.cpuUsec, `${q}.cpuUsec`, { nullable: true }),
      mem: counter(c.mem, `${q}.mem`, { nullable: true }),
    }), { optional: false })),
    processes: obj(s.processes, "$.processes", (pr, p) => clean({
      cpu: list(pr.cpu, 5, `${p}.cpu`, proc), mem: list(pr.mem, 5, `${p}.mem`, proc),
    })),
    ubuntu: obj(s.ubuntu, "$.ubuntu", (u, p) => clean({
      updates: num(u.updates, 0, 1e6, `${p}.updates`, { int: true }),
      security: num(u.security, 0, 1e6, `${p}.security`, { int: true }),
      rebootRequired: bool(u.rebootRequired, `${p}.rebootRequired`),
      rebootPkgs: list(u.rebootPkgs, 32, `${p}.rebootPkgs`, (v, q) => str(v, 128, q, { optional: false })),
      failedUnits: list(u.failedUnits, 32, `${p}.failedUnits`, (v, q) => str(v, 128, q, { optional: false })),
    })),
  });
}

function validate(s) {
  try { return { ok: true, value: build(s) }; }
  catch (e) { if (e instanceof Invalid) return { ok: false, path: e.path }; throw e; }
}

// bytes per second between two counters, or null when they cannot be compared
function rate(cur, prev, dtMs) {
  if (typeof cur !== "number" || typeof prev !== "number" || !(dtMs > 0) || cur < prev) return null;
  return Math.round((cur - prev) / (dtMs / 1000));
}

const TREND_LEN = 60;
function trendPoint(s) {
  const m = s.mem;
  return {
    cpu: s.cpu && typeof s.cpu.usage === "number" ? s.cpu.usage : null,
    mem: m && m.total > 0 ? Math.round((m.used * 1000) / m.total) / 10 : null,
    temp: s.temp && typeof s.temp.package === "number" ? s.temp.package : null,
  };
}

// the page's view of a node: validated data plus what only the hub derives
function view(cur, prev, trend = []) {
  const dt = prev ? cur.ts - prev.ts : 0;
  const out = { ...cur };
  if (cur.net) {
    const sameIface = prev && prev.net && prev.net.iface === cur.net.iface;
    const v = cur.net.vnstat || {};
    out.net = {
      iface: cur.net.iface,
      rateRx: sameIface ? rate(cur.net.rxBytes, prev.net.rxBytes, dt) : null,
      rateTx: sameIface ? rate(cur.net.txBytes, prev.net.txBytes, dt) : null,
      today: v.today, month: v.month, total: v.total, days: v.days, hours: v.hours,
    };
  }
  if (cur.docker) {
    const before = new Map((prev && prev.docker || []).map((c) => [c.id || c.name, c]));
    const cores = (cur.cpu && cur.cpu.cores) || 1;
    out.docker = cur.docker.map((c) => {
      const p = before.get(c.id || c.name);
      let cpu = null;
      if (p && typeof c.cpuUsec === "number" && typeof p.cpuUsec === "number" && dt > 0 && c.cpuUsec >= p.cpuUsec) {
        cpu = Math.min(100, Math.round((1000 * (c.cpuUsec - p.cpuUsec)) / (dt * 1000 * cores)) / 10);
      }
      const { cpuUsec, ...rest } = c;
      return { ...rest, cpu };
    });
  }
  out.trend = [...trend, trendPoint(cur)].slice(-TREND_LEN);
  return out;
}

module.exports = { validate, view, trendPoint, TREND_LEN };
