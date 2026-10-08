# servitals Alert Rule Editor (sub-project 6b-2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person sets the alert rules from the page: a default rule's threshold, time, clear value and severity, or off; rules of their own on any metric the defaults watch, for all servers, one server or a tag, and optionally one disk or container; and per-server or per-tag overrides (another threshold, or off).

**Why:** the defaults fit a typical server, not every one. A NAS that runs at 92 % disk by design, a Raspberry Pi that runs hot, a laptop or phone that is often off: each pages for nothing until its rule can change for it. Spec 8.1 asks for scope and per-node overrides; this plan delivers them.

**Architecture:**
- **`hub/lib/alertrules.js` (new):**
  - `checkRules(input, {nodeIds})` checks a whole rules file and returns it clean, or throws an Error naming the rule and field. `nodeIds: null` accepts any server id (a file kept before its server was revoked).
  - `buildRules(saved)` turns the file into the engine's rules: every default (with its changes), then the person's own. Minutes become milliseconds.
  - `defaultsForPage()` returns the defaults in minutes, for the editor; `METRICS` lists what a rule of one's own can watch (everything but offline).
  - The file, `<state>/alerts/rules.json`: `{rules: [{id, threshold?, for?, clear?, severity?, off?, overrides?} | {id: "c_…", name, metric, op, threshold, for, clear, severity, off?, scope: {} | {node} | {tag}, sub?, overrides?}]}`, an override being `{node | tag, threshold}` or `{node | tag, off: true}`.
  - Checks: a clear value on the near side of the threshold (none for `==`); offline only severity, off, and off overrides; ids `c_` and up to 16 letters or digits; at most 100 rules and 50 overrides each.
- **`hub/lib/alerts.js`:**
  - `forNode(rule, node)` gives a rule as it holds for one node `{id, tags}`: null when off, out of scope or turned off there; else the rule with the node's override threshold (its clear value moves with it). A server's own override wins over its tag's.
  - `evaluate` and `check` judge each rule through `forNode`; a rule that no longer holds for a node ends its alerts there (a told one ends told). A rule with `sub` watches only that disk or container.
  - `setRules(list)` replaces the rules: the alerts of a rule removed or turned off end at once. `ruleIds()` lists them.
- **`hub/server.js`:** reads `rules.json` at start (a file that cannot be read leaves the defaults, logged `alerts.rules_ignored`); passes each node's tags to the engine; `GET /__ctl/alerts/rules` → `{saved, defaults, metrics}`; `POST /__ctl/alerts/rules` checks, keeps (atomic) and applies the whole set, audited `alert.rules_saved`; a mute accepts any current rule id.
- **The page (`www/js/alerts.js`):** a "rules" tab in the alerts view.
  - `rulesRows(saved, defaults)` and `rulesFile(rows, defaults)` turn the file into editable rows and back; a default rule keeps only what differs.
  - `rulesHtml(rows)` draws the form: what a rule cannot set is left out (no threshold for a true-or-false rule, only severity and off for offline); every name is escaped; a temperature shows and is typed in the page's unit (kept in °C).
  - `readRules()` reads the form back; `rulesAction(act, i, j)` adds and removes rules and overrides; `saveRules()` posts the file and shows what the hub refused, keeping what was typed.
- `www/index.html` (the tabs), `www/app.css`, `hub/lib/i18n.js` (every word), `test/screens/shoot.js` (`rules-1280.png`, `rules-390.png`).

**Tech Stack:** Node.js ≥ 18 built-ins; plain browser JavaScript, no framework.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- 8.1: a rule's metric, scope (all nodes, a tag, a node, optionally a mount or container), op, threshold, for, clear, severity; per-node overrides (another threshold, or disabled, for a node or a tag);
- 10.4: alerts are customised from the page;
- 10.5: the alert editor loads when opened.

**Scope:** 6b-2b. Out of scope: per-rule repeat times (all stay 24 h), routing, quiet hours and the digest (8.3), channels (6c), Web Push (6d).

**Proven before writing:** every code block was built and run in a scratch copy of `main` (cc1b2e3) on 2026-10-08: node suite 405 tests; budget, screens, compose smoke, both packages and autopkgtest pass.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6b-2a still holds.
- The strict CSP: no inline script, no `style="…"` in markup or generated HTML. Every word on the page through `tr()`; temperatures through the unit helpers.
- A bad rules file never stops the hub: the defaults apply and the hub logs why.
- First page load stays at most 60 KB gzipped (test/budget.sh); the editor lives in the lazy `alerts.js`.
- Work in a worktree `.claude/worktrees/servitals-rules` on branch `feat/alert-rules` from `main` (cc1b2e3).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **A rule that stops holding:** turned off, removed, out of scope after a tag change, an override set to off, while its alert fires (told or not), and for a node that never pushes again. Tests: "overrides: …", "new rules: …", "offline turned off for a server…".
2. **Thresholds and clear values:** an override on a rule with hysteresis, a default threshold moved past its default clear value, `<=` and `==` rules. Tests: "what is refused, and why", "overrides: …".
3. **The file across time:** a revoked server still named, a hand-edited or torn `rules.json`, a restart. Tests: "alert rules: a server revoked…", "alert rules: a rules file that cannot be read…", "alert rules: the page reads and saves them…".
4. **The form:** hostile names (rule, server, tag, disk), °F, an empty number field, a metric changed under its threshold, unsaved edits across tabs. Tests: the four "rule editor: …" tests.
5. **Phone width and every style:** `bash test/screens.sh` shoots `rules-1280.png` and `rules-390.png`.

---

### Task 1: Rules a person sets, in the hub

**Files:**
- Create: `hub/lib/alertrules.js`, `test/alertrules.test.js`
- Modify: `hub/lib/alerts.js`, `hub/server.js`, `test/alerts.test.js`, `test/agentapi.test.js`

**Interfaces:**
- Consumes: `createAlerts`, `DEFAULT_RULES` (6b-1).
- Produces:
  - `checkRules(input, {nodeIds})`, `buildRules(saved)`, `defaultsForPage()`, `METRICS`, `OPS`, `SEVERITIES` from `hub/lib/alertrules.js`;
  - `forNode(rule, node)` and, on the engine, `setRules(list)` and `ruleIds()`;
  - `GET /__ctl/alerts/rules` → `{saved, defaults, metrics}`; `POST /__ctl/alerts/rules` → 200, or 400 `{error}` naming the rule and field.

  Task 2's editor reads and writes these.

- [ ] **Step 1: Write the failing tests**

Create `test/alertrules.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The alert rules a person sets (spec 8.1): changes to the defaults, rules of their own,
 * per-server and per-tag overrides; checked before they are kept, built into the engine's.
 */
const test = require("node:test");
const assert = require("node:assert");
const { checkRules, buildRules, defaultsForPage } = require("../hub/lib/alertrules");
const { DEFAULT_RULES } = require("../hub/lib/alerts");

const A = "nodeaaaaaaaa", B = "nodebbbbbbbb";
const ok = (rules) => checkRules({ rules }, { nodeIds: [A, B] }).rules;
const bad = (rules, re) => assert.throws(() => checkRules({ rules }, { nodeIds: [A, B] }), re);

test("a change to a default rule keeps only what it changes; a rule of one's own gets every field", () => {
  assert.deepStrictEqual(ok([{ id: "disk_full", threshold: 85, clear: 80, for: 10, junk: 1 }]),
    [{ id: "disk_full", threshold: 85, clear: 80, for: 10 }]);
  assert.deepStrictEqual(ok([{ id: "cpu", off: true, overrides: [{ node: A, threshold: 99 }, { tag: "lab", off: true }] }]),
    [{ id: "cpu", off: true, overrides: [{ node: A, threshold: 99 }, { tag: "lab", off: true }] }]);
  assert.deepStrictEqual(ok([{ id: "c_backup", name: " backup disk ", metric: "disk.used", op: ">=", threshold: 70, severity: "warning",
    scope: { node: A }, sub: "/mnt/b" }]),
    [{ id: "c_backup", name: "backup disk", metric: "disk.used", op: ">=", threshold: 70, scope: { node: A }, sub: "/mnt/b", for: 0,
       clear: null, severity: "warning" }]);
});

test("what is refused, and why", () => {
  bad({}, /rules: a list/);
  bad([{ id: "disk_full" }, { id: "disk_full" }], /listed twice/);
  bad([{ id: "nope" }], /no default rule/);
  bad([{ id: "cpu", threshold: "95" }], /threshold: a number/);
  bad([{ id: "cpu", for: -1 }], /whole minutes/);
  bad([{ id: "cpu", for: 1.5 }], /whole minutes/);
  bad([{ id: "cpu", severity: "page" }], /severity/);
  bad([{ id: "cpu", off: "yes" }], /off: true or false/);
  bad([{ id: "offline", threshold: 3 }], /offline has no threshold/);
  bad([{ id: "offline", for: 3 }], /heartbeat/);
  bad([{ id: "offline", overrides: [{ node: A, threshold: 3 }] }], /only be turned off/);
  bad([{ id: "cpu", overrides: [{ node: A, tag: "x", threshold: 1 }] }], /a server or a tag/);
  bad([{ id: "cpu", overrides: [{ node: "nodecccccccc", threshold: 1 }] }], /no such server/);
  bad([{ id: "cpu", overrides: [{ tag: "Lab<", threshold: 1 }] }], /a tag is lowercase/);
  bad([{ id: "cpu", overrides: [{ node: A }] }], /a threshold, or off/);
  bad([{ id: "disk_full", threshold: 80 }], /clear: at most the threshold/, "the default clear 88 sits above 80");
  bad([{ id: "c_x", name: "x", metric: "mem", op: "<=", threshold: 10, clear: 5, severity: "info" }], /at least the threshold/);
  bad([{ id: "c_x", name: "x", metric: "mem", op: "==", threshold: 10, clear: 10, severity: "info" }], /none for ==/);
  bad([{ id: "c_X", name: "x", metric: "mem", op: ">=", threshold: 1, severity: "info" }], /no default rule/);
  bad([{ id: "c_x", name: "", metric: "mem", op: ">=", threshold: 1, severity: "info" }], /name/);
  bad([{ id: "c_x", name: "a\nb", metric: "mem", op: ">=", threshold: 1, severity: "info" }], /name/);
  bad([{ id: "c_x", name: "x", metric: "offline", op: ">=", threshold: 1, severity: "info" }], /metric/);
  bad([{ id: "c_x", name: "x", metric: "mem", op: ">", threshold: 1, severity: "info" }], /op/);
  bad([{ id: "c_x", name: "x", metric: "mem", op: ">=", threshold: 1 }], /severity/);
  bad([{ id: "c_x", name: "x", metric: "mem", op: ">=", threshold: 1, severity: "info", sub: "/" }], /only for disks and containers/);
  bad([{ id: "c_x", name: "x", metric: "mem", op: ">=", threshold: 1, severity: "info", scope: { node: "nodecccccccc" } }], /no such server/);
  bad([{ id: "c_x", name: "x", metric: "mem", op: ">=", threshold: 1, severity: "info", scope: { node: A, tag: "lab" } }], /scope/);
  bad(Array.from({ length: 101 }, (_, i) => ({ id: "c_" + i })), /at most 100/);
});

test("built for the engine: every default rule with its changes, minutes in milliseconds, then one's own", () => {
  const saved = ok([{ id: "memory", threshold: 80, for: 3 }, { id: "c_ups", name: "ups", metric: "temp", op: ">=", threshold: 60, severity: "critical", scope: { tag: "lab" } }]);
  const built = buildRules({ rules: saved });
  assert.deepStrictEqual(built.map((r) => r.id), [...DEFAULT_RULES.map((r) => r.id), "c_ups"]);
  const mem = built.find((r) => r.id === "memory");
  assert.deepStrictEqual([mem.threshold, mem.for, mem.severity, mem.op, mem.repeat], [80, 3 * 60000, "warning", ">=", 24 * 3600000]);
  assert.deepStrictEqual(built.find((r) => r.id === "c_ups"), { id: "c_ups", name: "ups", metric: "temp", op: ">=", threshold: 60, for: 0,
    clear: null, severity: "critical", scope: { tag: "lab" }, repeat: 24 * 3600000 });
  assert.deepStrictEqual(buildRules({ rules: [] }), DEFAULT_RULES.map((r) => ({ ...r })), "nothing saved: the defaults");
  assert.strictEqual(defaultsForPage().find((r) => r.id === "cpu").for, 15, "the page sees minutes");
});
```

