# servitals Alerts on the Page (sub-project 6b-2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The page shows the alerts the hub judges. Badges on the header, the node tabs and the fleet cards count each node's firing alerts, coloured by the worst severity. An alerts view (`[a]`) lists what is firing, the running mutes and the last events, and mutes or unmutes a rule or a server for 1 hour, 1 day or 7 days.

**Why:** since 6b-1 the hub fires, resolves and logs alerts, but only its log shows them. Until channels arrive (6c), the page is where a person sees them, and where they silence one they already know about.

**Architecture:**
- **`hub/lib/alerts.js`:**
  - `mute({rule | node, until})` with `until` now or earlier removes the mute (an unmute).
  - `mutes()` returns the mutes still running: `{rules: {id: until}, nodes: {id: until}}`.
  - `badges()` returns, per node, the firing alerts that were told (not muted, not held back by an offline node): `{id: {count, worst}}`.
- **`hub/server.js`:** `GET /__ctl/alerts` adds `mutes`; each node in `GET /__ctl/nodes` gets `alerts: {count, worst} | null`.
- **The page:**
  - `www/js/app.js`:
    - `alertBadge(a)` draws a badge; the tabs and fleet cards carry one per node;
    - `renderAlertCount()` adds them up in the header, next to a new `[a] alerts` key;
    - the node view now asks for the fleet at most every 30 s, so tab lamps and badges stay current;
    - `openAlerts()` loads `www/js/alerts.js` on first use (spec 10.5) and opens the dialog; `[a]` toggles it, esc closes it, and each refresh redraws it while open.
  - `www/js/alerts.js`: `alertsHtml(d, names)` draws the view; `loadAlerts()` fetches it (a late answer never draws over a newer one); `muteAlert(kind, id, until)` posts a mute, then redraws the view and the badges.
  - `www/index.html`: the `[a] alerts` key with its count, and the dialog with its "mute for" choice.
  - `www/app.css`: the badges and the rows; one column on a phone.
  - `hub/lib/i18n.js`: every new word; rule names as `alert.rule.<camelCase id>`.
  - `www/sw.js`: keeps `js/alerts.js` for the offline copy.

