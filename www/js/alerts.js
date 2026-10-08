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
