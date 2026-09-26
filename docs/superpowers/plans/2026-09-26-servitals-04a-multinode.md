# servitals Multi-node Core (sub-project 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch several servers from one hub: pair a server with `servitals-ctl node add` and `servitals-agent join`, validate every snapshot against the protocol, derive rates on the hub, show a fleet grid with node tabs, and let agents reach the hub through HTTP proxies, TLS with a private CA and Cloudflare Access.

**Architecture:** Agents send protocol-shaped snapshots (schema 1, `ts` in ms, counters instead of rates). `hub/lib/snapshot.js` validates them and builds the page's **view** (network rates, container CPU %, a 60-point trend) from the previous snapshot, so the page reads derived values only (spec 6.3). `hub/lib/fleet.js` computes liveness and card numbers. The node store gains add/rename/revoke/list with a CLI behind `servitals-ctl node`. The hub serves `/__ctl/nodes`, `/__ctl/node/<id>`, `/__ctl/refresh?node=<id|all>`, refuses container controls for remote nodes, slows down addresses that keep failing agent authentication, and keeps replay counters across restarts. The page opens on a fleet grid with tabs once there is a second node. `servitals-agent join|status` pair and inspect an agent; `HUB_HEADERS` and `HUB_CA_FILE` cover tunnels and private CAs.

**Tech Stack:** Node.js ≥ 18 (built-ins), bash, jq, curl, openssl (tests only), debhelper/autopkgtest from sub-project 3.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` sections 5.2 (proxies, `WAIT_SECONDS`), 6.1 (pairing, join results), 6.2 (liveness, wake), 6.3 (validation, derived values), 6.4 (local-only powers), 10.1 (layout B), 13.4 (autopkgtest pairs a second agent), 15.1 (`docs/networking.md`), 19 (proxy tests), 20 row 4; `docs/protocol.md` sections 4, 5.5, 6.

**Scope (4a of sub-project 4):** 4b code-based linking (RFC 8628), 4c style registry and CSP-safe ES modules, 4d customization and config as code, 4e backup and rotation CLI follow as their own plans.

**Proven before writing:** every code block was built and run in a scratch copy on 2026-09-26: node suite 167 tests on Node 24 and Node 18, shellcheck at CI settings, budget (page 23.1 KB gz, agent tick 200 ms, 9 MB), Docker smoke test, both series built and lintian clean (134 KB / 19 KB), autopkgtest smoke (now pairing a second agent) and purge on noble and resolute, and the install-local migration test.

## Global Constraints

- Everything from sub-projects 1-3 still holds: zero runtime dependencies (hub: Node built-ins; agent: bash, coreutils, jq, curl, optional vnstat), Node 18 compatibility (no `fetch` in `hub/` or `test/`), SPDX headers, lintian clean, `.deb` ≤ 500 KB, systemd exposure ≤ 2.0, the lightness budget.
- Protocol v1 (`docs/protocol.md`): snapshot `schema: 1`, `ts` in **milliseconds**, `interval` 5..3600, counters (`net.rxBytes`, `net.txBytes`, `docker[].cpuUsec`), no rates from agents; limits from protocol section 6 (hostname 64, labels 128, disks 32, containers 200, sensors 64, processes 5 per list); numbers out of range fail with the first path; strings lose control characters and are cut; unknown keys are dropped.
- Liveness (spec 6.2): online while pushes arrive; stale after 3 × interval; offline after max(10 min, 5 × interval).
- Node secrets never reach the page, the logs or `node list`; a join string is printed once, by `servitals-ctl node add`.
- Container controls (`/__ctl/container/*`) act only on the hub's own host, whatever the page sends (spec 6.4).
- The live dashboard runs on this host (native install, port 20002). All tests run in temp dirs and containers; do not touch `/etc/servitals`, `/var/lib/servitals` or the running units.
- Work in a worktree `.claude/worktrees/servitals-multinode` on branch `feat/multinode` from `main` (2fc2b81).
- Docker Hub may time out on this host: `IMAGE_PREFIX=mirror.gcr.io/library/` for the package scripts, `INSTALL_SMOKE_IMAGE=mirror.gcr.io/library/ubuntu:26.04`.
- Every `local` variable used in an `EXIT` trap is a bug (twice in this project): use a global.
- `pkill -f <pattern>` inside a shell command also matches that shell and kills it; find PIDs first.
- Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers. OpenWolf: log fixed bugs in `.wolf/buglog.json`.

## Review Focus

1. **Agents behind proxies and tunnels**: CONNECT with `Proxy-Authorization`, an HTTPS hub signed by a private CA, Cloudflare Access headers; the hub host's own agent never uses the proxy; no credential reaches the agent's output. Test: Task 3, `test/proxy.test.js`.
2. **A hostile or broken remote node**: out-of-range numbers, huge lists, control characters and `<script>` in names must not reach the page unvalidated or unescaped; one bad node must not affect others. Tests: Task 1 `test/snapshot.test.js`; Task 4 checks the fleet markup goes through `esc()`.
3. **Counters that reset** (reboot, new interface, container restart) must not produce negative or huge rates. Test: Task 1, "a counter that went backwards gives no rate".
4. **A leaked join string or a retired server**: `node revoke` refuses the agent at once and removes it from the fleet; a client that keeps failing authentication gets `429`; replays stay refused after a hub restart. Tests: Task 3 `test/agentapi.test.js`, `test/multinode.test.js`.
5. **Pairing mistakes**: a mistyped secret, an unknown id and an unreachable hub each get a plain-language answer from `join`, and nothing is saved. Test: Task 5, "join explains what went wrong and saves nothing".

---

### Task 1: Snapshot validation, derived view, fleet helpers

**Files:**
- Create: `hub/lib/snapshot.js`, `hub/lib/fleet.js`, `test/snapshot.test.js`, `test/fleet.test.js`

**Interfaces:**
- Produces: `validate(obj) → { ok: true, value } | { ok: false, path }`, `view(cur, prev, trend = []) → view` (adds `net.rateRx/rateTx` or `null`, `docker[].cpu` % or `null`, drops `cpuUsec`, flattens `net.vnstat` into `net.today/month/total/days/hours`, appends to `trend`, max 60 points `{cpu, mem, temp}`), `trendPoint`, `TREND_LEN` from `snapshot.js`; `status(lastPushMs, intervalS, now) → "waiting"|"online"|"stale"|"offline"` and `summary(view) → { host, cpu, mem, temp, disk: {mount, pct}, containers, running, trend }` from `fleet.js`. Task 3 wires both into the hub.

- [ ] **Step 1: Write the failing tests**

Create `test/snapshot.test.js`:

```js
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
```

Create `test/fleet.test.js`:

```js
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
    host: { name: "nas", distro: "Ubuntu" }, cpu: { usage: 12.4 }, mem: { total: 200, used: 50 }, temp: { package: 46 },
    disks: [{ mount: "/", pct: 40 }, { mount: "/srv", pct: 93 }, { mount: "/mnt/x", mounted: false }],
    docker: [{ state: "running" }, { state: "exited" }], trend: Array.from({ length: 30 }, (_, i) => ({ cpu: i })),
  });
  assert.deepStrictEqual(s.disk, { mount: "/srv", pct: 93 });
  assert.deepStrictEqual([s.cpu, s.mem, s.temp, s.containers, s.running], [12.4, 25, 46, 2, 1]);
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/snapshot.test.js test/fleet.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/snapshot'` and `'../hub/lib/fleet'`.

- [ ] **Step 3: Write `hub/lib/snapshot.js`**

```js
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
```

- [ ] **Step 4: Write `hub/lib/fleet.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Fleet view helpers (spec 6.2, 10.1).
 *   status(lastPushMs, intervalS, now) → "waiting" | "online" | "stale" | "offline"
 *     online while pushes arrive; stale after 3 × interval without one;
 *     offline after max(10 min, 5 × interval).
 *   summary(view) → the numbers a fleet card shows.
 */
function status(at, interval, now = Date.now()) {
  if (!at) return "waiting";
  const iv = Math.max(5, interval || 60) * 1000;
  const age = now - at;
  if (age <= 3 * iv) return "online";
  if (age <= Math.max(600000, 5 * iv)) return "stale";
  return "offline";
}

function summary(v) {
  if (!v) return null;
  const mem = v.mem && v.mem.total > 0 ? Math.round((v.mem.used * 100) / v.mem.total) : null;
  const disks = (v.disks || []).filter((d) => d.mounted !== false && typeof d.pct === "number");
  const fullest = disks.reduce((a, d) => (!a || d.pct > a.pct ? d : a), null);
  const docker = Array.isArray(v.docker) ? v.docker : null;
  return {
    host: v.host ? { name: v.host.name, distro: v.host.distro } : null,
    cpu: v.cpu && typeof v.cpu.usage === "number" ? v.cpu.usage : null,
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
    disk: fullest ? { mount: fullest.mount, pct: fullest.pct } : null,
    containers: docker ? docker.length : null,
    running: docker ? docker.filter((c) => c.state === "running").length : null,
    trend: (v.trend || []).slice(-20).map((p) => p.cpu),
  };
}

module.exports = { status, summary };
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (8 new tests).

- [ ] **Step 6: Commit**

```bash
git add hub/lib/snapshot.js hub/lib/fleet.js test/snapshot.test.js test/fleet.test.js
git commit -m "feat(hub): protocol snapshot validation, derived view, fleet liveness" -m "validate() checks every field of schema 1 against its range, cuts strings and lists, drops unknown keys and names the first bad path. view() derives network rates, container CPU and a 60-point trend from the previous snapshot. fleet.status() follows spec 6.2."
```

---

### Task 2: Node store management and `servitals-ctl node`

**Files:**
- Modify: `hub/lib/nodes.js` (whole file), `bin/servitals-ctl`, `test/cli.test.js`

**Interfaces:**
- Consumes: `createNodeStore` from sub-project 2.
- Produces: store methods `add(name, tags = []) → { id, secret }`, `rename(id, name)`, `revoke(id)` (sets `revoked`, clears the secret; the local node cannot be revoked), `list() → [{ id, name, local, created, tags }]` (no secrets, no revoked nodes); CLI `node hub/lib/nodes.js <nodes.json> add <name> [tag...] | list | rename <id> <name> | revoke <id>` (JSON on stdout, exit 1 with a message on stderr); `servitals-ctl node add <name> [--tag T]... | list | rename <id> <name> | revoke <id>`. `node add` prints `sudo servitals-agent join <hub-url> <id>:<secret>`, where hub-url is `PUBLIC_URL` (from `ETC_DIR/hub.env`, then `<checkout>/.env`), else `http://<hostname -f>:<PORT>`. After every change `nodes.json` is chowned to the state directory's owner and made 0600.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test("node rename and revoke", () => {
  const state = tmp();
  const add = run("servitals-ctl", ["node", "add", "old name"], { STATE_DIR: state, ETC_DIR: "/nonexistent" });
  const id = /node ([a-z2-7]{12})/.exec(add.stdout)[1];
  assert.strictEqual(run("servitals-ctl", ["node", "rename", id, "new name"], { STATE_DIR: state }).status, 0);
  assert.match(run("servitals-ctl", ["node", "list"], { STATE_DIR: state }).stdout, /new name/);
  assert.strictEqual(run("servitals-ctl", ["node", "revoke", id], { STATE_DIR: state }).status, 0);
  assert.doesNotMatch(run("servitals-ctl", ["node", "list"], { STATE_DIR: state }).stdout, new RegExp(id));
  assert.strictEqual(fs.statSync(path.join(state, "nodes.json")).mode & 0o777, 0o600);
  assert.notStrictEqual(run("servitals-ctl", ["node", "add", ""], { STATE_DIR: state }).status, 0);
});