**Tech Stack:** Node.js ≥ 18 built-ins; plain browser JavaScript, no framework.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- 8.1: mutes per rule or node, until a time;
- 10.1: the alert badge on a fleet card, and the alerts view that lists firing and recent alerts;
- 10.2: high contrast puts text labels on alerts (the severity is a word in the view, and in the badge's title);
- 10.5: the alerts view loads on first use; no inline script or style.

**Scope:** 6b-2a. Out of scope: the rule editor, custom rules and per-node overrides (6b-2b); the phone's bottom bar (spec 10.1); channels (6c) and Web Push (6d).

**Proven before writing:** every code block was built and run in a scratch copy of `main` (8d76e2f) on 2026-10-08: node suite 386 tests; budget, screens, compose smoke, both packages and autopkgtest pass.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6b-1 still holds.
- The strict CSP: no inline script, no `style="…"` in markup or generated HTML.
- Every word on the page comes from `hub/lib/i18n.js` through `tr()` (test/i18n.test.js checks app.js, settings.js, history.js and now alerts.js).
- First page load stays at most 60 KB gzipped (test/budget.sh); `alerts.js` is not part of it.
- Work in a worktree `.claude/worktrees/servitals-alerts-ui` on branch `feat/alerts-ui` from `main` (8d76e2f).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Badges that lie:** a muted alert, an alert held back by an offline node, a node with no alerts, an unknown severity. Tests: "the page's view of the alerts…" (alerts.test.js), "alert badge…", "the header adds up…".
2. **Mute and unmute:** an unmute (until now), a mute that ran out, a double click, a hub that refuses. Tests: "the page's view of the alerts…", "alerts: the page gets the running mutes…" (agentapi), "alerts view: mute sends…".
3. **Hostile text:** a container or mount name, a node name or a rule id with markup. Test: "alerts view: firing worst first…" (escaping).
4. **Stale and racing answers:** a slow answer after a newer one, a failed load, the dialog open across refreshes. Tests: "alerts view: a late answer…", "the node view asks for the fleet…".
5. **Phone width and every style:** the dialog at 390 px and in each style. Check: `bash test/screens.sh` shoots `alerts-1280.png` and `alerts-390.png`.

---

### Task 1: The hub tells the page the running mutes, unmutes, and counts each node's alerts

**Files:**
- Modify: `hub/lib/alerts.js`, `hub/server.js`, `test/alerts.test.js`, `test/agentapi.test.js`

**Interfaces:**
- Consumes: `createAlerts` (6b-1).
- Produces:
  - `mutes()` → `{rules: {id: until}, nodes: {id: until}}`;
  - `badges()` → `{nodeId: {count, worst}}`;
  - `mute({rule | node, until})` with `until <= now` unmutes;
  - `GET /__ctl/alerts` → `{firing, recent, mutes}`;
  - `GET /__ctl/nodes` → each node has `alerts: {count, worst} | null`.

  Task 2's page reads these.

- [ ] **Step 1: Write the failing tests**

In `test/alerts.test.js`:

1. Replace

```js
  assert.ok(warned.includes("alerts.log_failed"));
});

```

   with

```js
  assert.ok(warned.includes("alerts.log_failed"));
});

test("the page's view of the alerts: running mutes, an unmute, and per node a count and the worst severity", () => {
  const { c, a } = setup();
  const M = { id: "nodebbbbbbbb", name: "pi", tags: [] };
  c.at(0);
  a.evaluate(N, view({ ubuntu: { rebootRequired: true, security: 3 }, disks: [{ mount: "/srv", pct: 96 }] }));
  c.at(5); a.evaluate(N, view({ ubuntu: { rebootRequired: true, security: 3 }, disks: [{ mount: "/srv", pct: 96 }] }));
  a.evaluate(M, view({ ubuntu: { rebootRequired: true } }));
  assert.deepStrictEqual(a.badges(), { [N.id]: { count: 4, worst: "critical" }, [M.id]: { count: 1, worst: "info" } });
  a.mute({ rule: "disk_critical", until: c.t + 60 * MIN });
  a.mute({ node: M.id, until: c.t + 30 * MIN });
  a.mute({ rule: "cpu", until: c.t - 1 });
  assert.deepStrictEqual(a.mutes(), { rules: { disk_critical: c.t + 60 * MIN }, nodes: { [M.id]: c.t + 30 * MIN } }, "only mutes still running");
  assert.deepStrictEqual(a.badges(), { [N.id]: { count: 3, worst: "warning" } }, "muted alerts are not counted");
  a.mute({ node: M.id, until: c.t });
  assert.deepStrictEqual(a.mutes().nodes, {}, "a mute until now is an unmute");
  assert.deepStrictEqual(a.badges()[M.id], { count: 1, worst: "info" });
  c.at(40);
  a.check([{ id: N.id, name: "nas", lastPush: c.t - 30 * MIN, interval: 60 }]);
  assert.deepStrictEqual(a.badges()[N.id], { count: 1, worst: "critical" }, "an offline node: only the offline alert counts");
});

```

In `test/agentapi.test.js`:

1. Replace

```js
  assert.match(src, /^const HUB_START = Date\.now\(\);/m);
});

```

   with

```js
  assert.match(src, /^const HUB_START = Date\.now\(\);/m);
});

test("alerts: the page gets the running mutes, can unmute, and sees each node's count on the fleet", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const get = async (p) => JSON.parse((await request(hub.port, { path: p, headers: { cookie } })).body);
    assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true, security: 2 } }) })).status, 200);
    const card = async () => (await get("/__ctl/nodes")).find((n) => n.id === c.id).alerts;
    assert.deepStrictEqual(await card(), { count: 2, worst: "info" });
    const until = Date.now() + 3600000;
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ node: c.id, until }))).status, 200);
    assert.deepStrictEqual((await get("/__ctl/alerts")).mutes, { rules: {}, nodes: { [c.id]: until } });
    assert.strictEqual(await card(), null, "nothing told: no badge");
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ node: c.id, until: Date.now() }))).status, 200);
    assert.deepStrictEqual((await get("/__ctl/alerts")).mutes, { rules: {}, nodes: {} }, "unmuted");
    assert.deepStrictEqual(await card(), { count: 2, worst: "info" });
  });
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/alerts.test.js test/agentapi.test.js`
Expected: FAIL, 2 tests: "the page's view of the alerts…" (`TypeError: a.badges is not a function`) and "alerts: the page gets the running mutes…" (`Expected values to be strictly deep-equal`).

- [ ] **Step 3: The engine and the routes**

In `hub/lib/alerts.js`:

1. Replace

```js
 * alert log, the last 1000).
 *   createAlerts(dir, { now, onEvent, warn }) → { evaluate(node, view), check(nodes),
 *     firing(), recent(n), mute({ rule | node, until }), forget(node), log(event) }
 */
const fs = require("fs");
```

   with

```js
 * alert log, the last 1000).
 *   createAlerts(dir, { now, onEvent, warn }) → { evaluate(node, view), check(nodes),
 *     firing(), recent(n), mute({ rule | node, until }), mutes(), badges(), forget(node), log(event) }
 */
const fs = require("fs");
```

2. Replace

```js
  rule("security_updates", "security_updates", 1, 0, "info"),
];
const OPS = { ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, "==": (a, b) => a === b };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
```

   with

```js
  rule("security_updates", "security_updates", 1, 0, "info"),
];
const SEVERITY = ["critical", "warning", "info"];
const OPS = { ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, "==": (a, b) => a === b };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
```

3. Replace

```js
    },
    recent(n = 50) { return events.slice(-n).reverse(); },
    mute({ rule: id, node, until }) {
      if (!id && !node) throw new Error("mute needs a rule or a node");
      if (id) st.mutes.rules[id] = until; else st.mutes.nodes[node] = until;
      save();
    },
    // a revoked node: its told alerts end told
```

   with

```js
    },
    recent(n = 50) { return events.slice(-n).reverse(); },
    // a mute until now or earlier is an unmute
    mute({ rule: id, node, until }) {
      if (!id && !node) throw new Error("mute needs a rule or a node");
      const m = id ? st.mutes.rules : st.mutes.nodes, k = id || node;
      if (until > now()) m[k] = until; else delete m[k];
      save();
    },
    // the mutes still running: { rules: { id: until }, nodes: { id: until } }
    mutes() {
      const t = now(), live = (o) => Object.fromEntries(Object.entries(o).filter(([, u]) => u > t));
      return { rules: live(st.mutes.rules), nodes: live(st.mutes.nodes) };
    },
    // per node, the firing alerts that are told (not muted, not held back by an offline
    // node): { id: { count, worst } }, for the page's badges
    badges() {
      const t = now(), out = {};
      for (const i of Object.values(st.instances)) {
        const r = rules.find((x) => x.id === i.rule);
        if (i.state !== "firing" || !r || quiet(i, r, t)) continue;
        const b = out[i.node] = out[i.node] || { count: 0, worst: r.severity };
        b.count++;
        if (SEVERITY.indexOf(r.severity) < SEVERITY.indexOf(b.worst)) b.worst = r.severity;
      }
      return out;
    },
    // a revoked node: its told alerts end told
```

In `hub/server.js`:

1. Replace

```js
    // alerts (spec 8): what is firing, and the last events
    if (req.method === "GET" && pathname === "/__ctl/alerts") {
      return json(200, { firing: alerts.firing(), recent: alerts.recent(50) });
    }
    // mute a rule or a node until a time (ms since 1970; at most a year ahead)
    if (req.method === "POST" && pathname === "/__ctl/alerts/mute") {
      let body = null;
```

   with

```js
    // alerts (spec 8): what is firing, and the last events
    if (req.method === "GET" && pathname === "/__ctl/alerts") {
      return json(200, { firing: alerts.firing(), recent: alerts.recent(50), mutes: alerts.mutes() });
    }
    // mute a rule or a node until a time (ms since 1970; at most a year ahead); now or earlier unmutes
    if (req.method === "POST" && pathname === "/__ctl/alerts/mute") {
      let body = null;
```

2. Replace

```js
    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
      const list = nodes.list().map(withFile).map((n) => {
        const rec = latest.get(n.id);
        return { ...n, status: nodeStatus(n.id), lastSeen: rec ? rec.at : null,
                 interval: rec ? rec.snap.interval : null, summary: rec ? fleet.summary(rec.view) : null };
      }).sort((a, b) => (b.local - a.local) || a.name.localeCompare(b.name));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
```

   with

```js
    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
      const badges = alerts.badges();
      const list = nodes.list().map(withFile).map((n) => {
        const rec = latest.get(n.id);
        return { ...n, status: nodeStatus(n.id), lastSeen: rec ? rec.at : null,
                 interval: rec ? rec.snap.interval : null, summary: rec ? fleet.summary(rec.view) : null,
                 alerts: badges[n.id] || null };
      }).sort((a, b) => (b.local - a.local) || a.name.localeCompare(b.name));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 377 tests (2 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/alerts.js hub/server.js test/alerts.test.js test/agentapi.test.js
git commit -m "feat(hub): the page's view of the alerts: running mutes, unmute, a count per node"
```

---

### Task 2: Badges and the alerts view on the page

**Files:**
- Create: `www/js/alerts.js`
- Modify: `www/js/app.js`, `www/index.html`, `www/app.css`, `www/sw.js`, `hub/lib/i18n.js`, `test/helpers/page.js`, `test/page.test.js`, `test/pwa.test.js`, `test/i18n.test.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `GET /__ctl/alerts`, `POST /__ctl/alerts/mute`, `alerts` on each node of `GET /__ctl/nodes` (Task 1).
- Produces (page globals): `alertBadge(a)`, `renderAlertCount()`, `renderFleetIfShown()`, `openAlerts()`, `closeAlerts()`, `loadAlertsIfOpen()`, `nodesAt` in app.js; `alertsHtml(d, names)`, `loadAlerts()`, `muteAlert(kind, id, until)`, `initAlerts()`, `ruleLabel(id)`, `alertValue(rule, v)` in alerts.js. 6b-2b's rule editor reuses `ruleLabel`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/page.js`:

1. Replace

```js
const BOOT = read("boot.js");
const I18N = fs.readFileSync(path.join(__dirname, "..", "..", "hub", "lib", "i18n.js"), "utf8");
const JS = I18N + "\n" + read("js/app.js") + "\n" + read("js/settings.js") + "\n" + read("js/history.js");
const PAGE = [MARKUP, CSS, BOOT, JS].join("\n");

```

   with

```js
const BOOT = read("boot.js");
const I18N = fs.readFileSync(path.join(__dirname, "..", "..", "hub", "lib", "i18n.js"), "utf8");
const JS = I18N + "\n" + read("js/app.js") + "\n" + read("js/settings.js") + "\n" + read("js/history.js") + "\n" + read("js/alerts.js");
const PAGE = [MARKUP, CSS, BOOT, JS].join("\n");

```

In `test/page.test.js`:

1. Replace

```js
  assert.strictEqual(bad.histState.range, "24h", "a stored range it does not know: 24h");
});

```

   with

```js
  assert.strictEqual(bad.histState.range, "24h", "a stored range it does not know: 24h");
});

// alerts (spec 8, 10.1): badges on the header, tabs and cards, and the alerts view
const escA = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
test("alert badge: a count coloured by the worst severity, words for a screen reader, nothing when none", () => {
  const alertBadge = pageFn("alertBadge", { esc: escA });
  assert.strictEqual(alertBadge(null), "");
  assert.strictEqual(alertBadge({ count: 0, worst: "critical" }), "");
  assert.strictEqual(alertBadge({ count: 3, worst: "critical" }), '<span class="abadge critical" title="3 alerts, worst critical">3</span>');
  assert.match(alertBadge({ count: 1, worst: "<odd>" }), /^<span class="abadge info" title="1 alerts, worst info">1<\/span>$/, "a severity the page does not know: info");
});

test("the header adds up every node's badge and takes the worst colour", () => {
  const el = { className: "", textContent: "" };
  const run = (fleetNodes) => { pageFn("renderAlertCount", { $: () => el, fleetNodes })(); return [el.className, el.textContent]; };
  assert.deepStrictEqual(run([{ alerts: { count: 2, worst: "info" } }, { alerts: { count: 1, worst: "warning" } }, { alerts: null }]),
    ["abadge warning", "3"]);
  assert.deepStrictEqual(run([{ alerts: null }, {}]), ["abadge info hidden", ""], "none: hidden");
});

test("the tabs and the fleet cards carry each node's alert badge", () => {
  assert.match(JS, /\$\{esc\(n\.name\)\}\$\{alertBadge\(n\.alerts\)\}<\/button>/);
  assert.match(JS, /\$\{esc\(n\.name\)\}\$\{alertBadge\(n\.alerts\)\}<\/div>/);
});

test("alerts view: firing worst first with mute buttons, running mutes with unmute, recent events with why they were quiet", () => {
  const { STRINGS } = require("../hub/lib/i18n");
  const env = { esc: escA, STRINGS, fmtShare: (v) => v + "%", fmtTemp: (v) => v + "°C", fmtDur: () => "5m",
    fmtTime: () => "12:00", Date };
  const scope = new Function(...Object.keys(env), "tr", `${fs.readFileSync(path.join(__dirname, "..", "www", "js", "alerts.js"), "utf8")};
    return { alertsHtml, ruleLabel, alertValue };`)(...Object.values(env), tr);
  assert.deepStrictEqual(["disk_full", "security_updates", "my_rule"].map(scope.ruleLabel), ["disk full", "security updates", "my_rule"]);
  assert.deepStrictEqual([["disk_full", 92], ["temperature", 86], ["failed_units", 2], ["reboot_required", 1], ["cpu", null]]
    .map(([r, v]) => scope.alertValue(r, v)), ["92%", "86°C", "2", "", ""]);
  const now = Date.now();
  const html = scope.alertsHtml({
    firing: [
      { rule: "reboot_required", severity: "info", node: "nodeaaaaaaaa", nodeName: "nas", value: 1, since: now, firedAt: now, muted: true },
      { rule: "disk_critical", severity: "critical", node: "nodeaaaaaaaa", nodeName: "nas", sub: "/srv<x>", value: 96, since: now, firedAt: now },
    ],
    mutes: { rules: { cpu: now + 3600000 }, nodes: { nodebbbbbbbb: now + 3600000 } },
    recent: [{ kind: "resolved", rule: "memory", severity: "warning", node: "nodeaaaaaaaa", nodeName: "nas", value: 80, at: now, quiet: "muted" },
             { kind: "firing", rule: "offline", severity: "critical", node: "nodebbbbbbbb", nodeName: "pi", at: now }],
  }, { nodebbbbbbbb: "pi" });
  const rows = html.split('<div class="arow');
  assert.match(rows[1], /critical<\/span><span class="awhat">disk critical <span class="asub">\/srv&#60;x&#62;<\/span> <b>96%<\/b>/, "critical first, escaped");
  assert.match(rows[1], /<button data-mute="rule" data-id="disk_critical">mute rule<\/button><button data-mute="node" data-id="nodeaaaaaaaa">mute server<\/button>/);
  assert.match(rows[2], /^ amuted">.*reboot required.*<i>muted<\/i>/, "a muted alert is listed and marked");
  assert.match(rows[3], /rule: cpu<\/span><span class="asince">until 12:00<\/span>.*data-unmute="rule" data-id="cpu">unmute/);
  assert.match(rows[4], /server: pi<\/span>.*data-unmute="node" data-id="nodebbbbbbbb"/);
  assert.match(rows[5], /resolved: memory <b>80%<\/b><\/span><span class="anode">nas<\/span><span class="asince">12:00<\/span><span class="aacts"><i>muted<\/i>/);
  assert.match(rows[6], /fired: offline <b><\/b>.*<span class="anode">pi<\/span>/);
  assert.doesNotMatch(html, /style=/, "the strict CSP: no style attributes");
  const empty = scope.alertsHtml({ firing: [], recent: [], mutes: { rules: {}, nodes: {} } }, {});
  assert.match(empty, /nothing is firing/);
  assert.match(empty, /no alerts yet/);
  assert.doesNotMatch(empty, /unmute/, "no mutes: no mute list");
});

// alerts.js run with stubbed DOM and fetch
function alertsHarness(fetchImpl) {
  const els = {}, toasts = [], calls = { loadNodes: 0, renderFleetIfShown: 0 };
  const el = (sel) => (els[sel] = els[sel] || { innerHTML: "", value: "86400000" });
  const env = { $: el, fetch: fetchImpl, esc: (x) => String(x), tr: (k) => k, STRINGS: {}, fmtShare: String, fmtTemp: String,
    fmtDur: String, fmtTime: () => "", fleetNodes: [], toast: (m, err) => toasts.push([m, !!err]),
    loadNodes: async () => { calls.loadNodes++; }, renderFleetIfShown: () => { calls.renderFleetIfShown++; } };
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "js", "alerts.js"), "utf8");
  const api = new Function(...Object.keys(env), `${src}; return { loadAlerts, muteAlert, initAlerts };`)(...Object.values(env));
  return { ...api, els, toasts, calls };
}

test("alerts view: a late answer never draws over a newer one; a failed load says so", async () => {
  const pending = [];
  const h = alertsHarness(() => { const l = later(); pending.push(l); return l.p; });
  const first = h.loadAlerts(), second = h.loadAlerts();
  pending[1].done(answer({ firing: [], recent: [], mutes: {} }));
  await second;
  pending[0].done(answer({ firing: [{ rule: "cpu", severity: "warning", node: "x", since: 0 }], recent: [], mutes: {} }));
  await first;
  assert.match(h.els["#alerts-body"].innerHTML, /alerts\.none/, "the newer answer stays");
  const bad = alertsHarness(async () => ({ ok: false, json: async () => ({}) }));
  await bad.loadAlerts();
  assert.match(bad.els["#alerts-body"].innerHTML, /alerts\.failed/);
});

test("alerts view: mute sends the rule or node and the chosen time, unmute sends now; the badges follow", async () => {
  const sent = [];
  const h = alertsHarness(async (url, opt) => {
    if (opt && opt.method === "POST") { sent.push([url, JSON.parse(opt.body)]); return { ok: true, json: async () => ({ ok: true }) }; }
    return answer({ firing: [], recent: [], mutes: {} });
  });
  const t = Date.now();
  await h.muteAlert("rule", "disk_full", t + 86400000);
  await h.muteAlert("node", "nodeaaaaaaaa", t);
  assert.deepStrictEqual(sent, [["/__ctl/alerts/mute", { rule: "disk_full", until: t + 86400000 }], ["/__ctl/alerts/mute", { node: "nodeaaaaaaaa", until: t }]]);
  assert.deepStrictEqual(h.toasts, [["alerts.muted", false], ["alerts.unmuted", false]]);
  assert.deepStrictEqual(h.calls, { loadNodes: 2, renderFleetIfShown: 2 });
  const no = alertsHarness(async (url, opt) => (opt ? { ok: false, status: 400 } : answer({})));
  await no.muteAlert("rule", "cpu", t + 1);
  assert.deepStrictEqual(no.toasts, [["alerts.muteFailed", true]]);
  // the buttons: a click mutes for the time chosen above the list
  h.initAlerts();
  const btn = { dataset: { mute: "node", id: "nodebbbbbbbb" }, disabled: false };
  h.els["#alerts-for"] = { value: "3600000" };
  h.els["#alerts-body"].onclick({ target: { closest: () => btn } });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(btn.disabled, true, "one click, one request");
  assert.strictEqual(sent[2][1].node, "nodebbbbbbbb");
  assert.ok(Math.abs(sent[2][1].until - (Date.now() + 3600000)) < 5000);
});

test("the alerts view is a dialog loaded on first use: [a], its button, esc; kept for the offline copy", () => {
  for (const id of ["alerts-overlay", "alerts-body", "alerts-for", "btn-alerts", "alerts-count", "alerts-close"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(JS, /s\.src = "js\/alerts\.js";/);
  assert.match(JS, /if \(e\.key === "a"\)/);
  assert.match(JS, /if \(e\.key === "Escape"\) \{ closeSettings\(\); closeAlerts\(\);/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "www", "sw.js"), "utf8"), /"\/js\/alerts\.js"/);
});

```

In `test/pwa.test.js`:

1. Replace

```js
    const s = pageScope(["hubStateOf", "hubText", "tick", "setStatus"], {
      $, fetch: fetchFn, navigator: { onLine }, view: "node", currentNode: null, lastData: null, cfg: {},
      renderMetrics() {}, loadNodes() {}, renderFleet() {}, fmtTime: () => "12:00", fmtDur: () => "1m",
    });
    await s.tick();
    return [s.state(), el["#lastupdate"].textContent];
```

   with

```js
    const s = pageScope(["hubStateOf", "hubText", "tick", "setStatus"], {
      $, fetch: fetchFn, navigator: { onLine }, view: "node", currentNode: null, lastData: null, cfg: {},
      renderMetrics() {}, loadNodes() {}, renderFleet() {}, fmtTime: () => "12:00", fmtDur: () => "1m",
      nodesAt: Date.now(), loadAlertsIfOpen() {},
    });
    await s.tick();
    return [s.state(), el["#lastupdate"].textContent];
```

2. Replace

```js
  assert.match(t4, /^agent unreachable/);
});

```

   with

```js
  assert.match(t4, /^agent unreachable/);
});

test("the node view asks for the fleet (lamps, badges) at most every 30 s, and refreshes an open alerts view", async () => {
  const run = async (nodesAt) => {
    const calls = [];
    const $ = () => ({ textContent: "", classList: { add() {}, remove() {} } });
    const s = pageScope(["hubStateOf", "hubText", "tick", "setStatus"], {
      $, fetch: async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ts: Date.now() }) }),
      navigator: { onLine: true }, view: "node", currentNode: null, lastData: null, cfg: {}, showHistory() {},
      renderMetrics() {}, loadNodes() { calls.push("nodes"); }, renderFleet() {}, fmtTime: () => "12:00", fmtDur: () => "1m",
      nodesAt, loadAlertsIfOpen() { calls.push("alerts"); },
    });
    await s.tick();
    return calls;
  };
  assert.deepStrictEqual(await run(Date.now() - 31000), ["nodes", "alerts"]);
  assert.deepStrictEqual(await run(Date.now() - 5000), ["alerts"]);
});

```

In `test/i18n.test.js`:

1. Replace

```js
});

test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"), read("js/history.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
```

   with

```js
});

test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"), read("js/history.js"), read("js/alerts.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
```

2. Replace

```js
  assert.deepStrictEqual(wordsOutsideTr(read("js/history.js")), []);
});

```

   with

```js
  assert.deepStrictEqual(wordsOutsideTr(read("js/history.js")), []);
});

test("alerts.js puts no words on the page except through tr()", () => {
  assert.deepStrictEqual(wordsOutsideTr(read("js/alerts.js")), []);
});

```

In `test/screens/shoot.js`:

1. Replace

```js
  await page.locator("#cfg-style").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/settings.png` });

  // the settings panel on a desktop and a phone: styled controls, none squeezed or sticking out
