# servitals Alert Engine (sub-project 6b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub judges spec 8.2's default alert rules on each push and once a minute. Each alert moves through pending, firing and resolved, with hysteresis and daily repeats, and can be muted per rule or per node. The hub lists firing alerts and recent events through `GET /__ctl/alerts`.

**Why:** a dashboard tells you only what you look at. Alerts tell you what you did not: a node that went offline, a disk that filled, a container that stopped, a reboot that was asked for. This plan builds the engine. The page's alerts view (6b-2) and the channels that send them (6c, 6d) build on it.

**Architecture:**
- **`hub/lib/alerts.js`:**
  - `DEFAULT_RULES` copies spec 8.2:
    - each rule has `id`, `metric`, `op`, `threshold`, `for`, `clear`, `severity` and `repeat` (24 h);
    - offline is critical after `max(10 min, 5 × interval)`;
    - disk full is 90 % (clears below 88 %) and disk critical is 95 % (clears below 93 %), both for 5 min;
    - memory is 90 % for 10 min; cpu is 95 % for 15 min; temperature is 85 °C for 5 min;
    - a container that was seen running and is now not running or unhealthy fires after 2 min;
    - failed units fire after 5 min; a needed reboot and security updates fire at once (info).
  - `valuesOf(metric, view, running)` gives a rule's values per node, and per disk or container.
  - `createAlerts(dir, {now, onEvent})` keeps instances (`rule|node|sub`):
    - ok → pending → firing → resolved;
    - a missing value ends an instance;
    - the first unmuted firing is told, the end is told only if the start was, and a repeat is told after `repeat`;
    - a muted rule or node, or another rule's alert on an offline node (inhibition), is logged as quiet and told once that ends;
    - `evaluate(node, view)` runs on each push (a push ends "offline");
    - `check(nodes)` runs once a minute: it handles "offline", plus repeats for nodes that are not offline;
    - `firing()`, `recent(n)`, `mute({rule | node, until})`, `forget(node)` and `log(event)`;
    - state and mutes are kept in `state.json` (atomic), and the event log in `events.jsonl` (the last 1000).
- **`hub/server.js`:**
  - Builds the engine under the state directory's `alerts/`.
  - Logs each event as `alert.<kind>`.
  - Evaluates every push, checks every minute, and forgets a revoked node.
  - Serves `GET /__ctl/alerts` → `{{firing, recent}}`.
  - Serves `POST /__ctl/alerts/mute` with `{{rule | node, until}}` (a known rule or node; `until` at most a year ahead), audited.

**Tech Stack:** Node.js ≥ 18 built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- 8.1: the engine (states, dedup, inhibition, mute, state that survives restarts);
- 8.2: the default rules.

**Scope:** 6b-1 of sub-project 6. Out of scope here:
- custom rules and per-node overrides (8.1);
- the page's alerts view and editor (6b-2);
- routing, quiet hours and the digest (8.3);
- channels (8.4, 6c) and Web Push (8.5, 6d).

**Proven before writing:** every code block was built and run in a scratch copy of `main` (213d6b0) on 2026-10-08: node suite 371 tests.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6a still holds.
- One notification per alert and scope, then only repeats (spec 8.1 dedup). A threshold crossed back and forth inside the hysteresis band never refires.
- Alert state survives a restart. An alert that already fired is not told again on start.
- An alert failure never breaks a push: errors are logged.
- Work in a worktree `.claude/worktrees/servitals-alerts` on branch `feat/alerts` from `main` (213d6b0).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Flapping and repeats**:
   - a value that oscillates around the threshold, or around its clear value;
   - a condition that stops just before `for`;
   - a repeat exactly at 24 h.

   Tests: "a rule fires only after its condition held for its time…", "a condition that stops before its time never fires", "a firing alert repeats once a day…".
