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
const YESNO = ["reboot_required", "container.down"];   // true or false: an override only turns them off
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
    // an error names the rule as the page shows it: its name, or its id
    let at = `rule ${i + 1}`;
    if (!isObj(r) || typeof r.id !== "string") throw new Error(`${at}: needs an id`);
    at = typeof r.name === "string" && r.name.trim() && !DEFAULT_RULES.some((d) => d.id === r.id) ? r.name.trim().slice(0, 60) : r.id;
    if (seen.has(r.id)) throw new Error(`${at}: listed twice`);
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
      const metric = def ? def.metric : c.metric, whos = new Set();
      c.overrides = r.overrides.map((o, k) => {
        const oat = `${at}: override ${k + 1}`;
        if (!isObj(o) || (o.node === undefined) === (o.tag === undefined)) throw new Error(`${oat}: a server or a tag`);
        if (o.node !== undefined && !known(o.node)) throw new Error(`${oat}: no such server`);
        if (o.tag !== undefined && !(typeof o.tag === "string" && TAG.test(o.tag))) throw new Error(`${oat}: a tag is lowercase letters, digits, dot, dash, underscore`);
        const who = o.node !== undefined ? { node: o.node } : { tag: o.tag };
        const key = o.node !== undefined ? "server " + o.node : "tag " + o.tag;
        if (whos.has(key)) throw new Error(`${oat}: ${key} is listed twice`);
        whos.add(key);
        if (o.off === true) return { ...who, off: true };
        if (r.id === "offline") throw new Error(`${oat}: offline can only be turned off`);
        if (YESNO.includes(metric)) throw new Error(`${oat}: a true-or-false rule can only be turned off`);
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