In `test/alerts.test.js`:

1. Replace

```js
  assert.deepStrictEqual(a.firing().map((f) => f.quiet), ["muted", "muted"]);
});

```

   with

```js
  assert.deepStrictEqual(a.firing().map((f) => f.quiet), ["muted", "muted"]);
});

// rules the person set (spec 8.1): built by hub/lib/alertrules.js
const { buildRules } = require("../hub/lib/alertrules");
function setupWith(saved) {
  const c = { t: 1790000000000, now: () => c.t, at: (m) => { c.t = 1790000000000 + m * MIN; } };
  const events = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-alerts-"));
  const a = createAlerts(dir, { now: c.now, onEvent: (e) => events.push(e), rules: buildRules({ rules: saved }) });
  return { c, a, events, dir };
}
const LAB = { id: "nodebbbbbbbb", name: "lab-pi", tags: ["lab"] };

test("a rule of one's own: its scope (a server or a tag), its disk, its operator", () => {
  const { c, a, events } = setupWith([
    { id: "c_backup", name: "backup", metric: "disk.used", op: ">=", threshold: 70, for: 0, clear: null, severity: "warning", scope: { node: N.id }, sub: "/mnt/b" },
    { id: "c_cold", name: "cold", metric: "temp", op: "<=", threshold: 5, for: 0, clear: null, severity: "info", scope: { tag: "lab" } },
  ]);
  const v = view({ disks: [{ mount: "/", pct: 75 }, { mount: "/mnt/b", pct: 75 }], temp: { package: 3 } });
  c.at(0); a.evaluate(N, v); a.evaluate(LAB, v);
  assert.deepStrictEqual(kinds(events).sort(), ["firing:c_backup:/mnt/b", "firing:c_cold"], "only its disk, only its server; only the tagged one is cold");
  assert.strictEqual(events.find((e) => e.rule === "c_cold").node, LAB.id);
});

test("overrides: a server's own threshold beats its tag's; off for a server ends its alert, told", () => {
  const { c, a, events } = setupWith([
    { id: "memory", for: 0, overrides: [{ tag: "lab", threshold: 50 }, { node: LAB.id, threshold: 70 }, { node: N.id, off: true }] },
    { id: "disk_full", for: 0, overrides: [{ node: LAB.id, threshold: 80 }] },
  ]);
  const mem = (pct, extra) => view({ mem: { total: 100, used: pct }, ...extra });
  c.at(0); a.evaluate(LAB, mem(60)); a.evaluate(N, mem(99));
  assert.deepStrictEqual(kinds(events), [], "60 is under the server's own 70; the nas has memory off");
  a.evaluate(LAB, mem(72, { disks: [{ mount: "/", pct: 81 }] }));
  assert.deepStrictEqual(kinds(events), ["firing:disk_full:/", "firing:memory"]);
  a.evaluate(LAB, mem(72, { disks: [{ mount: "/", pct: 79 }] }));
  assert.deepStrictEqual(kinds(events).slice(2), [], "the clear value moved with the threshold: 88 - 10 = 78");
  a.evaluate(LAB, mem(72, { disks: [{ mount: "/", pct: 77 }] }));
  assert.deepStrictEqual(kinds(events).slice(2), ["resolved:disk_full:/"]);
  a.setRules(buildRules({ rules: [{ id: "memory", overrides: [{ node: LAB.id, off: true }] }] }));
  a.evaluate(LAB, mem(72));
  assert.deepStrictEqual(kinds(events).slice(3), ["resolved:memory"], "turned off for the server: the told alert ends told");
});

test("new rules: a rule removed or turned off ends its alerts at once; a mute names the rules there are", () => {
  const { c, a, events } = setupWith([{ id: "c_ups", name: "ups", metric: "security_updates", op: ">=", threshold: 1, for: 0, clear: null, severity: "info" }]);
  c.at(0); a.evaluate(N, view({ ubuntu: { security: 2, rebootRequired: true } }));
  assert.deepStrictEqual(kinds(events).sort(), ["firing:c_ups", "firing:reboot_required", "firing:security_updates"]);
  assert.ok(a.ruleIds().includes("c_ups"));
  a.setRules(buildRules({ rules: [{ id: "reboot_required", off: true }] }));
  assert.deepStrictEqual(kinds(events).slice(3).sort(), ["resolved:c_ups", "resolved:reboot_required"]);
  assert.deepStrictEqual(a.firing().map((f) => f.rule), ["security_updates"]);
  assert.ok(!a.ruleIds().includes("c_ups"));
  c.at(1); a.evaluate(N, view({ ubuntu: { security: 2, rebootRequired: true } }));
  assert.deepStrictEqual(a.firing().map((f) => f.rule), ["security_updates"], "off stays off");
});

test("offline turned off for a server (a laptop, a phone): it is never offline, and an offline alert ends", () => {
  const { c, a, events } = setupWith([]);
  c.at(0); a.evaluate(N, view({}));
  c.at(20); a.check([{ ...N, lastPush: c.t - 15 * MIN, interval: 60 }]);
  assert.deepStrictEqual(kinds(events), ["firing:offline"]);
  a.setRules(buildRules({ rules: [{ id: "offline", overrides: [{ tag: "roaming", off: true }] }] }));
  c.at(21); a.check([{ ...N, tags: ["roaming"], lastPush: c.t - 16 * MIN, interval: 60 }]);
  assert.deepStrictEqual(kinds(events), ["firing:offline", "resolved:offline"]);
  c.at(40); a.check([{ ...N, tags: ["roaming"], lastPush: c.t - 35 * MIN, interval: 60 }]);
  assert.deepStrictEqual(kinds(events), ["firing:offline", "resolved:offline"]);
});

```

In `test/agentapi.test.js`:

1. Replace

```js
    assert.strictEqual((await post({ node: c.id, for: 3600000, until: 0 })).status, 400, "one of the two");
  });
});

```

   with