```

   with

```js
  await page.locator("#cfg-style").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/settings.png` });

  // the alerts view on a desktop and a phone (the nas waits for a reboot and has security updates)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/?shot=alerts-${width}#fleet`);
    await page.waitForTimeout(1200);
    await page.keyboard.press("a");
    await page.waitForSelector("#alerts-body .arow");
    await page.screenshot({ path: `${out}/alerts-${width}.png` });
  }

  // the settings panel on a desktop and a phone: styled controls, none squeezed or sticking out
```

Then create an empty `www/js/alerts.js`, so the page helper can read it: `: > www/js/alerts.js`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js test/pwa.test.js test/i18n.test.js`
Expected: FAIL, 8 tests:
- "alert badge: a count coloured by the worst severity…", "the header adds up every node's badge…", "the tabs and the fleet cards carry each node's alert badge";
- "alerts view: firing worst first…", "alerts view: a late answer never draws over a newer one…", "alerts view: mute sends the rule or node…";
- "the alerts view is a dialog loaded on first use…";
- "the node view asks for the fleet (lamps, badges) at most every 30 s…".

- [ ] **Step 3: The alerts view**

Create `www/js/alerts.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* the alerts view (spec 8, 10.1): what is firing, the mutes still running and the last
   events, from GET /__ctl/alerts; a rule or a node is muted (and unmuted) with POST
   /__ctl/alerts/mute. Loaded by openAlerts() in app.js on first use. */
const ALERT_SEV = ["critical", "warning", "info"];
let alertsSeq = 0;

// a rule in words: the default rules from the dictionary (disk_full is alert.rule.diskFull),
// any other by its id
function ruleLabel(id) {
  const k = String(id).replace(/_([a-z])/g, (m, c) => c.toUpperCase());
  return STRINGS["alert.rule." + k] ? tr("alert.rule." + k) : id;
}
// an alert's value in its unit; rules that are only true or false show none
function alertValue(rule, v) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  if (/^disk_|^memory$|^cpu$/.test(rule)) return fmtShare(v);
  if (rule === "temperature") return fmtTemp(v, true);
  if (rule === "failed_units" || rule === "security_updates") return String(v);
  return "";
}
// a time: the clock today, the date and the clock before
function alertWhen(t) {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? fmtTime(d) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + fmtTime(d);
}
const sevTag = sev => `<span class="asev ${esc(sev)}">${esc(tr("alert.sev." + (ALERT_SEV.includes(sev) ? sev : "info")))}</span>`;
const alertWhat = a => esc(ruleLabel(a.rule)) + (a.sub ? ` <span class="asub">${esc(a.sub)}</span>` : "");

// the whole view from one answer of GET /__ctl/alerts
function alertsHtml(d, names) {
  const firing = (Array.isArray(d.firing) ? d.firing : []).slice()
    .sort((a, b) => (ALERT_SEV.indexOf(a.severity) - ALERT_SEV.indexOf(b.severity)) || (b.firedAt || 0) - (a.firedAt || 0));
  const now = Date.now();
  let h = `<section><label>${esc(tr("alerts.firing"))}</label>`;
  h += firing.length ? firing.map(a => `<div class="arow${a.muted ? " amuted" : ""}">${sevTag(a.severity)}`
    + `<span class="awhat">${alertWhat(a)} <b>${esc(alertValue(a.rule, a.value))}</b></span>`
    + `<span class="anode">${esc(a.nodeName || a.node)}</span>`
    + `<span class="asince">${esc(tr("alerts.for", { time: fmtDur((now - (a.since || now)) / 1000) }))}</span>`
    + `<span class="aacts">${a.muted ? `<i>${esc(tr("alerts.mutedTag"))}</i>` : ""}`
    + `<button data-mute="rule" data-id="${esc(a.rule)}">${esc(tr("alerts.muteRule"))}</button>`
    + `<button data-mute="node" data-id="${esc(a.node)}">${esc(tr("alerts.muteNode"))}</button></span></div>`).join("")
    : `<div class="muted">${esc(tr("alerts.none"))}</div>`;
  h += "</section>";
  const m = d.mutes || {};
  const mutes = [...Object.entries(m.rules || {}).map(([id, until]) => ["rule", id, ruleLabel(id), until]),
                 ...Object.entries(m.nodes || {}).map(([id, until]) => ["node", id, names[id] || id, until])];
  if (mutes.length) {
    h += `<section><label>${esc(tr("alerts.mutes"))}</label>` + mutes.map(([kind, id, label, until]) => `<div class="arow">`
      + `<span class="awhat">${esc(tr("alerts.mute." + kind, { name: label }))}</span>`
      + `<span class="asince">${esc(tr("alerts.until", { time: alertWhen(until) }))}</span>`
      + `<span class="aacts"><button data-unmute="${esc(kind)}" data-id="${esc(id)}">${esc(tr("alerts.unmute"))}</button></span></div>`).join("")
      + "</section>";
  }
  const recent = Array.isArray(d.recent) ? d.recent : [];
  h += `<section><label>${esc(tr("alerts.recent"))}</label>`;
  h += recent.length ? recent.map(e => `<div class="arow">${sevTag(e.severity)}`
    + `<span class="awhat">${esc(tr("alert.kind." + (e.kind === "resolved" || e.kind === "repeat" ? e.kind : "firing")))}: ${alertWhat(e)} `
    + `<b>${esc(alertValue(e.rule, e.value))}</b></span>`
    + `<span class="anode">${esc(e.nodeName || e.node)}</span>`
    + `<span class="asince">${esc(alertWhen(e.at))}</span>`
    + `<span class="aacts">${e.quiet ? `<i>${esc(tr("alert.quiet." + (["muted", "offline"].includes(e.quiet) ? e.quiet : "untold")))}</i>` : ""}</span></div>`).join("")
    : `<div class="muted">${esc(tr("alerts.noneYet"))}</div>`;
  return h + "</section>";
}

// fetch and draw; a late answer never draws over a newer one
async function loadAlerts() {
  const seq = ++alertsSeq;
  let d = null;
  try {
    const r = await fetch("/__ctl/alerts?t=" + Date.now());
    d = r.ok ? await r.json() : null;
  } catch (e) { d = null; }
  if (seq !== alertsSeq) return;
  if (!d) { $("#alerts-body").innerHTML = `<div class="muted">${esc(tr("alerts.failed"))}</div>`; return; }
  const names = Object.fromEntries(fleetNodes.map(n => [n.id, n.name]));
  $("#alerts-body").innerHTML = alertsHtml(d, names);
}

// mute (for the chosen time) or unmute a rule or a node, then show the new state
async function muteAlert(kind, id, until) {
  try {
    const r = await fetch("/__ctl/alerts/mute", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ [kind]: id, until }) });
    if (!r.ok) throw new Error(String(r.status));
    toast(until > Date.now() ? tr("alerts.muted") : tr("alerts.unmuted"));
  } catch (e) { toast(tr("alerts.muteFailed"), true); }
  await loadAlerts();
  await loadNodes();
  renderFleetIfShown();
}

// wiring, once, when this file has loaded
function initAlerts() {
  $("#alerts-body").onclick = e => {
    const b = e.target.closest("button[data-mute], button[data-unmute]");
    if (!b) return;
    b.disabled = true;
    if (b.dataset.mute) muteAlert(b.dataset.mute, b.dataset.id, Date.now() + Number($("#alerts-for").value));
    else muteAlert(b.dataset.unmute, b.dataset.id, Date.now());
  };
}
```

