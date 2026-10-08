// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* the alerts view (spec 8, 10.1): what is firing, the mutes still running and the last
   events, from GET /__ctl/alerts; a rule or a node is muted (and unmuted) with POST
   /__ctl/alerts/mute. Its second tab edits the rules (spec 8.1): the defaults' thresholds,
   times and severities, rules of one's own, and per-server or per-tag overrides, from GET
   and POST /__ctl/alerts/rules. Loaded by openAlerts() in app.js on first use. */
const ALERT_SEV = ["critical", "warning", "info"];
let alertsSeq = 0;
// each rule's name (a rule of one's own) and metric, from GET /__ctl/alerts: { id: { name?, metric } }
let alertRuleInfo = {};
const DEFAULT_METRIC = { disk_full: "disk.used", disk_critical: "disk.used", memory: "mem", cpu: "cpu", temperature: "temp",
  failed_units: "failed_units", security_updates: "security_updates" };

// a rule in words: the default rules from the dictionary (disk_full is alert.rule.diskFull),
// one's own by its name, any other by its id
function ruleLabel(id) {
  const k = String(id).replace(/_([a-z])/g, (m, c) => c.toUpperCase());
  if (STRINGS["alert.rule." + k]) return tr("alert.rule." + k);
  const info = alertRuleInfo[id];
  return info && info.name ? info.name : id;
}
// an alert's value in its metric's unit; true-or-false metrics show none
function alertValue(rule, v) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  const m = (alertRuleInfo[rule] && alertRuleInfo[rule].metric) || DEFAULT_METRIC[rule];
  if (m === "disk.used" || m === "mem" || m === "cpu") return fmtShare(v);
  if (m === "temp") return fmtTemp(v, true);
  if (m === "failed_units" || m === "security_updates") return String(v);
  return "";
}
// a time: the clock today, the date and the clock before
function alertWhen(t) {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? fmtTime(d) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + fmtTime(d);
}
const sevTag = sev => `<span class="asev ${esc(sev)}">${esc(tr("alert.sev." + (ALERT_SEV.includes(sev) ? sev : "info")))}</span>`;
const alertWhat = a => esc(a.name || ruleLabel(a.rule)) + (a.sub ? ` <span class="asub">${esc(a.sub)}</span>` : "");

// the whole view from one answer of GET /__ctl/alerts
function alertsHtml(d, names) {
  const firing = (Array.isArray(d.firing) ? d.firing : []).slice()
    .sort((a, b) => (ALERT_SEV.indexOf(a.severity) - ALERT_SEV.indexOf(b.severity)) || (b.firedAt || 0) - (a.firedAt || 0));
  const now = Date.now();
  let h = `<section><label>${esc(tr("alerts.firing"))}</label>`;
  // why an alert is not told: muted, or held back while its server is offline
  const why = a => (["muted", "offline"].includes(a.quiet) ? a.quiet : a.muted ? "muted" : "");
  h += firing.length ? firing.map(a => `<div class="arow${why(a) ? " amuted" : ""}">${sevTag(a.severity)}`
    + `<span class="awhat">${alertWhat(a)} <b>${esc(alertValue(a.rule, a.value))}</b></span>`
    + `<span class="anode">${esc(a.nodeName || a.node)}</span>`
    + `<span class="asince">${esc(tr("alerts.for", { time: fmtDur((now - (a.since || now)) / 1000) }))}</span>`
    + `<span class="aacts">${why(a) ? `<i>${esc(tr("alert.quiet." + why(a)))}</i>` : ""}`
    + `<button data-mute="rule" data-id="${esc(a.rule)}">${esc(tr("alerts.muteRule"))}</button>`
    + `<button data-mute="node" data-id="${esc(a.node)}">${esc(tr("alerts.muteNode"))}</button></span></div>`).join("")
    : `<div class="muted">${esc(tr("alerts.none"))}</div>`;
  h += "</section>";
  const m = d.mutes || {};
  const mutes = [...Object.entries(m.rules || {}).map(([id, until]) => ["rule", id, ruleLabel(id), until]),
                 ...Object.entries(m.nodes || {}).map(([id, until]) => ["node", id, names[id] || id, until])];
  if (mutes.length) {
    h += `<section><label>${esc(tr("alerts.mutes"))}</label>` + mutes.map(([kind, id, label, until]) => `<div class="arow amrow">`
      + `<span class="awhat">${esc(tr("alerts.mute." + kind, { name: label }))}</span>`
      + `<span class="asince">${esc(tr("alerts.until", { time: alertWhen(until) }))}</span>`
      + `<span class="aacts"><button data-unmute="${esc(kind)}" data-id="${esc(id)}">${esc(tr("alerts.unmute"))}</button></span></div>`).join("")
      + "</section>";
  }
  const recent = Array.isArray(d.recent) ? d.recent : [];
  h += `<section><label>${esc(tr("alerts.recent"))}</label>`;
  h += recent.length ? recent.map(e => `<div class="arow">${sevTag(e.severity)}`
    + `<span class="awhat">${esc(e.ended ? tr("alert.kind.ended") : tr("alert.kind." + (e.kind === "resolved" || e.kind === "repeat" ? e.kind : "firing")))}: ${alertWhat(e)} `
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
  alertRuleInfo = d.rules && typeof d.rules === "object" ? d.rules : {};
  $("#alerts-body").innerHTML = alertsHtml(d, names);
}

// mute a rule or a node for ms (the hub counts it from its own clock), or unmute it (0),
// then show the new state
async function muteAlert(kind, id, ms) {
  try {
    const r = await fetch("/__ctl/alerts/mute", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(ms > 0 ? { [kind]: id, for: ms } : { [kind]: id, until: 0 }) });
    if (!r.ok) throw new Error(String(r.status));
    toast(ms > 0 ? tr("alerts.muted") : tr("alerts.unmuted"));
  } catch (e) { toast(tr("alerts.muteFailed"), true); }
  await loadAlerts();
  await loadNodes();
  renderFleetIfShown();
}