test("node add takes tags with --tag", () => {
  const state = tmp();
  const r = run("servitals-ctl", ["node", "add", "nas", "--tag", "home", "--tag", "lab"], { STATE_DIR: state, ETC_DIR: "/nonexistent" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(run("servitals-ctl", ["node", "list"], { STATE_DIR: state }).stdout, / nas +remote +home,lab /);
  assert.notStrictEqual(run("servitals-ctl", ["node", "add", "x", "--tag"], { STATE_DIR: state }).status, 0);
  assert.notStrictEqual(run("servitals-ctl", ["node", "add", "x", "--tag", "Bad Tag"], { STATE_DIR: state }).status, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/cli.test.js`
Expected: FAIL: `servitals-ctl node` prints the usage text and exits 1.

- [ ] **Step 3: Replace `hub/lib/nodes.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * nodes.json: { "<node id>": { name, secret, local, created, tags?, revoked? } }, mode 0600.
 * Re-read when its mtime changes, so servitals-ctl can edit it without a
 * restart. A file that does not parse keeps the last good copy in memory.
 */
const crypto = require("crypto");
const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const newNodeId = () => [...crypto.randomBytes(12)].map((b) => B32[b & 31]).join("");

function createNodeStore(file) {
  let nodes = {};
  let mtime = -1;
  let unreadable = false;   // the file exists but never parsed: never overwrite it

  function load() {
    let st;
    try { st = fs.statSync(file); } catch (_) { nodes = {}; mtime = -1; unreadable = false; return nodes; }
    if (st.mtimeMs === mtime) return nodes;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      nodes = parsed;
      mtime = st.mtimeMs;
      unreadable = false;
    } catch (_) {
      // half-written or bad hand edit: keep the last good copy; with none, refuse to write
      if (mtime === -1) unreadable = true;
    }
    return nodes;
  }

  function save() {
    writeFileAtomic(file, JSON.stringify(nodes, null, 2) + "\n", 0o600);
    mtime = fs.statSync(file).mtimeMs;
  }

  function get(id) {
    const n = Object.prototype.hasOwnProperty.call(load(), id) ? nodes[id] : null;
    return n && !n.revoked ? n : null;
  }

  function localId() {
    const all = load();
    return Object.keys(all).find((id) => all[id].local && !all[id].revoked) || null;
  }

  function ensureLocal(name) {
    const existing = localId();
    if (existing) return { id: existing, created: false };
    if (unreadable) throw new Error(`${file} exists but does not parse; fix or remove it`);
    const id = newNodeId();
    nodes[id] = { name, secret: crypto.randomBytes(32).toString("hex"), local: true, created: Date.now() };
    save();
    return { id, created: true };
  }

  const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
  const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  function checkName(name) {
    const n = String(name || "").trim();
    if (!NAME.test(n)) throw new Error("name: 1-64 printable characters");
    return n;
  }

  // a remote node: returns its id and secret (the secret is shown once, in the join string)
  function add(name, tags = []) {
    const clean = checkName(name);
    for (const t of tags) if (!TAG.test(t)) throw new Error(`tag "${t}": lowercase letters, digits, dot, dash, underscore`);
    load();
    let id;
    do { id = newNodeId(); } while (nodes[id]);
    const secret = crypto.randomBytes(32).toString("hex");
    nodes[id] = { name: clean, secret, local: false, created: Date.now(), tags };
    save();
    return { id, secret };
  }

  function change(id, fn) {
    load();
    if (!Object.prototype.hasOwnProperty.call(nodes, id) || nodes[id].revoked) throw new Error(`no node ${id}`);
    fn(nodes[id]);
    save();
  }
  const rename = (id, name) => change(id, (n) => { n.name = checkName(name); });
  const revoke = (id) => change(id, (n) => {
    if (n.local) throw new Error("the local node cannot be revoked");
    n.revoked = true;
    n.secret = "";
  });

  // every node that is not revoked, without secrets
  function list() {
    const all = load();
    return Object.keys(all).filter((id) => !all[id].revoked).map((id) => ({
      id, name: all[id].name, local: !!all[id].local, created: all[id].created, tags: all[id].tags || [],
    }));
  }

  return { get, localId, ensureLocal, add, rename, revoke, list, all: load };
}

const localAgentEnv = (hubUrl, id, secret) => `HUB_URL=${hubUrl}\nNODE_ID=${id}\nNODE_SECRET=${secret}\n`;

module.exports = { createNodeStore, newNodeId, localAgentEnv };

// CLI for servitals-ctl: node nodes.js <nodes.json> add <name> [tag...] | list | rename <id> <name> | revoke <id>
if (require.main === module) {
  const [file, cmd, ...args] = process.argv.slice(2);
  try {
    const store = createNodeStore(file);
    let out;
    if (cmd === "add") out = store.add(args[0], args.slice(1));
    else if (cmd === "list") out = store.list();
    else if (cmd === "rename") { store.rename(args[0], args[1]); out = { ok: true }; }
    else if (cmd === "revoke") { store.revoke(args[0]); out = { ok: true }; }
    else throw new Error("usage: nodes.js <nodes.json> add|list|rename|revoke ...");
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Add `node` to `servitals-ctl`**

In `bin/servitals-ctl`:

1. Replace

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals-ctl: admin commands for the servitals hub.
#   servitals-ctl bans                 list blocked IPs and the whitelist
#   servitals-ctl unban <ip>           remove a block (takes effect immediately)
```

   with

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals-ctl: admin commands for the servitals hub.
#   servitals-ctl node add <name> [--tag T]...  add a server; prints the join command for it
#   servitals-ctl node list            list servers (id, name, tags, last push)
#   servitals-ctl node rename <id> <name> | node revoke <id>
#   servitals-ctl bans                 list blocked IPs and the whitelist
#   servitals-ctl unban <ip>           remove a block (takes effect immediately)
```

2. Replace

```bash
}

case "${1:-}" in
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

   with

```bash
}

# the address agents use: PUBLIC_URL, else this host and the hub's PORT
hub_url() {
  local url port
  url=$(env_get "$ETC_DIR/hub.env" PUBLIC_URL 2>/dev/null || true)
  [ -n "$url" ] || url=$(env_get "$ROOT/.env" PUBLIC_URL 2>/dev/null || true)
  if [ -n "$url" ]; then echo "${url%/}"; return; fi
  port=$(env_get "$ETC_DIR/hub.env" PORT 2>/dev/null || true)
  [ -n "$port" ] || port=$(env_get "$ROOT/.env" PORT 2>/dev/null || true)
  echo "http://$(hostname -f 2>/dev/null || hostname):${port:-20002}"
}

nodes_js() {  # run the node store CLI, then give the file back to the hub's user
  local f="$DATA_DIR/nodes.json" rc=0
  node "$ROOT/hub/lib/nodes.js" "$f" "$@" || rc=$?
  if [ -e "$f" ]; then
    chown --reference="$DATA_DIR" "$f" 2>/dev/null || true
    chmod 600 "$f"
  fi
  return "$rc"
}

cmd_node() {
  local sub=${1:-} out id at
  shift || true
  [ -d "$DATA_DIR" ] || die "state directory $DATA_DIR does not exist"
  case "$sub" in
    add)
      local name=${1:-} tags=()
      [ -n "$name" ] && shift || die "usage: servitals-ctl node add <name> [--tag TAG]..."
      while [ $# -gt 0 ]; do
        [ "$1" = --tag ] && [ -n "${2:-}" ] || die "usage: servitals-ctl node add <name> [--tag TAG]..."
        tags+=("$2"); shift 2
      done
      out=$(nodes_js add "$name" "${tags[@]}") || exit 1
      id=$(jq -r .id <<< "$out")
      echo "added \"$name\" as node $id. On that server, run once (the secret is shown only now):"
      echo "  sudo servitals-agent join $(hub_url) $id:$(jq -r .secret <<< "$out")"
      ;;
    list)
      printf '%-13s %-24s %-7s %-20s %s\n' ID NAME KIND TAGS "LAST PUSH"
      nodes_js list | jq -r '.[] | [.id, .name, (if .local then "local" else "remote" end), ((.tags // []) | join(","))] | @tsv' |
        while IFS=$'\t' read -r id name kind tags; do
          at=$(jq -r '.at // empty' "$DATA_DIR/snapshots/$id.json" 2>/dev/null || true)
          if [ -n "$at" ]; then at=$(date -d "@$((at / 1000))" '+%F %T'); else at="never"; fi
          printf '%-13s %-24s %-7s %-20s %s\n' "$id" "$name" "$kind" "${tags:--}" "$at"
        done
      ;;
    rename)
      [ $# -eq 2 ] || die "usage: servitals-ctl node rename <id> <name>"
      nodes_js rename "$1" "$2" >/dev/null && echo "renamed $1 to \"$2\""
      ;;
    revoke)
      [ $# -eq 1 ] || die "usage: servitals-ctl node revoke <id>"
      nodes_js revoke "$1" >/dev/null && echo "revoked $1: its agent is refused from now on"
      ;;
    *) die "usage: servitals-ctl node add|list|rename|revoke" ;;
  esac
}

case "${1:-}" in
  node) shift; cmd_node "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

3. Replace

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

   with

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

- [ ] **Step 5: Run all tests and shellcheck**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-ctl`
Expected: PASS, no shellcheck output.

- [ ] **Step 6: Commit**

```bash
git add hub/lib/nodes.js bin/servitals-ctl test/cli.test.js
git commit -m "feat(ctl): node add, list, rename and revoke" -m "node add prints the join command with the node's secret once. The node store keeps tags, never lists secrets or revoked nodes, and refuses to revoke the local node. servitals-ctl gives nodes.json back to the hub's user."
```

---
### Task 3: Protocol snapshots end to end, fleet API, hub hardening

The agent now sends protocol-shaped snapshots and the hub serves the page a derived view. Until Task 4 the page shows snapshot times as long ago (it still reads `ts` as seconds); do Task 4 next.

**Files:**
- Modify (whole files): `agent/collect.sh`, `agent/lib/net.sh`, `agent/lib/docker.sh`, `agent/lib/api.sh`, `hub/lib/agentapi.js`
- Remove: `agent/lib/trend.sh` (the hub keeps the trend now)
- Modify: `hub/server.js`, `test/agentapi.test.js`, `test/agent-docker.test.js`
- Create: `test/multinode.test.js`, `test/proxy.test.js`

**Interfaces:**
- Consumes: `validate`, `view` (Task 1), `fleet.status/summary` (Task 1), node store `list/add/revoke` (Task 2).
- Produces: agent snapshot `{ schema: 1, ts (ms), interval, agent, host: {..., os: "linux"}, mem, cpu, temp, disks, net: { iface, rxBytes, txBytes, vnstat }, docker: [{..., cpuUsec, mem}] }`; agent env `HUB_HEADERS` (`"Name: value; Name: value"`), `HUB_CA_FILE`; agent state file `$STATE/last-push` (`<epoch s> <status> <error|->`, used by Task 5); `createAgentApi({ ..., replayFile, clientIp })` with `onSnapshot(id, validatedSnap)`, `lastWakeAt(id)`, `FAIL_LIMIT = 30` per minute per client address; hub state `STATE_DIR/snapshots/<id>.json = { snap, view, at }`, `STATE_DIR/replay.json` (0600); HTTP `GET /__ctl/nodes`, `GET /__ctl/node/<id>` (view + `node: { id, name, local, tags, created, status, lastSeen }`), `POST /__ctl/refresh?node=<id|all>` (`{ ok, woke, fresh }` for one node, `{ ok, woke: <count> }` for all; no `node` means the local node), `/__ctl/container/...?node=<id>` → 403 for any node but the local one. `/data.json` serves the local view.

- [ ] **Step 1: Write the failing tests**

In `test/agentapi.test.js`:

1. Replace

```js
      ...headers,
    },
  }).then((r) => ({ ...r, ts }));
}
const snap = (extra = {}) => JSON.stringify({ ts: Math.floor(Date.now() / 1000), interval: 60, host: { name: "t" }, ...extra });
const err = (r) => JSON.parse(r.body).error;
const replyOk = (r, c) => r.headers["x-servitals-sig"] === signReply(c.secret, r.ts, r.body);

async function withHub(fn, env = {}) {
```

   with

```js
      ...headers,
    },
  }).then((r) => ({ ...r, ts }));
}
const snap = (extra = {}) => JSON.stringify({ schema: 1, ts: Date.now(), interval: 60, host: { name: "t", os: "linux" }, ...extra });
const err = (r) => JSON.parse(r.body).error;
const replyOk = (r, c) => r.headers["x-servitals-sig"] === signReply(c.secret, r.ts, r.body);

async function withHub(fn, env = {}) {
```

2. Replace

```js
    const badSig = await signed(hub, c, { body: snap(), secret: "ff".repeat(32) });
    assert.deepStrictEqual([badSig.status, err(badSig)], [401, "bad_signature"]);
    assert.strictEqual((await signed(hub, c, { body: snap(), path: PUSH + "?x=1" })).status, 400);
    assert.strictEqual((await signed(hub, c, { method: "GET", body: "" })).status, 405);
    for (const [body, where] of [["[1]", "$"], ["nope", "$"], ['{"host":{}}', "$.ts"],
                                 ['{"ts":1,"host":"x"}', "$.host"], ['{"ts":1,"host":{},"interval":1}', "$.interval"]]) {
      const bad = await signed(hub, c, { body });
      assert.deepStrictEqual([bad.status, err(bad), JSON.parse(bad.body).path], [422, "invalid_snapshot", where], body);
    }
    const big = await signed(hub, c, { body: snap({ pad: "x".repeat(300 * 1024) }) });
```

   with

```js
    const badSig = await signed(hub, c, { body: snap(), secret: "ff".repeat(32) });
    assert.deepStrictEqual([badSig.status, err(badSig)], [401, "bad_signature"]);
    assert.strictEqual((await signed(hub, c, { body: snap(), path: PUSH + "?x=1" })).status, 400);
    assert.strictEqual((await signed(hub, c, { method: "GET", body: "" })).status, 405);
    for (const [body, where] of [["[1]", "$"], ["nope", "$"],
                                 ['{"schema":2,"ts":1,"interval":60,"host":{"name":"x"}}', "$.schema"],
                                 ['{"schema":1,"interval":60,"host":{"name":"x"}}', "$.ts"],
                                 ['{"schema":1,"ts":1,"interval":60,"host":"x"}', "$.host"],
                                 ['{"schema":1,"ts":1,"interval":1,"host":{"name":"x"}}', "$.interval"]]) {
      const bad = await signed(hub, c, { body });
      assert.deepStrictEqual([bad.status, err(bad), JSON.parse(bad.body).path], [422, "invalid_snapshot", where], body);
    }
    const big = await signed(hub, c, { body: snap({ pad: "x".repeat(300 * 1024) }) });
```

3. Replace

```js
    assert.ok(Date.now() - started >= 4500);
  });
});

```

   with

```js
    assert.ok(Date.now() - started >= 4500);
  });
});

test("an address that keeps failing authentication is slowed down", async () => {
  await withHub(async (hub, c) => {
    for (let i = 0; i < 30; i++) {
      assert.strictEqual((await signed(hub, c, { body: snap(), secret: "ab".repeat(32) })).status, 401);
    }
    const blocked = await signed(hub, c, { body: snap() });
    assert.strictEqual(blocked.status, 429, "even a good request waits out the minute");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
  });
});

test("a captured push cannot be replayed after a hub restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  const a = await startHub({}, { dataDir: dir });
  const c = creds(a);
  const body = snap();
  let first;
  try {
    first = await signed(a, c, { body });
    assert.strictEqual(first.status, 200);
  } finally { await a.stop(); }
  const b = await startHub({}, { dataDir: dir });
  try {
    const again = await signed(b, c, { body, ts: first.ts });
    assert.deepStrictEqual([again.status, JSON.parse(again.body).error], [401, "replay"]);
    assert.strictEqual(fs.statSync(path.join(dir, "replay.json")).mode & 0o777, 0o600);
  } finally { await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

```

In `test/agent-docker.test.js`:

1. Replace

```js
}

test("containers from the API socket, memory and CPU from the cgroup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dk-"));
  const host = path.join(dir, "host");
```

   with

```js
}

test("containers from the API socket, memory and the CPU-time counter from the cgroup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dk-"));
  const host = path.join(dir, "host");