```js
    assert.strictEqual((await post({ node: c.id, for: 3600000, until: 0 })).status, 400, "one of the two");
  });
});

test("alert rules: the page reads and saves them; they apply at once, survive a restart, and a bad set is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  const a = await startHub({}, { dataDir: dir });
  const c = creds(a);
  const own = { id: "c_upd", name: "any update", metric: "security_updates", op: ">=", threshold: 1, for: 0, severity: "warning",
                scope: { node: c.id } };
  try {
    const cookie = cookieFrom(await login(a.port));
    const get = async (p) => JSON.parse((await request(a.port, { path: p, headers: { cookie } })).body);
    const r0 = await get("/__ctl/alerts/rules");
    assert.deepStrictEqual(r0.saved, { rules: [] });
    assert.strictEqual(r0.defaults.find((r) => r.id === "disk_full").for, 5, "minutes");
    assert.ok(r0.metrics.includes("disk.used") && !r0.metrics.includes("offline"));
    const save = (body) => ctlPost(a.port, cookie, "/__ctl/alerts/rules", JSON.stringify(body));
    const refused = await save({ rules: [{ id: "cpu", severity: "page" }] });
    assert.strictEqual(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, /severity/);
    assert.strictEqual((await save({ rules: [own, { id: "reboot_required", off: true }] })).status, 200);
    assert.match(a.logs(), /event=alert\.rules_saved/);
    assert.strictEqual((await signed(a, c, { body: snap({ ubuntu: { rebootRequired: true, security: 2 } }) })).status, 200);
    assert.deepStrictEqual((await get("/__ctl/alerts")).firing.map((f) => f.rule).sort(), ["c_upd", "security_updates"], "applied at once");
    assert.strictEqual((await ctlPost(a.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ rule: "c_upd", for: 60000 }))).status, 200,
      "a rule of one's own can be muted");
    assert.strictEqual((await request(a.port, { path: "/__ctl/alerts/rules" })).status, 401);
  } finally { await a.stop(); }
  const b = await startHub({}, { dataDir: dir });
  try {
    const cookie = cookieFrom(await login(b.port));
    const r1 = JSON.parse((await request(b.port, { path: "/__ctl/alerts/rules", headers: { cookie } })).body);
    assert.deepStrictEqual(r1.saved.rules.map((r) => r.id), ["c_upd", "reboot_required"], "kept");
    assert.strictEqual((await signed(b, c, { body: snap({ ubuntu: { rebootRequired: true, security: 2 } }) })).status, 200);
    const f = JSON.parse((await request(b.port, { path: "/__ctl/alerts", headers: { cookie } })).body).firing;
    assert.ok(!f.some((x) => x.rule === "reboot_required"), "still off after the restart");
  } finally { await b.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("alert rules: a rules file that cannot be read leaves the defaults, and says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  fs.mkdirSync(path.join(dir, "alerts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "alerts", "rules.json"), '{"rules":[{"id":"cpu","severity":"page"}]}');
  const h = await startHub({}, { dataDir: dir });
  try {
    assert.match(h.logs(), /event=alerts\.rules_ignored/);
    const cookie = cookieFrom(await login(h.port));
    const r = JSON.parse((await request(h.port, { path: "/__ctl/alerts/rules", headers: { cookie } })).body);
    assert.deepStrictEqual(r.saved, { rules: [] });
  } finally { await h.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("alert rules: a server revoked after it was named stays savable; a new name must be a server there is", async () => {
  await withHub(async (hub) => {
    const other = JSON.parse(require("node:child_process").execFileSync(process.execPath,
      [path.join(__dirname, "..", "hub", "lib", "nodes.js"), path.join(hub.dataDir, "nodes.json"), "add", "other"]).toString());
    const cookie = cookieFrom(await login(hub.port));
    const save = (body) => ctlPost(hub.port, cookie, "/__ctl/alerts/rules", JSON.stringify(body));
    const rules = { rules: [{ id: "cpu", overrides: [{ node: other.id, off: true }] }] };
    assert.strictEqual((await save(rules)).status, 200);
    assert.strictEqual((await ctlPost(hub.port, cookie, `/__ctl/node/${other.id}/revoke`)).status, 200);
    assert.strictEqual((await save({ rules: [...rules.rules, { id: "memory", threshold: 80 }] })).status, 200, "the revoked server's override is kept");
    const fresh = await save({ rules: [{ id: "cpu", overrides: [{ node: "nodecccccccc", off: true }] }] });
    assert.deepStrictEqual([fresh.status, JSON.parse(fresh.body).error], [400, "rules[0].overrides[0]: no such server"]);
  }, { CTL_LAN_ONLY: "0" });
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/alertrules.test.js test/alerts.test.js test/agentapi.test.js`
Expected: FAIL:
- `test/alertrules.test.js` and `test/alerts.test.js` as whole files (`Cannot find module '../hub/lib/alertrules'`);
- 3 tests in agentapi: "alert rules: the page reads and saves them…", "alert rules: a rules file that cannot be read…", "alert rules: a server revoked after it was named…".

- [ ] **Step 3: The rules, the engine, the routes**

Create `hub/lib/alertrules.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The alert rules a person sets (spec 8.1): changes to the default rules, rules of their
 * own, and per-server or per-tag overrides. Kept in <state>/alerts/rules.json as
 *   { rules: [ { id, threshold?, for?, clear?, severity?, off?, overrides? }            a default rule
 *            | { id: "c_…", name, metric, op, threshold, for, clear, severity, off,
 *                scope: {} | { node } | { tag }, sub?, overrides? } ] }                  one of their own
 *   override: { node | tag, threshold } or { node | tag, off: true }
 * "for" is in minutes here and in milliseconds in the engine; the same file keeps its shape.
 *   checkRules(input, { nodeIds }) → the clean file, or throws an Error that says what is wrong;
 *     nodeIds null: any server id is taken (a file kept before its server was revoked)
 *   buildRules(saved) → the engine's rules: the defaults with the changes, then the person's own
 *   defaultsForPage() → the default rules in the file's units, for the editor
 */
const { DEFAULT_RULES } = require("./alerts");

const MIN = 60000;
// what a rule of one's own can watch; offline stays the default rule's
const METRICS = {
  "disk.used": { sub: true }, mem: {}, cpu: {}, temp: {},
  "container.down": { sub: true }, failed_units: {}, reboot_required: {}, security_updates: {},
};
const OPS = [">=", "<=", "=="];
const SEVERITIES = ["critical", "warning", "info"];
const NODE_ID = /^[a-z2-7]{12}$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const CUSTOM_ID = /^c_[a-z0-9]{1,16}$/;
const MAX_RULES = 100, MAX_OVERRIDES = 50, WEEK_MIN = 7 * 24 * 60;

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const num = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9;

function checkRules(input, { nodeIds = [] } = {}) {
  const known = (id) => NODE_ID.test(id) && (nodeIds === null || nodeIds.includes(id));
  if (!isObj(input) || !Array.isArray(input.rules)) throw new Error("rules: a list");
  if (input.rules.length > MAX_RULES) throw new Error(`rules: at most ${MAX_RULES}`);
  const seen = new Set(), out = [];
  for (const [i, r] of input.rules.entries()) {
    const at = `rules[${i}]`;
    if (!isObj(r) || typeof r.id !== "string") throw new Error(`${at}: needs an id`);
    if (seen.has(r.id)) throw new Error(`${at}: ${r.id} is listed twice`);
    seen.add(r.id);
    const def = DEFAULT_RULES.find((d) => d.id === r.id);
    if (!def && !CUSTOM_ID.test(r.id)) throw new Error(`${at}: ${r.id} is no default rule, and a rule of one's own is c_ and up to 16 letters or digits`);
    const c = { id: r.id };
    if (!def) {
      if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 60 || /[\u0000-\u001f\u007f]/.test(r.name)) throw new Error(`${at}: name: 1 to 60 characters`);
      if (!Object.prototype.hasOwnProperty.call(METRICS, r.metric)) throw new Error(`${at}: metric: one of ${Object.keys(METRICS).join(", ")}`);
      if (!OPS.includes(r.op)) throw new Error(`${at}: op: one of ${OPS.join(" ")}`);
      if (!num(r.threshold)) throw new Error(`${at}: threshold: a number`);
      Object.assign(c, { name: r.name.trim(), metric: r.metric, op: r.op, threshold: r.threshold });
      const s = r.scope === undefined ? {} : r.scope;
      if (!isObj(s) || (s.node !== undefined && s.tag !== undefined)) throw new Error(`${at}: scope: all servers, a server or a tag`);
      if (s.node !== undefined && !known(s.node)) throw new Error(`${at}: scope: no such server`);
      if (s.tag !== undefined && !(typeof s.tag === "string" && TAG.test(s.tag))) throw new Error(`${at}: scope: a tag is lowercase letters, digits, dot, dash, underscore`);
      c.scope = s.node !== undefined ? { node: s.node } : s.tag !== undefined ? { tag: s.tag } : {};
      if (r.sub !== undefined && r.sub !== "") {
        if (!METRICS[r.metric].sub) throw new Error(`${at}: sub: only for disks and containers`);
        if (typeof r.sub !== "string" || r.sub.length > 200 || /[\u0000-\u001f\u007f]/.test(r.sub)) throw new Error(`${at}: sub: a mount or container name`);
        c.sub = r.sub;
      }
    } else if (r.threshold !== undefined) {
      if (r.id === "offline") throw new Error(`${at}: offline has no threshold`);
      if (!num(r.threshold)) throw new Error(`${at}: threshold: a number`);
      c.threshold = r.threshold;
    }
    if (r.for !== undefined || !def) {
      const f = r.for === undefined ? 0 : r.for;
      if (r.id === "offline" && r.for !== undefined) throw new Error(`${at}: offline's time follows the server's heartbeat`);
      if (!(Number.isInteger(f) && f >= 0 && f <= WEEK_MIN)) throw new Error(`${at}: for: whole minutes, 0 to ${WEEK_MIN}`);
      c.for = f;
    }
    if (r.clear !== undefined && r.clear !== null) {
      if (r.id === "offline" || !num(r.clear)) throw new Error(`${at}: clear: a number`);
      c.clear = r.clear;
    } else if (r.clear === null || !def) c.clear = null;
    if (r.severity !== undefined || !def) {
      if (!SEVERITIES.includes(r.severity)) throw new Error(`${at}: severity: one of ${SEVERITIES.join(", ")}`);
      c.severity = r.severity;
    }
    if (r.off !== undefined && typeof r.off !== "boolean") throw new Error(`${at}: off: true or false`);
    if (r.off) c.off = true;
    if (r.overrides !== undefined) {
      if (!Array.isArray(r.overrides) || r.overrides.length > MAX_OVERRIDES) throw new Error(`${at}: overrides: a list of at most ${MAX_OVERRIDES}`);
      c.overrides = r.overrides.map((o, k) => {
        const oat = `${at}.overrides[${k}]`;
        if (!isObj(o) || (o.node === undefined) === (o.tag === undefined)) throw new Error(`${oat}: a server or a tag`);
        if (o.node !== undefined && !known(o.node)) throw new Error(`${oat}: no such server`);
        if (o.tag !== undefined && !(typeof o.tag === "string" && TAG.test(o.tag))) throw new Error(`${oat}: a tag is lowercase letters, digits, dot, dash, underscore`);
        const who = o.node !== undefined ? { node: o.node } : { tag: o.tag };
        if (o.off === true) return { ...who, off: true };
        if (r.id === "offline") throw new Error(`${oat}: offline can only be turned off`);
        if (!num(o.threshold)) throw new Error(`${oat}: a threshold, or off`);
        return { ...who, threshold: o.threshold };
      });
      if (!c.overrides.length) delete c.overrides;
    }
    // the clear value sits on the near side of the threshold, or the alert would end as it fires
    const op = c.op || (def && def.op), th = c.threshold !== undefined ? c.threshold : def && def.threshold;
    const clear = c.clear !== undefined ? c.clear : def ? def.clear : null;
    if (clear !== null && r.id !== "offline") {
      if (op === "==" || (op === ">=" && clear > th) || (op === "<=" && clear < th)) {
        throw new Error(`${at}: clear: ${op === "==" ? "none for ==" : op === ">=" ? "at most the threshold" : "at least the threshold"}`);
      }
    }
    out.push(c);
  }
  return { rules: out };
}

