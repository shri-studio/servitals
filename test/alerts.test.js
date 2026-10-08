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

test("a group the push lacks leaves its alerts alone: a crashed docker daemon or a dropped group is not a recovery", () => {
  const { c, a, events } = setup();
  const ctr = (state) => view({ docker: [{ name: "web", state, health: null }] });
  c.at(0); a.evaluate(N, ctr("running"));
  c.at(1); a.evaluate(N, ctr("exited")); c.at(4); a.evaluate(N, ctr("exited"));
  assert.deepStrictEqual(kinds(events), ["firing:container_down:web"]);
  c.at(5); a.evaluate(N, view({ docker: [] }));          // the daemon is restarting: the agent sends []
  c.at(6); a.evaluate(N, view({}));                      // or no docker group at all
  c.at(7); a.evaluate(N, ctr("exited"));
  assert.deepStrictEqual(kinds(events), ["firing:container_down:web"], "still the one incident");
  c.at(8); a.evaluate(N, view({ docker: [{ name: "db", state: "running" }] }));   // web removed from a real list
  assert.deepStrictEqual(kinds(events).slice(1), ["resolved:container_down:web"]);

  const d = setup();
  const disk = (disks) => view({ disks, temp: { package: 90 } });
  d.c.at(0); d.a.evaluate(N, disk([{ mount: "/srv", pct: 96 }]));
  d.c.at(5); d.a.evaluate(N, disk([{ mount: "/srv", pct: 96 }]));
  assert.deepStrictEqual(kinds(d.events).sort(), ["firing:disk_critical:/srv", "firing:disk_full:/srv", "firing:temperature"]);
  d.c.at(6); d.a.evaluate(N, view({ temp: { package: null } }));   // no disks group, a failed sensor read
  d.c.at(7); d.a.evaluate(N, disk([{ mount: "/srv", pct: 96 }]));
  assert.strictEqual(d.events.length, 3, "nothing resolved, nothing fired again");
  d.c.at(8); d.a.evaluate(N, disk([{ mount: "/srv", mounted: false }]));
  assert.deepStrictEqual(kinds(d.events).slice(3).sort(), ["resolved:disk_critical:/srv", "resolved:disk_full:/srv"], "unmounted: an explicit end");
});

test("an alert that was told ends told, also while muted, and when its node is revoked", () => {
  const { c, a, events } = setup();
  c.at(0); a.evaluate(N, view({ ubuntu: { rebootRequired: true, security: 2 } }));
  a.mute({ rule: "reboot_required", until: c.t + 60 * MIN });
  c.at(5); a.evaluate(N, view({ ubuntu: { rebootRequired: false, security: 2 } }));
  assert.deepStrictEqual(kinds(events), ["firing:reboot_required", "firing:security_updates", "resolved:reboot_required"]);
  a.forget(N.id);
  assert.deepStrictEqual(kinds(events).at(-1), "resolved:security_updates");
  const quietOne = setup();
  quietOne.a.mute({ node: N.id, until: quietOne.c.t + 60 * MIN });
  quietOne.c.at(0); quietOne.a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  quietOne.c.at(1); quietOne.a.evaluate(N, view({ ubuntu: { rebootRequired: false } }));
  assert.deepStrictEqual(quietOne.events, [], "never told: its end is not told either");
  assert.deepStrictEqual(quietOne.a.recent(5).map((e) => [e.kind, e.quiet]), [["resolved", "muted"], ["firing", "muted"]], "but both are in the log");
});

test("the alert log survives a torn line and a failed append; state is written only when it changed", () => {
  const { c, a, dir } = setup();
  c.at(0); a.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  fs.appendFileSync(path.join(dir, "events.jsonl"), '{"kind":"fir');   // a crash in the middle of a line
  const again = createAlerts(dir, { now: c.now });
  assert.deepStrictEqual(again.recent(5).map((e) => e.kind), ["firing"]);
  const writes = [];
  const orig = fs.writeFileSync;
  fs.writeFileSync = (f, ...r) => { writes.push(String(f)); return orig.call(fs, f, ...r); };
  try {
    c.at(1); again.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
    c.at(2); again.evaluate(N, view({ ubuntu: { rebootRequired: true } }));
  } finally { fs.writeFileSync = orig; }
  assert.deepStrictEqual(writes.filter((f) => f.includes("state.json")), [], "nothing changed: nothing written");
  fs.rmSync(path.join(dir, "events.jsonl")); fs.mkdirSync(path.join(dir, "events.jsonl"));   // appends now fail
  const warned = [];
  const b = createAlerts(dir, { now: c.now, warn: (e) => warned.push(e) });
  c.at(3); assert.doesNotThrow(() => b.evaluate(N, view({ ubuntu: { rebootRequired: false, security: 1 } })));
  assert.deepStrictEqual(b.firing().map((f) => f.rule), ["security_updates"], "judged and kept all the same");
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