```

2. Replace

```js
    assert.deepStrictEqual(first[0], {
      name: "web", id: ID1, state: "running", status: "Up 2 hours (healthy)",
      health: "healthy", cpu: null, mem: 5242880,
    });
    assert.strictEqual(first[1].mem, null);
    assert.strictEqual(first[1].health, null);
    // +0.1 s of CPU: a clear non-zero percentage even on a slow runner
    fs.writeFileSync(path.join(cg, "cpu.stat"), "usage_usec 1100000\nuser_usec 600000\n");
    const second = await dockerJson(host, state, api.sock);
    assert.strictEqual(typeof second[0].cpu, "number");
    assert.ok(second[0].cpu > 0 && second[0].cpu <= 100, String(second[0].cpu));
    assert.match(fs.readFileSync(path.join(state, "docker-cpu"), "utf8"), new RegExp(`^${ID1} 1100000 \\d+$`, "m"));
  } finally {
    await api.close();
```

   with

```js
    assert.deepStrictEqual(first[0], {
      name: "web", id: ID1, state: "running", status: "Up 2 hours (healthy)",
      health: "healthy", cpuUsec: 1000000, mem: 5242880,
    });
    assert.deepStrictEqual([first[1].cpuUsec, first[1].mem, first[1].health], [null, null, null]);
  } finally {
    await api.close();
```

Create `test/multinode.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { signRequest } = require("../hub/lib/agentsig");

const NODES_JS = path.join(__dirname, "..", "hub", "lib", "nodes.js");
const PUSH = "/api/v1/agent/push";
const WAIT = "/api/v1/agent/wait";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addNode(hub, name) {
  return JSON.parse(execFileSync(process.execPath, [NODES_JS, path.join(hub.dataDir, "nodes.json"), "add", name, "lab"]).toString());
}
let lastTs = 0;
const nextTs = () => String(lastTs = Math.max(Date.now(), lastTs + 1));
function signed(hub, c, { method = "POST", path: p = PUSH, body = "", ts = nextTs(), headers = {}, secret = c.secret } = {}) {
  const buf = Buffer.from(body);
  return request(hub.port, {
    method, path: p, body: buf.length ? buf : undefined,
    headers: { "content-type": "application/json", "content-length": buf.length, "x-servitals-proto": "1",
      "x-servitals-agent": "test/0", "x-servitals-node": c.id, "x-servitals-ts": ts,
      "x-servitals-sig": signRequest(secret, method, p, ts, buf), ...headers },
  }).then((r) => ({ ...r, ts }));
}
const snap = (over = {}) => JSON.stringify({
  schema: 1, ts: Date.now(), interval: 60, host: { name: "nas", os: "linux", distro: "Ubuntu" },
  cpu: { usage: 5, cores: 2 }, mem: { total: 100, used: 30 },
  disks: [{ mount: "/srv", mounted: true, pct: 91 }],
  net: { iface: "eth0", rxBytes: 1000, txBytes: 0 }, docker: [{ name: "db", id: "d1", state: "running", cpuUsec: 0, mem: 1 }],
  ...over,
});
const getJSON = async (hub, cookie, p) => {
  const r = await request(hub.port, { path: p, headers: { cookie } });
  return { status: r.status, body: JSON.parse(r.body) };
};

test("a second node joins the fleet and gets its own view", { timeout: 60000 }, async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    const before = await getJSON(hub, cookie, "/__ctl/nodes");
    assert.deepStrictEqual(before.body.map((n) => [n.local, n.status]), [[true, "waiting"], [false, "waiting"]]);

    assert.strictEqual((await signed(hub, nas, { body: snap() })).status, 200);
    const list = (await getJSON(hub, cookie, "/__ctl/nodes")).body;
    const card = list.find((n) => n.id === nas.id);
    assert.strictEqual(card.status, "online");
    assert.deepStrictEqual(card.tags, ["lab"]);
    assert.deepStrictEqual([card.summary.cpu, card.summary.mem, card.summary.disk], [5, 30, { mount: "/srv", pct: 91 }]);
    assert.ok(!JSON.stringify(list).includes(nas.secret), "secrets never reach the page");

    await sleep(5100);   // the hub takes one push per 5 s per node
    assert.strictEqual((await signed(hub, nas, { body: snap({ net: { iface: "eth0", rxBytes: 6000, txBytes: 0 },
      docker: [{ name: "db", id: "d1", state: "running", cpuUsec: 2000000, mem: 1 }] }) })).status, 200);
    const v = await getJSON(hub, cookie, `/__ctl/node/${nas.id}`);
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.node.name, "nas");
    assert.ok(v.body.net.rateRx > 0 && v.body.net.rateRx <= 1000, String(v.body.net.rateRx));
    assert.ok(v.body.docker[0].cpu > 0);
    assert.strictEqual(v.body.trend.length, 2);
    assert.strictEqual((await getJSON(hub, cookie, "/__ctl/node/aaaaaaaaaaaa")).status, 404);
  } finally { await hub.stop(); }
});

test("refresh wakes one node or all of them", async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    const wait = signed(hub, nas, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    await sleep(300);
    const r = await ctlPost(hub.port, cookie, `/__ctl/refresh?node=${nas.id}`);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, woke: true, fresh: false });
    assert.strictEqual((await wait).status, 200);
    const all = await ctlPost(hub.port, cookie, "/__ctl/refresh?node=all");
    assert.deepStrictEqual(JSON.parse(all.body), { ok: true, woke: 0 }, "nobody is waiting now");
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/refresh?node=aaaaaaaaaaaa")).status, 404);
  } finally { await hub.stop(); }
});

test("container controls refuse every node but the hub's own", async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    const r = await ctlPost(hub.port, cookie, `/__ctl/container/web/restart?node=${nas.id}`);
    assert.strictEqual(r.status, 403);
    assert.match(JSON.parse(r.body).error, /only on the hub's own host/);
    const local = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "nodes.json"), "utf8"));
    const localId = Object.keys(local).find((id) => local[id].local);
    const mine = await ctlPost(hub.port, cookie, `/__ctl/container/web/restart?node=${localId}`);
    assert.doesNotMatch(mine.body, /only on the hub's own host/);
  } finally { await hub.stop(); }
});

