// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The alert engine (spec 8.1, 8.2). Each rule is judged per node, and per disk or
 * container where it has those ("instances"): on each push for the rules on what the
 * node sends, and once a minute (check) for a node that stopped pushing.
 *   ok -> pending (the condition holds) -> firing (it held for the rule's time)
 *      -> resolved (it stopped holding; past the clear value when the rule has one)
 * A firing alert is told once (onEvent), then once a day while it lasts; its end is
 * always told if its start was, mute or not. A muted rule or node changes state
 * silently and is told when the mute ends, if still firing. A push that lacks a group
 * (a dropped group, a crashed docker daemon) leaves that group's alerts as they are. An offline node's other alerts are held back.
 * State and mutes live in <dir>/state.json, every event in <dir>/events.jsonl (the
 * alert log, the last 1000).
 *   createAlerts(dir, { now, onEvent, warn, rules }) → { evaluate(node, view), check(nodes), setRules(rules), ruleIds(),
 *     firing(), recent(n), mute({ rule | node, until }), mutes(), badges(), forget(node), log(event) }
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
const SEVERITY = ["critical", "warning", "info"];
const OPS = { ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, "==": (a, b) => a === b };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// a metric's values in a node's view: [{ sub, value }], or null when the push lacks the
// group (a crashed docker daemon sends [], a dropped group or a failed sensor read sends
// nothing): then the rule's alerts stay as they are. Only a real list ends one: a disk
// gone from it or unmounted, a container gone from a list that has containers.
function valuesOf(metric, v, running) {
  switch (metric) {
    case "disk.used": return Array.isArray(v.disks)
      ? v.disks.filter((d) => d.mounted !== false && num(d.pct) !== null).map((d) => ({ sub: d.mount, value: d.pct })) : null;
    case "mem": return v.mem && num(v.mem.total) > 0 && num(v.mem.used) !== null ? [{ sub: "", value: Math.round((v.mem.used * 1000) / v.mem.total) / 10 }] : null;
    case "cpu": return v.cpu && num(v.cpu.usage) !== null ? [{ sub: "", value: v.cpu.usage }] : null;
    case "temp": return v.temp && num(v.temp.package) !== null ? [{ sub: "", value: v.temp.package }] : null;
    // a container counts once it was seen running: down while not running, or unhealthy
    case "container.down": return Array.isArray(v.docker) && v.docker.length
      ? v.docker.filter((c) => running.has(c.name)).map((c) => ({ sub: c.name, value: c.state !== "running" || c.health === "unhealthy" ? 1 : 0 }))
      : null;
    case "failed_units": return v.ubuntu && Array.isArray(v.ubuntu.failedUnits) ? [{ sub: "", value: v.ubuntu.failedUnits.length }] : null;
    case "reboot_required": return v.ubuntu && typeof v.ubuntu.rebootRequired === "boolean" ? [{ sub: "", value: v.ubuntu.rebootRequired ? 1 : 0 }] : null;
    case "security_updates": return v.ubuntu && num(v.ubuntu.security) !== null ? [{ sub: "", value: v.ubuntu.security }] : null;
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

function createAlerts(dir, { now = Date.now, onEvent = () => {}, warn = () => {}, rules = DEFAULT_RULES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json"), logFile = path.join(dir, "events.jsonl");
  const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
  let st = { instances: {}, running: {}, mutes: { rules: {}, nodes: {} } };
  try {
    const f = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (isObj(f.instances)) st.instances = f.instances;
    if (isObj(f.running)) st.running = f.running;
    if (isObj(f.mutes) && isObj(f.mutes.rules) && isObj(f.mutes.nodes)) st.mutes = f.mutes;
  } catch (_) { /* first start */ }
  // the log, a line at a time: a line torn by a crash is skipped, not the whole log
  let events = [];
  try {
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (_) { /* torn */ }
    }
    events = events.slice(-LOG_MAX);
  } catch (_) { /* none yet */ }
  // state is written when it changed; a value that moves on every push is not state
  let saved = "";
  const save = () => {
    const text = JSON.stringify(st, (k, v) => (k === "value" ? undefined : v));
    if (text === saved) return;
    writeFileAtomic(stateFile, text);
    saved = text;
  };
  try { saved = fs.readFileSync(stateFile, "utf8"); } catch (_) { /* none */ }

  function log(e) {
    events.push(e);
    try {
      fs.appendFileSync(logFile, JSON.stringify(e) + "\n");
      if (events.length > LOG_MAX + 100) {
        events = events.slice(-LOG_MAX);
        writeFileAtomic(logFile, events.map((x) => JSON.stringify(x)).join("\n") + "\n");
      }
    } catch (err) { warn("alerts.log_failed", { error: err.code || String(err) }); }
  }
  const muted = (inst, t) => (st.mutes.rules[inst.rule] || 0) > t || (st.mutes.nodes[inst.node] || 0) > t;
  const offline = (node) => { const o = st.instances[`offline|${node}|`]; return !!(o && o.state === "firing"); };
  // why an instance is not told now: muted, or its node is offline (inhibition); else ""
  const quiet = (inst, r, t) => (muted(inst, t) ? "muted" : r.id !== "offline" && offline(inst.node) ? "offline" : "");
  // an event: always in the log (with why it stayed quiet); passed on unless quiet. The end
  // of an alert whose start was told is always told, mute or not (spec 8.1).
  // (extra: { ended: "rule" } when it ends because its rule no longer holds there, not because it is fixed)
  function tell(kind, inst, r, t, extra) {
    const e = { kind, rule: inst.rule, ...(r.name ? { name: r.name } : {}), severity: r.severity, node: inst.node, nodeName: inst.nodeName,
                ...(inst.sub ? { sub: inst.sub } : {}), value: inst.value, at: t, since: inst.since, ...extra };
    const why = kind === "resolved" ? (inst.notified ? "" : quiet(inst, r, t) || "untold") : quiet(inst, r, t);
    log(why ? { ...e, quiet: why } : e);
    if (!why) onEvent(e);
    return !why;
  }
  // a firing alert not told yet (it was quiet) is told now if no longer quiet; a told one repeats
  function retell(inst, r, t) {
    if (!inst.notified && !quiet(inst, r, t)) { tell("firing", inst, r, t); inst.notified = true; inst.lastNotified = t; }
    else if (inst.notified && t - inst.lastNotified >= r.repeat && !quiet(inst, r, t)) { tell("repeat", inst, r, t); inst.lastNotified = t; }
  }
  // one instance, one value (null: its disk or container is gone, so it ends)
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
      if (over) { tell("resolved", inst, r, t); delete st.instances[key]; return; }
      retell(inst, r, t);
      return;
    }
    if (!holds) { delete st.instances[key]; return; }
    if (inst.state === "ok") { inst.state = "pending"; inst.since = t; }
    if (t - inst.since >= r.for) {
      inst.state = "firing"; inst.firedAt = t; inst.severity = r.severity;
      inst.notified = tell("firing", inst, r, t);
      if (inst.notified) inst.lastNotified = t;
    }
  }

  // an alert whose rule no longer holds: it ends (a told one ends told, saying why)
  function end(k, r, t) {
    const i = st.instances[k];
    if (i.state === "firing") tell("resolved", i, r, t, { ended: "rule" });
    delete st.instances[k];
  }
  // a rule that no longer holds for a node: its alerts there end
  function endAll(r, node, t) {
    for (const [k, i] of Object.entries(st.instances)) if (i.rule === r.id && i.node === node.id) end(k, r, t);
  }
  // the alerts of a rule removed or turned off end; the mutes of a rule removed go. Also at a
  // start, for a rules file that lost a rule while the hub was down.
  function prune(old) {
    const t = now();
    for (const [k, i] of Object.entries(st.instances)) {
      const r = rules.find((x) => x.id === i.rule);
      if (r && !r.off) continue;
      end(k, r || old.find((x) => x.id === i.rule) || { severity: i.severity || "warning" }, t);
    }
    for (const id of Object.keys(st.mutes.rules)) if (!rules.some((r) => r.id === id)) delete st.mutes.rules[id];
  }

  prune([]);
  save();

  return {
    // a push from node ({ id, name, tags }): every rule on what it sends; a push ends "offline"
    evaluate(node, v) {
      const t = now();
      // the containers seen running: kept as they were when the push has no containers
      const run = new Set(st.running[node.id] || []);
      if (Array.isArray(v.docker) && v.docker.length) {
        for (const c of v.docker) if (c.state === "running") run.add(c.name);
        for (const name of [...run]) if (!v.docker.some((c) => c.name === name)) run.delete(name);   // removed
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
        for (const inst of Object.values(st.instances)) {
          if (inst.rule === r.id && inst.node === node.id && !seen.has(inst.sub)) judge(r, node, inst.sub, null, t);
        }
      }
      save();
    },
    // once a minute: nodes ({ id, name, lastPush, interval }) that stopped pushing go offline;
    // firing alerts of nodes that are not offline repeat (nothing else is judged without a push)
    check(nodes) {
      const t = now();
      const off = rules.find((x) => x.metric === "offline");
      for (const n of nodes) {
        if (!n.lastPush) continue;   // waiting for its first push: not offline
        const limit = Math.max(10 * MIN, 5 * (n.interval || 60) * 1000);
        const r = off && forNode(off, n);
        if (r) judge(r, n, "", t - n.lastPush >= limit ? 1 : 0, t);
        else if (off) endAll(off, n, t);
        // its other firing alerts: one whose rule no longer holds there ends; the rest repeat,
        // unless the node stopped pushing (with offline off for it, nothing else says so)
        const stale = t - n.lastPush >= limit;
        for (const [k, inst] of Object.entries(st.instances)) {
          if (inst.node !== n.id || inst.state !== "firing" || inst.rule === "offline") continue;
          const rr = rules.find((x) => x.id === inst.rule);
          if (!rr) continue;
          const eff = forNode(rr, n);
          if (!eff) end(k, rr, t);
          else if (!stale) retell(inst, eff, t);
        }
      }
      save();
    },
    // with why each is not told now: "muted", "offline" (held back by its node) or ""
    firing() {
      const t = now();
      return Object.values(st.instances).filter((i) => i.state === "firing").map((i) => {
        const r = rules.find((x) => x.id === i.rule) || {};
        return { rule: i.rule, ...(r.name ? { name: r.name } : {}), severity: r.severity, node: i.node, nodeName: i.nodeName, sub: i.sub, value: i.value,
                 since: i.since, firedAt: i.firedAt, muted: muted(i, t), quiet: quiet(i, r, t) };
      });
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
    // new rules (from the editor): the alerts of a rule removed or turned off end now (a told
    // one ends told); a change of scope or override applies at each node's next push
    setRules(list) {
      const old = rules;
      rules = list;
      prune(old);
      save();
    },
    ruleIds() { return rules.map((r) => r.id); },
    // what the page needs to name an alert: { id: { name?, metric } }
    ruleInfo() { return Object.fromEntries(rules.map((r) => [r.id, r.name ? { name: r.name, metric: r.metric } : { metric: r.metric }])); },
    // a revoked node: its told alerts end told
    forget(node) {
      const t = now();
      for (const [k, i] of Object.entries(st.instances)) {
        if (i.node !== node) continue;
        const r = rules.find((x) => x.id === i.rule);
        if (r && i.state === "firing") tell("resolved", i, r, t);
        delete st.instances[k];
      }
      delete st.running[node]; delete st.mutes.nodes[node];
      save();
    },
    log,
  };
}

module.exports = { createAlerts, DEFAULT_RULES, valuesOf, forNode };