// the engine's rules: every default rule (changed where the file says), then the person's own
function buildRules(saved) {
  const list = saved && Array.isArray(saved.rules) ? saved.rules : [];
  const edit = (r) => {
    const e = { ...r };
    if (e.for !== undefined) e.for *= MIN;
    if (e.clear === undefined) delete e.clear;
    return e;
  };
  const defaults = DEFAULT_RULES.map((d) => {
    const c = list.find((r) => r.id === d.id);
    return c ? { ...d, ...edit(c) } : { ...d };
  });
  const own = list.filter((r) => !DEFAULT_RULES.some((d) => d.id === r.id))
    .map((r) => ({ repeat: 24 * 60 * MIN, ...edit(r), clear: r.clear === undefined ? null : r.clear }));
  return [...defaults, ...own];
}

const defaultsForPage = () => DEFAULT_RULES.map((d) => ({ ...d, for: d.for / MIN, repeat: undefined }));

module.exports = { checkRules, buildRules, defaultsForPage, METRICS: Object.keys(METRICS), OPS, SEVERITIES };
```

In `hub/lib/alerts.js`:

1. Replace

```js
 * State and mutes live in <dir>/state.json, every event in <dir>/events.jsonl (the
 * alert log, the last 1000).
 *   createAlerts(dir, { now, onEvent, warn }) → { evaluate(node, view), check(nodes),
 *     firing(), recent(n), mute({ rule | node, until }), mutes(), badges(), forget(node), log(event) }
 */
```

   with

```js
 * State and mutes live in <dir>/state.json, every event in <dir>/events.jsonl (the
 * alert log, the last 1000).
 *   createAlerts(dir, { now, onEvent, warn, rules }) → { evaluate(node, view), check(nodes), setRules(rules), ruleIds(),
 *     firing(), recent(n), mute({ rule | node, until }), mutes(), badges(), forget(node), log(event) }
 */
```

2. Replace

```js
    default: return null;
  }
}

```

   with

```js
    default: return null;
  }
}

// a rule as it holds for one node ({ id, tags }): null when it is off, out of its scope, or
// turned off for the node; else the rule, with the node's override threshold (the clear value
// moves with it). A node's own override wins over its tag's.
function forNode(r, node) {
  if (r.off) return null;
  const s = r.scope || {}, tags = Array.isArray(node.tags) ? node.tags : [];
  if ((s.node && s.node !== node.id) || (s.tag && !tags.includes(s.tag))) return null;
  const ovs = Array.isArray(r.overrides) ? r.overrides : [];
  const ov = ovs.find((o) => o.node === node.id) || ovs.find((o) => o.tag && tags.includes(o.tag));
  if (!ov) return r;
  if (ov.off) return null;
  return { ...r, threshold: ov.threshold, clear: r.clear === null ? null : r.clear + (ov.threshold - r.threshold) };
}