2. **Offline and inhibition**:
   - a node that never pushed;
   - a long interval;
   - another rule's repeat during an outage;
   - the push that ends it.

   Tests: "a node that stops pushing goes offline…", "an offline node's other alerts do not repeat…".
3. **Containers**: never running, running then exited, unhealthy, removed from the list. Test: "the discrete rules…".
4. **Mutes**: a node mute against a rule mute, an alert that fired while muted, and the end of a mute. Test: "muted rules and nodes change state silently…".
5. **Persistence and growth**:
   - restart;
   - the 1000-event cap;
   - a revoked node;
   - mute input validation on the API.

   Tests: "alert state and the log survive a restart…", "a revoked node's alerts go", and the agentapi test "alerts: …".

---

### Task 1: The engine

**Files:**
- Create: `hub/lib/alerts.js`, `test/alerts.test.js`

**Interfaces:**
- Produces:
  - `createAlerts(dir, {now, onEvent, rules})` → `{evaluate(node, view), check(nodes), firing(), recent(n), mute({rule | node, until}), forget(node), log(event)}`;
  - `DEFAULT_RULES`;
  - `valuesOf(metric, view, running)`;
  - events `{kind: firing | repeat | resolved, rule, severity, node, nodeName, sub?, value, at, since}`.

  Task 2 wires these into the hub.

- [ ] **Step 1: Write the failing tests**

