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