```

3. Replace

```js
  }

  return {
    // a push from node ({ id, name }): every rule on what it sends; a push ends "offline"
    evaluate(node, v) {
      const t = now();
```

   with

```js
  }

  // a rule that no longer holds for a node: its alerts there end (a told one ends told)
  function endAll(r, node, t) {
    for (const inst of Object.values(st.instances)) {
      if (inst.rule === r.id && inst.node === node.id) judge(r, node, inst.sub, null, t);
    }
  }

  return {
    // a push from node ({ id, name, tags }): every rule on what it sends; a push ends "offline"
    evaluate(node, v) {
      const t = now();
```

4. Replace

```js
        st.running[node.id] = [...run];
      }
      for (const r of rules) {
        if (r.metric === "offline") { judge(r, node, "", 0, t); continue; }
        const vals = valuesOf(r.metric, v, run);
        if (vals === null) continue;   // the push lacks the group: its alerts stay as they are
        const seen = new Set(vals.map((x) => x.sub));
        for (const x of vals) judge(r, node, x.sub, x.value, t);
```

   with

```js
        st.running[node.id] = [...run];
      }
      for (const rule of rules) {
        const r = forNode(rule, node);
        if (!r) { endAll(rule, node, t); continue; }
        if (r.metric === "offline") { judge(r, node, "", 0, t); continue; }
        let vals = valuesOf(r.metric, v, run);
        if (vals === null) continue;   // the push lacks the group: its alerts stay as they are
        if (r.sub) vals = vals.filter((x) => x.sub === r.sub);
        const seen = new Set(vals.map((x) => x.sub));
        for (const x of vals) judge(r, node, x.sub, x.value, t);
```

5. Replace

```js
    check(nodes) {
      const t = now();
      const r = rules.find((x) => x.metric === "offline");
      for (const n of nodes) {
        if (!n.lastPush) continue;   // waiting for its first push: not offline
        const limit = Math.max(10 * MIN, 5 * (n.interval || 60) * 1000);
        if (r) judge(r, n, "", t - n.lastPush >= limit ? 1 : 0, t);
        for (const inst of Object.values(st.instances)) {
          if (inst.node !== n.id || inst.state !== "firing" || inst.rule === "offline") continue;
```

   with

```js
    check(nodes) {
      const t = now();
      const off = rules.find((x) => x.metric === "offline");
      for (const n of nodes) {
        if (!n.lastPush) continue;   // waiting for its first push: not offline
        const limit = Math.max(10 * MIN, 5 * (n.interval || 60) * 1000);
        const r = off && forNode(off, n);
        if (r) judge(r, n, "", t - n.lastPush >= limit ? 1 : 0, t);
        else if (off) endAll(off, n, t);
        for (const inst of Object.values(st.instances)) {
          if (inst.node !== n.id || inst.state !== "firing" || inst.rule === "offline") continue;
```

6. Replace

```js
      return out;
    },
    // a revoked node: its told alerts end told
    forget(node) {
```

   with

```js
      return out;
    },
    // new rules (from the editor): the alerts of a rule removed or turned off end now (a told
    // one ends told); a change of scope or override applies at each node's next push
    setRules(list) {
      const t = now(), old = rules;
      rules = list;
      for (const [k, i] of Object.entries(st.instances)) {
        const r = rules.find((x) => x.id === i.rule);
        if (r && !r.off) continue;
        const was = r || old.find((x) => x.id === i.rule);
        if (was && i.state === "firing") tell("resolved", i, was, t);
        delete st.instances[k];
      }
      save();
    },
    ruleIds() { return rules.map((r) => r.id); },
    // a revoked node: its told alerts end told
    forget(node) {
```

7. Replace

```js
}

module.exports = { createAlerts, DEFAULT_RULES, valuesOf };

```

   with

```js
}

module.exports = { createAlerts, DEFAULT_RULES, valuesOf, forNode };

```

In `hub/server.js`:

1. Replace

```js
const { view: snapshotView } = require("./lib/snapshot");
const { createHistory, seriesOf } = require("./lib/history");
const { createAlerts, DEFAULT_RULES } = require("./lib/alerts");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

   with

```js
const { view: snapshotView } = require("./lib/snapshot");
const { createHistory, seriesOf } = require("./lib/history");
const { createAlerts } = require("./lib/alerts");
const alertRules = require("./lib/alertrules");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

2. Replace

```js
// alerts (spec 8.1): judged on each push and once a minute; events go to the log (channels: 6c)
const HUB_START = Date.now();
const alerts = createAlerts(path.join(DATA, "alerts"), {
  warn: (event, fields) => log.warn(event, fields),
  onEvent: (e) => log.info("alert." + e.kind, { rule: e.rule, severity: e.severity, node: e.node, ...(e.sub ? { sub: e.sub } : {}), value: e.value }),
```

   with

```js
// alerts (spec 8.1): judged on each push and once a minute; events go to the log (channels: 6c)
const HUB_START = Date.now();
// the alert rules the person set (spec 8.1); a file that cannot be read leaves the defaults
const RULES_F = path.join(DATA, "alerts", "rules.json");
let savedRules = { rules: [] };
try { savedRules = alertRules.checkRules(JSON.parse(fs.readFileSync(RULES_F, "utf8")), { nodeIds: null }); }
catch (e) { if (e.code !== "ENOENT") log.warn("alerts.rules_ignored", { error: e.message || String(e) }); }
const alerts = createAlerts(path.join(DATA, "alerts"), {
  rules: alertRules.buildRules(savedRules),
  warn: (event, fields) => log.warn(event, fields),
  onEvent: (e) => log.info("alert." + e.kind, { rule: e.rule, severity: e.severity, node: e.node, ...(e.sub ? { sub: e.sub } : {}), value: e.value }),
```

3. Replace

```js
      const rec = latest.get(n.id);
      // a hub that was down is no reason to page: a node's time runs from the hub's start at the earliest
      return { id: n.id, name: n.name, lastPush: rec ? Math.max(rec.at, HUB_START) : null, interval: rec ? rec.snap.interval : null };
    }));
  } catch (e) { log.warn("alerts.check_failed", { error: e.code || String(e) }); }
```

   with

```js
      const rec = latest.get(n.id);
      // a hub that was down is no reason to page: a node's time runs from the hub's start at the earliest
      return { id: n.id, name: n.name, tags: n.tags, lastPush: rec ? Math.max(rec.at, HUB_START) : null, interval: rec ? rec.snap.interval : null };
    }));
  } catch (e) { log.warn("alerts.check_failed", { error: e.code || String(e) }); }
```

4. Replace

```js
    latest.set(id, rec);
    try { history.add(id, seriesOf(rec.view)); } catch (e) { log.warn("history.add_failed", { node: id, error: e.code || String(e) }); }
    try { alerts.evaluate({ id, name: nodeName(id) }, rec.view); } catch (e) { log.warn("alerts.evaluate_failed", { node: id, error: e.code || String(e) }); }
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
```

   with

```js
    latest.set(id, rec);
    try { history.add(id, seriesOf(rec.view)); } catch (e) { log.warn("history.add_failed", { node: id, error: e.code || String(e) }); }
    try { alerts.evaluate({ id, name: nodeName(id), tags: (nodes.get(id) || {}).tags || [] }, rec.view); } catch (e) { log.warn("alerts.evaluate_failed", { node: id, error: e.code || String(e) }); }
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
```

5. Replace

```js
      try { body = JSON.parse(await readBodyN(req, 1024)); } catch (_) { /* answered below */ }
      const b = body && typeof body === "object" ? body : {};
      const okRule = typeof b.rule === "string" && DEFAULT_RULES.some((r) => r.id === b.rule);
      const okNode = typeof b.node === "string" && !!nodes.get(b.node);
      const YEAR = 366 * 86400000;
```

   with

```js
      try { body = JSON.parse(await readBodyN(req, 1024)); } catch (_) { /* answered below */ }
      const b = body && typeof body === "object" ? body : {};
      const okRule = typeof b.rule === "string" && alerts.ruleIds().includes(b.rule);
      const okNode = typeof b.node === "string" && !!nodes.get(b.node);
      const YEAR = 366 * 86400000;
```

6. Replace

```js
      alerts.mute(okRule ? { rule: b.rule, until } : { node: b.node, until });
      log.audit("alert.muted", { ip, ...(okRule ? { rule: b.rule } : { node: b.node }), until });
      return json(200, { ok: true });
    }
```

   with

```js
      alerts.mute(okRule ? { rule: b.rule, until } : { node: b.node, until });
      log.audit("alert.muted", { ip, ...(okRule ? { rule: b.rule } : { node: b.node }), until });
      return json(200, { ok: true });
    }

    // the alert rules (spec 8.1): what is saved, the defaults and the metrics, for the editor
    if (req.method === "GET" && pathname === "/__ctl/alerts/rules") {
      return json(200, { saved: savedRules, defaults: alertRules.defaultsForPage(), metrics: alertRules.METRICS });
    }
    // save them whole: checked, kept, applied at once. A server named before it was revoked
    // may stay named; a new one must exist.
    if (req.method === "POST" && pathname === "/__ctl/alerts/rules") {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 64 * 1024)); } catch (_) { return json(400, { error: "invalid json" }); }
      const named = savedRules.rules.flatMap((r) => [r.scope && r.scope.node, ...(r.overrides || []).map((o) => o.node)]).filter(Boolean);
      let clean;
      try { clean = alertRules.checkRules(body, { nodeIds: [...nodes.list().map((n) => n.id), ...named] }); }
      catch (e) { return json(400, { error: e.message }); }
      try { writeFileAtomic(RULES_F, JSON.stringify(clean, null, 2) + "\n"); }
      catch (e) { return json(500, { error: String(e.code || e) }); }
      savedRules = clean;
      alerts.setRules(alertRules.buildRules(clean));
      log.audit("alert.rules_saved", { ip, rules: clean.rules.length });
      return json(200, { ok: true });
    }
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 400 tests (10 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/alertrules.js hub/lib/alerts.js hub/server.js test/alertrules.test.js test/alerts.test.js test/agentapi.test.js
git commit -m "feat(hub): alert rules a person sets: default changes, rules of one's own, per-server and per-tag overrides"
```

---

### Task 2: The rule editor

**Files:**
- Modify: `www/js/alerts.js`, `www/index.html`, `www/app.css`, `hub/lib/i18n.js`, `test/page.test.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `GET` and `POST /__ctl/alerts/rules`, `defaultsForPage()` and `METRICS` (Task 1, also used by the tests).
- Produces (alerts.js globals): `rulesState`, `rulesRows(saved, defaults)`, `rulesFile(rows, defaults)`, `rulesHtml(rows)`, `readRules()`, `drawRules()`, `loadRules(force)`, `saveRules()`, `rulesAction(act, i, j)`, `showRulesTab(on)`, `shown(metric, v)`, `typed(metric, v)`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js
  assert.match(JS, /if \(\$\("#alerts-overlay"\)\.classList\.contains\("open"\)\) \{\n\s+if \(e\.key === "a" \|\| e\.key === "Escape"\) closeAlerts\(\);\n\s+return;\n\s+\}/);
});

```

   with

```js
  assert.match(JS, /if \(\$\("#alerts-overlay"\)\.classList\.contains\("open"\)\) \{\n\s+if \(e\.key === "a" \|\| e\.key === "Escape"\) closeAlerts\(\);\n\s+return;\n\s+\}/);
});

// the rule editor (spec 8.1), in alerts.js
function rulesScope(extra = {}) {
  const { STRINGS } = require("../hub/lib/i18n");
  const { defaultsForPage } = require("../hub/lib/alertrules");
  const env = { esc: escA, STRINGS, fmtShare: String, fmtTemp: String, fmtDur: String, fmtTime: () => "", Date,
    units: () => ({ temp: "c" }), tempUnit: () => "°C", fleetNodes: [], $: () => ({}), $$: () => [], toast() {}, fetch: async () => answer({}),
    loadNodes: async () => {}, renderFleetIfShown() {}, ...extra };
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "js", "alerts.js"), "utf8");
  const api = new Function(...Object.keys(env), "tr", `${src}; return { rulesRows, rulesFile, rulesHtml, readRules, saveRules, rulesAction, rulesState, shown, typed };`)(...Object.values(env), tr);
  api.rulesState.defaults = JSON.parse(JSON.stringify(defaultsForPage()));
  api.rulesState.metrics = require("../hub/lib/alertrules").METRICS;
  return api;
}

test("rule editor: the saved file and the defaults become rows, and rows become the smallest file again", () => {
  const s = rulesScope();
  const D = s.rulesState.defaults;
  assert.deepStrictEqual(s.rulesFile(s.rulesRows({ rules: [] }, D), D), { rules: [] }, "nothing changed: nothing kept");
  const saved = { rules: [   // in the defaults' order, as the editor writes it
    { id: "offline", overrides: [{ node: "nodeaaaaaaaa", off: true }] },
    { id: "disk_full", threshold: 85, clear: 80 },
    { id: "cpu", off: true, overrides: [{ tag: "lab", threshold: 99 }] },
    { id: "c_b", name: "backup", metric: "disk.used", op: ">=", threshold: 70, for: 0, clear: null, severity: "warning", scope: { node: "nodeaaaaaaaa" }, sub: "/b" },
  ] };
  const rows = s.rulesRows(saved, D);
  assert.deepStrictEqual(rows.find((r) => r.id === "cpu"), { id: "cpu", own: false, metric: "cpu", op: ">=", threshold: 95, for: 15, clear: null,
    severity: "warning", on: false, overrides: [{ who: "tag:lab", threshold: 99, off: false }] });
  assert.strictEqual(rows[rows.length - 1].scope, "node:nodeaaaaaaaa");
  assert.deepStrictEqual(s.rulesFile(rows, D), saved, "round trip");
  rows.find((r) => r.id === "memory").clear = 85;
  rows.find((r) => r.id === "disk_full").clear = null;
  const f = s.rulesFile(rows, D).rules;
  assert.deepStrictEqual(f.find((r) => r.id === "memory"), { id: "memory", clear: 85 });
  assert.deepStrictEqual(f.find((r) => r.id === "disk_full"), { id: "disk_full", threshold: 85, clear: null }, "no hysteresis: null, not the default");
});