- [ ] **Step 4: Badges, the dialog and its loader, the words**

In `www/js/app.js`:

1. Replace

```js
    : tr("status.hubDown") + (navigator.onLine === false ? " " + tr("status.deviceOffline") : "");
}
async function loadNodes() {
  try {
    const r = await fetch("/__ctl/nodes?t=" + Date.now());
```

   with

```js
    : tr("status.hubDown") + (navigator.onLine === false ? " " + tr("status.deviceOffline") : "");
}
let nodesAt = 0;
async function loadNodes() {
  nodesAt = Date.now();
  try {
    const r = await fetch("/__ctl/nodes?t=" + Date.now());
```

2. Replace

```js
  localNode = local ? local.id : null;
  renderTabs();
}

function route() {
```

   with

```js
  localNode = local ? local.id : null;
  renderTabs();
  renderAlertCount();
}

/* alert badges (spec 10.1): per node the firing alerts that were told, their worst
   severity as the colour; the header adds them up */
function alertBadge(a) {
  if (!a || !(a.count > 0)) return "";
  const sev = ["critical", "warning", "info"].includes(a.worst) ? a.worst : "info";
  return `<span class="abadge ${sev}" title="${esc(tr("alerts.badge", { n: a.count, severity: tr("alert.sev." + sev) }))}">${a.count}</span>`;
}
function renderAlertCount() {
  const all = fleetNodes.map(n => n.alerts).filter(a => a && a.count > 0);
  const sev = ["critical", "warning", "info"].find(s => all.some(a => a.worst === s));
  const n = all.reduce((t, a) => t + a.count, 0);
  const el = $("#alerts-count");
  el.className = "abadge " + (sev || "info") + (n ? "" : " hidden");
  el.textContent = n ? String(n) : "";
}
function renderFleetIfShown() { if (view === "fleet") renderFleet(); }

function route() {
```