test("a revoked node is refused and leaves the fleet", async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    execFileSync(process.execPath, [NODES_JS, path.join(hub.dataDir, "nodes.json"), "revoke", nas.id]);
    const r = await signed(hub, nas, { body: snap() });
    assert.deepStrictEqual([r.status, JSON.parse(r.body).error], [401, "unknown_node"]);
    assert.ok(!(await getJSON(hub, cookie, "/__ctl/nodes")).body.some((n) => n.id === nas.id));
    assert.strictEqual((await getJSON(hub, cookie, `/__ctl/node/${nas.id}`)).status, 404);
  } finally { await hub.stop(); }
});
```

Create `test/proxy.test.js` (it needs `openssl`, which the CI runners and this host have):

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The agent reaches an HTTPS hub through an HTTP proxy (CONNECT, with
 * Proxy-Authorization), sends HUB_HEADERS, trusts HUB_CA_FILE, and never
 * sends the hub host's own agent through the proxy (spec 5.2, 19).
 * The proxy and a TLS front for the hub run in this process, so the agent
 * runs asynchronously.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { startHub, request, login, cookieFrom } = require("./helpers/hub");

const AGENT = path.join(__dirname, "..", "agent", "collect.sh");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-proxy-"));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

function certFor(dir, host) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { stdio: "ignore" });
  return { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")), ca: path.join(dir, "cert.pem") };
}

// TLS in front of the hub, like a reverse proxy; remembers the headers it saw
async function tlsFront(tls, hubPort) {
  const seen = [];
  const srv = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    seen.push(req.headers);
    req.on("error", () => {});
    const up = http.request({ host: "127.0.0.1", port: hubPort, method: req.method, path: req.url, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  srv.on("tlsClientError", () => {});   // an agent that does not trust the certificate
  return { port: await listen(srv), seen, close: () => { srv.close(); srv.closeAllConnections(); } };
}

// an HTTP proxy that only tunnels (CONNECT) and wants user:pw
async function connectProxy(target) {
  const log = [];
  const open = new Set();   // tunnels outlive the HTTP server's own connection list
  const srv = http.createServer((req, res) => { log.push(`plain ${req.url}`); res.writeHead(405); res.end(); });
  srv.on("connect", (req, socket) => {
    open.add(socket);
    socket.on("error", () => {});   // the agent may hang up first
    socket.on("close", () => open.delete(socket));
    const auth = req.headers["proxy-authorization"] || "";
    log.push(`CONNECT ${req.url} ${auth}`);
    if (auth !== "Basic " + Buffer.from("user:pw").toString("base64")) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const up = net.connect(target(req.url), "127.0.0.1", () => {
      open.add(up);
      up.on("close", () => { open.delete(up); socket.destroy(); });
      socket.on("close", () => up.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(socket); socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
  });
  return { port: await listen(srv), log, close: () => { for (const s of open) s.destroy(); srv.close(); } };
}

function agentOnce(env) {
  return new Promise((resolve) => execFile("bash", [AGENT], {
    env: { PATH: process.env.PATH, HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent", COLLECT_NET: "0",
           STATE_DIR: tmp(), ONCE: "1", ...env }, timeout: 30000,
  }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: stdout + stderr })));
}

test("the agent pushes to an HTTPS hub through an authenticating proxy", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const dir = tmp();
  const tls = certFor(dir, "hub.test");
  const front = await tlsFront(tls, hub.port);
  const proxy = await connectProxy(() => front.port);   // the proxy resolves hub.test
  try {
    const local = fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8");
    const creds = path.join(dir, "creds.env");
    fs.writeFileSync(creds, local.replace(/^HUB_URL=.*$/m, `HUB_URL=https://hub.test:${front.port}`));
    const r = await agentOnce({
      CREDENTIALS_FILE: creds, HUB_CA_FILE: tls.ca, HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}`,
      HUB_HEADERS: "CF-Access-Client-Id: abc.access; CF-Access-Client-Secret: s3cr3t-token",
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(proxy.log.some((l) => l.startsWith(`CONNECT hub.test:${front.port} Basic `)), proxy.log.join("\n"));
    assert.strictEqual(front.seen[0]["cf-access-client-id"], "abc.access");
    assert.strictEqual(front.seen[0]["cf-access-client-secret"], "s3cr3t-token");
    assert.ok(!r.out.includes("pw@") && !r.out.includes("s3cr3t-token"), "no credentials in the agent's output");
    const cookie = cookieFrom(await login(hub.port));
    const d = JSON.parse((await request(hub.port, { path: "/data.json", headers: { cookie } })).body);
    assert.ok(d.host.name.length > 0, "the push landed");
  } finally { proxy.close(); front.close(); await hub.stop(); }
});

test("a wrong proxy password or an untrusted certificate fails the push", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const dir = tmp();
  const tls = certFor(dir, "hub.test");
  const front = await tlsFront(tls, hub.port);
  const proxy = await connectProxy(() => front.port);
  try {
    const creds = path.join(dir, "creds.env");
    fs.writeFileSync(creds, fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8")
      .replace(/^HUB_URL=.*$/m, `HUB_URL=https://hub.test:${front.port}`));
    const wrongPw = await agentOnce({ CREDENTIALS_FILE: creds, HUB_CA_FILE: tls.ca, HTTPS_PROXY: `http://user:nope@127.0.0.1:${proxy.port}` });
    assert.notStrictEqual(wrongPw.code, 0);
    assert.match(wrongPw.out, /status=000/);
    const noCa = await agentOnce({ CREDENTIALS_FILE: creds, HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}` });
    assert.notStrictEqual(noCa.code, 0, "a self-signed hub needs HUB_CA_FILE");
  } finally { proxy.close(); front.close(); await hub.stop(); }
});

test("the hub host's own agent never goes through the proxy", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const proxy = await connectProxy(() => 9);
  try {
    const r = await agentOnce({
      CREDENTIALS_FILE: path.join(hub.dataDir, "local-agent.env"),
      HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://user:pw@127.0.0.1:${proxy.port}`,
      http_proxy: `http://user:pw@127.0.0.1:${proxy.port}`, NO_PROXY: "example.org",
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(proxy.log, [], "127.0.0.1 is always in NO_PROXY");
  } finally { proxy.close(); await hub.stop(); }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agentapi.test.js test/agent-docker.test.js test/multinode.test.js test/proxy.test.js`
Expected: FAIL: invalid snapshots are accepted (`$.schema` expected), the docker test sees `cpu` instead of `cpuUsec`, `/__ctl/nodes` answers the login page or 404, the proxy sees no `CF-Access-Client-Id` header.

- [ ] **Step 3: The agent sends protocol snapshots**

Run `git rm agent/lib/trend.sh`, then replace these files.

`agent/collect.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent: samples this host every INTERVAL seconds, or at once when
# the hub asks, and pushes the snapshot to the hub over the signed agent API
# (docs/protocol.md). One file per metric group in lib/. HOST_ROOT is / on a
# normal install; the Docker agent reads the host through /host.
#   OUT_FILE=<path>  write snapshots to this file instead of pushing (debugging)
#   ONCE=1           one tick, then exit
# shellcheck disable=SC2034
# (IFACE_ENV, VNSTAT_DB, AGENT_NAME and others are read by the lib/*.sh files)
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
HOST="${HOST_ROOT:-/}"
INTERVAL="${INTERVAL:-60}"    # heartbeat; the hub wakes the agent for fresh samples on demand
[[ $INTERVAL =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 3600 ] || INTERVAL=60
IFACE_ENV="${NET_IFACE:-}"
DISKS="${DISKS:-auto}"   # "auto": every real filesystem; or a comma-separated list
VNSTAT_DB="$HOST/var/lib/vnstat"
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# cpu delta counters, wake trigger, last push; systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
mkdir -p "$STATE"
CREDENTIALS_FILE="${CREDENTIALS_FILE:-/etc/servitals/agent-credentials.env}"
AGENT_VERSION=$(cat "$HERE/VERSION" "$HERE/../VERSION" 2>/dev/null | head -n 1)
AGENT_NAME="bash/${AGENT_VERSION:-unknown}"
SNAP="${OUT_FILE:-$STATE/snapshot.json}"
TRIGGER="$STATE/wake"       # the wait loop touches it when the hub asks for a sample
# the hub host's own agent must never go through a proxy
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

for f in "$HERE"/lib/*.sh; do
  # shellcheck source=/dev/null
  . "$f"
done

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
    net=$(net_json "$IFACE")
  fi
  if on "${COLLECT_DOCKER:-1}"; then docker=$(docker_json); fi

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, temp: $temp,
      disks: $disks, net: $net, docker: $docker}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}

tick() {
  collect "$SNAP" || { agent_log warn agent.tick_failed; return 1; }
  [ -n "${OUT_FILE:-}" ] || push "$SNAP"
}

agent_log info agent.start version="${AGENT_VERSION:-unknown}" interval="$INTERVAL" \
  host_root="$HOST" mode="$([ -n "${OUT_FILE:-}" ] && echo file || echo push)"
if [ -z "${OUT_FILE:-}" ]; then
  until load_credentials "$CREDENTIALS_FILE"; do
    if [ "${CRED_WAIT:-0}" != 1 ]; then
      agent_log error agent.no_credentials file="$CREDENTIALS_FILE"
      exit 1
    fi
    sleep 2   # Docker: the gateway writes the file on its first start
  done
  hmac_init "$NODE_SECRET"
  hub_args
  agent_log info agent.hub url="$HUB_URL" node="$NODE_ID"
fi
IFACE=$(pick_iface)

if [ "${ONCE:-0}" = 1 ]; then
  tick
  exit $?
fi

if [ -z "${OUT_FILE:-}" ]; then
  wait_loop &
  WAIT_PID=$!
  trap 'kill "$WAIT_PID" 2>/dev/null; exit 0' TERM INT
fi
while true; do
  tick
  # sleep INTERVAL, but sample at once when the wait loop touches the trigger
  i=0
  while [ "$i" -lt "$INTERVAL" ]; do
    if [ -e "$TRIGGER" ]; then rm -f "$TRIGGER"; break; fi
    sleep 1
    i=$((i + 1))
  done
done
```

`agent/lib/net.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# net: live rate from interface counters, history from vnStat

pick_iface() {
  if [ -n "$IFACE_ENV" ]; then echo "$IFACE_ENV"; return; fi
  vnstat --json --dbdir "$VNSTAT_DB" 2>/dev/null \
    | jq -r '.interfaces[].name' 2>/dev/null \
    | grep -Ev '^(lo|docker|veth|br-|virbr|tap|tun)' | head -n1
}

net_json() {
  local iface="$1" rx tx vn
  [ -n "$iface" ] || { echo 'null'; return; }
  # counters only: the hub derives the live rate from two snapshots
  rx=$(cat "$HOST/sys/class/net/$iface/statistics/rx_bytes" 2>/dev/null || echo 0)
  tx=$(cat "$HOST/sys/class/net/$iface/statistics/tx_bytes" 2>/dev/null || echo 0)
  [[ $rx =~ ^[0-9]+$ ]] || rx=0
  [[ $tx =~ ^[0-9]+$ ]] || tx=0

  # vnStat reads its DB in the reading process's timezone, so the agent's TZ
  # must match the host's: then day/month buckets roll over at local midnight.
  vn=$(vnstat --json --dbdir "$VNSTAT_DB" -i "$iface" 2>/dev/null | jq -c --argjson now "$(date +%s)" '
    .interfaces[0] as $if | ($if.traffic) as $t |
    ( $if.created.timestamp // 0 ) as $created |

    # average rate = bytes / seconds the bucket actually spans, from its own
    # start (or the vnstat tracking start, whichever is later) to now.
    def summary(bucket):
      ( bucket | last // {rx:0, tx:0, timestamp:$now} ) as $b |
      ( [ $now - ([ ($b.timestamp // 0), $created ] | max), 1 ] | max ) as $secs |
      { rx: $b.rx, tx: $b.tx, avgRx: ($b.rx / $secs), avgTx: ($b.tx / $secs) };

    # recent buckets as chart bars, labelled in local time
    def bars(bucket; n; short; long):
      ( bucket // [] | .[-n:] | map({
          label: ( .timestamp | strflocaltime(short) ),
          title: ( .timestamp | strflocaltime(long) ),
          rx, tx }) );

    {
      today:  summary($t.day),
      month:  summary($t.month),
      total:  ( $t.total // {rx:0, tx:0} | {rx, tx} ),
      days:   bars($t.day;  30; "%m-%d";    "%Y-%m-%d"),
      hours:  bars($t.hour; 24; "%H:00";    "%m-%d %H:00")
    }' 2>/dev/null)
  [ -n "$vn" ] || vn=null
  jq -cn --arg iface "$iface" --argjson rx "$rx" --argjson tx "$tx" --argjson vn "$vn" \
    '{iface: $iface, rxBytes: $rx, txBytes: $tx, vnstat: $vn}'
}
```

`agent/lib/docker.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# docker: the container list from the Docker API over its unix socket (curl,
# not the docker CLI, which briefly takes ~29 MB per call), and each
# container's memory and CPU-time counter from its cgroup.

cgroup_dir() {  # $1 = container id -> its cgroup v2 directory, if there is one
  local d
  for d in "$HOST/sys/fs/cgroup/system.slice/docker-$1.scope" "$HOST/sys/fs/cgroup/docker/$1"; do
    if [ -f "$d/cpu.stat" ]; then echo "$d"; return; fi
  done
}

docker_json() {
  local sock="${DOCKER_SOCK:-/var/run/docker.sock}" list rows="" cid name state status d k v usage mem v1
  [ -S "$sock" ] || { echo '[]'; return; }   # no Docker here: do not start curl at all
  list=$(curl -sf --max-time 5 --unix-socket "$sock" 'http://d/containers/json?all=1' 2>/dev/null) \
    || { echo '[]'; return; }
  while IFS=$'\t' read -r cid name state status; do
    [ -n "$cid" ] || continue
    usage=""; mem=""
    d=$(cgroup_dir "$cid")
    if [ -n "$d" ]; then
      while read -r k v; do [ "$k" = usage_usec ] && usage=$v; done < "$d/cpu.stat"
      [ -f "$d/memory.stat" ] && while read -r k v; do [ "$k" = anon ] && mem=$v; done < "$d/memory.stat"
    else
      v1="$HOST/sys/fs/cgroup/memory/docker/$cid/memory.stat"   # cgroup v1
      if [ -f "$v1" ]; then
        while read -r k v; do [ "$k" = total_rss ] && mem=$v; done < "$v1"
        v=$(cat "$HOST/sys/fs/cgroup/cpuacct/docker/$cid/cpuacct.usage" 2>/dev/null) && usage=$((v / 1000))
      fi
    fi
    rows+="$cid"$'\t'"$name"$'\t'"$state"$'\t'"$status"$'\t'"$usage"$'\t'"$mem"$'\n'
  done < <(jq -r '.[] | [.Id, ((.Names[0] // "") | ltrimstr("/")), .State, .Status] | @tsv' <<< "$list" 2>/dev/null)
  # cpuUsec is a counter: the hub turns two of them into a CPU percentage
  printf '%s' "$rows" | jq -R -s -c '
    [ split("\n")[] | select(length > 0) | split("\t") | {
        name: .[1], id: .[0], state: .[2], status: .[3],
        health: ( .[3] | capture("\\((?<h>healthy|unhealthy|health: starting|starting)\\)").h // null ),
        cpuUsec: ( if .[4] == "" then null else (.[4] | tonumber) end ),
        mem: ( if .[5] == "" then null else (.[5] | tonumber) end ) } ]
    | sort_by( (if .state == "running" then 0 else 1 end), -( .mem // -1 ) )'
}
```

`agent/lib/api.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as STATE, INTERVAL and TRIGGER are set by collect.sh)
# api: the agent side of docs/protocol.md. Signed POST /api/v1/agent/push,
# the GET /api/v1/agent/wait long poll, and reply-signature checks.

load_credentials() {  # $1 = file with HUB_URL, NODE_ID, NODE_SECRET; parsed, never sourced
  local k v
  HUB_URL=""; NODE_ID=""; NODE_SECRET=""
  [ -r "$1" ] || return 1
  while IFS='=' read -r k v || [ -n "$k" ]; do
    v=${v%$'\r'}
    case "$k" in
      HUB_URL) HUB_URL=${v%/} ;;
      NODE_ID) NODE_ID=$v ;;
      NODE_SECRET) NODE_SECRET=$v ;;
    esac
  done < "$1"
  [[ $HUB_URL =~ ^https?://[^[:space:]]+$ && $NODE_ID =~ ^[a-z2-7]{12}$ && $NODE_SECRET =~ ^[0-9a-f]{64}$ ]]
}

# extra request headers, e.g. a Cloudflare Access service token:
#   HUB_HEADERS="CF-Access-Client-Id: <id>; CF-Access-Client-Secret: <secret>"
# Values are sent, never logged. HUB_CA_FILE trusts a private CA for an HTTPS hub.
hub_args() {
  HUB_ARGS=()
  local part name value
  if [ -n "${HUB_HEADERS:-}" ]; then
    IFS=';' read -ra parts <<< "$HUB_HEADERS"
    for part in "${parts[@]}"; do
      name=$(printf '%s' "${part%%:*}" | xargs)
      value=$(printf '%s' "${part#*:}" | sed 's/^ *//; s/ *$//')
      [[ $name =~ ^[A-Za-z0-9-]{1,64}$ && $part == *:* ]] || { agent_log error agent.bad_hub_headers; continue; }
      HUB_ARGS+=(-H "$name: $value")
    done
  fi
  if [ -n "${HUB_CA_FILE:-}" ]; then HUB_ARGS+=(--cacert "$HUB_CA_FILE"); fi
}

now_ms() { local t; t=$(date +%s%N); echo "${t:0:13}"; }

api_error() { jq -r '.error // empty' "$1" 2>/dev/null | head -c 40; }

# api_call METHOD PATH BODY_FILE OUT_FILE [curl args...]
# Sets API_STATUS. Returns 0 only for a 2xx whose reply signature is valid.
api_call() {
  local method=$1 path=$2 body=$3 out=$4 ts bh sig got
  shift 4
  : > "$out"; : > "$out.h"   # never read a previous reply if this request fails early
  ts=$(now_ms)
  bh=$(sha256sum < "$body"); bh=${bh%% *}
  sig=$(hmac_hex "$method"$'\n'"$path"$'\n'"$ts"$'\n'"$bh")
  API_STATUS=$(curl -sS -o "$out" -D "$out.h" -w '%{http_code}' -X "$method" --max-time 20 \
    -H "X-Servitals-Proto: 1" -H "X-Servitals-Agent: $AGENT_NAME" -H "X-Servitals-Node: $NODE_ID" \
    -H "X-Servitals-Ts: $ts" -H "X-Servitals-Sig: $sig" \
    -H "Content-Type: application/json" -H "Expect:" "${HUB_ARGS[@]}" \
    --data-binary @"$body" "$@" "$HUB_URL$path" 2>/dev/null) || API_STATUS=000
  case "$API_STATUS" in 2??) ;; *) return 1 ;; esac
  got=$(awk 'tolower($1) == "x-servitals-sig:" { v = $2 } END { print v }' "$out.h" | tr -d '\r')
  bh=$(sha256sum < "$out"); bh=${bh%% *}
  if [ "$got" != "$(hmac_hex "reply"$'\n'"$ts"$'\n'"$bh")" ]; then
    API_STATUS=bad_reply_signature   # an impostor or a proxy rewrote the reply
    return 1
  fi
}

push() {  # $1 = snapshot file; 0 when the hub stored it
  local out="$STATE/push.out" err small
  api_call POST /api/v1/agent/push "$1" "$out"
  err=$(api_error "$out")
  if [ "$API_STATUS" = 401 ] && [ "$err" = replay ]; then
    api_call POST /api/v1/agent/push "$1" "$out"   # a fresh timestamp, once
  elif [ "$API_STATUS" = 429 ]; then
    # inside the hub's 5 s push limit (a restart, a wake right after a push): wait it out once
    local wait_s
    wait_s=$(awk 'tolower($1) == "retry-after:" { v = $2 + 0 } END { print (v >= 1 && v <= 5) ? v : 5 }' "$out.h" 2>/dev/null)
    sleep "${wait_s:-5}"
    api_call POST /api/v1/agent/push "$1" "$out"
  elif [ "$API_STATUS" = 413 ]; then
    # too large: send it again without the optional lists (protocol 5.5)
    small="$STATE/snapshot.small.json"
    jq -c 'del(.docker, .processes)' "$1" > "$small" 2>/dev/null && api_call POST /api/v1/agent/push "$small" "$out"
  fi
  err=$(api_error "$out")
  printf '%s %s %s\n' "$(date +%s)" "$API_STATUS" "${err:--}" > "$STATE/last-push"
  case "$API_STATUS" in 2??) return 0 ;; esac
  agent_log warn agent.push_failed status="$API_STATUS" error="$err"
  return 1
}

wait_loop() {  # background: touch $TRIGGER whenever the hub asks for a sample
  local empty="$STATE/wait.empty" out="$STATE/wait.out" hold="${WAIT_SECONDS:-55}" backoff=5
  : > "$empty"
  [[ $hold =~ ^[0-9]+$ ]] || hold=55
  [ "$hold" -lt 5 ] && hold=5
  [ "$hold" -gt 55 ] && hold=55
  while true; do
    if api_call GET /api/v1/agent/wait "$empty" "$out" -H "X-Servitals-Wait: $hold" --max-time $((hold + 15)); then
      backoff=5
      if [ "$API_STATUS" = 200 ] && grep -q '"sample":true' "$out"; then touch "$TRIGGER"; fi
    else
      agent_log warn agent.wait_failed status="$API_STATUS" error="$(api_error "$out")" retry_in="$backoff"
      # a revoked or unknown node, or a protocol this hub does not speak: stop
      # asking until someone changes the credentials (protocol 5.5)
      case "$API_STATUS:$(api_error "$out")" in
        401:unknown_node|426:*) sleep 600; continue ;;
      esac
      sleep "$backoff"
      backoff=$((backoff * 2))
      [ "$backoff" -gt "$INTERVAL" ] && backoff=$INTERVAL
      [ "$backoff" -lt 5 ] && backoff=5
    fi
  done
}
```

- [ ] **Step 4: The hub validates, derives and serves the fleet**

Replace `hub/lib/agentapi.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Agent API v1 (docs/protocol.md): POST /api/v1/agent/push and the
 * GET /api/v1/agent/wait long poll. Checks run in the protocol's order, and
 * the last accepted TS is stored only after every check passed.
 * The last accepted TS per node and endpoint is saved to `replayFile`, so a
 * restart does not reopen the 120 s window for captured requests. A client
 * address that keeps failing authentication is slowed down (429) before the
 * hub reads anything else.
 */
const fs = require("fs");
const { verifyRequest, signReply } = require("./agentsig");
const { validate } = require("./snapshot");
const { writeFileAtomic } = require("./fsutil");

const MAX_SKEW_MS = 120000;
const PUSH_MIN_MS = 5000;
const WAIT_MAX_S = 55;
const WAIT_MIN_S = 5;
const NODE_ID = /^[a-z2-7]{12}$/;
const MESSAGES = {
  not_found: "no such endpoint",
  method_not_allowed: "wrong method for this endpoint",
  query_not_allowed: "agent requests carry no query string",
  unsupported_protocol: "this hub speaks protocol 1",
  unknown_node: "unknown or revoked node",
  clock_skew: "clock differs from the hub by more than 120 s",
  replay: "timestamp not newer than the last accepted one",
  too_large: "request body too large",
  bad_signature: "signature does not match",
  invalid_snapshot: "snapshot failed validation",
  rate_limited: "pushing too often",
};

const FAIL_LIMIT = 30;          // failed authentications per client address ...
const FAIL_WINDOW_MS = 60000;   // ... per minute, then 429 until the minute is over

function clampWait(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(WAIT_MAX_S, Math.max(WAIT_MIN_S, n)) : WAIT_MAX_S;
}