Create `test/alerts.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The alert engine (spec 8.1, 8.2): rules judged on each push and once a minute;
 * ok -> pending -> firing -> resolved, with "for", hysteresis and repeats.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAlerts, DEFAULT_RULES } = require("../hub/lib/alerts");

const MIN = 60000;
function setup() {
  const c = { t: 1790000000000, now: () => c.t, at: (m) => { c.t = 1790000000000 + m * MIN; } };
  const events = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-alerts-"));
  const a = createAlerts(dir, { now: c.now, onEvent: (e) => events.push(e) });
  return { c, a, events, dir };
}
const N = { id: "nodeaaaaaaaa", name: "nas", tags: [] };
const view = (extra) => ({ interval: 60, ...extra });
const kinds = (events) => events.map((e) => `${e.kind}:${e.rule}${e.sub ? ":" + e.sub : ""}`);

test("the default rules are the ones spec 8.2 lists", () => {
  assert.deepStrictEqual(DEFAULT_RULES.map((r) => [r.id, r.severity]), [
    ["offline", "critical"], ["disk_full", "warning"], ["disk_critical", "critical"], ["memory", "warning"],
    ["cpu", "warning"], ["temperature", "warning"], ["container_down", "warning"], ["failed_units", "warning"],
    ["reboot_required", "info"], ["security_updates", "info"],
  ]);
});

test("a rule fires only after its condition held for its time, once, and resolves past its clear value", () => {
  const { c, a, events } = setup();
  const disk = (pct) => view({ disks: [{ mount: "/srv", pct }] });
  c.at(0); a.evaluate(N, disk(91));
  assert.deepStrictEqual(kinds(events), [], "pending, not yet firing");
  c.at(3); a.evaluate(N, disk(92));
  c.at(5); a.evaluate(N, disk(92));
  assert.deepStrictEqual(kinds(events), ["firing:disk_full:/srv"]);
  assert.deepStrictEqual(events[0], { kind: "firing", rule: "disk_full", severity: "warning", node: N.id, nodeName: "nas",
    sub: "/srv", value: 92, at: c.t, since: 1790000000000 });
  c.at(6); a.evaluate(N, disk(89));                      // below 90, but not below 88: still firing (hysteresis)
  c.at(7); a.evaluate(N, disk(92));
  assert.deepStrictEqual(kinds(events), ["firing:disk_full:/srv"], "one firing, no flapping");
  c.at(8); a.evaluate(N, disk(87));
  assert.deepStrictEqual(kinds(events), ["firing:disk_full:/srv", "resolved:disk_full:/srv"]);
  assert.deepStrictEqual(a.firing(), []);
});

test("a condition that stops before its time never fires", () => {
  const { c, a, events } = setup();
  c.at(0); a.evaluate(N, view({ cpu: { usage: 99 } }));
  c.at(10); a.evaluate(N, view({ cpu: { usage: 99 } }));
  c.at(11); a.evaluate(N, view({ cpu: { usage: 50 } }));
  c.at(30); a.evaluate(N, view({ cpu: { usage: 99 } }));
  assert.deepStrictEqual(kinds(events), [], "15 minutes are needed, in one stretch");
  c.at(45); a.evaluate(N, view({ cpu: { usage: 99 } }));
  assert.deepStrictEqual(kinds(events), ["firing:cpu"]);
});

test("a firing alert repeats once a day while it lasts", () => {
  const { c, a, events } = setup();
  const reboot = view({ ubuntu: { rebootRequired: true } });
  c.at(0); a.evaluate(N, reboot);
  c.at(60); a.evaluate(N, reboot);
  c.at(24 * 60 + 1); a.evaluate(N, reboot);
  assert.deepStrictEqual(kinds(events), ["firing:reboot_required", "repeat:reboot_required"]);
});

test("the discrete rules: failed units, security updates, a container that was running and stopped", () => {
  const { c, a, events } = setup();
  const v = (state, extra = {}) => view({ docker: [{ name: "web", state, health: null }], ...extra });
  c.at(0); a.evaluate(N, v("exited"));                   // never seen running: not an alert
  c.at(1); a.evaluate(N, v("running", { ubuntu: { security: 3, failedUnits: ["a.service"] } }));
  c.at(2); a.evaluate(N, v("exited", { ubuntu: { security: 3, failedUnits: ["a.service"] } }));
  c.at(4); a.evaluate(N, v("exited", { ubuntu: { security: 3, failedUnits: ["a.service"] } }));
  c.at(6); a.evaluate(N, v("exited", { ubuntu: { security: 0, failedUnits: ["a.service"] } }));
  assert.deepStrictEqual(kinds(events), ["firing:security_updates", "firing:container_down:web",
    "firing:failed_units", "resolved:security_updates"]);
  c.at(7); a.evaluate(N, view({ docker: [{ name: "web", state: "running", health: "unhealthy" }], ubuntu: { failedUnits: [] } }));
  assert.deepStrictEqual(kinds(events).slice(4), ["resolved:failed_units"], "unhealthy is still down");
});

test("a node that stops pushing goes offline, and while it is, its other alerts stay quiet", () => {
  const { c, a, events } = setup();
  c.at(0); a.evaluate(N, view({ cpu: { usage: 99 } }));
  c.at(5); a.check([{ ...N, lastPush: c.t - 5 * MIN, interval: 60 }]);
  assert.deepStrictEqual(kinds(events), [], "5 minutes: not yet");
  c.at(11); a.check([{ ...N, lastPush: c.t - 11 * MIN, interval: 60 }]);
  assert.deepStrictEqual(kinds(events), ["firing:offline"]);
  c.at(20); a.check([{ ...N, lastPush: c.t - 20 * MIN, interval: 60 }]);   // cpu's 15 min passed meanwhile
  assert.deepStrictEqual(kinds(events), ["firing:offline"], "the offline node's cpu alert is held back");
  c.at(21); a.evaluate(N, view({ cpu: { usage: 10 } }));
  assert.deepStrictEqual(kinds(events), ["firing:offline", "resolved:offline"], "a push brings it back");
  c.at(30); a.check([{ id: "nodebbbbbbbb", name: "pi", lastPush: null, interval: null }]);
  assert.strictEqual(events.length, 2, "a node that never pushed is waiting, not offline");
});

test("muted rules and nodes change state silently until the mute ends", () => {
  const { c, a, events } = setup();
  a.mute({ node: N.id, until: c.t + 60 * MIN });
  c.at(0); a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  assert.deepStrictEqual(kinds(events), []);
  assert.strictEqual(a.firing()[0].muted, true, "listed, marked muted");
  a.mute({ rule: "security_updates", until: 1790000000000 + 71 * MIN });
  c.at(61); a.evaluate(N, view({ ubuntu: { rebootRequired: true, security: 1 } }));
  assert.deepStrictEqual(kinds(events), ["firing:reboot_required"], "the node's mute ended: the firing alert is told");
  c.at(72); a.evaluate(N, view({ ubuntu: { rebootRequired: true, security: 1 } }));
  assert.deepStrictEqual(kinds(events), ["firing:reboot_required", "firing:security_updates"]);
  assert.throws(() => a.mute({ until: c.t }), /rule or a node/);
});

test("alert state and the log survive a restart; the log keeps the last 1000 events", () => {
  const { c, a, dir } = setup();
  c.at(0); a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  const again = createAlerts(dir, { now: c.now, onEvent: () => {} });
  assert.deepStrictEqual(again.firing().map((f) => f.rule), ["reboot_required"]);
  assert.deepStrictEqual(again.recent(10).map((e) => e.kind), ["firing"]);
  for (let i = 0; i < 1100; i++) again.log({ kind: "firing", rule: "x", at: i });
  assert.strictEqual(createAlerts(dir, { now: c.now }).recent(5000).length, 1000);
});

test("a revoked node's alerts go", () => {
  const { c, a } = setup();
  c.at(0); a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  a.forget(N.id);
  assert.deepStrictEqual(a.firing(), []);
});

test("an offline node's other alerts do not repeat; the overdue repeat goes out when it is back", () => {
  const { c, a, events } = setup();
  c.at(0); a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  c.at(20); a.check([{ ...N, lastPush: 1790000000000, interval: 60 }]);
  c.at(24 * 60 + 5); a.check([{ ...N, lastPush: 1790000000000, interval: 60 }]);
  assert.deepStrictEqual(kinds(events), ["firing:reboot_required", "firing:offline"], "no repeat while offline");
  c.at(24 * 60 + 6); a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  assert.deepStrictEqual(kinds(events).slice(2), ["resolved:offline", "repeat:reboot_required"], "back: the overdue repeat goes out");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/alerts.test.js`