3. Replace

```js
  tabs.innerHTML = `<button data-go="fleet" class="${shown === "fleet" ? "on" : ""}">${esc(tr("tabs.fleet"))}</button>`
    + fleetNodes.map(n => `<button data-go="${esc(n.id)}" class="${shown === n.id ? "on" : ""}">`
      + `<span class="lamp ${esc(n.status)}"></span>${esc(n.name)}</button>`).join("");
}

```

   with

```js
  tabs.innerHTML = `<button data-go="fleet" class="${shown === "fleet" ? "on" : ""}">${esc(tr("tabs.fleet"))}</button>`
    + fleetNodes.map(n => `<button data-go="${esc(n.id)}" class="${shown === n.id ? "on" : ""}">`
      + `<span class="lamp ${esc(n.status)}"></span>${esc(n.name)}${alertBadge(n.alerts)}</button>`).join("");
}

```

4. Replace

```js
  const cont = s.containers ? esc(tr("svc.up", { running: s.running, total: s.containers })) : "";
  return `<div class="panel ncard ${esc(n.status)}" data-node="${esc(n.id)}">`
    + `<div class="nhead" data-state="${esc(tr("fleet.state." + n.status))}"><span class="lamp ${esc(n.status)}"></span>${esc(n.name)}</div>`
    + `<div class="kv">${cardNumbers().map(k => `<span><small>${esc(tr("card." + k))}</small>${cardValue(k, s)}</span>`).join("")}</div>`
    + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
```

   with

