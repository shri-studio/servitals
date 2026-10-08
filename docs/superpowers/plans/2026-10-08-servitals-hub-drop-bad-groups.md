# servitals One Bad Group Never Costs the Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an optional group in a pushed snapshot is invalid, the hub drops that group and stores the rest. It names the dropped paths in its reply and logs each new set once per node. Only an invalid required part (`schema`, `ts`, `interval`, `host`) still refuses the push with 422.

**Why:** 5e's review found that one glitched hwmon reading (1350000 rpm, or a driver's error voltage) made the hub refuse every push from that node. The node went stale on the dashboard for as long as the reading stayed bad. 5e fixed that source in the agent; the same weakness waits behind every other group, and behind any third-party agent. Spec 9 says every group degrades. The hub now honours that as well.

**Architecture:**
- **`hub/lib/snapshot.js`:** `build()` wraps each optional top-level value in `opt(() => …)`: `agent` and every group from `mem` to `ubuntu`. An `Invalid` thrown inside it records its path in `dropped` and leaves the group out. Required parts throw as before. `validate()` returns `{{ok: true, value, dropped}}` or `{{ok: false, path}}`.
- **`hub/lib/agentapi.js`:**
  - Stores the value.
  - When something was dropped, replies `{{ok: true, dropped: [...]}}` and logs `api.groups_dropped` (node, paths), but only when the set differs from the last one logged for that node. A clean push forgets it.
- **Agents:** unchanged; they read only the status.

**Tech Stack:** Node.js ≥ 18 (hub, tests).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 6.3 (validation; updated by this plan) and section 9 (every group degrades). Also `docs/protocol.md` rule 7 (updated).

**Scope:** The groups inside a group (for example one container of 200) stay all-or-nothing: a bad container drops `docker`, not just that container.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (920350b) on 2026-10-08: node suite 337 tests.

## Global Constraints

- Everything from sub-projects 1-5 still holds: zero runtime dependencies, Node 18 compatibility, SPDX headers.
- Untrusted input stays untrusted: a dropped group never reaches storage, and the reply names only paths, never values.
- A node with a persistently bad sensor logs one warning, not one per push.
- Work in a worktree `.claude/worktrees/servitals-groups` on branch `fix/hub-groups` from `main` (920350b).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Required parts:** `schema`, `ts`, `interval`, `host` and its fields still refuse the push. Tests: "a bad required value refuses the snapshot…" and the agentapi 422 cases.
2. **A bad optional group:** only it is dropped, the others are kept, and every dropped path is named. Test: "a bad value in an optional group drops that group only…".
3. **Logging:** once per node per set, never per push. Test: "a push with a bad optional group is stored without it…".
4. **Errors that are not validation errors** (a bug in the builder): these must still throw, not be swallowed as "dropped". Read `opt()`.
5. **Nothing invalid stored:** a dropped group leaves no partial copy (`clean()` drops `undefined`). Test: the group is `undefined` in the value.

---

### Task 1: Drop the invalid group, keep the snapshot

**Files:**
- Modify: `hub/lib/snapshot.js`, `hub/lib/agentapi.js`, `docs/protocol.md`, `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`, `CHANGELOG.md`, `test/snapshot.test.js`, `test/agentapi.test.js`

**Interfaces:**
- Produces:
  - `validate(s)` → `{ok: true, value, dropped: string[]}` or `{ok: false, path}`;
  - push reply `{ok: true, dropped}` when something was left out;
  - log event `api.groups_dropped` (`node`, `paths`).

- [ ] **Step 1: Write the failing tests**

In `test/snapshot.test.js`:

1. Replace

```js
  assert.strictEqual(r.value.processes.mem[0].name.length, 64);
  assert.strictEqual(r.value.processes.mem[0].cpuPct, null);
  assert.deepStrictEqual(validate(base({ processes: { cpu: [p(1, { rss: -1 })] } })), { ok: false, path: "$.processes.cpu[0].rss" });
});

```

   with