test("rule editor: the form escapes every name, leaves out what a rule cannot set, and shows temperatures in °F when asked", () => {
  const s = rulesScope({ fleetNodes: [{ id: "nodeaaaaaaaa", name: "<nas>", tags: ["l&b"] }] });
  const D = s.rulesState.defaults;
  const rows = s.rulesRows({ rules: [
    { id: "offline", overrides: [{ node: "nodeaaaaaaaa", off: true }] },
    { id: "c_x", name: "<img src=x>", metric: "temp", op: ">=", threshold: 70, for: 0, clear: null, severity: "info", scope: { tag: "gone" } },
  ] }, D);
  const html = s.rulesHtml(rows);
  assert.doesNotMatch(html, /<img|<nas>|style=/);
  assert.match(html, /value="&#60;img src=x&#62;"/);
  assert.match(html, /<option value="node:nodeaaaaaaaa" selected>server &#60;nas&#62;<\/option>/, "the override names its server");
  assert.match(html, /<option value="tag:gone" selected>gone<\/option>/, "a tag no server has any more is kept");
  const off = html.split('<div class="rule')[1];
  assert.doesNotMatch(off, /data-f="threshold"|data-f="for"|data-f="clear"/, "offline: its time follows the heartbeat");
  assert.match(off, /data-of="off" checked disabled/);
  const reboot = html.split('<div class="rule').find((x) => x.includes(">reboot required<"));
  assert.doesNotMatch(reboot, /data-f="threshold"|data-f="clear"/, "true or false: no threshold");
  assert.match(reboot, /data-f="for"/);
  const f = rulesScope({ units: () => ({ temp: "f" }), tempUnit: () => "°F" });
  assert.match(f.rulesHtml(f.rulesRows({ rules: [] }, f.rulesState.defaults)), /data-f="threshold" value="185"[^>]*><span class="unit">°F</, "85 °C reads 185 °F");
  assert.deepStrictEqual([f.typed("temp", 185), f.typed("temp", 98.6), f.typed("cpu", 50), f.shown("temp", 85.3)], [85, 37, 50, 185.5]);
});

// a fake form: what the editor reads back
function fakeRule(i, fields, overrides = []) {
  const f = (attr, k, v) => ({ dataset: { [attr]: k }, value: v, checked: v === true });
  const line = Object.entries(fields).map(([k, v]) => f("f", k, v));
  const ovs = overrides.map((o, j) => ({ dataset: { o: String(j) }, querySelector: (sel) => {
    const k = /data-of=(\w+)/.exec(sel)[1];
    return o[k] === undefined ? null : f("of", k, o[k]);
  } }));
  return { dataset: { i: String(i) }, querySelectorAll: (sel) => (sel.includes("[data-f]") ? line : sel.includes(".rov") ? ovs : []) };
}

test("rule editor: the form is read back into the rules, temperatures from °F, a true-or-false rule kept at 1", () => {
  let form = [];
  const s = rulesScope({ $$: () => form, units: () => ({ temp: "f" }), tempUnit: () => "°F" });
  s.rulesState.rows = s.rulesRows({ rules: [] }, s.rulesState.defaults);
  const t = s.rulesState.rows.findIndex((r) => r.id === "temperature");
  const rb = s.rulesState.rows.findIndex((r) => r.id === "reboot_required");
  form = [fakeRule(t, { on: true, threshold: "176", for: "3", clear: "", severity: "critical" }, [{ who: "tag:lab", threshold: "194", off: false }]),
          fakeRule(rb, { on: false, for: "0", severity: "info" })];
  s.rulesState.rows[t].overrides.push({ who: "", threshold: null, off: false });
  s.readRules();
  assert.deepStrictEqual(s.rulesState.rows[t], { id: "temperature", own: false, metric: "temp", op: ">=", threshold: 80, for: 3, clear: null,
    severity: "critical", on: true, overrides: [{ who: "tag:lab", threshold: 90, off: false }] });
  assert.deepStrictEqual([s.rulesState.rows[rb].on, s.rulesState.rows[rb].threshold], [false, 1]);
});

test("rule editor: save sends the file and shows what the hub refused; add, remove and overrides change the rows", async () => {
  const sent = [], toasts = [];
  let reply = { ok: false, status: 400, json: async () => ({ error: "rules[0]: severity: one of critical, warning, info" }) };
  const s = rulesScope({ fetch: async (url, opt) => { if (opt) { sent.push(JSON.parse(opt.body)); return reply; } return answer({}); },
    toast: (m, err) => toasts.push([m, !!err]), fleetNodes: [{ id: "nodeaaaaaaaa", name: "nas", tags: [] }], $: () => ({ innerHTML: "" }) });
  s.rulesState.rows = s.rulesRows({ rules: [] }, s.rulesState.defaults);
  s.rulesAction("add");
  const own = s.rulesState.rows[s.rulesState.rows.length - 1];
  assert.match(own.id, /^c_[a-z0-9]{1,16}$/);
  assert.deepStrictEqual([own.own, own.name, own.metric, own.scope], [true, "new rule", "disk.used", ""]);
  s.rulesAction("addov", 1);
  assert.deepStrictEqual(s.rulesState.rows[1].overrides, [{ who: "node:nodeaaaaaaaa", threshold: 90, off: false }]);
  s.rulesAction("addov", 0);
  assert.deepStrictEqual(s.rulesState.rows[0].overrides, [{ who: "node:nodeaaaaaaaa", threshold: null, off: true }], "offline: only off");
  s.rulesAction("rmov", 1, 0);
  assert.deepStrictEqual(s.rulesState.rows[1].overrides, []);
  assert.strictEqual(s.rulesState.dirty, true);
  await s.saveRules();
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].rules.map((r) => r.id), ["offline", own.id]);
  assert.deepStrictEqual(toasts, [["not saved: rules[0]: severity: one of critical, warning, info", true]]);
  assert.strictEqual(s.rulesState.dirty, true, "what was typed stays");
  s.rulesAction("remove", s.rulesState.rows.length - 1);
  assert.ok(!s.rulesState.rows.some((r) => r.own));
});

test("the alerts view has a rules tab", () => {
  for (const id of ["alerts-tab-list", "alerts-tab-rules", "alerts-list", "rules-body"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(JS, /\$\("#alerts-tab-rules"\)\.onclick = \(\) => showRulesTab\(true\);/);
});

```

In `test/screens/shoot.js`:

1. Replace

```js
  await page.click("#alerts-body button[data-unmute]");
  await page.waitForTimeout(500);

  // the settings panel on a desktop and a phone: styled controls, none squeezed or sticking out
```

   with

```js
  await page.click("#alerts-body button[data-unmute]");
  await page.waitForTimeout(500);
  // the rule editor, with a rule of one's own and an override, on a desktop and a phone
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1400 });
    await page.goto(`${base}/?shot=rules-${width}#fleet`);
    await page.waitForTimeout(1200);
    await page.keyboard.press("a");
    await page.click("#alerts-tab-rules");
    await page.waitForSelector("#rules-body .rule");
    await page.click("#rules-body .rule:nth-of-type(3) button[data-act=addov]");
    await page.click("#rules-body button[data-act=add]");
    await page.screenshot({ path: `${out}/rules-${width}.png`, fullPage: true });
  }

  // the settings panel on a desktop and a phone: styled controls, none squeezed or sticking out
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 5 tests: the four "rule editor: …" tests (`ReferenceError: rulesRows is not defined`) and "the alerts view has a rules tab".

- [ ] **Step 3: The editor**

In `www/js/alerts.js`:

1. Replace

```js
/* the alerts view (spec 8, 10.1): what is firing, the mutes still running and the last
   events, from GET /__ctl/alerts; a rule or a node is muted (and unmuted) with POST
   /__ctl/alerts/mute. Loaded by openAlerts() in app.js on first use. */
const ALERT_SEV = ["critical", "warning", "info"];
let alertsSeq = 0;
```

   with

```js
/* the alerts view (spec 8, 10.1): what is firing, the mutes still running and the last
   events, from GET /__ctl/alerts; a rule or a node is muted (and unmuted) with POST
   /__ctl/alerts/mute. Its second tab edits the rules (spec 8.1): the defaults' thresholds,
   times and severities, rules of one's own, and per-server or per-tag overrides, from GET
   and POST /__ctl/alerts/rules. Loaded by openAlerts() in app.js on first use. */
const ALERT_SEV = ["critical", "warning", "info"];
let alertsSeq = 0;
```

2. Replace

```js
}

// wiring, once, when this file has loaded
function initAlerts() {
  $("#alerts-body").onclick = e => {
    const b = e.target.closest("button[data-mute], button[data-unmute]");
```

   with

