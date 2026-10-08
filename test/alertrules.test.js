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