```js
  assert.strictEqual(r.value.processes.mem[0].name.length, 64);
  assert.strictEqual(r.value.processes.mem[0].cpuPct, null);
  assert.deepStrictEqual(validate(base({ processes: { cpu: [p(1, { rss: -1 })] } })).dropped, ["$.processes.cpu[0].rss"]);
});

```

2. Replace

```js
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.value.voltages, [{ label: "Vcore", value: 1.216 }, { label: "-12V", value: -11.9 }]);
  assert.deepStrictEqual(validate(base({ voltages: [{ label: "x", value: 5000 }] })), { ok: false, path: "$.voltages[0].value" });
  assert.deepStrictEqual(validate(base({ voltages: [{ label: "x" }] })), { ok: false, path: "$.voltages[0].value" });
  assert.strictEqual(validate(base({ voltages: Array.from({ length: 40 }, () => ({ label: "v", value: 1 })) })).value.voltages.length, 32);
});

test("the first bad value names its path", () => {
  const cases = [
    [null, "$"], [[1], "$"], [{ ...base(), schema: 2 }, "$.schema"], [{ ...base(), ts: -1 }, "$.ts"],
    [{ ...base(), ts: 1.5 }, "$.ts"], [{ ...base(), interval: 4 }, "$.interval"], [{ ...base(), host: {} }, "$.host.name"],
    [{ ...base(), host: { name: "x", os: "plan9" } }, "$.host.os"],
    [base({ cpu: { usage: 101 } }), "$.cpu.usage"], [base({ cpu: { usage: Infinity } }), "$.cpu.usage"],
    [base({ cpu: { iowait: 101 } }), "$.cpu.iowait"], [base({ cpu: { steal: -1 } }), "$.cpu.steal"],
```

   with

```js
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
```

3. Replace

```js
    [base({ disks: [{ mount: "/", pct: 150 }] }), "$.disks[0].pct"], [base({ disks: "x" }), "$.disks"],
    [base({ docker: [{ name: "a", cpuUsec: -1 }] }), "$.docker[0].cpuUsec"],
    [base({ net: { rxBytes: 2 ** 60 } }), "$.net.rxBytes"],
  ];
  for (const [s, path] of cases) assert.deepStrictEqual(validate(s), { ok: false, path }, JSON.stringify(s));
});

```

   with

```js
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

```

In `test/agentapi.test.js`:

1. Replace

```js
    assert.strictEqual(wait.status, 204);
  });
});

```

   with

```js
    assert.strictEqual(wait.status, 204);
  });
});

test("a push with a bad optional group is stored without it, says what was dropped, and logs it once", async () => {
  await withHub(async (hub, c) => {
    const r = await signed(hub, c, { body: snap({ fans: [{ label: "f", rpm: 1350000 }], mem: { total: 100, used: 50 } }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, dropped: ["$.fans[0].rpm"] });
    await new Promise((ok) => setTimeout(ok, 200));
    assert.strictEqual((hub.logs().match(/api\.groups_dropped/g) || []).length, 1);
    assert.match(hub.logs(), /api\.groups_dropped.*\$\.fans\[0\]\.rpm/);
  });
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/snapshot.test.js test/agentapi.test.js`
Expected: FAIL, 4 tests:
- "a bad value in an optional group drops that group only…" (`{"schema":1,…,"cpu":{"usage":101}}` is refused);
- "processes pass with a cpu share still unknown…" and "voltages pass with their label…" (no `dropped`);
- "a push with a bad optional group is stored without it…" (`422`).

- [ ] **Step 3: The validator**

In `hub/lib/snapshot.js`:

1. Replace

```js
  if (!isObj(s)) throw new Invalid("$");
  const schema = num(s.schema, 1, 1, "$.schema", { optional: false, int: true });
  return clean({
    schema,
    ts: counter(s.ts, "$.ts", { optional: false }),
    interval: num(s.interval, 5, 3600, "$.interval", { optional: false, int: true }),
    agent: str(s.agent, 32, "$.agent"),
    host: obj(s.host, "$.host", (h, p) => clean({
      name: str(h.name, 64, `${p}.name`, { optional: false }),
```

   with