```js
}

/* ------------------------------------------------------------------ the rule editor */
// rows: one per rule, the defaults first: { id, own, name, metric, op, threshold, for, clear,
// severity, on, scope ("", "node:<id>", "tag:<tag>"), sub, overrides: [{ who, threshold, off }] }
const rulesState = { defaults: [], metrics: [], rows: [], dirty: false };
const YESNO = ["reboot_required", "container.down"];   // true or false: no threshold to set
const metricLabel = m => tr("alert.metric." + String(m).replace(/[._]([a-z])/g, (x, c) => c.toUpperCase()));
const metricUnit = m => (/^(disk\.used|mem|cpu)$/.test(m) ? "%" : m === "temp" ? tempUnit() : "");
// a temperature rule is kept in °C and shown (and typed) in the page's unit
const inF = m => m === "temp" && units().temp === "f";
const shown = (m, v) => (v === null || v === undefined || !inF(m) ? v : Math.round((v * 9 / 5 + 32) * 10) / 10);
const typed = (m, v) => (v === null || Number.isNaN(v) || !inF(m) ? v : Math.round((v - 32) * 50 / 9) / 10);
const OP_SIGN = { ">=": "≥", "<=": "≤", "==": "=" };

// the saved file and the defaults, as rows
function rulesRows(saved, defaults) {
  const list = saved && Array.isArray(saved.rules) ? saved.rules : [];
  const who = o => (o.node ? "node:" + o.node : "tag:" + o.tag);
  const ovs = r => (Array.isArray(r.overrides) ? r.overrides : []).map(o => ({ who: who(o), threshold: o.off ? null : o.threshold, off: !!o.off }));
  const rows = defaults.map(d => {
    const c = list.find(r => r.id === d.id) || {};
    return { id: d.id, own: false, metric: d.metric, op: d.op, threshold: c.threshold ?? d.threshold, for: c.for ?? d.for,
             clear: c.clear !== undefined ? c.clear : d.clear, severity: c.severity || d.severity, on: !c.off, overrides: ovs(c) };
  });
  for (const r of list) {
    if (defaults.some(d => d.id === r.id)) continue;
    const s = r.scope || {};
    rows.push({ id: r.id, own: true, name: r.name, metric: r.metric, op: r.op, threshold: r.threshold, for: r.for, clear: r.clear,
                severity: r.severity, on: !r.off, scope: s.node ? "node:" + s.node : s.tag ? "tag:" + s.tag : "", sub: r.sub || "", overrides: ovs(r) });
  }
  return rows;
}

// rows back to the file: a default rule keeps only what differs from its default
function rulesFile(rows, defaults) {
  const who = w => (w.startsWith("node:") ? { node: w.slice(5) } : { tag: w.slice(4) });
  const ovs = r => r.overrides.map(o => (o.off ? { ...who(o.who), off: true } : { ...who(o.who), threshold: o.threshold }));
  const rules = [];
  for (const r of rows) {
    const d = defaults.find(x => x.id === r.id);
    if (d && !r.own) {
      const c = { id: r.id };
      if (r.id !== "offline") {
        if (r.threshold !== d.threshold) c.threshold = r.threshold;
        if (r.for !== d.for) c.for = r.for;
        if (r.clear !== d.clear) c.clear = r.clear;
      }
      if (r.severity !== d.severity) c.severity = r.severity;
      if (!r.on) c.off = true;
      if (r.overrides.length) c.overrides = ovs(r);
      if (Object.keys(c).length > 1) rules.push(c);
      continue;
    }
    const c = { id: r.id, name: r.name, metric: r.metric, op: r.op, threshold: r.threshold, for: r.for, clear: r.clear, severity: r.severity };
    c.scope = r.scope ? who(r.scope) : {};
    if (r.sub) c.sub = r.sub;
    if (!r.on) c.off = true;
    if (r.overrides.length) c.overrides = ovs(r);
    rules.push(c);
  }
  return { rules };
}

// the servers and tags a scope or an override can name
function rulesTargets() {
  const tags = [...new Set(fleetNodes.flatMap(n => (Array.isArray(n.tags) ? n.tags : [])))].sort();
  return [...fleetNodes.map(n => ["node:" + n.id, tr("rules.server", { name: n.name })]), ...tags.map(t => ["tag:" + t, tr("rules.tag", { tag: t })])];
}
const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
const numVal = v => (v === null || v === undefined || Number.isNaN(v) ? "" : esc(String(v)));

function rulesHtml(rows) {
  const targets = rulesTargets();
  const sevs = ["critical", "warning", "info"].map(s => [s, tr("alert.sev." + s)]);
  const known = w => targets.some(([v]) => v === w) ? targets : [...targets, [w, w.replace(/^(node|tag):/, "")]];
  let h = `<p class="hint">${esc(tr("rules.intro"))}</p>`;
  h += rows.map((r, i) => {
    const yesno = YESNO.includes(r.metric), offline = r.metric === "offline";
    let row = `<div class="rule${r.on ? "" : " roff"}" data-i="${i}"><div class="rline">`
      + `<input type="checkbox" data-f="on" aria-label="${esc(tr("rules.on"))}"${r.on ? " checked" : ""}>`;
    row += r.own
      ? `<input type="text" class="rname" data-f="name" maxlength="60" value="${esc(r.name || "")}" aria-label="${esc(tr("rules.name"))}">`
        + `<select data-f="metric" aria-label="${esc(tr("rules.metric"))}">${opts(rulesState.metrics.map(m => [m, metricLabel(m)]), r.metric)}</select>`
        + (yesno ? "" : `<select data-f="op" aria-label="${esc(tr("rules.op"))}">${opts(Object.entries(OP_SIGN), r.op)}</select>`)
      : `<span class="rname">${esc(ruleLabel(r.id))}</span>` + (yesno || offline ? "" : `<span class="rop">${esc(OP_SIGN[r.op] || r.op)}</span>`);
    if (!yesno && !offline) {
      row += `<input type="number" step="any" class="rnum" data-f="threshold" value="${numVal(shown(r.metric, r.threshold))}" aria-label="${esc(tr("rules.threshold"))}">`
        + `<span class="unit">${esc(metricUnit(r.metric))}</span>`;
    }
    if (!offline) {
      row += `<label>${esc(tr("rules.for"))} <input type="number" min="0" step="1" class="rnum" data-f="for" value="${numVal(r.for)}"> ${esc(tr("rules.min"))}</label>`;
      if (!yesno && r.op !== "==") row += `<label>${esc(tr("rules.clear"))} <input type="number" step="any" class="rnum" data-f="clear" value="${numVal(shown(r.metric, r.clear))}"></label>`;
    }
    row += `<select data-f="severity" aria-label="${esc(tr("rules.severity"))}">${opts(sevs, r.severity)}</select>`;
    if (r.own) {
      row += `<select data-f="scope" aria-label="${esc(tr("rules.scope"))}">${opts([["", tr("rules.all")], ...(r.scope ? known(r.scope) : targets)], r.scope || "")}</select>`;
      if (/^(disk\.used|container\.down)$/.test(r.metric)) {
        row += `<input type="text" class="rsub" data-f="sub" value="${esc(r.sub || "")}" placeholder="${esc(tr("rules.subAll"))}" aria-label="${esc(tr("rules.sub"))}">`;
      }
      row += `<button data-act="remove">${esc(tr("rules.remove"))}</button>`;
    }
    row += "</div>";
    row += r.overrides.map((o, j) => `<div class="rov" data-o="${j}"><span>${esc(tr("rules.overrideFor"))}</span>`
      + `<select data-of="who" aria-label="${esc(tr("rules.overrideWho"))}">${opts(known(o.who), o.who)}</select>`
      + (offline ? "" : `<input type="number" step="any" class="rnum" data-of="threshold" value="${numVal(shown(r.metric, o.threshold))}"${o.off ? " disabled" : ""} aria-label="${esc(tr("rules.threshold"))}">`)
      + `<label><input type="checkbox" data-of="off"${o.off || offline ? " checked" : ""}${offline ? " disabled" : ""}> ${esc(tr("rules.off"))}</label>`
      + `<button data-act="rmov">${esc(tr("rules.remove"))}</button></div>`).join("");
    if (targets.length) row += `<div class="rov"><button data-act="addov">${esc(tr("rules.addOverride"))}</button></div>`;
    return row + "</div>";
  }).join("");
  h += `<div class="rbtns"><button data-act="add">${esc(tr("rules.add"))}</button><span class="grow"></span>`
    + `<button data-act="revert">${esc(tr("rules.revert"))}</button><button data-act="save" class="primary">${esc(tr("rules.save"))}</button></div>`;
  return h;
}

// what the form says now, into the rows
function readRules() {
  const num = v => (String(v).trim() === "" ? null : Number(v));
  for (const el of $$("#rules-body .rule")) {
    const r = rulesState.rows[Number(el.dataset.i)];
    if (!r) continue;
    for (const f of el.querySelectorAll(":scope > .rline [data-f]")) {
      const k = f.dataset.f;
      r[k] = k === "on" ? f.checked : k === "for" ? num(f.value) : ["threshold", "clear"].includes(k) ? typed(r.metric, num(f.value)) : f.value;
    }
    for (const o of el.querySelectorAll(".rov[data-o]")) {
      const ov = r.overrides[Number(o.dataset.o)];
      if (!ov) continue;
      ov.who = o.querySelector("[data-of=who]").value;
      const off = o.querySelector("[data-of=off]");
      ov.off = r.metric === "offline" || (off ? off.checked : false);
      const th = o.querySelector("[data-of=threshold]");
      ov.threshold = ov.off || !th ? null : typed(r.metric, num(th.value));
    }
    if (YESNO.includes(r.metric)) { r.threshold = 1; r.op = ">="; r.clear = null; }
    if (r.op === "==") r.clear = null;
  }
}
function drawRules() { $("#rules-body").innerHTML = rulesHtml(rulesState.rows); }

async function loadRules(force) {
  if (rulesState.dirty && !force) { drawRules(); return; }
  let d = null;
  try {
    const r = await fetch("/__ctl/alerts/rules?t=" + Date.now());
    d = r.ok ? await r.json() : null;
  } catch (e) { d = null; }
  if (!d || !Array.isArray(d.defaults)) { $("#rules-body").innerHTML = `<div class="muted">${esc(tr("rules.loadFailed"))}</div>`; return; }
  rulesState.defaults = d.defaults;
  rulesState.metrics = Array.isArray(d.metrics) ? d.metrics : [];
  rulesState.rows = rulesRows(d.saved, d.defaults);
  rulesState.dirty = false;
  drawRules();
}

async function saveRules() {
  readRules();
  try {
    const r = await fetch("/__ctl/alerts/rules", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(rulesFile(rulesState.rows, rulesState.defaults)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || String(r.status));
    rulesState.dirty = false;
    toast(tr("rules.saved"));
    await loadRules(true);
    loadAlerts();
  } catch (e) { toast(tr("rules.saveFailed", { error: e.message }), true); }
}

// a click on the editor's buttons: change the rows, then draw them again
function rulesAction(act, i, j) {
  readRules();
  const rows = rulesState.rows;
  if (act === "add") {
    const m = rulesState.metrics[0] || "disk.used";
    rows.push({ id: "c_" + Date.now().toString(36), own: true, name: tr("rules.newName"), metric: m, op: ">=", threshold: 90, for: 5,
                clear: null, severity: "warning", on: true, scope: "", sub: "", overrides: [] });
  }
  if (act === "remove") rows.splice(i, 1);
  if (act === "addov") rows[i].overrides.push({ who: rulesTargets()[0][0], threshold: rows[i].metric === "offline" ? null : rows[i].threshold, off: rows[i].metric === "offline" });
  if (act === "rmov") rows[i].overrides.splice(j, 1);
  if (act === "revert") { rulesState.dirty = false; loadRules(true); return; }
  rulesState.dirty = true;
  drawRules();
}

function showRulesTab(on) {
  $("#alerts-tab-list").classList.toggle("on", !on);
  $("#alerts-tab-rules").classList.toggle("on", on);
  $("#alerts-list").classList.toggle("hidden", on);
  $("#rules-body").classList.toggle("hidden", !on);
  if (on) loadRules();
}

// wiring, once, when this file has loaded
function initAlerts() {
  $("#alerts-tab-list").onclick = () => showRulesTab(false);
  $("#alerts-tab-rules").onclick = () => showRulesTab(true);
  $("#rules-body").onclick = e => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const row = b.closest(".rule"), ov = b.closest(".rov[data-o]");
    if (b.dataset.act === "save") { saveRules(); return; }
    rulesAction(b.dataset.act, row ? Number(row.dataset.i) : -1, ov ? Number(ov.dataset.o) : -1);
  };
  // a change that alters the form's shape (metric, operator, on, off) draws it again
  $("#rules-body").onchange = e => {
    rulesState.dirty = true;
    if (e.target.matches("[data-f=metric], [data-f=op], [data-f=on], [data-of=off]")) { readRules(); drawRules(); }
  };
  $("#alerts-body").onclick = e => {
    const b = e.target.closest("button[data-mute], button[data-unmute]");
```