Expected: FAIL, the file as a whole (`Cannot find module '../hub/lib/alerts'`).

- [ ] **Step 3: The engine**

Create `hub/lib/alerts.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The alert engine (spec 8.1, 8.2). Each rule is judged per node, and per disk or
 * container where it has those ("instances"): on each push for the rules on what the
 * node sends, and once a minute (check) for a node that stopped pushing.
 *   ok -> pending (the condition holds) -> firing (it held for the rule's time)
 *      -> resolved (it stopped holding; past the clear value when the rule has one)
 * A firing alert is told once (onEvent), then once a day while it lasts; its end is
 * told if its start was. A muted rule or node changes state silently and is told when
 * the mute ends, if still firing. An offline node's other alerts are held back.
 * State and mutes live in <dir>/state.json, every event in <dir>/events.jsonl (the
 * alert log, the last 1000).
 *   createAlerts(dir, { now, onEvent }) → { evaluate(node, view), check(nodes),
 *     firing(), recent(n), mute({ rule | node, until }), forget(node), log(event) }
 */
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./fsutil");

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const LOG_MAX = 1000;
const rule = (id, metric, threshold, forMin, severity, extra = {}) =>
  ({ id, metric, op: ">=", threshold, for: forMin * MIN, clear: null, severity, repeat: DAY, ...extra });
const DEFAULT_RULES = [
  rule("offline", "offline", 1, 0, "critical"),
  rule("disk_full", "disk.used", 90, 5, "warning", { clear: 88 }),
  rule("disk_critical", "disk.used", 95, 5, "critical", { clear: 93 }),
  rule("memory", "mem", 90, 10, "warning"),
  rule("cpu", "cpu", 95, 15, "warning"),
  rule("temperature", "temp", 85, 5, "warning"),
  rule("container_down", "container.down", 1, 2, "warning"),
  rule("failed_units", "failed_units", 1, 5, "warning"),
  rule("reboot_required", "reboot_required", 1, 0, "info"),
  rule("security_updates", "security_updates", 1, 0, "info"),
];
const OPS = { ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, "==": (a, b) => a === b };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// a metric's values in a node's view: [{ sub, value }], [] when the node sends none
function valuesOf(metric, v, running) {
  switch (metric) {
    case "disk.used": return (v.disks || []).filter((d) => d.mounted !== false && num(d.pct) !== null).map((d) => ({ sub: d.mount, value: d.pct }));
    case "mem": return v.mem && num(v.mem.total) > 0 && num(v.mem.used) !== null ? [{ sub: "", value: (v.mem.used * 100) / v.mem.total }] : [];
    case "cpu": return v.cpu && num(v.cpu.usage) !== null ? [{ sub: "", value: v.cpu.usage }] : [];
    case "temp": return v.temp && num(v.temp.package) !== null ? [{ sub: "", value: v.temp.package }] : [];
    // a container counts once it was seen running: down while not running, or unhealthy
    case "container.down": return (v.docker || []).filter((c) => running.has(c.name))
      .map((c) => ({ sub: c.name, value: c.state !== "running" || c.health === "unhealthy" ? 1 : 0 }));
    case "failed_units": return v.ubuntu && Array.isArray(v.ubuntu.failedUnits) ? [{ sub: "", value: v.ubuntu.failedUnits.length }] : [];
    case "reboot_required": return v.ubuntu && typeof v.ubuntu.rebootRequired === "boolean" ? [{ sub: "", value: v.ubuntu.rebootRequired ? 1 : 0 }] : [];
    case "security_updates": return v.ubuntu && num(v.ubuntu.security) !== null ? [{ sub: "", value: v.ubuntu.security }] : [];
    default: return [];
  }
}

function createAlerts(dir, { now = Date.now, onEvent = () => {}, rules = DEFAULT_RULES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json"), logFile = path.join(dir, "events.jsonl");
  let st = { instances: {}, running: {}, mutes: { rules: {}, nodes: {} } };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch (_) { /* first start */ }
  let events = [];
  try { events = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(-LOG_MAX); } catch (_) { /* none yet */ }
  const save = () => writeFileAtomic(stateFile, JSON.stringify(st));

  function log(e) {
    events.push(e);
    fs.appendFileSync(logFile, JSON.stringify(e) + "\n");
    if (events.length > LOG_MAX + 100) { events = events.slice(-LOG_MAX); fs.writeFileSync(logFile, events.map((x) => JSON.stringify(x)).join("\n") + "\n"); }
  }
  const muted = (inst, t) => (st.mutes.rules[inst.rule] || 0) > t || (st.mutes.nodes[inst.node] || 0) > t;
  const offline = (node) => { const o = st.instances[`offline|${node}|`]; return !!(o && o.state === "firing"); };
  // why an instance is not told now: muted, or its node is offline (inhibition); else ""
  const quiet = (inst, r, t) => (muted(inst, t) ? "muted" : r.id !== "offline" && offline(inst.node) ? "offline" : "");
  // an event: always in the log (with why it stayed quiet); passed on unless quiet
  function tell(kind, inst, r, t) {
    const e = { kind, rule: inst.rule, severity: r.severity, node: inst.node, nodeName: inst.nodeName,
                ...(inst.sub ? { sub: inst.sub } : {}), value: inst.value, at: t, since: inst.since };
    const why = quiet(inst, r, t);
    log(why ? { ...e, quiet: why } : e);
    if (!why) onEvent(e);
    return !why;
  }
  // one instance, one value (null: the node does not send it, so the condition does not hold)
  function judge(r, node, sub, value, t) {
    const key = `${r.id}|${node.id}|${sub}`;
    let inst = st.instances[key];
    const holds = value !== null && OPS[r.op](value, r.threshold);
    if (!inst) {
      if (!holds) return;
      inst = st.instances[key] = { rule: r.id, node: node.id, nodeName: node.name, sub, state: "ok", since: t, value };
    }
    inst.value = value; inst.nodeName = node.name;
    if (inst.state === "firing") {
      const over = value === null || (r.clear !== null ? !OPS[r.op](value, r.clear) : !holds);
      if (over) {
        if (inst.notified) tell("resolved", inst, r, t);
        delete st.instances[key];
        return;
      }
      // told late: quiet when it fired (muted, or its node offline) and no longer
      if (!inst.notified && !quiet(inst, r, t)) { tell("firing", inst, r, t); inst.notified = true; inst.lastNotified = t; }
      else if (inst.notified && t - inst.lastNotified >= r.repeat && !quiet(inst, r, t)) { tell("repeat", inst, r, t); inst.lastNotified = t; }
      return;
    }
    if (!holds) { delete st.instances[key]; return; }
    if (inst.state === "ok") { inst.state = "pending"; inst.since = t; }
    if (t - inst.since >= r.for) {
      inst.state = "firing"; inst.firedAt = t;
      inst.notified = tell("firing", inst, r, t);
      if (inst.notified) inst.lastNotified = t;
    }
  }

  return {
    // a push from node ({ id, name }): every rule on what it sends; a push ends "offline"
    evaluate(node, v) {
      const t = now();
      const run = new Set(st.running[node.id] || []);
      for (const c of v.docker || []) if (c.state === "running") run.add(c.name);
      for (const name of [...run]) if (!(v.docker || []).some((c) => c.name === name)) run.delete(name);   // removed
      st.running[node.id] = [...run];
      for (const r of rules) {
        if (r.metric === "offline") { judge(r, node, "", 0, t); continue; }
        const vals = valuesOf(r.metric, v, run);
        const seen = new Set(vals.map((x) => x.sub));
        for (const x of vals) judge(r, node, x.sub, x.value, t);
        // an instance whose disk or container is gone: no value, so it ends
        for (const inst of Object.values(st.instances)) {
          if (inst.rule === r.id && inst.node === node.id && !seen.has(inst.sub)) judge(r, node, inst.sub, null, t);
        }
      }
      save();
    },
    // once a minute: nodes ({ id, name, lastPush, interval }) that stopped pushing go offline;
    // firing alerts of nodes that are not offline repeat
    check(nodes) {
      const t = now();
      const r = rules.find((x) => x.metric === "offline");
      for (const n of nodes) {
        if (!n.lastPush) continue;   // waiting for its first push: not offline
        const limit = Math.max(10 * MIN, 5 * (n.interval || 60) * 1000);
        if (r) judge(r, n, "", t - n.lastPush >= limit ? 1 : 0, t);
        for (const inst of Object.values(st.instances)) {
          if (inst.node !== n.id || inst.state !== "firing" || inst.rule === "offline") continue;
          const rr = rules.find((x) => x.id === inst.rule);
          if (rr) judge(rr, n, inst.sub, inst.value, t);
        }
      }
      save();
    },
    firing() {
      const t = now();
      return Object.values(st.instances).filter((i) => i.state === "firing").map((i) => {
        const r = rules.find((x) => x.id === i.rule) || {};
        return { rule: i.rule, severity: r.severity, node: i.node, nodeName: i.nodeName, sub: i.sub, value: i.value,
                 since: i.since, firedAt: i.firedAt, muted: muted(i, t) };
      });
    },
    recent(n = 50) { return events.slice(-n).reverse(); },
    mute({ rule: id, node, until }) {
      if (!id && !node) throw new Error("mute needs a rule or a node");
      if (id) st.mutes.rules[id] = until; else st.mutes.nodes[node] = until;
      save();
    },
    forget(node) {
      for (const [k, i] of Object.entries(st.instances)) if (i.node === node) delete st.instances[k];
      delete st.running[node]; delete st.mutes.nodes[node];
      save();
    },
    log,
  };
}

module.exports = { createAlerts, DEFAULT_RULES, valuesOf };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 370 tests (10 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/alerts.js test/alerts.test.js
git commit -m "feat(hub): the alert engine: default rules, pending, firing and resolved, hysteresis, repeats, mutes"
```