```js
  if (!isObj(s)) throw new Invalid("$");
  const schema = num(s.schema, 1, 1, "$.schema", { optional: false, int: true });
  // the required parts refuse the whole snapshot; an optional group that fails is
  // dropped alone (its path recorded), so one bad sensor never costs the rest
  const dropped = [];
  const opt = (build) => {
    try { return build(); } catch (e) { if (!(e instanceof Invalid)) throw e; dropped.push(e.path); return undefined; }
  };
  const value = clean({
    schema,
    ts: counter(s.ts, "$.ts", { optional: false }),
    interval: num(s.interval, 5, 3600, "$.interval", { optional: false, int: true }),
    agent: opt(() => str(s.agent, 32, "$.agent")),
    host: obj(s.host, "$.host", (h, p) => clean({
      name: str(h.name, 64, `${p}.name`, { optional: false }),
```

2. Replace

```js
      uptime: counter(h.uptime, `${p}.uptime`),
    }), { optional: false }),
    mem: obj(s.mem, "$.mem", (m, p) => clean(Object.fromEntries(
      ["total", "used", "available", "free", "cache", "swapTotal", "swapUsed"].map((k) => [k, counter(m[k], `${p}.${k}`)])))),
    cpu: obj(s.cpu, "$.cpu", (c, p) => clean({
      usage: num(c.usage, 0, 100, `${p}.usage`), cores: num(c.cores, 1, 4096, `${p}.cores`, { int: true }),
      iowait: num(c.iowait, 0, 100, `${p}.iowait`), steal: num(c.steal, 0, 100, `${p}.steal`),
      per: list(c.per, 1024, `${p}.per`, (v, q) => num(v, 0, 100, q, { optional: false })),
      load: list(c.load, 3, `${p}.load`, (v, q) => num(v, 0, 1e6, q, { optional: false })),
    })),
    pressure: obj(s.pressure, "$.pressure", (x, p) => clean({
      cpu: stall(x.cpu, `${p}.cpu`), mem: stall(x.mem, `${p}.mem`), io: stall(x.io, `${p}.io`),
    })),
    temp: obj(s.temp, "$.temp", (t, p) => clean({
      package: num(t.package, -50, 150, `${p}.package`, { nullable: true }),
      max: num(t.max, -50, 150, `${p}.max`, { nullable: true }),
```

   with

```js
      uptime: counter(h.uptime, `${p}.uptime`),
    }), { optional: false }),
    mem: opt(() => obj(s.mem, "$.mem", (m, p) => clean(Object.fromEntries(
      ["total", "used", "available", "free", "cache", "swapTotal", "swapUsed"].map((k) => [k, counter(m[k], `${p}.${k}`)]))))),
    cpu: opt(() => obj(s.cpu, "$.cpu", (c, p) => clean({
      usage: num(c.usage, 0, 100, `${p}.usage`), cores: num(c.cores, 1, 4096, `${p}.cores`, { int: true }),
      iowait: num(c.iowait, 0, 100, `${p}.iowait`), steal: num(c.steal, 0, 100, `${p}.steal`),
      per: list(c.per, 1024, `${p}.per`, (v, q) => num(v, 0, 100, q, { optional: false })),
      load: list(c.load, 3, `${p}.load`, (v, q) => num(v, 0, 1e6, q, { optional: false })),
    }))),
    pressure: opt(() => obj(s.pressure, "$.pressure", (x, p) => clean({
      cpu: stall(x.cpu, `${p}.cpu`), mem: stall(x.mem, `${p}.mem`), io: stall(x.io, `${p}.io`),
    }))),
    temp: opt(() => obj(s.temp, "$.temp", (t, p) => clean({
      package: num(t.package, -50, 150, `${p}.package`, { nullable: true }),
      max: num(t.max, -50, 150, `${p}.max`, { nullable: true }),
```

3. Replace