In `www/index.html`:

1. Replace

```html
    <h3><span data-i18n="alerts.title">alerts</span> <span class="x" id="alerts-close" data-i18n="dlg.close">[esc]</span></h3>
    <div class="body">
      <div class="amutefor"><span data-i18n="alerts.muteFor">mute for</span>
        <select id="alerts-for" aria-label="mute for" data-i18n-aria-label="alerts.muteFor">
```

   with

```html
    <h3><span data-i18n="alerts.title">alerts</span> <span class="x" id="alerts-close" data-i18n="dlg.close">[esc]</span></h3>
    <div class="body">
      <div class="atabs"><button id="alerts-tab-list" class="on" data-i18n="alerts.tabList">alerts</button><button id="alerts-tab-rules" data-i18n="alerts.tabRules">rules</button></div>
      <div id="alerts-list">
      <div class="amutefor"><span data-i18n="alerts.muteFor">mute for</span>
        <select id="alerts-for" aria-label="mute for" data-i18n-aria-label="alerts.muteFor">
```

2. Replace

```html
        </select></div>
      <div id="alerts-body"><div class="muted" data-i18n="logs.loading">loading&hellip;</div></div>
    </div>
  </div>
```

   with

```html
        </select></div>
      <div id="alerts-body"><div class="muted" data-i18n="logs.loading">loading&hellip;</div></div>
      </div>
      <div id="rules-body" class="hidden"></div>
    </div>
  </div>
```

In `www/app.css`:

1. Replace

```css
  .arow .aacts:empty { display: none; }
}

```

   with

```css
  .arow .aacts:empty { display: none; }
}

/* the rule editor, the alerts view's second tab */
.atabs { display: flex; gap: 6px; margin-bottom: 14px; }
#alerts-overlay .atabs button, #rules-body button { background: var(--bg); border: var(--border-w, 1px) solid var(--border); color: var(--dim);
  font-family: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer; white-space: nowrap; }
#alerts-overlay .atabs button.on { color: var(--fg-bright); border-color: var(--blue); }
#rules-body button { color: var(--cyan); padding: 2px 8px; }
#rules-body button.primary { border-color: var(--cyan); }
#rules-body .hint { color: var(--dim); font-size: 11.5px; margin: 0 0 10px; }
.rule { border-bottom: 1px solid var(--border); padding: 6px 0; font-size: 12.5px; }
.rule.roff > .rline > :not([data-f=on]) { opacity: .5; }
.rline, .rov { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.rov { margin: 4px 0 0 24px; color: var(--dim); }
.rline .rname { min-width: 130px; color: var(--fg-bright); }
.rline label, .rov label { display: flex; align-items: center; gap: 4px; color: var(--dim); }
#alerts-overlay #rules-body select, #alerts-overlay #rules-body input[type=text], #alerts-overlay #rules-body input[type=number] { width: auto; }
#alerts-overlay #rules-body input.rnum { width: 72px; }
#alerts-overlay #rules-body input.rname, #alerts-overlay #rules-body input.rsub { width: 150px; }
.rline .unit, .rline .rop { color: var(--dim); }
.rbtns { display: flex; gap: 8px; margin-top: 12px; }
.rbtns .grow { flex: 1; }

```

In `hub/lib/i18n.js`:

1. Replace

```js
  "alerts.failed": "could not load the alerts",
  "alerts.openFailed": "the alerts did not load; reload the page",
  "alert.sev.critical": "critical", "alert.sev.warning": "warning", "alert.sev.info": "info",
  "alert.kind.firing": "fired", "alert.kind.resolved": "resolved", "alert.kind.repeat": "still firing",
```

   with

```js
  "alerts.failed": "could not load the alerts",
  "alerts.openFailed": "the alerts did not load; reload the page",
  "alerts.tabList": "alerts",
  "alerts.tabRules": "rules",
  "alert.metric.diskUsed": "disk used", "alert.metric.mem": "memory", "alert.metric.cpu": "cpu", "alert.metric.temp": "temperature",
  "alert.metric.containerDown": "container down", "alert.metric.failedUnits": "failed units",
  "alert.metric.rebootRequired": "reboot required", "alert.metric.securityUpdates": "security updates",
  "rules.intro": "Changes apply when saved. An override for one server wins over one for its tag; off turns the rule off there.",
  "rules.on": "on",
  "rules.name": "name",
  "rules.newName": "new rule",
  "rules.metric": "what",
  "rules.op": "condition",
  "rules.threshold": "threshold",
  "rules.for": "for",
  "rules.min": "min",
  "rules.clear": "clears at",
  "rules.severity": "severity",
  "rules.scope": "where",
  "rules.all": "all servers",
  "rules.server": "server {name}",
  "rules.tag": "tag {tag}",
  "rules.sub": "disk or container",
  "rules.subAll": "every disk or container",
  "rules.overrideFor": "for",
  "rules.overrideWho": "server or tag",
  "rules.off": "off",
  "rules.remove": "remove",
  "rules.addOverride": "+ override",
  "rules.add": "+ rule",
  "rules.revert": "undo changes",
  "rules.save": "save",
  "rules.saved": "rules saved",
  "rules.saveFailed": "not saved: {error}",
  "rules.loadFailed": "could not load the rules",
  "alert.sev.critical": "critical", "alert.sev.warning": "warning", "alert.sev.info": "info",
  "alert.kind.firing": "fired", "alert.kind.resolved": "resolved", "alert.kind.repeat": "still firing",
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Alerts on the page (spec 10.1): the header, the node tabs and the fleet
  cards carry a badge with each server's firing alerts, coloured by the
```

   with

```markdown

### Added
- Alert rules (spec 8.1): the alerts view's "rules" tab changes a default
  rule's threshold, time, clear value and severity, or turns it off; adds
  rules of one's own on any metric the defaults watch, for all servers, one
  server or a tag, and optionally one disk or container; and sets per-server
  or per-tag overrides (another threshold, or off; a server's own wins over
  its tag's). Turning "offline" off for a laptop or phone stops it paging.
  Rules are kept in the state directory's `alerts/rules.json`, checked on
  save, and applied at once; `GET` and `POST /__ctl/alerts/rules`.
- Alerts on the page (spec 10.1): the header, the node tabs and the fleet
  cards carry a badge with each server's firing alerts, coloured by the
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 405 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`; look at `build/screens/rules-1280.png` and `rules-390.png`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 5: Commit**

```bash
git add www hub/lib/i18n.js test CHANGELOG.md
git commit -m "feat(ui): a rule editor in the alerts view"
```