---

### Task 2: Every push and a minute timer feed the alerts; the API

**Files:**
- Modify: `hub/server.js`, `test/agentapi.test.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `createAlerts`, `DEFAULT_RULES` (Task 1).
- Produces:
  - `GET /__ctl/alerts` → `{firing, recent}`;
  - `POST /__ctl/alerts/mute` → 200, or 400 for an unknown rule or node or a bad `until`;
  - log events `alert.firing`, `alert.repeat` and `alert.resolved`;
  - audit event `alert.muted`.

  6b-2 and 6c build on these.

- [ ] **Step 1: Write the failing test**

In `test/agentapi.test.js`:

1. Replace

```js
  } finally { await hub.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

```

   with

```js
  } finally { await hub.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("alerts: a push that meets a rule shows as firing; it can be muted; the log keeps it", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const get = async () => JSON.parse((await request(hub.port, { path: "/__ctl/alerts", headers: { cookie } })).body);
    assert.deepStrictEqual((await get()).firing, []);
    assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true } }) })).status, 200);
    const a = await get();
    assert.deepStrictEqual(a.firing.map((f) => [f.rule, f.severity, f.node, f.muted]), [["reboot_required", "info", c.id, false]]);
    assert.deepStrictEqual(a.recent.map((e) => [e.kind, e.rule]), [["firing", "reboot_required"]]);
    assert.match(hub.logs(), /event=alert\.firing.*rule=reboot_required/);
    const until = Date.now() + 3600000;
    const m = await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ rule: "reboot_required", until }));
    assert.strictEqual(m.status, 200);
    assert.strictEqual((await get()).firing[0].muted, true);
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ until }))).status, 400, "a rule or a node");
    assert.strictEqual((await request(hub.port, { path: "/__ctl/alerts" })).status, 401, "logged in only");
  });
});