// Resolves with the body, or null past `max` bytes. Past the limit the rest is
// drained and dropped, never buffered.
function readLimited(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function createAgentApi({ nodes, log, onSnapshot, maxBody = 256 * 1024, now = Date.now,
                          replayFile = null, clientIp = (req) => req.socket.remoteAddress }) {
  const lastTs = new Map();     // "<id> <endpoint>" -> last accepted TS
  if (replayFile) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(replayFile, "utf8")))) {
        if (typeof v === "number") lastTs.set(k, v);
      }
    } catch (_) { /* first start, or an unreadable file: the skew window still bounds replays */ }
  }
  function acceptTs(key, ts) {
    lastTs.set(key, ts);
    if (!replayFile) return;
    try { writeFileAtomic(replayFile, JSON.stringify(Object.fromEntries(lastTs)), 0o600); }
    catch (e) { log.warn("api.replay_write_failed", { error: e.code || String(e) }); }
  }
  const failures = new Map();   // client address -> { n, until }
  function failed(ip) {
    const t = now();
    const f = failures.get(ip);
    if (!f || f.until < t) failures.set(ip, { n: 1, until: t + FAIL_WINDOW_MS });
    else f.n++;
    if (failures.size > 10000) failures.clear();   // bounded memory under a flood
  }
  const blocked = (ip) => { const f = failures.get(ip); return !!f && f.until >= now() && f.n >= FAIL_LIMIT; };
  const lastPush = new Map();   // id -> hub time of the last stored push
  const lastWake = new Map();   // id -> hub time of the last wake sent
  const waiters = new Map();    // id -> { res, secret, ts, timer }
  const seen = new Set();       // ids that pushed since this process started

  function fail(res, code, error, { headers = {}, body = {} } = {}) {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ error, message: MESSAGES[error] || error, ...body }));
  }

  function reply(res, code, secret, ts, obj) {
    const body = obj === undefined ? "" : JSON.stringify(obj);
    const headers = { "x-servitals-sig": signReply(secret, ts, body) };
    if (body) headers["content-type"] = "application/json";
    res.writeHead(code, headers);
    res.end(body);
  }

  function finishWait(id, w, code) {
    clearTimeout(w.timer);
    if (waiters.get(id) === w) waiters.delete(id);
    if (!w.res.writableEnded) reply(w.res, code, w.secret, w.ts, code === 200 ? { sample: true } : undefined);
  }

  async function handle(req, res) {
    const url = req.url || "";
    const q = url.indexOf("?");
    const pathname = q < 0 ? url : url.slice(0, q);
    let endpoint;
    if (pathname === "/api/v1/agent/push") endpoint = "push";
    else if (pathname === "/api/v1/agent/wait") endpoint = "wait";
    else return fail(res, 404, "not_found");
    if (req.method !== (endpoint === "push" ? "POST" : "GET")) return fail(res, 405, "method_not_allowed");
    if (q >= 0) return fail(res, 400, "query_not_allowed");

    const ip = clientIp(req) || "?";
    if (blocked(ip)) {
      return fail(res, 429, "rate_limited", { headers: { "retry-after": String(Math.ceil(FAIL_WINDOW_MS / 1000)) } });
    }
    const h = req.headers;
    if (h["x-servitals-proto"] !== "1") return fail(res, 426, "unsupported_protocol");
    const id = h["x-servitals-node"] || "";
    const node = NODE_ID.test(id) ? nodes.get(id) : null;
    if (!node) { failed(ip); log.warn("api.refused", { error: "unknown_node" }); return fail(res, 401, "unknown_node"); }
    const tsRaw = h["x-servitals-ts"] || "";
    const ts = /^\d{1,16}$/.test(tsRaw) ? Number(tsRaw) : NaN;
    const hubMs = now();
    if (!Number.isFinite(ts) || Math.abs(hubMs - ts) > MAX_SKEW_MS) {
      failed(ip);
      log.warn("api.refused", { node: id, error: "clock_skew" });
      return fail(res, 401, "clock_skew", { body: { hub_ms: hubMs } });
    }
    const key = `${id} ${endpoint}`;
    if (ts <= (lastTs.get(key) || 0)) { failed(ip); return fail(res, 401, "replay"); }
    const tooLarge = () => fail(res, 413, "too_large", { headers: { connection: "close" } });
    if (Number(h["content-length"] || 0) > maxBody) { req.resume(); return tooLarge(); }
    const body = await readLimited(req, maxBody);
    if (body === null) return tooLarge();
    if (!verifyRequest(node.secret, req.method, pathname, tsRaw, body, h["x-servitals-sig"])) {
      failed(ip);
      log.warn("api.refused", { node: id, error: "bad_signature" });
      return fail(res, 401, "bad_signature");
    }

    if (endpoint === "push") {
      const since = hubMs - (lastPush.get(id) || 0);
      if (since < PUSH_MIN_MS) {
        return fail(res, 429, "rate_limited", { headers: { "retry-after": String(Math.ceil((PUSH_MIN_MS - since) / 1000)) } });
      }
      let raw;
      try { raw = JSON.parse(body.toString("utf8")); } catch (_) { raw = undefined; }
      const checked = validate(raw);
      if (!checked.ok) return fail(res, 422, "invalid_snapshot", { body: { path: checked.path } });
      acceptTs(key, ts);
      lastPush.set(id, hubMs);
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, checked.value);
      return reply(res, 200, node.secret, tsRaw, { ok: true });
    }

    acceptTs(key, ts);
    const prev = waiters.get(id);
    if (prev) finishWait(id, prev, 204);   // a reconnecting agent is never locked out
    const w = { res, secret: node.secret, ts: tsRaw };
    w.timer = setTimeout(() => finishWait(id, w, 204), clampWait(h["x-servitals-wait"]) * 1000);
    waiters.set(id, w);
    res.on("close", () => { clearTimeout(w.timer); if (waiters.get(id) === w) waiters.delete(id); });
  }

  function wake(id) {
    const w = waiters.get(id);
    if (!w) return false;
    lastWake.set(id, now());
    finishWait(id, w, 200);
    return true;
  }

  return {
    handle,
    wake,
    lastPushAt: (id) => lastPush.get(id) || 0,
    lastWakeAt: (id) => lastWake.get(id) || 0,
    close() { for (const [id, w] of [...waiters]) finishWait(id, w, 204); },
  };
}

module.exports = { createAgentApi, clampWait, FAIL_LIMIT };
```

In `hub/server.js`:

1. Replace

```js
const { createNodeStore, localAgentEnv } = require("./lib/nodes");
const { createAgentApi } = require("./lib/agentapi");
const { createAdminStore, USER_RE } = require("./lib/admin");

```

   with

```js
const { createNodeStore, localAgentEnv } = require("./lib/nodes");
const { createAgentApi } = require("./lib/agentapi");
const { view: snapshotView } = require("./lib/snapshot");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");

```

2. Replace

```js
const SNAP_DIR = path.join(DATA, "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });
const latest = new Map();   // node id -> raw snapshot bytes
try { latest.set(localNode.id, fs.readFileSync(path.join(SNAP_DIR, localNode.id + ".json"))); }
catch (_) { /* no snapshot yet */ }
const agentApi = createAgentApi({
  nodes, log,
  onSnapshot(id, snap, raw) {
    latest.set(id, raw);
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), raw); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
  },
});

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
```

   with

```js
const SNAP_DIR = path.join(DATA, "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });
// node id -> { snap (validated, as pushed), view (what the page reads), at (hub ms) }
const latest = new Map();
for (const n of nodes.list()) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, n.id + ".json"), "utf8"));
    if (rec && rec.snap && rec.view && rec.at) latest.set(n.id, rec);   // older formats: wait for a push
  } catch (_) { /* no snapshot yet */ }
}
const agentApi = createAgentApi({
  nodes, log,
  replayFile: path.join(DATA, "replay.json"),
  clientIp: (req) => resolveClient(req).ip,
  onSnapshot(id, snap) {
    const prev = latest.get(id);
    const rec = { snap, view: snapshotView(snap, prev && prev.snap, prev ? prev.view.trend : []), at: Date.now() };
    latest.set(id, rec);
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
  },
});
const nodeStatus = (id) => {
  const rec = latest.get(id);
  return fleet.status(rec && rec.at, rec && rec.snap.interval);
};
// wake one node unless it pushed or was woken in the last 5 s
function wakeNode(id) {
  const now = Date.now();
  const fresh = now - agentApi.lastPushAt(id) < 5000;
  const pending = now - agentApi.lastWakeAt(id) < 5000;
  return { fresh, woke: !fresh && !pending && agentApi.wake(id) };
}

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
```

3. Replace

```js
  // the local node's latest snapshot, where the page and old scripts expect it
  if (authed && req.method === "GET" && pathname === "/data.json") {
    const snap = latest.get(nodes.localId());
    res.writeHead(snap ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(snap || '{"error":"no snapshot yet"}');
  }

```

   with

```js
  // the local node's latest snapshot, where the page and old scripts expect it
  if (authed && req.method === "GET" && pathname === "/data.json") {
    const rec = latest.get(nodes.localId());
    res.writeHead(rec ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(rec ? JSON.stringify(rec.view) : '{"error":"no snapshot yet"}');
  }

```

4. Replace

```js
    // ask the local agent to sample now — harmless, any authed user. Within 5 s
    // of a push the data is fresh and a wake would only earn a 429.
    if (req.method === "POST" && req.url === "/__ctl/refresh") {
      const id = nodes.localId();
      const fresh = !!id && Date.now() - agentApi.lastPushAt(id) < 5000;
      // a wake in the last 5 s is still being answered (other tabs, a double click)
      const pending = !!id && Date.now() - agentApi.lastWakeAt(id) < 5000;
      const woke = !!id && !fresh && !pending && agentApi.wake(id);
      return json(200, { ok: true, woke, fresh });
    }

```

   with

```js
    // ask the local agent to sample now — harmless, any authed user. Within 5 s
    // of a push the data is fresh and a wake would only earn a 429.
    if (req.method === "POST" && pathname === "/__ctl/refresh") {
      const which = new URL(req.url, "http://x").searchParams.get("node");
      if (which === "all") {
        let woke = 0;
        for (const n of nodes.list()) if (wakeNode(n.id).woke) woke++;
        return json(200, { ok: true, woke });
      }
      const id = which || nodes.localId();
      if (!id || !nodes.get(id)) return json(404, { error: "no such node" });
      const r = wakeNode(id);
      return json(200, { ok: true, woke: r.woke, fresh: r.fresh });
    }

    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
      const list = nodes.list().map((n) => {
        const rec = latest.get(n.id);
        return { ...n, status: nodeStatus(n.id), lastSeen: rec ? rec.at : null,
                 interval: rec ? rec.snap.interval : null, summary: rec ? fleet.summary(rec.view) : null };
      }).sort((a, b) => (b.local - a.local) || a.name.localeCompare(b.name));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(list));
    }

    // one node's latest view
    const nm = /^\/__ctl\/node\/([a-z2-7]{12})$/.exec(pathname);
    if (req.method === "GET" && nm) {
      const n = nodes.list().find((x) => x.id === nm[1]);
      if (!n) return json(404, { error: "no such node" });
      const rec = latest.get(n.id);
      if (!rec) return json(503, { error: "no snapshot yet", node: { ...n, status: "waiting" } });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ ...rec.view, node: { ...n, status: nodeStatus(n.id), lastSeen: rec.at } }));
    }