```js
        label: str(o.label, 128, `${q}.label`), value: num(o.value, -50, 150, `${q}.value`, { optional: false }),
      }), { optional: false })),
    })),
    fans: list(s.fans, 32, "$.fans", (x, q) => obj(x, q, (o) => clean({
      label: str(o.label, 128, `${q}.label`), rpm: num(o.rpm, 0, 1e6, `${q}.rpm`, { optional: false }),
    }), { optional: false })),
    voltages: list(s.voltages, 32, "$.voltages", (x, q) => obj(x, q, (o) => clean({
      label: str(o.label, 128, `${q}.label`), value: num(o.value, -1000, 1000, `${q}.value`, { optional: false }),
    }), { optional: false })),
    battery: obj(s.battery, "$.battery", (b, p) => clean({
      capacity: num(b.capacity, 0, 100, `${p}.capacity`), status: str(b.status, 16, `${p}.status`),
    })),
    disks: list(s.disks, 32, "$.disks", (x, q) => obj(x, q, (d) => clean({
      mount: str(d.mount, 128, `${q}.mount`, { optional: false }), mounted: bool(d.mounted, `${q}.mounted`),
      source: str(d.source, 128, `${q}.source`), model: str(d.model, 128, `${q}.model`),
```

   with

```js
        label: str(o.label, 128, `${q}.label`), value: num(o.value, -50, 150, `${q}.value`, { optional: false }),
      }), { optional: false })),
    }))),
    fans: opt(() => list(s.fans, 32, "$.fans", (x, q) => obj(x, q, (o) => clean({
      label: str(o.label, 128, `${q}.label`), rpm: num(o.rpm, 0, 1e6, `${q}.rpm`, { optional: false }),
    }), { optional: false }))),
    voltages: opt(() => list(s.voltages, 32, "$.voltages", (x, q) => obj(x, q, (o) => clean({
      label: str(o.label, 128, `${q}.label`), value: num(o.value, -1000, 1000, `${q}.value`, { optional: false }),
    }), { optional: false }))),
    battery: opt(() => obj(s.battery, "$.battery", (b, p) => clean({
      capacity: num(b.capacity, 0, 100, `${p}.capacity`), status: str(b.status, 16, `${p}.status`),
    }))),
    disks: opt(() => list(s.disks, 32, "$.disks", (x, q) => obj(x, q, (d) => clean({
      mount: str(d.mount, 128, `${q}.mount`, { optional: false }), mounted: bool(d.mounted, `${q}.mounted`),
      source: str(d.source, 128, `${q}.source`), model: str(d.model, 128, `${q}.model`),
```

4. Replace

```js
      size: counter(d.size, `${q}.size`), used: counter(d.used, `${q}.used`), avail: counter(d.avail, `${q}.avail`),
      pct: num(d.pct, 0, 100, `${q}.pct`), device: str(d.device, 128, `${q}.device`),
    }), { optional: false })),
    io: list(s.io, 32, "$.io", (x, q) => obj(x, q, (d) => clean({
      device: str(d.device, 128, `${q}.device`, { optional: false }),
      readBytes: counter(d.readBytes, `${q}.readBytes`), writeBytes: counter(d.writeBytes, `${q}.writeBytes`),
    }), { optional: false })),
    net: obj(s.net, "$.net", (n, p) => clean({
      iface: str(n.iface, 128, `${p}.iface`), rxBytes: counter(n.rxBytes, `${p}.rxBytes`), txBytes: counter(n.txBytes, `${p}.txBytes`),
      vnstat: obj(n.vnstat, `${p}.vnstat`, (v, q) => clean({
```

   with

```js
      size: counter(d.size, `${q}.size`), used: counter(d.used, `${q}.used`), avail: counter(d.avail, `${q}.avail`),
      pct: num(d.pct, 0, 100, `${q}.pct`), device: str(d.device, 128, `${q}.device`),
    }), { optional: false }))),
    io: opt(() => list(s.io, 32, "$.io", (x, q) => obj(x, q, (d) => clean({
      device: str(d.device, 128, `${q}.device`, { optional: false }),
      readBytes: counter(d.readBytes, `${q}.readBytes`), writeBytes: counter(d.writeBytes, `${q}.writeBytes`),
    }), { optional: false }))),
    net: opt(() => obj(s.net, "$.net", (n, p) => clean({
      iface: str(n.iface, 128, `${p}.iface`), rxBytes: counter(n.rxBytes, `${p}.rxBytes`), txBytes: counter(n.txBytes, `${p}.txBytes`),
      vnstat: obj(n.vnstat, `${p}.vnstat`, (v, q) => clean({
```