/* ------------------------------------------------------------------ the rule editor */
// rows: one per rule, the defaults first: { id, own, name, metric, op, threshold, for, clear,
// severity, on, scope ("", "node:<id>", "tag:<tag>"), sub, overrides: [{ who, threshold, off }] }
const rulesState = { defaults: [], metrics: [], rows: [], dirty: false };
const YESNO = ["reboot_required", "container.down"];   // true or false: no threshold to set
const USUAL = { "disk.used": 90, mem: 90, cpu: 95, temp: 85 };   // a new metric's threshold (counts and yes-no: 1)
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
      + (offline || yesno ? "" : `<input type="number" step="any" class="rnum" data-of="threshold" value="${numVal(shown(r.metric, o.threshold))}"${o.off ? " disabled" : ""} aria-label="${esc(tr("rules.threshold"))}">`)
      + `<label><input type="checkbox" data-of="off"${o.off || offline || yesno ? " checked" : ""}${offline || yesno ? " disabled" : ""}> ${esc(tr("rules.off"))}</label>`
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
      ov.off = r.metric === "offline" || YESNO.includes(r.metric) || (off ? off.checked : false);
      const th = o.querySelector("[data-of=threshold]");
      ov.threshold = ov.off || !th ? null : typed(r.metric, num(th.value));
    }
    if (YESNO.includes(r.metric)) { r.threshold = 1; r.op = ">="; r.clear = null; }
    if (r.own && !/^(disk\.used|container\.down)$/.test(r.metric)) r.sub = "";
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
  if (act === "addov") {
    const only = rows[i].metric === "offline" || YESNO.includes(rows[i].metric);   // these can only be turned off
    rows[i].overrides.push({ who: rulesTargets()[0][0], threshold: only ? null : rows[i].threshold, off: only });
  }
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
  // every change is read at once (a tab change keeps it); one that alters the form's shape
  // draws it again, and a new metric starts from its usual threshold
  $("#rules-body").onchange = e => {
    rulesState.dirty = true;
    readRules();
    if (e.target.matches("[data-f=metric]")) {
      const el = e.target.closest(".rule"), r = el && rulesState.rows[Number(el.dataset.i)];
      if (r) Object.assign(r, { op: ">=", threshold: USUAL[r.metric] ?? 1, clear: null, sub: "" });
    }
    if (e.target.matches("[data-f=metric], [data-f=op], [data-f=on], [data-of=off]")) drawRules();
  };
  $("#alerts-body").onclick = e => {
    const b = e.target.closest("button[data-mute], button[data-unmute]");
    if (!b) return;
    b.disabled = true;
    if (b.dataset.mute) muteAlert(b.dataset.mute, b.dataset.id, Number($("#alerts-for").value));
    else muteAlert(b.dataset.unmute, b.dataset.id, 0);
  };
}