```

5. Replace

```js

    // container lifecycle — whitelisted (LAN) only by default
    const m = req.url.match(/^\/__ctl\/container\/([^/]+)\/(restart|start|stop|logs)$/);
    if (m) {
      if (CTL_LAN_ONLY && !wl) return json(403, { error: "container controls are LAN-only" });
      const name = decodeURIComponent(m[1]), action = m[2];
```

   with

```js

    // container lifecycle — whitelisted (LAN) only by default
    const m = pathname.match(/^\/__ctl\/container\/([^/]+)\/(restart|start|stop|logs)$/);
    if (m) {
      // only the hub's own host: never a remote node, whatever the page sends (spec 6.4)
      const target = new URL(req.url, "http://x").searchParams.get("node");
      if (target && target !== nodes.localId()) {
        return json(403, { error: "container controls work only on the hub's own host" });
      }
      if (CTL_LAN_ONLY && !wl) return json(403, { error: "container controls are LAN-only" });
      const name = decodeURIComponent(m[1]), action = m[2];
```

- [ ] **Step 5: Run all tests, shellcheck and the budget**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh && bash test/budget.sh`
Expected: PASS (`test/proxy.test.js` about 2 s, `test/multinode.test.js` about 6 s); shellcheck prints nothing; every budget line `ok`.

- [ ] **Step 6: Commit**

```bash
git add -A agent hub test/agentapi.test.js test/agent-docker.test.js test/multinode.test.js test/proxy.test.js
git commit -m "feat: protocol snapshots end to end, fleet API, hub hardening" -m "Agents send schema-1 snapshots with counters; the hub validates them and derives rates, container CPU and the trend. /__ctl/nodes, /__ctl/node/<id> and refresh?node= serve the fleet; container controls refuse remote nodes. Addresses that keep failing agent authentication get 429; replay counters survive restarts. Agents support HUB_HEADERS and HUB_CA_FILE, stop asking after unknown_node and resend a too-large snapshot without its lists."
```

---

### Task 4: Fleet grid and node tabs in the page

**Files:**
- Modify: `www/index.html`, `test/page.test.js`

**Interfaces:**
- Consumes: `/__ctl/nodes`, `/__ctl/node/<id>`, `/__ctl/refresh?node=`, `/__ctl/container/...?node=` (Task 3).
- Produces: routes `#fleet` and `#node=<id>` (default: fleet with two or more nodes, else the local node view), key `f` for the fleet, `fmtVal(v, unit)`; container buttons only when `isLocalView()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/page.test.js`:

```js
test("the fleet grid and node tabs are wired up", () => {
  for (const id of ["tabs", "fleet"]) assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /fetch\("\/__ctl\/nodes\?t="/);
  assert.match(HTML, /`\/__ctl\/node\/\$\{currentNode\}`/);
  assert.match(HTML, /"\/__ctl\/refresh\?node=all"/);
  assert.match(HTML, /window\.addEventListener\("hashchange"/);
  // container buttons only for the hub's own host
  assert.match(HTML, /if \(!ctlAllowed \|\| !isLocalView\(\)\) return "";/);
  assert.match(HTML, /\/logs\$\{nodeQuery\(\)\}/);
  // node names, statuses and mounts come from remote machines: always escaped
  for (const expr of ["esc(n.name)", "esc(n.status)", "esc(disk.mount)", "esc(n.id)"]) {
    assert.ok(HTML.includes("${" + expr + "}"), `renderFleet must use \${${expr}}`);
  }
});

test("snapshot times are milliseconds", () => {
  assert.match(HTML, /const age = \(Date\.now\(\) - \(ts \|\| 0\)\) \/ 1000;/);
  assert.match(HTML, /new Date\(ts \|\| 0\)\.toLocaleTimeString\(\)/);
});

test("fleet numbers show a dash when unknown", () => {
  const fmtVal = pageFunction("fmtVal");
  assert.strictEqual(fmtVal(null, "%"), "–");
  assert.strictEqual(fmtVal(12.6, "%"), "13%");
  assert.strictEqual(fmtVal(0, "°C"), "0°C");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL: no `#tabs`, no `fmtVal`, `ts` still read as seconds.

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html
    .grid > .panel, .grid > .p-wide, .grid > .p-full { grid-column: span 1; }
  }

  .panel {
```

   with

```html
    .grid > .panel, .grid > .p-wide, .grid > .p-full { grid-column: span 1; }
  }

  /* fleet: node tabs and node cards (spec 10.1, layout B) */
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 14px; }
  .tabs button { font: inherit; font-size: 12px; background: var(--bg-panel); color: var(--dim);
    border: var(--border-w, 1px) solid var(--border); padding: 3px 10px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; }
  .tabs button.on { color: var(--fg-bright); border-color: var(--blue); }
  .fleet { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .ncard { cursor: pointer; display: flex; flex-direction: column; gap: 8px; }
  .ncard:hover { border-color: var(--blue); }
  .ncard .nhead { display: flex; align-items: center; gap: 8px; color: var(--fg-bright);
    text-transform: uppercase; letter-spacing: .1em; font-size: 11.5px; }
  .ncard .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; font-variant-numeric: tabular-nums; }
  .ncard .kv small { display: block; color: var(--dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .ncard .foot { display: flex; justify-content: space-between; gap: 6px; color: var(--dim); font-size: 12px; }
  .ncard.stale, .ncard.offline, .ncard.waiting { opacity: .62; }
  .lamp { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: none; display: inline-block; }
  .lamp.stale { background: var(--amber); }
  .lamp.offline { background: var(--red); }
  .lamp.waiting { background: var(--dim); }

  .panel {
```

2. Replace

```html
    </div>
  </div>

  <div class="grid" id="grid">
```

   with

```html
    </div>
  </div>

  <nav class="tabs hidden" id="tabs" aria-label="nodes"></nav>
  <div class="fleet hidden" id="fleet"></div>

  <div class="grid" id="grid">
```

3. Replace

```html
}

async function tick() {
  try {
    const d = await (await fetch("data.json?t=" + Date.now())).json();
    lastData = d;
    renderMetrics(d);
```

   with

```html
}

/* ------------------------------------------------------------------ fleet
   With more than one node the page opens on the fleet grid (#fleet); the tabs
   and the cards open one node's view (#node=<id>). With one node it is the
   node view, as before. Container buttons exist only for the hub's own host. */
let fleetNodes = [];
let localNode = null;
let view = "node";            // "node" | "fleet"
let currentNode = null;       // the node in the node view; null means the local node

const isLocalView = () => !currentNode || currentNode === localNode;
const nodeQuery = () => (currentNode ? "?node=" + encodeURIComponent(currentNode) : "");

async function loadNodes() {
  try {
    const r = await fetch("/__ctl/nodes?t=" + Date.now());
    if (!r.ok) return;
    fleetNodes = await r.json();
  } catch (e) { return; }
  const local = fleetNodes.find(n => n.local);
  localNode = local ? local.id : null;
  renderTabs();
}

function route() {
  const m = /^#node=([a-z2-7]{12})$/.exec(location.hash);
  const wasView = view, wasNode = currentNode;
  if (m && fleetNodes.some(n => n.id === m[1])) { view = "node"; currentNode = m[1]; }
  else if (location.hash === "#fleet" || (!m && fleetNodes.length > 1)) { view = "fleet"; currentNode = null; }
  else { view = "node"; currentNode = null; }
  if (view !== wasView || currentNode !== wasNode) {
    // another node: its own sparklines, containers and network history
    lastData = null; dockerData = null; netData = null;
    hist = { cpu: [], mem: [], temp: [] }; trendFromServer = false;
  }
  $("#fleet").classList.toggle("hidden", view !== "fleet");
  $("#grid").classList.toggle("hidden", view === "fleet");
  renderTabs();
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.classList.toggle("hidden", fleetNodes.length < 2);
  if (fleetNodes.length < 2) return;
  const shown = view === "fleet" ? "fleet" : (currentNode || localNode);
  tabs.innerHTML = `<button data-go="fleet" class="${shown === "fleet" ? "on" : ""}">fleet</button>`
    + fleetNodes.map(n => `<button data-go="${esc(n.id)}" class="${shown === n.id ? "on" : ""}">`
      + `<span class="lamp ${esc(n.status)}"></span>${esc(n.name)}</button>`).join("");
}

function fmtVal(v, unit) { return v == null ? "–" : Math.round(v) + unit; }

function renderFleet() {
  $("#fleet").innerHTML = fleetNodes.map(n => {
    const s = n.summary || {};
    const disk = s.disk;
    const dcls = disk ? HCLS[health(disk.pct, 78, 90)] : "";
    const ago = n.lastSeen ? fmtDur((Date.now() - n.lastSeen) / 1000) + " ago" : "";
    const foot = n.status === "online"
      ? (disk ? `disk ${esc(disk.mount)} <span class="${dcls}">${disk.pct}%</span>` : esc(s.host && s.host.distro || ""))
      : n.status === "waiting" ? "waiting for the first push" : `${esc(n.status)} · ${ago}`;
    const cont = s.containers ? `${s.running}/${s.containers} up` : "";
    return `<div class="panel ncard ${esc(n.status)}" data-node="${esc(n.id)}">`
      + `<div class="nhead"><span class="lamp ${esc(n.status)}"></span>${esc(n.name)}</div>`
      + `<div class="kv"><span><small>cpu</small>${fmtVal(s.cpu, "%")}</span>`
      + `<span><small>mem</small>${fmtVal(s.mem, "%")}</span>`
      + `<span><small>temp</small>${fmtVal(s.temp, "°C")}</span></div>`
      + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
      + (disk ? meter(disk.pct, dcls) : "")
      + `<div class="foot"><span>${foot}</span><span>${cont}</span></div></div>`;
  }).join("");
  const online = fleetNodes.filter(n => n.status === "online").length;
  const dot = $("#statusdot");
  dot.classList.remove("down", "stale");
  if (online < fleetNodes.length) dot.classList.add(fleetNodes.some(n => n.status === "offline") ? "down" : "stale");
  $("#hostname").textContent = cfg.title || "servitals";
  $("#hostmeta").textContent = `${fleetNodes.length} nodes · ${online} online`;
  $("#lastupdate").textContent = `fleet · ${new Date().toLocaleTimeString()}`;
}

async function tick() {
  if (view === "fleet") { await loadNodes(); renderFleet(); return; }
  try {
    const r = await fetch((currentNode ? `/__ctl/node/${currentNode}` : "data.json") + "?t=" + Date.now());
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "no snapshot");
    lastData = d;
    renderMetrics(d);
```

4. Replace

```html
function setStatus(ts, hardFail) {
  const dot = $("#statusdot");
  const age = Date.now() / 1000 - (ts || 0);
  // tolerate the agent's own heartbeat interval (it only samples on demand)
  const budget = ((lastData && lastData.interval) || cfg.refreshSec || 60) * 2 + 120;
```

   with

```html
function setStatus(ts, hardFail) {
  const dot = $("#statusdot");
  const age = (Date.now() - (ts || 0)) / 1000;   // ts is in milliseconds
  // tolerate the agent's own heartbeat interval (it only samples on demand)
  const budget = ((lastData && lastData.interval) || cfg.refreshSec || 60) * 2 + 120;
```

5. Replace

```html
  else { label = "online"; }
  $("#lastupdate").textContent = label + " · " +
    new Date((ts || 0) * 1000).toLocaleTimeString();
}

```

   with

```html
  else { label = "online"; }
  $("#lastupdate").textContent = label + " · " +
    new Date(ts || 0).toLocaleTimeString();
}

```

6. Replace

```html
      + `<td class="tx">${withAvg ? fmtRate(o.avgTx) : "—"}</td>`
      + `</tr>`;
    $("#net-tbody").innerHTML =
      trow("today", n.today, true) + trow("month", n.month, true) + trow("all time", n.total, false);

    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const frac = (now.getDate() - 1 + now.getHours() / 24) / dim;
    $("#net-est").textContent = frac > 0.02
      ? "projected " + fmtBytes((n.month.rx + n.month.tx) / frac) + " this month" : "";

```

   with

```html
      + `<td class="tx">${withAvg ? fmtRate(o.avgTx) : "—"}</td>`
      + `</tr>`;
    // without vnStat only the live rate is known
    $("#net-tbody").innerHTML = [["today", n.today, true], ["month", n.month, true], ["all time", n.total, false]]
      .filter(([, o]) => o).map(([label, o, avg]) => trow(label, o, avg)).join("");

    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const frac = (now.getDate() - 1 + now.getHours() / 24) / dim;
    $("#net-est").textContent = n.month && frac > 0.02
      ? "projected " + fmtBytes((n.month.rx + n.month.tx) / frac) + " this month" : "";

```

7. Replace

```html
}
function ctlButtons(c) {
  if (!ctlAllowed) return "";
  const p = portainerLink(c);
  const run = c.state === "running";
```

   with

```html
}
function ctlButtons(c) {
  if (!ctlAllowed || !isLocalView()) return "";
  const p = portainerLink(c);
  const run = c.state === "running";
```

8. Replace

```html
  $("#docker-note").textContent = `${up.length}/${list.length} up`
    + (haveStats ? ` · ${fmtBytes(totMem)} · ${totCpu.toFixed(0)}% cpu` : "")
    + (ctlAllowed ? "" : " · controls: LAN only");
  $$(".svsort").forEach(s => s.classList.toggle("on", s.dataset.s === svcSort));
  $("#docker-list").classList.toggle("ctl", ctlAllowed);
  const openNames = new Set($$(".svc.open", $("#docker-list")).map(el => el.dataset.name));

```

   with

```html
  $("#docker-note").textContent = `${up.length}/${list.length} up`
    + (haveStats ? ` · ${fmtBytes(totMem)} · ${totCpu.toFixed(0)}% cpu` : "")
    + (!isLocalView() ? " · controls: hub host only" : ctlAllowed ? "" : " · controls: LAN only");
  $$(".svsort").forEach(s => s.classList.toggle("on", s.dataset.s === svcSort));
  $("#docker-list").classList.toggle("ctl", ctlAllowed && isLocalView());
  const openNames = new Set($$(".svc.open", $("#docker-list")).map(el => el.dataset.name));

```

9. Replace

```html
  if (btn) { btn.disabled = true; }
  try {
    const r = await fetch(`/__ctl/container/${encodeURIComponent(name)}/${action}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || `${action} failed (${r.status})`, true); return; }
```

   with

```html
  if (btn) { btn.disabled = true; }
  try {
    const r = await fetch(`/__ctl/container/${encodeURIComponent(name)}/${action}${nodeQuery()}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || `${action} failed (${r.status})`, true); return; }
```

10. Replace

```html
  $("#logs-overlay").classList.add("open");
  try {
    const r = await fetch(`/__ctl/container/${encodeURIComponent(name)}/logs`);
    const txt = await r.text();
    $("#logs-body").textContent = r.ok ? (txt || "(no output)") : `error: ${txt}`;
```

   with

```html
  $("#logs-overlay").classList.add("open");
  try {
    const r = await fetch(`/__ctl/container/${encodeURIComponent(name)}/logs${nodeQuery()}`);
    const txt = await r.text();
    $("#logs-body").textContent = r.ok ? (txt || "(no output)") : `error: ${txt}`;
```

11. Replace

```html
  refreshing = true;
  await tick();                                   // show the current snapshot first
  const before = lastData ? lastData.ts : 0;
  try { await fetch("/__ctl/refresh", { method: "POST" }); } catch (e) {}
  // then poll until the agent publishes one newer than that (or give up ~7 s)
  for (let i = 0; i < 14; i++) {
```

   with

```html
  refreshing = true;
  await tick();                                   // show the current snapshot first
  if (view === "fleet") {
    try { await fetch("/__ctl/refresh?node=all", { method: "POST" }); } catch (e) {}
    await new Promise(r => setTimeout(r, 2500));  // agents answer a wake within about 2 s
    await tick();
    refreshing = false;
    return;
  }
  const before = lastData ? lastData.ts : 0;
  try { await fetch("/__ctl/refresh" + nodeQuery(), { method: "POST" }); } catch (e) {}
  // then poll until the agent publishes one newer than that (or give up ~7 s)
  for (let i = 0; i < 14; i++) {
```

12. Replace

```html
  renderWeather();
  tickClocks();
  startTimers();
  refreshNow(true);       // a fresh sample for the first view, not a stale data.json
```

   with

```html
  renderWeather();
  tickClocks();
  await loadNodes();
  route();
  window.addEventListener("hashchange", () => { route(); refreshNow(true); });
  $("#tabs").onclick = e => {
    const b = e.target.closest("button[data-go]");
    if (b) location.hash = b.dataset.go === "fleet" ? "#fleet" : "#node=" + b.dataset.go;
  };
  $("#fleet").onclick = e => {
    const c = e.target.closest(".ncard[data-node]");
    if (c) location.hash = "#node=" + c.dataset.node;
  };
  startTimers();
  refreshNow(true);       // a fresh sample for the first view, not a stale data.json
```

13. Replace

```html
    if (e.key === "y") toggleStyle();
    if (e.key === "r") { e.preventDefault(); refreshNow(); }
    if (e.key === "Escape") { closeSettings(); $("#logs-overlay").classList.remove("open"); }
  });
```

   with

```html
    if (e.key === "y") toggleStyle();
    if (e.key === "r") { e.preventDefault(); refreshNow(); }
    if (e.key === "f" && fleetNodes.length > 1) location.hash = "#fleet";
    if (e.key === "Escape") { closeSettings(); $("#logs-overlay").classList.remove("open"); }
  });
```

- [ ] **Step 4: Run all tests and the budget**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS; first page load about 23.1 KB gzipped (limit 60 KB).

- [ ] **Step 5: Commit**

```bash
git add www/index.html test/page.test.js
git commit -m "feat(ui): fleet grid and node tabs" -m "With a second node the page opens on a grid of node cards (status lamp, CPU, memory, temperature, CPU sparkline, fullest disk, containers) and tabs for each node's panels. Container buttons appear only for the hub's own host. Snapshot times are milliseconds; the network panel works without vnStat."
```

---

### Task 5: `servitals-agent join` and `status`

**Files:**
- Modify: `bin/servitals-agent` (whole file), `test/cli.test.js`

**Interfaces:**
- Consumes: `servitals-ctl node add` (Task 2), the agent's `ONCE=1` push and `$STATE/last-push` (Task 3).
- Produces: `servitals-agent join [--no-start] <hub-url> <node-id>:<secret>` prints `testing …`, then `ok`, `unreachable: …`, `bad secret: …`, `clock skew: …`, `unsupported protocol: …` or `failed: HTTP …`; on `ok` it writes `CREDENTIALS_FILE` (default `/etc/servitals/agent-credentials.env`, 0600, owned by `_servitals-agent` when run as root) and, without `--no-start`, enables and restarts the unit (`SYSTEMCTL` overrides `systemctl` in tests). `servitals-agent status` prints `hub:`, `node:`, `service:`, `last push:`. Task 6's autopkgtest uses `join --no-start`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
const { startHub, request, login, cookieFrom } = require("./helpers/hub");

function joinEnv(extra = {}) {
  return { AGENT_ENV: "/nonexistent", HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent", COLLECT_NET: "0",
           SYSTEMCTL: "true", ...extra };
}
function addNodeWithCtl(hub, name) {
  const etc = tmp();
  fs.writeFileSync(path.join(etc, "hub.env"), `PUBLIC_URL=http://127.0.0.1:${hub.port}/\n`);
  const r = run("servitals-ctl", ["node", "add", name], { STATE_DIR: hub.dataDir, ETC_DIR: etc });
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /servitals-agent join (\S+) ([a-z2-7]{12}):([0-9a-f]{64})/.exec(r.stdout);
  assert.ok(m, r.stdout);
  return { url: m[1], id: m[2], secret: m[3], out: r.stdout };
}

test("node add prints a join command; join tests the push and saves the credentials", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    assert.strictEqual(n.url, `http://127.0.0.1:${hub.port}`, "PUBLIC_URL without its trailing slash");
    const creds = path.join(tmp(), "agent-credentials.env");
    const r = run("servitals-agent", ["join", "--no-start", n.url, `${n.id}:${n.secret}`], joinEnv({ CREDENTIALS_FILE: creds }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok$/m);
    assert.ok(!r.stdout.includes(n.secret) && !r.stderr.includes(n.secret), "the secret is not echoed");
    assert.strictEqual(fs.statSync(creds).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(creds, "utf8"), new RegExp(`^NODE_ID=${n.id}$`, "m"));
    const cookie = cookieFrom(await login(hub.port));
    const list = JSON.parse((await request(hub.port, { path: "/__ctl/nodes", headers: { cookie } })).body);
    assert.strictEqual(list.find((x) => x.id === n.id).status, "online", "the test push landed");
    const listed = run("servitals-ctl", ["node", "list"], { STATE_DIR: hub.dataDir });
    assert.match(listed.stdout, new RegExp(`^${n.id} +nas +remote +- +\\d{4}-`, "m"));
  } finally { await hub.stop(); }
});

test("join explains what went wrong and saves nothing", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    const creds = path.join(tmp(), "agent-credentials.env");
    const cases = [
      [[n.url, `${n.id}:${"ab".repeat(32)}`], /^bad secret: copy the whole join string again$/m],
      [[n.url, `aaaaaaaaaaaa:${n.secret}`], /^bad secret: the hub does not know this node id/m],
      [["http://127.0.0.1:9", `${n.id}:${n.secret}`], /^unreachable: /m],
    ];
    for (const [args, want] of cases) {
      const r = run("servitals-agent", ["join", "--no-start", ...args], joinEnv({ CREDENTIALS_FILE: creds }));
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stdout, want, args.join(" "));
      assert.ok(!fs.existsSync(creds));
    }
    const bad = run("servitals-agent", ["join", n.url, "nonsense"], joinEnv({ CREDENTIALS_FILE: creds }));
    assert.match(bad.stderr, /join string/);
  } finally { await hub.stop(); }
});