5. Replace

```js
        days: list(v.days, 31, `${q}.days`, bar), hours: list(v.hours, 24, `${q}.hours`, bar),
      })),
    })),
    docker: list(s.docker, 200, "$.docker", (x, q) => obj(x, q, (c) => clean({
      name: str(c.name, 128, `${q}.name`, { optional: false }), id: str(c.id, 128, `${q}.id`),
      state: str(c.state, 32, `${q}.state`), status: str(c.status, 128, `${q}.status`),
```

   with

```js
        days: list(v.days, 31, `${q}.days`, bar), hours: list(v.hours, 24, `${q}.hours`, bar),
      })),
    }))),
    docker: opt(() => list(s.docker, 200, "$.docker", (x, q) => obj(x, q, (c) => clean({
      name: str(c.name, 128, `${q}.name`, { optional: false }), id: str(c.id, 128, `${q}.id`),
      state: str(c.state, 32, `${q}.state`), status: str(c.status, 128, `${q}.status`),
```

6. Replace

```js
      cpuUsec: counter(c.cpuUsec, `${q}.cpuUsec`, { nullable: true }),
      mem: counter(c.mem, `${q}.mem`, { nullable: true }),
    }), { optional: false })),
    processes: obj(s.processes, "$.processes", (pr, p) => clean({
      cpu: list(pr.cpu, 5, `${p}.cpu`, proc), mem: list(pr.mem, 5, `${p}.mem`, proc),
    })),
    ubuntu: obj(s.ubuntu, "$.ubuntu", (u, p) => clean({
      updates: num(u.updates, 0, 1e6, `${p}.updates`, { int: true }),
      security: num(u.security, 0, 1e6, `${p}.security`, { int: true }),
```

   with

```js
      cpuUsec: counter(c.cpuUsec, `${q}.cpuUsec`, { nullable: true }),
      mem: counter(c.mem, `${q}.mem`, { nullable: true }),
    }), { optional: false }))),
    processes: opt(() => obj(s.processes, "$.processes", (pr, p) => clean({
      cpu: list(pr.cpu, 5, `${p}.cpu`, proc), mem: list(pr.mem, 5, `${p}.mem`, proc),
    }))),
    ubuntu: opt(() => obj(s.ubuntu, "$.ubuntu", (u, p) => clean({
      updates: num(u.updates, 0, 1e6, `${p}.updates`, { int: true }),
      security: num(u.security, 0, 1e6, `${p}.security`, { int: true }),
```

7. Replace

```js
      rebootPkgs: list(u.rebootPkgs, 32, `${p}.rebootPkgs`, (v, q) => str(v, 128, q, { optional: false })),
      failedUnits: list(u.failedUnits, 32, `${p}.failedUnits`, (v, q) => str(v, 128, q, { optional: false })),
    })),
  });
}

function validate(s) {
  try { return { ok: true, value: build(s) }; }
  catch (e) { if (e instanceof Invalid) return { ok: false, path: e.path }; throw e; }
}
```

   with

```js
      rebootPkgs: list(u.rebootPkgs, 32, `${p}.rebootPkgs`, (v, q) => str(v, 128, q, { optional: false })),
      failedUnits: list(u.failedUnits, 32, `${p}.failedUnits`, (v, q) => str(v, 128, q, { optional: false })),
    }))),
  });
  return { value, dropped };
}

function validate(s) {
  try { return { ok: true, ...build(s) }; }
  catch (e) { if (e instanceof Invalid) return { ok: false, path: e.path }; throw e; }
}
```

- [ ] **Step 4: The push**

In `hub/lib/agentapi.js`:

1. Replace

```js
  const waiters = new Map();    // id -> { res, secret, ts, timer }
  const seen = new Set();       // ids that pushed since this process started

  function fail(res, code, error, { headers = {}, body = {} } = {}) {
```

   with

```js
  const waiters = new Map();    // id -> { res, secret, ts, timer }
  const seen = new Set();       // ids that pushed since this process started
  const droppedSeen = new Map();   // node -> the dropped paths last logged, so a bad sensor logs once

  function fail(res, code, error, { headers = {}, body = {} } = {}) {
```

2. Replace

```js
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, checked.value);
      return reply(res, 200, secret, tsRaw, { ok: true });
    }
```

   with

```js
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, checked.value);
      // an optional group that failed validation was left out: say so, and log each new set once
      if (checked.dropped.length) {
        const key = checked.dropped.join(" ");
        if (droppedSeen.get(id) !== key) { droppedSeen.set(id, key); log.warn("api.groups_dropped", { node: id, paths: key }); }
        return reply(res, 200, secret, tsRaw, { ok: true, dropped: checked.dropped });
      }
      droppedSeen.delete(id);
      return reply(res, 200, secret, tsRaw, { ok: true });
    }
```

- [ ] **Step 5: The protocol, the spec and the changelog**

In `docs/protocol.md`:

1. Replace

```markdown
5. The body is within the size limit, else `413`.
6. The signature matches, else `401 bad_signature`.
7. For push: the body validates against the snapshot schema, else
   `422 invalid_snapshot` with the first failing path.

Only after all checks pass does the hub store the new last `TS`.
```

   with

```markdown
5. The body is within the size limit, else `413`.
6. The signature matches, else `401 bad_signature`.
7. For push: the required parts (`schema`, `ts`, `interval`, `host`) validate
   against the snapshot schema, else `422 invalid_snapshot` with the first
   failing path. An optional group that fails is left out and the rest is
   stored: the reply is `200 {"ok": true, "dropped": ["$.fans[0].rpm"]}` with
   the first failing path of each group left out, and the hub logs each new
   set once per node.

Only after all checks pass does the hub store the new last `TS`.
```

In `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:

1. Replace

```markdown
   64, labels 128, container names 128), arrays are capped (disks 32,
   containers 200, processes 5 per list, sensors 64), unknown keys are
   dropped;
3. stores the validated copy only, enriched with values the hub derives:
   network and disk I/O rates and per-container CPU % from the counters of
```

   with

```markdown
   64, labels 128, container names 128), arrays are capped (disks 32,
   containers 200, processes 5 per list, sensors 64), unknown keys are
   dropped; a failure in a required part (`schema`, `ts`, `interval`,
   `host`) refuses the snapshot (422), a failure in an optional group drops
   that group only, so one bad sensor never takes a node offline;
3. stores the validated copy only, enriched with values the hub derives:
   network and disk I/O rates and per-container CPU % from the counters of
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Changed
- The page follows the system's light or dark setting until someone picks a
  mode (it used to start dark). The 8bit style moved out of the page into
```

   with

```markdown

### Changed
- The hub keeps a node's snapshot when one optional group in it is invalid (a
  glitched sensor, a bad value): that group is left out, named in the reply
  and logged once, instead of the whole push being refused with 422. Only a
  bad `schema`, `ts`, `interval` or `host` still refuses it.
- The page follows the system's light or dark setting until someone picks a
  mode (it used to start dark). The 8bit style moved out of the page into
```

- [ ] **Step 6: Run everything**

Run: `node --test test/*.test.js`
Expected: PASS, 337 tests.

Then the packaging checks, which have not changed but run on every branch:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`.

- [ ] **Step 7: Commit**

```bash
git add hub/lib/snapshot.js hub/lib/agentapi.js docs/protocol.md docs/superpowers/specs/2026-09-24-servitals-platform-design.md CHANGELOG.md test/snapshot.test.js test/agentapi.test.js
git commit -m "fix(hub): an invalid optional group is dropped, not the whole snapshot"
```