```js
  const cont = s.containers ? esc(tr("svc.up", { running: s.running, total: s.containers })) : "";
  return `<div class="panel ncard ${esc(n.status)}" data-node="${esc(n.id)}">`
    + `<div class="nhead" data-state="${esc(tr("fleet.state." + n.status))}"><span class="lamp ${esc(n.status)}"></span>${esc(n.name)}${alertBadge(n.alerts)}</div>`
    + `<div class="kv">${cardNumbers().map(k => `<span><small>${esc(tr("card." + k))}</small>${cardValue(k, s)}</span>`).join("")}</div>`
    + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
```

5. Replace

```js

async function tick() {
  if (view === "fleet") { await loadNodes(); renderFleet(); return; }
  try {
    let r;
```

   with

```js

async function tick() {
  if (view === "fleet") { await loadNodes(); renderFleet(); loadAlertsIfOpen(); return; }
  // the tabs' lamps and badges and the header's alert count: at most every 30 s here
  if (Date.now() - nodesAt > 30000) await loadNodes();
  loadAlertsIfOpen();
  try {
    let r;
```

6. Replace

```js
}

let settingsReady = null;
function openSettings() {
```

   with

```js
}

/* ------------------------------------------------------------------ alerts, loaded on first use (spec 10.5) */
let alertsReady = null;
function openAlerts() {
  alertsReady = alertsReady || new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "js/alerts.js";
    s.onload = () => (typeof initAlerts === "function" ? (initAlerts(), ok()) : fail(new Error("alerts.js")));
    s.onerror = () => { alertsReady = null; fail(new Error("alerts.js")); };
    document.head.appendChild(s);
  });
  $("#alerts-overlay").classList.add("open");
  return alertsReady.then(() => loadAlerts(), () => toast(tr("alerts.openFailed"), true));
}
function closeAlerts() { $("#alerts-overlay").classList.remove("open"); }
function loadAlertsIfOpen() {
  if ($("#alerts-overlay").classList.contains("open") && typeof loadAlerts === "function") loadAlerts();
}

let settingsReady = null;
function openSettings() {
```