```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentapi.test.js`
Expected: FAIL, 1 test: "alerts: a push that meets a rule shows as firing…" (`Expected values to be strictly deep-equal`; the route does not exist yet, so `firing` is undefined).

- [ ] **Step 3: The wiring and the routes**

In `hub/server.js`:

1. Replace

```js
const { view: snapshotView } = require("./lib/snapshot");
const { createHistory, seriesOf } = require("./lib/history");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

   with

```js
const { view: snapshotView } = require("./lib/snapshot");
const { createHistory, seriesOf } = require("./lib/history");
const { createAlerts, DEFAULT_RULES } = require("./lib/alerts");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

2. Replace

```js
setInterval(historySweep, 86400000).unref();
historySweep();
const agentApi = createAgentApi({
  nodes, log,
```

   with

```js
setInterval(historySweep, 86400000).unref();
historySweep();
// alerts (spec 8.1): judged on each push and once a minute; events go to the log (channels: 6c)
const alerts = createAlerts(path.join(DATA, "alerts"), {
  onEvent: (e) => log.info("alert." + e.kind, { rule: e.rule, severity: e.severity, node: e.node, ...(e.sub ? { sub: e.sub } : {}), value: e.value }),
});
const nodeName = (id) => { const n = nodes.get(id); return (n && n.name) || id; };
setInterval(() => {
  try {
    alerts.check(nodes.list().map((n) => {
      const rec = latest.get(n.id);
      return { id: n.id, name: n.name, lastPush: rec ? rec.at : null, interval: rec ? rec.snap.interval : null };
    }));
  } catch (e) { log.warn("alerts.check_failed", { error: e.code || String(e) }); }
}, 60000).unref();
const agentApi = createAgentApi({
  nodes, log,
```