test("status shows the hub, the node and the last push", async () => {
  const hub = await startHub();
  try {
    const n = addNodeWithCtl(hub, "nas");
    const dir = tmp();
    const creds = path.join(dir, "credentials.env");
    fs.writeFileSync(creds, `HUB_URL=${n.url}\nNODE_ID=${n.id}\nNODE_SECRET=${n.secret}\n`);
    fs.writeFileSync(path.join(dir, "last-push"), `${Math.floor(Date.now() / 1000)} 200 -\n`);
    const r = run("servitals-agent", ["status"], { CREDENTIALS_FILE: creds, STATE_DIR: dir, SYSTEMCTL: "true" });
    assert.match(r.stdout, new RegExp(`^hub: +${n.url.replace(/[.]/g, "\\.")}$`, "m"));
    assert.match(r.stdout, new RegExp(`^node: +${n.id}$`, "m"));
    assert.match(r.stdout, /^last push: \d{4}-\d\d-\d\d .* ok$/m);
    assert.ok(!r.stdout.includes(n.secret));
    // the service's files are root-only: say so instead of "not paired" (root reads them anyway)
    if (process.getuid() !== 0) {
      fs.chmodSync(creds, 0o000);
      const lockedState = tmp();
      fs.chmodSync(lockedState, 0o600);
      const locked = run("servitals-agent", ["status"], { CREDENTIALS_FILE: creds, STATE_DIR: lockedState, SYSTEMCTL: "true" });
      fs.chmodSync(lockedState, 0o700);
      assert.match(locked.stdout, /^hub: +\(run with sudo to read /m);
      assert.match(locked.stdout, /^last push: \(run with sudo to read /m);
    }
  } finally { await hub.stop(); }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/cli.test.js`
Expected: FAIL: `join` and `status` print the usage text.

- [ ] **Step 3: Replace `bin/servitals-agent`**

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals-agent: run and inspect the servitals agent.
#   servitals-agent join <hub-url> <node-id>:<secret>   pair with a hub (from servitals-ctl node add)
#   servitals-agent status           show the hub, the node and the last push
#   servitals-agent run              run the agent (the systemd unit uses this)
#   servitals-agent test             sample once and print the snapshot; nothing is sent
#   servitals-agent docker enable    let the agent read the Docker socket (root-equivalent)
#   servitals-agent docker disable   take that access away again
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [ -f "$SELF_DIR/../agent/collect.sh" ]; then
  AGENT_HOME="$(cd "$SELF_DIR/../agent" && pwd)"   # running from a checkout
else
  AGENT_HOME=/usr/lib/servitals-agent
fi
UNIT=servitals-agent.service

die() { echo "servitals-agent: $*" >&2; exit 1; }

docker_access() {  # enable|disable
  local dir="${DROPIN_ROOT:-/etc/systemd/system}/$UNIT.d"
  case "${1:-}" in
    enable)
      "${GETENT:-getent}" group docker >/dev/null || die "this host has no docker group"
      echo "warning: members of the docker group can take over this host as root." >&2
      echo "The agent only reads the container list, but whoever controls the agent gets that power." >&2
      mkdir -p "$dir"
      printf '# written by: servitals-agent docker enable\n[Service]\nSupplementaryGroups=docker\n' > "$dir/docker.conf"
      ;;
    disable) rm -f "$dir/docker.conf" ;;
    *) die "usage: servitals-agent docker enable|disable" ;;
  esac
  "${SYSTEMCTL:-systemctl}" daemon-reload
  "${SYSTEMCTL:-systemctl}" try-restart "$UNIT"
  echo "docker access ${1}d for $UNIT"
}

cmd_test() {
  local env_file="${AGENT_ENV:-/etc/servitals/agent.env}"
  if [ -r "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
  fi
  # global, not local: the EXIT trap runs after this function has returned
  TEST_DIR=$(mktemp -d)
  trap 'rm -rf "$TEST_DIR"' EXIT
  STATE_DIR="$TEST_DIR" OUT_FILE="$TEST_DIR/snapshot.json" ONCE=1 HOST_ROOT="${HOST_ROOT:-/}" \
    bash "$AGENT_HOME/collect.sh" >&2 || die "sampling failed"
  jq . "$TEST_DIR/snapshot.json"
}

CREDENTIALS_FILE="${CREDENTIALS_FILE:-/etc/servitals/agent-credentials.env}"
AGENT_STATE="${STATE_DIR:-/var/lib/servitals-agent}"

# the test push's outcome in words (spec 6.1)
join_result() {  # status error
  case "$1:$2" in
    2??:*) echo ok ;;
    000:*) echo "unreachable: no answer from the hub (address, port, firewall, proxy?)" ;;
    401:bad_signature|bad_reply_signature:*) echo "bad secret: copy the whole join string again" ;;
    401:unknown_node) echo "bad secret: the hub does not know this node id (revoked?)" ;;
    401:clock_skew) echo "clock skew: this machine's clock differs from the hub's by more than 2 minutes (check NTP)" ;;
    426:*) echo "unsupported protocol: update servitals or servitals-agent" ;;
    *) echo "failed: HTTP $1 ${2:-}" ;;
  esac
}

cmd_join() {
  local start=1 url cred id secret state status err result
  if [ "${1:-}" = --no-start ]; then start=0; shift; fi
  [ $# -eq 2 ] || die "usage: servitals-agent join [--no-start] <hub-url> <node-id>:<secret>"
  url=${1%/} cred=$2
  id=${cred%%:*} secret=${cred#*:}
  [[ $url =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || die "hub url must start with http:// or https://"
  [[ $id =~ ^[a-z2-7]{12}$ && $secret =~ ^[0-9a-f]{64}$ ]] || die "the join string is <12-character node id>:<64 hex characters>"
  # global, not local: the EXIT trap runs after this function has returned
  JOIN_DIR=$(mktemp -d)
  trap 'rm -rf "$JOIN_DIR"' EXIT
  chmod 700 "$JOIN_DIR"
  printf 'HUB_URL=%s\nNODE_ID=%s\nNODE_SECRET=%s\n' "$url" "$id" "$secret" > "$JOIN_DIR/credentials.env"
  state="$JOIN_DIR/state"
  echo "testing $url as node $id ..."
  # the same settings the service uses (proxy, HUB_HEADERS, HUB_CA_FILE, disks)
  if [ -r "${AGENT_ENV:-/etc/servitals/agent.env}" ]; then
    set -a
    # shellcheck source=/dev/null
    . "${AGENT_ENV:-/etc/servitals/agent.env}"
    set +a
  fi
  STATE_DIR="$state" CREDENTIALS_FILE="$JOIN_DIR/credentials.env" ONCE=1 HOST_ROOT="${HOST_ROOT:-/}" \
    bash "$AGENT_HOME/collect.sh" > "$JOIN_DIR/log" 2>&1 || true
  read -r _ status err < "$state/last-push" 2>/dev/null || { status=000; err=-; }
  result=$(join_result "$status" "$err")
  echo "$result"
  [ "$result" = ok ] || exit 1
  install -m 600 "$JOIN_DIR/credentials.env" "$CREDENTIALS_FILE"
  # the service reads it as _servitals-agent (only root can hand it over)
  if [ "$(id -u)" = 0 ] && getent passwd _servitals-agent >/dev/null 2>&1; then
    chown _servitals-agent:_servitals-agent "$CREDENTIALS_FILE"
  fi
  echo "saved $CREDENTIALS_FILE"
  if [ "$start" = 1 ]; then
    "${SYSTEMCTL:-systemctl}" enable servitals-agent.service >/dev/null 2>&1 || true
    "${SYSTEMCTL:-systemctl}" restart servitals-agent.service && echo "servitals-agent started"
  fi
}

cmd_status() {
  local k v url="" id="" at="" status="" err=""
  if [ -r "$CREDENTIALS_FILE" ]; then
    while IFS='=' read -r k v; do
      case "$k" in HUB_URL) url=${v%$'\r'} ;; NODE_ID) id=${v%$'\r'} ;; esac
    done < "$CREDENTIALS_FILE"
  fi
  if [ -e "$CREDENTIALS_FILE" ] && [ ! -r "$CREDENTIALS_FILE" ]; then
    echo "hub:       (run with sudo to read $CREDENTIALS_FILE)"
  else
    echo "hub:       ${url:-not paired (servitals-agent join)}"
  fi
  echo "node:      ${id:--}"
  echo "service:   $("${SYSTEMCTL:-systemctl}" is-active servitals-agent.service 2>/dev/null || true)"
  if read -r at status err < "$AGENT_STATE/last-push" 2>/dev/null; then
    echo "last push: $(date -d "@$at" '+%F %T') $(join_result "$status" "$err")"
  elif [ -d "$AGENT_STATE" ] && [ ! -x "$AGENT_STATE" ]; then
    echo "last push: (run with sudo to read $AGENT_STATE)"
  else
    echo "last push: none yet"
  fi
}

case "${1:-}" in
  join)   shift; cmd_join "$@" ;;
  status) shift; cmd_status "$@" ;;
  run)    shift; exec bash "$AGENT_HOME/collect.sh" "$@" ;;
  test)   shift; cmd_test ;;
  docker) shift; docker_access "$@" ;;
  *) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
```

- [ ] **Step 4: Run all tests and shellcheck**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-agent`
Expected: PASS; no shellcheck output.

- [ ] **Step 5: Commit**

```bash
git add bin/servitals-agent test/cli.test.js
git commit -m "feat(agent): join and status" -m "join tests one push with the new credentials and says ok, unreachable, bad secret, clock skew or unsupported protocol in plain words; only on ok does it save the credentials (0600, for _servitals-agent) and start the service. status shows the hub, the node id, the unit and the last push."
```

---

### Task 6: Networking guide, man pages, package tests

**Files:**
- Create: `docs/networking.md`
- Modify: `man/servitals-ctl.1`, `man/servitals-agent.1`, `packaging/etc/agent.env`, `README.md`, `CHANGELOG.md`, `debian/tests/smoke`

**Interfaces:**
- Consumes: everything above.
- Produces: user docs for pairing and networks (spec 15.1); autopkgtest pairs a second agent (spec 13.4).

- [ ] **Step 1: Pair a second agent in the package test (failing first)**

In `debian/tests/smoke`:

1. Replace

```bash
wait_for "curl -fsS -b /tmp/jar $B/data.json 2>/dev/null | jq -e .host.name >/dev/null" || fail "no snapshot from the local agent"

printf 'another-pass-1\n' | servitals-ctl passwd --user owner
[ "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar "$B/__ctl/whoami")" = 401 ] || fail "old session survived passwd"
```

   with

```bash
wait_for "curl -fsS -b /tmp/jar $B/data.json 2>/dev/null | jq -e .host.name >/dev/null" || fail "no snapshot from the local agent"

# a second machine joins (spec 13.4): here the same host with its own credentials
join=$(servitals-ctl node add second | sed -n 's/^ *sudo servitals-agent join //p')
[ -n "$join" ] || fail "node add printed no join command"
# shellcheck disable=SC2086  # the join command is two words
[ "$(CREDENTIALS_FILE=/tmp/second.env servitals-agent join --no-start $join | tail -n 1)" = "saved /tmp/second.env" ] \
	|| fail "second agent could not join"
wait_for "curl -fsS -b /tmp/jar $B/__ctl/nodes | jq -e 'map(select(.name == \"second\" and .status == \"online\")) | length == 1' >/dev/null" \
	|| fail "second node not online in the fleet"

printf 'another-pass-1\n' | servitals-ctl passwd --user owner
[ "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar "$B/__ctl/whoami")" = 401 ] || fail "old session survived passwd"
```

Run: `IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh resolute && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh resolute`
Expected at this point: `smoke PASS` already (Tasks 2-5 are in the package). If it fails, the message names the step.

- [ ] **Step 2: `docs/networking.md`**

````markdown
# Networking: how agents reach the hub

Agents only make outbound HTTPS (or HTTP) requests to the hub. A watched
server needs no public address and no open port; only the hub must be
reachable by its agents. Everything below is about making the hub
reachable, and about the proxies and tunnels in between.

## Pair a server

On the hub:

```bash
sudo servitals-ctl node add nas --tag home
# added "nas" as node k3j7q2m4x5ab. On that server, run once (the secret is shown only now):
#   sudo servitals-agent join http://hub.lan:20002 k3j7q2m4x5ab:9f0c…
```

On the server (after `apt install servitals-agent`), run the printed line.
`join` sends one test push and says `ok`, or what went wrong (see
[Troubleshooting](#troubleshooting)). Set `PUBLIC_URL` in
`/etc/servitals/hub.env` when agents should use another address than the
hub's host name, for example a tunnel hostname.

## Pick a setup

| situation | what to do |
| --- | --- |
| all servers on one LAN | agents use the hub's LAN address: `http://hub.lan:20002` |
| servers on different sites | Tailscale or WireGuard; agents use the hub's private overlay address (recommended) |
| hub behind a Cloudflare tunnel | agents use the tunnel hostname; turn off Bot Fight Mode for it; Cloudflare Access needs a service token in `HUB_HEADERS` |
| hub behind a reverse proxy | TLS at the proxy; set `TRUSTED_PROXIES` in `hub.env` to the proxy's address |
| server with no outbound internet except one allowed destination | allow outbound 443 to the hub hostname only |
| server that reaches the internet through an HTTP proxy | `HTTPS_PROXY` in `agent.env`; lower `WAIT_SECONDS` if the proxy drops idle connections |
| many private servers in a closed network | run a self-hosted hub inside it (relaying chosen nodes to the hosted service comes later) |
| phone notifications (Web Push, later) | the hub must be served over HTTPS (tunnel, Tailscale certificate, or reverse proxy) |

### Same LAN

Nothing to set up. Use the address `servitals-ctl node add` prints, or put
`PUBLIC_URL=http://<lan address>:20002` in `hub.env` first.

### Tailscale or WireGuard

Install Tailscale on the hub and the servers. Use the hub's Tailscale name
or address: `http://hub.tailnet-name.ts.net:20002`. With
`tailscale cert` and a reverse proxy the hub can also serve HTTPS; plain
HTTP inside the tailnet is already encrypted by WireGuard.

### Cloudflare tunnel

1. Point a public hostname of the tunnel at `http://localhost:20002` on the
   hub (loopback: the hub then trusts the tunnel's `X-Forwarded-For`).
2. **Turn off Bot Fight Mode** for that hostname. It cannot be bypassed with
   WAF rules and blocks the agent's requests.
3. With Cloudflare Access in front, create a service token and give it to
   each agent in `/etc/servitals/agent.env`:

   ```sh
   HUB_HEADERS=CF-Access-Client-Id: <id>.access; CF-Access-Client-Secret: <secret>
   ```

   Headers are separated by `;`. They are sent with every request and never
   written to the log.
4. Set `PUBLIC_URL=https://dash.example.org` in `hub.env`, so
   `servitals-ctl node add` prints the tunnel address.

### Reverse proxy

Terminate TLS at the proxy and forward to the hub. Put the proxy's address
in `TRUSTED_PROXIES` in `hub.env` (loopback is the default); forwarding
headers from any other address are ignored. A hub with a certificate from a
private CA: give agents that CA in `HUB_CA_FILE=/etc/servitals/hub-ca.pem`.

### Outbound HTTP proxy

In `/etc/servitals/agent.env`:

```sh
HTTPS_PROXY=http://user:password@proxy.example:3128
NO_PROXY=.internal.example
```

`curl` tunnels HTTPS through the proxy with `CONNECT`. The agent always adds
`localhost,127.0.0.1,::1` to `NO_PROXY`, so the hub's own agent never uses
the proxy. Proxies and firewalls often cut idle connections before the
55-second long poll ends: set `WAIT_SECONDS=25` (5 to 55) if waits keep
failing.

## Troubleshooting

`servitals-agent join` and `servitals-agent status` report one of these:

| result | likely cause | fix |
| --- | --- | --- |
| `ok` | | |
| `unreachable` | wrong address or port, a firewall, DNS, the proxy, or TLS (untrusted certificate) | `curl -v <hub-url>/__auth/health` from the server; check `HTTPS_PROXY` and `HUB_CA_FILE` |
| `bad secret: copy the whole join string again` | a typo, or a secret from an older `node add` | run `servitals-ctl node add` again, or copy the line exactly |
| `bad secret: the hub does not know this node id` | the node was revoked, or the join line is for another hub | `servitals-ctl node list` on the hub |
| `clock skew` | the server's clock is more than 2 minutes off | enable NTP: `timedatectl set-ntp true` |
| `unsupported protocol` | the agent and hub versions do not share a protocol | update both packages |

Protocol errors in the agent's log (`journalctl -u servitals-agent`):

| log line | meaning | what the agent does |
| --- | --- | --- |
| `status=401 error=unknown_node` | node revoked or unknown | stops asking for 10 minutes at a time until the credentials change |
| `status=401 error=bad_signature` | wrong secret | backs off |
| `status=401 error=clock_skew` | clock off by more than 2 minutes | backs off; fix NTP |
| `status=401 error=replay` | a request was sent twice | retries once with a new timestamp |
| `status=413 error=too_large` | snapshot over 256 KiB | resends without the container and process lists |
| `status=422 error=invalid_snapshot` | a value outside its range | report a bug with the log line |
| `status=426` | unsupported protocol | stops; update |
| `status=429` | pushing more often than every 5 s, or too many failed requests from this address | waits `Retry-After` |
| `status=000` | no answer (network, DNS, proxy, TLS) | backs off from 5 s up to the heartbeat |
| `status=bad_reply_signature` | a reply the hub did not sign: an impostor, or a proxy that rewrites bodies | treats it as a failure |
````

- [ ] **Step 3: Man pages and `agent.env`**

In `man/servitals-ctl.1`:

1. Replace

```
Reads the password twice from the terminal, or one line from standard
input. Every session ends; no restart is needed.
.TP
.B bans
```

   with

```
Reads the password twice from the terminal, or one line from standard
input. Every session ends; no restart is needed.
.TP
.BI "node add" " name" " \fR[\fB\-\-tag\fP" " tag" "\fR]...\fP"
Add a server to watch. Prints the
.B servitals-agent join
command to run on it, with the node's secret; the secret is shown only once.
.TP
.B node list
List servers with their id, name, tags and last push.
.TP
.BI "node rename" " id name"
Rename a server without pairing it again.
.TP
.BI "node revoke" " id"
Refuse a server's agent from now on.
.TP
.B bans
```

In `man/servitals-agent.1`:

1. Replace

```
servitals-agent \- metrics agent for the servitals dashboard
.SH SYNOPSIS
.B servitals-agent
.RB { run | test }
.br
.B servitals-agent docker
```

   with

```
servitals-agent \- metrics agent for the servitals dashboard
.SH SYNOPSIS
.B servitals-agent join
.RB [ \-\-no\-start ]
.I hub-url node-id:secret
.br
.B servitals-agent
.RB { status | run | test }
.br
.B servitals-agent docker
```

2. Replace

```
connections and never runs anything the hub sends.
.SH COMMANDS
.TP
.B run
```

   with

```
connections and never runs anything the hub sends.
.SH COMMANDS
.TP
.BI join " hub-url node-id:secret"
Pair with a hub, using the line
.B servitals-ctl node add
printed there. Sends one test push and reports
.BR ok ,
.BR "bad secret" ,
.BR "clock skew" ,
.B unreachable
or
.BR "unsupported protocol" .
On success it writes the credentials file and starts the service
.RB ( \-\-no\-start
skips that).
.TP
.B status
Show the hub, the node id, the service state and the last push.
.TP
.B run
```

3. Replace

```
.I /etc/servitals/agent.env
INTERVAL, DISKS (auto or a list of mountpoints), NET_IFACE, COLLECT_*
switches, STAT_TIMEOUT, WAIT_SECONDS, HTTPS_PROXY, NO_PROXY, LOG_LEVEL.
.TP
.I /etc/servitals/agent-credentials.env
```

   with

```
.I /etc/servitals/agent.env
INTERVAL, DISKS (auto or a list of mountpoints), NET_IFACE, COLLECT_*
switches, STAT_TIMEOUT, WAIT_SECONDS, HTTPS_PROXY, NO_PROXY, HUB_HEADERS
(extra request headers, for example a Cloudflare Access service token),
HUB_CA_FILE (a private CA for an HTTPS hub), LOG_LEVEL.
.TP
.I /etc/servitals/agent-credentials.env
```

In `packaging/etc/agent.env`:

1. Replace

```sh
# HTTPS_PROXY=http://proxy.example:3128
# NO_PROXY=
LOG_LEVEL=info

```

   with

```sh
# HTTPS_PROXY=http://proxy.example:3128
# NO_PROXY=
# extra headers for the hub, e.g. a Cloudflare Access service token ("Name: value; Name: value")
# HUB_HEADERS=CF-Access-Client-Id: <id>; CF-Access-Client-Secret: <secret>
# a private CA (or self-signed certificate) for an HTTPS hub
# HUB_CA_FILE=/etc/servitals/hub-ca.pem
LOG_LEVEL=info

```

Check: `for m in man/*; do man --warnings -l "$m" >/dev/null; done` prints nothing.

- [ ] **Step 4: README and CHANGELOG**

In `README.md`:

1. Replace

```markdown
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Native install (systemd, no Docker)
```

   with

````markdown
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Watch more servers

```bash
sudo servitals-ctl node add nas --tag home        # on the hub: prints a join command
sudo servitals-agent join http://hub.lan:20002 <node-id>:<secret>   # on the server
```

With a second server the dashboard opens on the fleet grid: one card per
server with its status lamp, CPU, memory, temperature, a CPU sparkline and
the fullest disk. Click a card, or a tab, for that server's panels; `f`
goes back to the fleet. Container buttons are only offered for the hub's
own host. Agents only make outbound requests, so watched servers need no
open port: see [docs/networking.md](docs/networking.md) for LANs,
Tailscale, Cloudflare tunnels, reverse proxies and HTTP proxies.

## Native install (systemd, no Docker)
````

In `CHANGELOG.md`:

1. Replace

```markdown

## [Unreleased]

## [0.1.0] - 2026-09-26
```

   with

```markdown

## [Unreleased]

### Added
- Watch several servers: `servitals-ctl node add|list|rename|revoke` and
  `servitals-agent join|status`. The dashboard shows a fleet grid and node
  tabs once there is a second server; container controls stay on the hub's
  own host.
- `HUB_HEADERS` (for example a Cloudflare Access service token) and
  `HUB_CA_FILE` for agents; `docs/networking.md`.

### Changed
- Agent protocol: snapshots are fully validated (schema 1); agents send
  counters and the hub derives network rates, container CPU and the trend.
  Snapshot `ts` is in milliseconds. Upgrade the hub and its agents together:
  the hub refuses snapshots from older agents (`invalid_snapshot`). With
  Docker, rebuild both images (`docker compose up -d --build`).
- The agent stops asking a hub that no longer knows it (`unknown_node`) and
  resends a too-large snapshot without its lists.

### Security
- An address that keeps failing agent authentication gets `429` for a
  minute. The last accepted request time per node survives a hub restart,
  so captured requests cannot be replayed after it.

## [0.1.0] - 2026-09-26
```

- [ ] **Step 5: Everything, on both series**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/compose-smoke.sh && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh && IMAGE_PREFIX=mirror.gcr.io/library/ bash test/deb-migrate.sh resolute`
Expected: PASS; `compose smoke test passed`; both series `ok` at about 134 KB and 19 KB with no lintian errors or warnings; `smoke PASS` and `purge PASS` on noble and resolute (exposure 1.4 / 1.5); `deb migration test passed`.

- [ ] **Step 6: Commit**

```bash
git add docs/networking.md man packaging/etc/agent.env README.md CHANGELOG.md debian/tests/smoke
git commit -m "docs: networking guide, pairing in the man pages and README; autopkgtest pairs a second agent"
```

---

### Task 7: Pull request, CI, and a real second machine

**Files:** none. **Interfaces:** consumes everything above.

- [ ] **Step 1: Push and open the PR (ask the user first)**

`git push -u origin feat/multinode`, open a PR against `main` (no Claude trailers in the body), and read CI with `gh run watch`. Expected: lint, test (18, 22), budget, compose and deb all green.

- [ ] **Step 2: See it with a browser (user)**

This host has no browser for Claude. After merge, update the live install from the checkout (`sudo packaging/install-local.sh`, or the PPA package once Task 11 of sub-project 3 is done). Then:
1. `sudo servitals-ctl node add <name>` on this host; run the printed `sudo servitals-agent join ...` on a second machine (a laptop or a VM with `servitals-agent` installed from the `.deb` in `build/deb/`).
2. Open the dashboard: it shows the fleet grid with two cards; clicking a card shows that machine's panels; `f` returns; container buttons appear only on this host's tab.
3. Restart the hub (`sudo systemctl restart servitals`): both cards come back at once and stay online.

- [ ] **Step 3: Handoff**

Run `/handoff`: 4a done; next plans 4b (code linking), 4c (styles and CSP-safe modules), 4d (customization, config as code), 4e (backup and rotation).