7. Replace

```js

  $("#btn-settings").onclick = openSettings;
  $("#settings-close").onclick = closeSettings;
  $("#btn-theme").onclick = toggleTheme;
```

   with

```js

  $("#btn-settings").onclick = openSettings;
  $("#btn-alerts").onclick = openAlerts;
  $("#alerts-close").onclick = closeAlerts;
  $("#settings-close").onclick = closeSettings;
  $("#btn-theme").onclick = toggleTheme;
```

8. Replace

```js
    if (e.key === "r") { e.preventDefault(); refreshNow(); }
    if (e.key === "f" && fleetNodes.length > 1) location.hash = "#fleet";
    if (e.key === "Escape") { closeSettings(); $("#logs-overlay").classList.remove("open"); }
  });
})();
```

   with

```js
    if (e.key === "r") { e.preventDefault(); refreshNow(); }
    if (e.key === "f" && fleetNodes.length > 1) location.hash = "#fleet";
    if (e.key === "a") { e.preventDefault(); $("#alerts-overlay").classList.contains("open") ? closeAlerts() : openAlerts(); }
    if (e.key === "Escape") { closeSettings(); closeAlerts(); $("#logs-overlay").classList.remove("open"); }
  });
})();
```

In `www/index.html`:

1. Replace

```html
      <div class="hclock" id="headclock">--:--:--</div>
      <div class="hdate" id="headdate">&mdash;</div>
      <div class="keyhint"><b id="btn-refresh" data-i18n="key.refresh">[r] refresh</b> &nbsp; <b id="btn-settings" data-i18n="key.settings">[s] settings</b> &nbsp; <b id="btn-theme" data-i18n="key.theme">[t] theme</b> &nbsp; <b id="btn-style" data-i18n="key.style">[y] style</b> &nbsp; <form method="post" action="/__auth/logout" class="logout-form"><button type="submit" class="linkbtn" data-i18n="key.logout">[logout]</button></form></div>
    </div>
  </div>
```

   with

```html
      <div class="hclock" id="headclock">--:--:--</div>
      <div class="hdate" id="headdate">&mdash;</div>
      <div class="keyhint"><b id="btn-refresh" data-i18n="key.refresh">[r] refresh</b> &nbsp; <b id="btn-settings" data-i18n="key.settings">[s] settings</b> &nbsp; <b id="btn-alerts"><span data-i18n="key.alerts">[a] alerts</span> <span id="alerts-count" class="abadge hidden"></span></b> &nbsp; <b id="btn-theme" data-i18n="key.theme">[t] theme</b> &nbsp; <b id="btn-style" data-i18n="key.style">[y] style</b> &nbsp; <form method="post" action="/__auth/logout" class="logout-form"><button type="submit" class="linkbtn" data-i18n="key.logout">[logout]</button></form></div>
    </div>
  </div>
```

2. Replace

```html
</div>

<!-- confirm -->
<div class="overlay mid" id="confirm-overlay">
```

   with

```html
</div>

<!-- alerts -->
<div class="overlay" id="alerts-overlay">
  <div class="modal m860">
    <h3><span data-i18n="alerts.title">alerts</span> <span class="x" id="alerts-close" data-i18n="dlg.close">[esc]</span></h3>
    <div class="body">
      <div class="amutefor"><span data-i18n="alerts.muteFor">mute for</span>
        <select id="alerts-for" aria-label="mute for" data-i18n-aria-label="alerts.muteFor">
          <option value="3600000" data-i18n="alerts.for1h">1 hour</option>
          <option value="86400000" selected data-i18n="alerts.for1d">1 day</option>
          <option value="604800000" data-i18n="alerts.for7d">7 days</option>
        </select></div>
      <div id="alerts-body"><div class="muted" data-i18n="logs.loading">loading&hellip;</div></div>
    </div>
  </div>
</div>

<!-- confirm -->
<div class="overlay mid" id="confirm-overlay">
```