3. Replace

```js
    latest.set(id, rec);
    try { history.add(id, seriesOf(rec.view)); } catch (e) { log.warn("history.add_failed", { node: id, error: e.code || String(e) }); }
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
```

   with

```js
    latest.set(id, rec);
    try { history.add(id, seriesOf(rec.view)); } catch (e) { log.warn("history.add_failed", { node: id, error: e.code || String(e) }); }
    try { alerts.evaluate({ id, name: nodeName(id) }, rec.view); } catch (e) { log.warn("alerts.evaluate_failed", { node: id, error: e.code || String(e) }); }
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
```

4. Replace

```js
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
```

   with

```js
    }

    // alerts (spec 8): what is firing, and the last events
    if (req.method === "GET" && pathname === "/__ctl/alerts") {
      return json(200, { firing: alerts.firing(), recent: alerts.recent(50) });
    }
    // mute a rule or a node until a time (ms since 1970; at most a year ahead)
    if (req.method === "POST" && pathname === "/__ctl/alerts/mute") {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 1024)); } catch (_) { /* answered below */ }
      const b = body && typeof body === "object" ? body : {};
      const okRule = typeof b.rule === "string" && DEFAULT_RULES.some((r) => r.id === b.rule);
      const okNode = typeof b.node === "string" && !!nodes.get(b.node);
      const until = Number(b.until);
      if ((!okRule && !okNode) || (b.rule !== undefined && !okRule) || (b.node !== undefined && !okNode)
          || !Number.isFinite(until) || until > Date.now() + 366 * 86400000) {
        return json(400, { error: "mute needs a known rule or node, and until (ms, at most a year ahead)" });
      }
      alerts.mute(okRule ? { rule: b.rule, until } : { node: b.node, until });
      log.audit("alert.muted", { ip, ...(okRule ? { rule: b.rule } : { node: b.node }), until });
      return json(200, { ok: true });
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
```