In `www/app.css`:

1. Replace

```css
  .cursor { animation: none !important; opacity: 1; }
}

```

   with

```css
  .cursor { animation: none !important; opacity: 1; }
}

/* alerts: badges on the header, tabs and cards; the alerts view */
.abadge { display: inline-block; min-width: 16px; padding: 0 5px; margin-left: 6px; border-radius: 8px;
  font-size: 10px; line-height: 15px; text-align: center; font-weight: 600; color: var(--bg); background: var(--blue); }
.abadge.warning { background: var(--amber); }
.abadge.critical { background: var(--red); }
.amutefor { display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 12px; margin-bottom: 14px; }
#alerts-overlay .modal select { width: auto; }
#alerts-overlay section > label { display: block; color: var(--dim); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 6px; }
.arow { display: grid; grid-template-columns: 70px minmax(0, 1fr) minmax(0, 140px) 120px 200px; gap: 4px 10px; align-items: center;
  padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.arow.amuted { opacity: .6; }
.arow .awhat { color: var(--fg-bright); overflow-wrap: anywhere; }
.arow .asub, .arow .anode, .arow .asince { color: var(--dim); }
.arow .aacts { display: flex; gap: 6px; justify-content: flex-end; align-items: center; color: var(--dim); }
.arow .aacts button { background: var(--bg); border: var(--border-w, 1px) solid var(--border); color: var(--cyan);
  font-family: inherit; font-size: 11.5px; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
.arow .aacts button:hover { border-color: var(--cyan); }
.asev { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--blue); }
.asev.warning { color: var(--amber); }
.asev.critical { color: var(--red); }
@media (max-width: 640px) {
  /* a phone: the severity and what on one line, the server and the time under what, then the buttons */
  .arow { display: flex; flex-wrap: wrap; column-gap: 10px; }
  .arow .asev { flex: 0 0 60px; }
  .arow .awhat { flex: 1 1 calc(100% - 70px); }
  .arow .anode { margin-left: 70px; }
  .arow .aacts { flex: 1 1 100%; justify-content: flex-start; }
  .arow .aacts:empty { display: none; }
}

```

In `www/sw.js`:

1. Replace

```js
const VERSION = "0.1.0";   // keep equal to the VERSION file (test/pwa.test.js checks)
const CACHE = "servitals-" + VERSION;
const SHELL = ["/", "/app.css", "/boot.js", "/js/i18n.js", "/js/app.js", "/js/settings.js", "/js/history.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// "shell": network first, the cache when offline; "network": as if there were no worker
```

   with

```js
const VERSION = "0.1.0";   // keep equal to the VERSION file (test/pwa.test.js checks)
const CACHE = "servitals-" + VERSION;
const SHELL = ["/", "/app.css", "/boot.js", "/js/i18n.js", "/js/app.js", "/js/settings.js", "/js/history.js", "/js/alerts.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// "shell": network first, the cache when offline; "network": as if there were no worker
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "hist.ctr24": "containers keep 24 hours",
  "hist.summary": "avg {avg} · low {lo} · high {hi}",

  // dialogs
```

   with

```js
  "hist.ctr24": "containers keep 24 hours",
  "hist.summary": "avg {avg} · low {lo} · high {hi}",

  // alerts: the view, its words, the default rules
  "key.alerts": "[a] alerts",
  "alerts.title": "alerts",
  "alerts.badge": "{n} alerts, worst {severity}",
  "alerts.firing": "firing",
  "alerts.none": "nothing is firing",
  "alerts.recent": "recent",
  "alerts.noneYet": "no alerts yet",
  "alerts.mutes": "muted",
  "alerts.mute.rule": "rule: {name}",
  "alerts.mute.node": "server: {name}",
  "alerts.until": "until {time}",
  "alerts.for": "for {time}",
  "alerts.mutedTag": "muted",
  "alerts.muteRule": "mute rule",
  "alerts.muteNode": "mute server",
  "alerts.unmute": "unmute",
  "alerts.muteFor": "mute for",
  "alerts.for1h": "1 hour", "alerts.for1d": "1 day", "alerts.for7d": "7 days",
  "alerts.muted": "muted",
  "alerts.unmuted": "unmuted",
  "alerts.muteFailed": "could not change the mute",
  "alerts.failed": "could not load the alerts",
  "alerts.openFailed": "the alerts did not load; reload the page",
  "alert.sev.critical": "critical", "alert.sev.warning": "warning", "alert.sev.info": "info",
  "alert.kind.firing": "fired", "alert.kind.resolved": "resolved", "alert.kind.repeat": "still firing",
  "alert.quiet.muted": "muted", "alert.quiet.offline": "server offline", "alert.quiet.untold": "not told",
  "alert.rule.offline": "offline", "alert.rule.diskFull": "disk full", "alert.rule.diskCritical": "disk critical",
  "alert.rule.memory": "memory", "alert.rule.cpu": "cpu", "alert.rule.temperature": "temperature",
  "alert.rule.containerDown": "container down", "alert.rule.failedUnits": "failed units",
  "alert.rule.rebootRequired": "reboot required", "alert.rule.securityUpdates": "security updates",

  // dialogs
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Alerts (spec 8.1, 8.2): the hub judges the default rules on each push and
  once a minute: node offline, disk full and critical, memory, cpu,
```

   with

```markdown

### Added
- Alerts on the page (spec 10.1): the header, the node tabs and the fleet
  cards carry a badge with each server's firing alerts, coloured by the
  worst. `[a]` opens the alerts view: what is firing, the mutes still
  running and the last 50 events, with why an event stayed quiet. A rule or
  a server is muted from there for an hour, a day or a week, and unmuted.
  The node view now refreshes the tabs' lamps every 30 seconds.
- Alerts (spec 8.1, 8.2): the hub judges the default rules on each push and
  once a minute: node offline, disk full and critical, memory, cpu,
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 386 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`; look at `build/screens/alerts-1280.png` and `alerts-390.png`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 6: Commit**

```bash
git add www hub/lib/i18n.js test CHANGELOG.md
git commit -m "feat(ui): alert badges on the header, tabs and cards; an alerts view that mutes and unmutes"
```