5. Replace

```js
        try { fs.unlinkSync(path.join(SNAP_DIR, id + ".json")); } catch (_) { /* never pushed */ }
        try { history.remove(id); } catch (_) { /* swept later */ }
        log.audit("node.revoked", { ip, node: id });
        return json(200, { ok: true });
```

   with

```js
        try { fs.unlinkSync(path.join(SNAP_DIR, id + ".json")); } catch (_) { /* never pushed */ }
        try { history.remove(id); } catch (_) { /* swept later */ }
        try { alerts.forget(id); } catch (_) { /* nothing to forget */ }
        log.audit("node.revoked", { ip, node: id });
        return json(200, { ok: true });
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- History graph (spec 10.1): a "history" panel in each node's view charts
  any of its series (cpu, memory, temperature, load, iowait, pressure,
```

   with

```markdown

### Added
- Alerts (spec 8.1, 8.2): the hub judges the default rules on each push and
  once a minute: node offline, disk full and critical, memory, cpu,
  temperature, a container that stopped, failed units, a needed reboot and
  security updates. Each fires after its time, resolves past its clear value
  (no flapping), repeats daily while it lasts, and stays quiet while its node
  is offline or the rule or node is muted. State and the last 1000 events
  live under the state directory's `alerts/`. `GET /__ctl/alerts` lists what
  is firing and what happened; `POST /__ctl/alerts/mute` mutes a rule or a
  node. Events go to the hub's log for now; channels follow.
- History graph (spec 10.1): a "history" panel in each node's view charts
  any of its series (cpu, memory, temperature, load, iowait, pressure,
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 371 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 5: Commit**

```bash
git add hub/server.js test/agentapi.test.js CHANGELOG.md
git commit -m "feat(hub): every push and a minute timer feed the alerts; GET /__ctl/alerts, POST /__ctl/alerts/mute"
```
