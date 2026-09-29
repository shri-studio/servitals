// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* ------------------------------------------------------------------ utils */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
// package temp (°C) -> 0-100% of the display band, for the meter and sparkline
const tempPct = t => clamp((t - 30) / 65 * 100, 0, 100);

/* units (spec 10.4): the hub's default from config.json, like the other settings */
const UNIT_CHOICES = { temp: ["c", "f"], size: ["binary", "decimal"], rate: ["bytes", "bits"], clock: ["auto", "24h", "12h"] };
function units() {
  const u = (typeof cfg === "object" && cfg && cfg.units) || {};
  const out = {};
  for (const [k, choices] of Object.entries(UNIT_CHOICES)) out[k] = choices.includes(u[k]) ? u[k] : choices[0];
  return out;
}
// temperatures are Celsius everywhere inside the page; only the text changes
function tempUnit() { return units().temp === "f" ? "°F" : "°C"; }
function fmtTemp(c, withUnit) {
  if (c == null || !Number.isFinite(Number(c))) return "–";
  const n = Math.round(units().temp === "f" ? Number(c) * 9 / 5 + 32 : Number(c));
  return withUnit ? n + tempUnit() : n + tempUnit().slice(0, 1);
}
function fmtTime(date, timeZone) {
  const c = units().clock;
  // zone clocks read 24 hour, as they always did, unless a clock is chosen
  const locale = timeZone && c === "auto" ? "en-GB" : undefined;
  return date.toLocaleTimeString(locale, { timeZone, hour12: c === "12h" ? true : c === "24h" ? false : undefined });
}
/* CSP (spec 10.5): generated markup carries no style attributes. Sizes arrive as
   data-w / data-h (percent) and are set through the CSSOM, which the policy allows,
   before the next paint. */
function applySizes(root) {
  const els = root.matches && root.matches("[data-w],[data-h]") ? [root] : [];
  for (const el of [...els, ...(root.querySelectorAll ? root.querySelectorAll("[data-w],[data-h]") : [])]) {
    if (el.dataset.w !== undefined) el.style.width = el.dataset.w + "%";
    if (el.dataset.h !== undefined) el.style.height = el.dataset.h + "%";
  }
}
new MutationObserver(list => {
  for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) applySizes(n);
}).observe(document.documentElement, { childList: true, subtree: true });

function fmtBytes(n) {
  n = Number(n) || 0;
  const base = units().size === "decimal" ? 1000 : 1024;
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0;
  while (n >= base && i < u.length - 1) { n /= base; i++; }
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + u[i];
}
function fmtRate(Bps) {
  Bps = Number(Bps) || 0;
  const bits = units().rate === "bits";
  const base = bits || units().size === "decimal" ? 1000 : 1024;   // network speeds in bits are always powers of 1000
  const u = bits ? ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"] : ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bits ? Bps * 8 : Bps, i = 0;
  while (v >= base && i < u.length - 1) { v /= base; i++; }
  return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + " " + u[i];
}
function fmtDur(sec) {
  sec = Number(sec) || 0;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (d ? d + "d " : "") + (h || d ? h + "h " : "") + m + "m";
}

// health -> "ok" | "warn" | "crit"  (value, warn threshold, crit threshold)
function health(v, warn, crit) { return v >= crit ? "crit" : v >= warn ? "warn" : "ok"; }
const HCLS = { ok: "c-green", warn: "c-amber", crit: "c-red" };   // big numbers / meters
const HL   = { ok: "",        warn: "hl-amber", crit: "hl-red" };  // inline value highlight

function meter(pct, forceCls) {
  pct = clamp(pct, 0, 100);
  const cls = forceCls || HCLS[health(pct, 70, 90)];
  return `<div class="meter ${cls}"><div class="track"><i data-w="${pct.toFixed(1)}"></i></div>`
    + `<span class="pct">${Math.round(pct)}%</span></div>`;
}

// thin line sparkline as inline SVG (crisper than block chars at small sizes)
// trend line as inline SVG; `pct` values are 0–100, coloured green→amber→red
// by height (a past spike stays visibly red at that point of the line)
let sparkUid = 0;
function sparkSvg(pcts) {
  const vals = pcts.filter(v => v != null);
  if (vals.length < 3) return "";
  const W = 240, H = 22, id = "sg" + (++sparkUid);
  const step = W / (vals.length - 1);
  const y = v => H - 1.5 - (clamp(v, 0, 100) / 100) * (H - 3);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<defs><linearGradient id="${id}" x1="0" y1="${H}" x2="0" y2="0" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" class="s-green"/>`
    + `<stop offset="0.62" class="s-green"/>`
    + `<stop offset="0.78" class="s-amber"/>`
    + `<stop offset="0.92" class="s-red"/></linearGradient></defs>`
    + `<polyline points="${pts}" fill="none" stroke="url(#${id})" stroke-width="1.5" `
    + `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

/* i18n (spec 10.3): every word comes from the dictionary, js/i18n.js (tr, STRINGS).
   The markup keeps the English text for the first paint; its keys are in data-i18n. */
function applyStrings(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  for (const a of ["placeholder", "title", "aria-label"]) {
    for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) el.setAttribute(a, tr(el.getAttribute("data-i18n-" + a)));
  }
}

/* ------------------------------------------------------------------ config */
// per-browser settings; values stored under the pre-rename prefix move over once
function lsGet(key) {
  try {
    const v = localStorage.getItem("servitals." + key);
    if (v !== null) return v;
    const old = localStorage.getItem("sysdash." + key); // legacy-name
    if (old !== null) {
      localStorage.setItem("servitals." + key, old);
      localStorage.removeItem("sysdash." + key); // legacy-name
    }
    return old;
  } catch (e) { return null; }
}
function lsSet(key, value) { try { localStorage.setItem("servitals." + key, value); } catch (e) {} }
function lsDel(key) { try { localStorage.removeItem("servitals." + key); } catch (e) {} }
let DEFAULTS = {};
let cfg = {};

async function loadConfig() {
  try {
    DEFAULTS = await (await fetch("config.json?t=" + Date.now())).json();
  } catch (e) { DEFAULTS = {}; }
  const builtin = {
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, storage: 1, network: 1, docker: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "storage", "network", "docker", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", storage: "wide",
                 network: "wide", docker: "full", clocks: "normal", weather: "normal" }
  };
  // a conf.d file may set only a few panels: the others keep their built-in values
  for (const k of ["panels", "panelSize"]) {
    if (DEFAULTS[k] && typeof DEFAULTS[k] === "object") DEFAULTS[k] = { ...builtin[k], ...DEFAULTS[k] };
  }
  DEFAULTS = Object.assign(builtin, DEFAULTS);

  let saved = null;
  try { saved = JSON.parse(lsGet("cfg") || "null"); } catch (e) {}
  cfg = saved ? deepMerge(structuredClone(DEFAULTS), saved) : structuredClone(DEFAULTS);
  applyManaged();
  fixPanelOrder();
}
/* config as code (spec 12): what files in /etc/servitals/conf.d set (the hub
   lists it in _managed) wins, also over a copy saved in this browser */
function managedPaths() {
  return Array.isArray(DEFAULTS._managed) ? DEFAULTS._managed.filter(p => typeof p === "string") : [];
}
function applyManaged() {
  for (const p of managedPaths()) {
    const [k, sub] = p.split(".");
    if (sub === undefined) { if (DEFAULTS[k] !== undefined) cfg[k] = structuredClone(DEFAULTS[k]); }
    else if (DEFAULTS[k] && DEFAULTS[k][sub] !== undefined) {
      if (!cfg[k] || typeof cfg[k] !== "object") cfg[k] = {};
      cfg[k][sub] = structuredClone(DEFAULTS[k][sub]);
    }
  }
}
// the settings control for a managed path, or null
function managedSelector(p) {
  const plain = { title: "#cfg-name", refreshSec: "#cfg-refresh", kiosk: "#cfg-kiosk", kioskSec: "#cfg-kiosksec",
                  style: "#cfg-lookdefault", mode: "#cfg-lookdefault", density: "#cfg-lookdefault",
                  panelOrder: "#cfg-panels [data-up], #cfg-panels [data-down]",
                  "fleet.sort": "#cfg-f-sort", "fleet.group": "#cfg-f-group", "fleet.card": "#cfg-f-card input",
                  "fleet.pinned": "#cfg-servers .srv-pin", "fleet.hidden": "#cfg-servers .srv-hide" };
  if (plain[p]) return plain[p];
  const m = /^(units|panels|panelSize)\.([a-z]+)$/.exec(p);
  if (!m) return null;
  if (m[1] === "units") return `#cfg-u-${m[2]}`;
  return `#cfg-panels [data-p="${m[2]}"] [data-${m[1] === "panels" ? "vis" : "sz"}]`;
}
function markManaged() {
  const note = "managed by a file in /etc/servitals/conf.d";
  for (const p of managedPaths()) {
    // files set the shared panel set; a server's own set stays its own
    if (panelFor !== "all" && /^panel(s|Size)\./.test(p)) continue;
    const sel = managedSelector(p);
    if (!sel) continue;
    for (const el of $$(sel)) {
      el.disabled = true;
      el.title = note;
      const box = el.closest(".field, .check, .pcf");
      if (box) box.classList.add("managed");
    }
  }
}
// every panel appears exactly once in the order list
function fixPanelOrder() {
  const known = Object.keys(DEFAULTS.panels);
  const order = Array.isArray(cfg.panelOrder) ? cfg.panelOrder : [];
  cfg.panelOrder = [...new Set(order.filter(p => known.includes(p))), ...known.filter(p => !order.includes(p))];
}

function applyBranding() {
  const name = cfg.title || "servitals";
  document.title = name;
  if (cfg.favicon) $("#favicon").href = cfg.favicon;
}
// the panel set of one server: its own when it has one, else the shared one (spec 10.4)
function panelSet(id) {
  const own = id && cfg.nodePanels && cfg.nodePanels[id];
  // a hand-edited or imported entry without panels falls back to the shared set
  return own && own.panels && typeof own.panels === "object" ? own : { panels: cfg.panels, panelSize: cfg.panelSize };
}
function applyLayout() {
  const grid = $("#grid");
  const set = panelSet(currentNode || localNode);
  const order = (cfg.panelOrder && cfg.panelOrder.length) ? cfg.panelOrder : Object.keys(DEFAULTS.panels);
  order.forEach((p, i) => {
    const el = grid.querySelector(`[data-panel="${p}"]`);
    if (!el) return;
    el.style.order = i;
    const size = (set.panelSize && set.panelSize[p]) || "normal";
    el.classList.remove("p-normal", "p-wide", "p-full");
    el.classList.add("p-" + size);
    el.classList.toggle("hidden", set.panels[p] === false);
  });
}
function deepMerge(a, b) {
  // own keys only, and never the ones that reach Object.prototype (settings can be imported)
  for (const k of Object.keys(b)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      a[k] = deepMerge(a[k] || {}, b[k]);
    } else { a[k] = b[k]; }
  }
  return a;
}
function saveConfig() { lsSet("cfg", JSON.stringify(cfg)); }

/* ------------------------------------------------------------------ version */
// Footer shows the running version; after an update, a one-time note says so.
function applyVersion(v) {
  if (!v || v === "unknown") return;
  $("#sv-version").textContent = v;
  const seen = lsGet("version");
  if (seen && seen !== v) {
    $("#updver").textContent = v;
    $("#updnote").hidden = false;
    $("#upddismiss").onclick = () => { $("#updnote").hidden = true; };
  }
  lsSet("version", v);
}

/* ------------------------------------------------------------------ appearance
   Style and mode are independent (spec 10.2). A choice made in this browser
   wins; otherwise the hub's default from config.json applies. Each style but
   classic is a file in styles/, loaded only when chosen. */
const STYLES = [
  { id: "classic", label: "classic", group: "v1" },
  { id: "8bit", label: "8bit", group: "v1" },
  { id: "phosphor", label: "phosphor", group: "v1" },
  { id: "eink", label: "e-ink", group: "v1" },
  { id: "contrast", label: "high contrast", group: "access" },
  { id: "nord", label: "nord", group: "palette" },
  { id: "gruvbox", label: "gruvbox", group: "palette" },
  { id: "dracula", label: "dracula", group: "palette" },
  { id: "catppuccin", label: "catppuccin", group: "palette" },
  { id: "solarized", label: "solarized", group: "palette" },
];
const MODES = ["system", "light", "dark"];
const DENSITIES = ["compact", "comfortable", "large"];

function currentStyle() { return document.documentElement.getAttribute("data-style") || "classic"; }
function currentMode() { return document.documentElement.getAttribute("data-theme") || "system"; }
function currentDensity() { return document.documentElement.getAttribute("data-density") || "comfortable"; }

function applyStyle(id) {
  if (!STYLES.some(s => s.id === id)) id = "classic";
  const d = document.documentElement;
  let link = $("#style-css");
  if (id === "classic") {
    d.removeAttribute("data-style");
    if (link) link.remove();
  } else {
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet"; link.id = "style-css";
      document.head.appendChild(link);
    }
    link.href = `styles/${id}.css`;
    d.setAttribute("data-style", id);
  }
  $("#btn-style").textContent = `[y] ${(STYLES.find(s => s.id === id) || STYLES[0]).label}`;
}
function applyMode(m) {
  if (m === "light" || m === "dark") document.documentElement.setAttribute("data-theme", m);
  else document.documentElement.removeAttribute("data-theme");
  $("#btn-theme").textContent = `[t] ${currentMode()}`;
}
function applyDensity(n) {
  if (n === "compact" || n === "large") document.documentElement.setAttribute("data-density", n);
  else document.documentElement.removeAttribute("data-density");
}
// the keys change this browser only
function toggleStyle() {
  const i = STYLES.findIndex(s => s.id === currentStyle());
  const next = STYLES[(i + 1) % STYLES.length].id;
  applyStyle(next); lsSet("style", next);
}
function toggleTheme() {
  const next = MODES[(MODES.indexOf(currentMode()) + 1) % MODES.length];
  applyMode(next); lsSet("theme", next);
}
// after config.json: the hub's defaults where this browser has no choice of its own
function applyAppearanceDefaults() {
  applyStyle(lsGet("style") || cfg.style || "classic");
  applyMode(lsGet("theme") || cfg.mode || "system");
  applyDensity(lsGet("density") || cfg.density || "comfortable");
  // this screen's own ?kiosk / ?kiosk=0 wins; otherwise the hub decides, also when it turned kiosk off
  const own = lsGet("kiosk");
  document.documentElement.toggleAttribute("data-kiosk", own === "1" || (own !== "0" && !!cfg.kiosk));
  // remembered for the next visit, so the hub's look paints at once
  for (const k of ["style", "mode", "density"]) lsSet("hub." + k, cfg[k] || "");
  lsSet("hub.kiosk", cfg.kiosk ? "1" : "");
}

/* ------------------------------------------------------------------ kiosk
   Cycles through the nodes every kioskSec seconds (spec 10.3). */
let kioskTimer = null;
function startKiosk() {
  clearInterval(kioskTimer);
  if (!document.documentElement.hasAttribute("data-kiosk")) return;
  kioskTimer = setInterval(() => {
    const ids = fleetNodes.filter(n => !hiddenIds().has(n.id)).map(n => n.id);
    if (ids.length < 2) return;
    const now = view === "fleet" ? -1 : ids.indexOf(currentNode || localNode);
    location.hash = "#node=" + ids[(now + 1) % ids.length];
  }, clamp(+cfg.kioskSec || 20, 5, 600) * 1000);
}

/* ------------------------------------------------------------------ render: metrics */
let lastData = null;
const HISTLEN = 60;   // matches the agent's `tail -n 60`: 60 samples = 60 × INTERVAL of trend
let hist = { cpu: [], mem: [], temp: [] };
let trendFromServer = false;
function pushHist(k, v) {
  if (trendFromServer) return;   // the agent's `d.trend` is the source once we've seen it
  hist[k].push(v); if (hist[k].length > HISTLEN) hist[k].shift();
}

// the agent keeps a rolling cpu/mem/temp history and ships it in `d.trend`,
// so the sparklines are populated on the first load instead of after several
// polls. Fall back to accumulating client-side if an older agent omits it.
function seedTrend(d) {
  if (!Array.isArray(d.trend) || d.trend.length < 2) return;
  hist = {
    cpu:  d.trend.map(x => x.cpu).slice(-HISTLEN),
    mem:  d.trend.map(x => x.mem).slice(-HISTLEN),
    temp: d.trend.map(x => x.temp).filter(v => v != null).slice(-HISTLEN),
  };
  trendFromServer = true;
}

/* ------------------------------------------------------------------ fleet
   With more than one node the page opens on the fleet grid (#fleet); the tabs
   and the cards open one node's view (#node=<id>). With one node it is the
   node view, as before. Container buttons exist only for the hub's own host. */
let fleetNodes = [];
let localNode = null;
let view = "node";            // "node" | "fleet"
let currentNode = null;       // the node in the node view; null means the local node

const isLocalView = () => !currentNode || currentNode === localNode;
const nodeQuery = () => (currentNode ? "?node=" + encodeURIComponent(currentNode) : "");

// "ok", "down" (no answer: offline, or the hub is gone) or "login" (the session ended)
let hubState = "ok";
// what an answer says about the hub: JSON is the hub's own; the login page (200 or 401)
// means the session ended; any other answer is a proxy saying the hub is down
function hubStateOf(r) {
  if (r.status === 401) return "login";
  if (/json/.test(r.headers.get("content-type") || "")) return "ok";
  return r.ok ? "login" : "down";
}
function hubText() {
  return hubState === "login" ? "logged out: reload the page to log in"
    : "hub unreachable" + (navigator.onLine === false ? " (this device is offline)" : "");
}
async function loadNodes() {
  try {
    const r = await fetch("/__ctl/nodes?t=" + Date.now());
    if (!r.ok) { hubState = r.status === 401 ? "login" : "down"; return; }
    fleetNodes = await r.json();
    hubState = "ok";
  } catch (e) { hubState = "down"; return; }
  const local = fleetNodes.find(n => n.local);
  localNode = local ? local.id : null;
  renderTabs();
}

function route() {
  const m = /^#node=([a-z2-7]{12})$/.exec(location.hash);
  const wasView = view, wasNode = currentNode;
  if (m && fleetNodes.some(n => n.id === m[1])) { view = "node"; currentNode = m[1]; }
  else if (location.hash === "#fleet" || (!m && fleetNodes.length > 1)) { view = "fleet"; currentNode = null; }
  else { view = "node"; currentNode = null; }
  if (view !== wasView || currentNode !== wasNode) {
    // another node: its own sparklines, containers and network history
    lastData = null; dockerData = null; netData = null;
    hist = { cpu: [], mem: [], temp: [] }; trendFromServer = false;
  }
  $("#fleet").classList.toggle("hidden", view !== "fleet");
  $("#grid").classList.toggle("hidden", view === "fleet");
  renderTabs();
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.classList.toggle("hidden", fleetNodes.length < 2);
  if (fleetNodes.length < 2) return;
  const shown = view === "fleet" ? "fleet" : (currentNode || localNode);
  tabs.innerHTML = `<button data-go="fleet" class="${shown === "fleet" ? "on" : ""}">fleet</button>`
    + fleetNodes.map(n => `<button data-go="${esc(n.id)}" class="${shown === n.id ? "on" : ""}">`
      + `<span class="lamp ${esc(n.status)}"></span>${esc(n.name)}</button>`).join("");
}

function fmtVal(v, unit) { return v == null ? "–" : Math.round(v) + unit; }

/* the fleet's order (spec 10.4): hidden nodes go, pinned ones lead, then the
   chosen sort; grouped by each node's first tag when asked */
function arrangeFleet(nodes, f) {
  const rank = { offline: 0, stale: 1, waiting: 2, online: 3 };
  const keys = { cpu: s => s.cpu, mem: s => s.mem, temp: s => s.temp, disk: s => s.disk && s.disk.pct };
  const byName = (a, b) => a.name.localeCompare(b.name);
  const key = keys[f.sort];
  const value = n => (n.summary && key(n.summary) != null ? key(n.summary) : null);
  const cmp = f.sort === "status" ? (a, b) => ((rank[a.status] ?? 9) - (rank[b.status] ?? 9)) || byName(a, b)
    : key ? (a, b) => {
      const x = value(a), y = value(b);
      if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
      return (y - x) || byName(a, b);
    } : byName;
  const list = v => (Array.isArray(v) ? v : []);   // a hand-edited config.json may hold anything
  const hidden = new Set(list(f.hidden)), pinned = new Set(list(f.pinned));
  const shown = nodes.filter(n => !hidden.has(n.id)).sort(cmp);
  const pins = shown.filter(n => pinned.has(n.id)), rest = shown.filter(n => !pinned.has(n.id));
  if (!f.group) return shown.length ? [{ title: "", nodes: [...pins, ...rest] }] : [];
  const groups = new Map();
  for (const n of rest) {
    const t = (n.tags && n.tags[0]) || "";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(n);
  }
  const out = pins.length ? [{ title: "pinned", nodes: pins }] : [];
  for (const t of [...groups.keys()].filter(Boolean).sort()) out.push({ title: t, nodes: groups.get(t) });
  if (groups.has("")) out.push({ title: "untagged", nodes: groups.get("") });
  return out;
}
// the servers hidden from the fleet (also from its status and kiosk rotation)
function hiddenIds() {
  const h = cfg.fleet && cfg.fleet.hidden;
  return new Set(Array.isArray(h) ? h.filter(x => typeof x === "string") : []);
}
// which numbers a fleet card shows
function cardNumbers() {
  const all = ["cpu", "mem", "temp", "disk", "containers"];
  const want = (cfg.fleet && Array.isArray(cfg.fleet.card) ? cfg.fleet.card : []).filter(k => all.includes(k));
  return want.length ? want.slice(0, 4) : ["cpu", "mem", "temp"];
}
const CARD_LABEL = { cpu: "cpu", mem: "mem", temp: "temp", disk: "disk", containers: "up" };
function cardValue(k, s) {
  if (k === "cpu" || k === "mem") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
  return s.containers ? `${s.running}/${s.containers}` : "–";
}

function renderFleet() {
  let html = "";
  for (const g of arrangeFleet(fleetNodes, cfg.fleet || {})) {
    if (g.title) html += `<div class="fgroup">${esc(g.title)}</div>`;
    html += g.nodes.map(fleetCard).join("");
  }
  $("#fleet").innerHTML = html;
  fleetStatus();
}
function fleetCard(n) {
  const s = n.summary || {};
  const disk = s.disk;
  const dcls = disk ? HCLS[health(disk.pct, 78, 90)] : "";
  const ago = n.lastSeen ? fmtDur((Date.now() - n.lastSeen) / 1000) + " ago" : "";
  const foot = n.status === "online"
    ? (disk ? `disk ${esc(disk.mount)} <span class="${dcls}">${disk.pct}%</span>` : esc(s.host && s.host.distro || ""))
    : n.status === "waiting" ? "waiting for the first push" : `${esc(n.status)} · ${ago}`;
  const cont = s.containers ? `${s.running}/${s.containers} up` : "";
  return `<div class="panel ncard ${esc(n.status)}" data-node="${esc(n.id)}">`
    + `<div class="nhead"><span class="lamp ${esc(n.status)}"></span>${esc(n.name)}</div>`
    + `<div class="kv">${cardNumbers().map(k => `<span><small>${CARD_LABEL[k]}</small>${cardValue(k, s)}</span>`).join("")}</div>`
    + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
    + (disk ? meter(disk.pct, dcls) : "")
    + `<div class="foot"><span>${foot}</span><span>${cont}</span></div></div>`;
}
function fleetStatus() {
  const hidden = hiddenIds();
  const shown = fleetNodes.filter(n => !hidden.has(n.id));
  const online = shown.filter(n => n.status === "online").length;
  const dot = $("#statusdot");
  dot.classList.remove("down", "stale");
  if (online < shown.length) dot.classList.add(shown.some(n => n.status === "offline") ? "down" : "stale");
  $("#hostname").textContent = cfg.title || "servitals";
  $("#hostmeta").textContent = `${shown.length} nodes · ${online} online`;
  // the installable app opens from its copy when the hub cannot be reached: say so
  if (hubState !== "ok") {
    dot.classList.add("down");
    $("#hostmeta").textContent = hubText()
      + (hubState === "down" && shown.length ? " · showing the last known servers" : "");
  }
  $("#lastupdate").textContent = `fleet · ${fmtTime(new Date())}`;
}

async function tick() {
  if (view === "fleet") { await loadNodes(); renderFleet(); return; }
  try {
    let r;
    try { r = await fetch((currentNode ? `/__ctl/node/${currentNode}` : "data.json") + "?t=" + Date.now()); }
    catch (e) { hubState = "down"; throw e; }
    hubState = hubStateOf(r);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "no snapshot");
    lastData = d;
    renderMetrics(d);
    setStatus(d.ts);
  } catch (e) {
    setStatus(lastData ? lastData.ts : 0, true);
  }
}

function setStatus(ts, hardFail) {
  const dot = $("#statusdot");
  const age = (Date.now() - (ts || 0)) / 1000;   // ts is in milliseconds
  // tolerate the agent's own heartbeat interval (it only samples on demand)
  const budget = ((lastData && lastData.interval) || cfg.refreshSec || 60) * 2 + 120;
  let label;
  dot.classList.remove("down", "stale");
  if (hardFail && hubState !== "ok") { dot.classList.add("down"); label = hubText(); }
  else if (hardFail && !ts) { dot.classList.add("down"); label = "agent unreachable"; }
  else if (age > budget) { dot.classList.add("stale"); label = "stale " + fmtDur(age) + " old"; }
  else { label = "online"; }
  $("#lastupdate").textContent = label + " · " +
    fmtTime(new Date(ts || 0));
}

function renderMetrics(d) {
  seedTrend(d);

  // header
  if (d.host) {
    $("#hostname").textContent = d.host.name || "host";
    $("#ps1").textContent = "visitor@" + (d.host.name || "host");
    $("#hostmeta").textContent =
      [d.host.distro, "kernel " + d.host.kernel, "up " + fmtDur(d.host.uptime)]
        .filter(Boolean).join("  ·  ");
  }

  // memory
  if (d.mem) {
    const m = d.mem, pct = m.total ? (m.used / m.total) * 100 : 0;
    const swapPct = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0;
    pushHist("mem", pct);
    const hc = HCLS[health(pct, 75, 90)];
    $("#mem-used").textContent  = fmtBytes(m.used);
    $("#mem-used").closest(".big").className = "big " + hc;
    $("#mem-total").textContent = fmtBytes(m.total);
    $("#mem-bar").innerHTML     = meter(pct, hc);
    $("#mem-spark").innerHTML = sparkSvg(hist.mem);
    $("#mem-used2").textContent = fmtBytes(m.used);
    $("#mem-cache").textContent = fmtBytes(m.cache);
    $("#mem-avail").textContent = fmtBytes(m.available);
    const sw = $("#mem-swap");
    sw.textContent = m.swapTotal ? fmtBytes(m.swapUsed) + " / " + fmtBytes(m.swapTotal) : "off";
    sw.className = "v " + (swapPct >= 25 ? "hl-red" : swapPct > 1 ? "hl-amber" : "");
    $("#mem-note").textContent = Math.round(pct) + "% in use";
  }

  // cpu
  if (d.cpu) {
    const c = d.cpu;
    pushHist("cpu", c.usage);
    $("#cpu-pct").textContent  = c.usage;
    $("#cpu-pct").closest(".big").className = "big " + HCLS[health(c.usage, 70, 90)];
    $("#cpu-bar").innerHTML    = meter(c.usage);
    $("#cpu-spark").innerHTML = sparkSvg(hist.cpu);
    const ratio = c.cores ? c.load[0] / c.cores : 0;
    const lh = HL[health(ratio, 1, 2)];
    $("#cpu-load").innerHTML = `<span class="${lh}">${c.load.map(x => x.toFixed(2)).join(" / ")}</span>`;
    $("#cpu-loadn").textContent = c.cores ? ratio.toFixed(2) + " × " + c.cores : "—";
    $("#cpu-note").textContent = c.cores + " threads";
    const per = c.per || [];
    $("#cpu-cores").innerHTML = per.map(v => {
      const cls = v >= 85 ? "max" : v >= 55 ? "hot" : "";
      return `<span class="cbar ${cls}" title="${v}%"><i data-h="${clamp(v, 2, 100)}"></i></span>`;
    }).join("");
    $("#cpu-cores-wrap").classList.toggle("hidden", !per.length);
  }

  // thermal
  if (d.temp) {
    const t = d.temp, pkg = t.package;
    if (pkg != null) pushHist("temp", pkg);
    const hc = HCLS[pkg == null ? "ok" : health(pkg, 70, 85)];
    $("#temp-pkg").textContent = pkg != null ? fmtTemp(pkg).replace("°", "") : "—";
    $("#temp-unit").textContent = tempUnit() + " package";
    $("#temp-pkg").closest(".big").className = "big " + hc;
    const tp = pkg != null ? tempPct(pkg) : 0;
    $("#temp-bar").innerHTML = meter(tp, hc).replace(/<span class="pct">.*?<\/span>/,
      `<span class="pct">${pkg != null ? fmtTemp(pkg) : "--"}</span>`);
    $("#temp-spark").innerHTML = sparkSvg(hist.temp.map(tempPct));
    if (hist.temp.length) {
      const lo = Math.min(...hist.temp), hi = Math.max(...hist.temp);
      const av = hist.temp.reduce((a, b) => a + b, 0) / hist.temp.length;
      $("#temp-range").textContent = `${fmtTemp(lo)} – ${fmtTemp(hi)}  ·  avg ${fmtTemp(av)}`;
    }
    const cores = (t.sensors || []).filter(s => /core/i.test(s.label));
    $("#temp-cores").textContent = cores.length
      ? cores.map(s => s.label.replace(/^Core /, "c") + " " + fmtTemp(s.value)).join("  ")
      : (t.sensors || []).map(s => s.label + " " + fmtTemp(s.value)).join("  ");
  }

  // storage
  if (d.disks) {
    $("#disks").innerHTML = d.disks.map(dk => {
      const meta = (cfg.disks && cfg.disks[dk.mount]) || {};
      const name = esc(meta.label || diskLabel(dk.mount));
      const kind = esc(dk.model
        ? dk.model + (dk.rotational ? " · hdd" : " · ssd")
        : (dk.fstype || dk.source || ""));
      const warn = meta.warn ? ` <span class="dwarn">⚠ ${esc(meta.warn)}</span>` : "";
      if (dk.mounted === false) {
        return `<div class="disk"><div class="dtop">
          <span class="dname">${name} <span class="muted">${esc(dk.mount)}</span></span>
          <span class="v hl-amber">not mounted</span></div>${warn ? `<div class="dmodel">${warn}</div>` : ""}</div>`;
      }
      const cls = HCLS[health(dk.pct, 78, 90)];
      const freePct = dk.size ? (dk.avail / dk.size) * 100 : 100;
      const freeCls = freePct < 5 ? "hl-red" : freePct < 10 ? "hl-amber" : "dfree";
      return `<div class="disk">
        <div class="dtop">
          <span class="dname">${name} <span class="muted">${esc(dk.mount)}</span></span>
          <span class="v">${fmtBytes(dk.used)} / ${fmtBytes(dk.size)}</span>
        </div>
        ${meter(dk.pct, cls)}
        <div class="dmodel">${kind} <span class="${freeCls}">· ${fmtBytes(dk.avail)} free</span>${warn}</div>
      </div>`;
    }).join("");
  }

  // network
  if (d.net) {
    const n = d.net;
    $("#net-iface").textContent = n.iface || "";
    $("#net-rx-rate").textContent = fmtRate(n.rateRx);
    $("#net-tx-rate").textContent = fmtRate(n.rateTx);

    const trow = (label, o, withAvg) => `<tr>`
      + `<td>${label}</td>`
      + `<td class="rx">${fmtBytes(o.rx)}</td>`
      + `<td class="tx">${fmtBytes(o.tx)}</td>`
      + `<td>${fmtBytes(o.rx + o.tx)}</td>`
      + `<td class="rx">${withAvg ? fmtRate(o.avgRx) : "—"}</td>`
      + `<td class="tx">${withAvg ? fmtRate(o.avgTx) : "—"}</td>`
      + `</tr>`;
    // without vnStat only the live rate is known
    $("#net-tbody").innerHTML = [["today", n.today, true], ["month", n.month, true], ["all time", n.total, false]]
      .filter(([, o]) => o).map(([label, o, avg]) => trow(label, o, avg)).join("");

    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const frac = (now.getDate() - 1 + now.getHours() / 24) / dim;
    $("#net-est").textContent = !n.month ? "live rate only · install vnstat for today, month and 30-day history"
      : frac > 0.02 ? "projected " + fmtBytes((n.month.rx + n.month.tx) / frac) + " this month" : "";

    netData = n;
    renderNetBars();
  }
  const shown = panelSet(currentNode || localNode).panels;
  $("[data-panel=network]").classList.toggle("hidden",
    !d.net || shown.network === false);

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;

  // a node without a group: hide its panel, never keep the previous node's
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
  }
}

/* ------------------------------------------------------------------ network bars */
let netData = null;
let netView = "30d";            // "30d" | "24h"
function renderNetBars() {
  const n = netData;
  if (!n) return;
  $$(".nvtoggle").forEach(s => s.classList.toggle("on", s.dataset.v === netView));
  const rows = (netView === "24h" ? n.hours : n.days) || [];
  const peak = Math.max(...rows.map(x => x.rx + x.tx), 1);
  $("#net-bars").innerHTML = rows.map(x =>
    `<span class="d" data-t="${esc(x.title)}" data-rx="${x.rx}" data-tx="${x.tx}">`
    + `<span class="up" data-h="${((x.tx / peak) * 100).toFixed(2)}"></span>`
    + `<span class="dn" data-h="${((x.rx / peak) * 100).toFixed(2)}"></span></span>`).join("");
  if (!rows.length) { $("#net-days-range").textContent = ""; return; }
  const busy = rows.reduce((a, x) => (x.rx + x.tx) > (a.rx + a.tx) ? x : a);
  const sep = ' <span class="muted">|</span> ';
  $("#net-days-range").innerHTML =
    `peak${sep}${esc(busy.label)}${sep}`
    + `<span class="rx">&#8595;&nbsp;${fmtBytes(busy.rx)}</span> `
    + `<span class="tx">&#8593;&nbsp;${fmtBytes(busy.tx)}</span> `
    + `<span class="v">${fmtBytes(busy.rx + busy.tx)}</span>`;
}

/* ------------------------------------------------------------------ docker panel */
let dockerData = null;
let svcSort = "mem";
let svcExpanded = false;
let ctlAllowed = false;         // container start/stop/restart/logs available to this client
const SVC_LIMIT = 10;
const esc = s => String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function portainerLink(c) {
  const base = (cfg.portainerUrl || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base) || !c.id) return "";   // only real http(s) URLs
  const ep = +cfg.portainerEndpoint || 1;
  return `<a class="sb" href="${esc(base)}/#!/${ep}/docker/containers/${esc(c.id)}" target="_blank" rel="noopener">↗ portainer</a>`;
}
function ctlButtons(c) {
  if (!ctlAllowed || !isLocalView()) return "";
  const p = portainerLink(c);
  const run = c.state === "running";
  return `<div class="svc-ctl">`
    + (run
        ? `<button class="sb" data-a="restart">⟳ restart</button>`
          + `<button class="sb stop" data-a="stop">◼ stop</button>`
        : `<button class="sb start" data-a="start">▶ start</button>`)
    + p
    + `<button class="sb" data-a="logs">≡ logs</button>`
    + `</div>`;
}
const CPUCLS = { ok: "cpu-ok", warn: "cpu-hot", crit: "cpu-max" };
// default disk name when config.json has no label: "/" is "system", else the last path part
function diskLabel(mount) {
  if (mount === "/") return "system";
  const parts = String(mount).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(mount);
}

function cpuClass(cpu) { return CPUCLS[health(cpu || 0, 50, 80)]; }

function renderDocker() {
  const list = dockerData;
  if (!list) return;
  const up = list.filter(c => c.state === "running");
  const totMem = up.reduce((s, c) => s + (c.mem || 0), 0);
  const totCpu = up.reduce((s, c) => s + (c.cpu || 0), 0);
  const haveStats = up.some(c => c.mem != null);
  const maxMem = Math.max(...up.map(c => c.mem || 0), 1);

  $("#docker-note").textContent = `${up.length}/${list.length} up`
    + (haveStats ? ` · ${fmtBytes(totMem)} · ${totCpu.toFixed(0)}% cpu` : "")
    + (!isLocalView() ? " · controls: hub host only" : ctlAllowed ? "" : " · controls: LAN only");
  $$(".svsort").forEach(s => s.classList.toggle("on", s.dataset.s === svcSort));
  $("#docker-list").classList.toggle("ctl", ctlAllowed && isLocalView());
  const openNames = new Set($$(".svc.open", $("#docker-list")).map(el => el.dataset.name));

  const running = up.slice().sort((a, b) => svcSort === "cpu"
    ? (b.cpu || 0) - (a.cpu || 0) : (b.mem || 0) - (a.mem || 0));
  const others = list.filter(c => c.state !== "running");   // always shown
  const shown = svcExpanded ? running : running.slice(0, SVC_LIMIT);
  const hidden = running.length - shown.length;

  const row = c => {
    let cd = "idle";
    if (c.state === "running") cd = c.health === "unhealthy" ? "warn" : "up";
    else if (c.state === "exited" || c.state === "dead") cd = "down";
    const name = `<span class="sname"><span class="cd ${cd}"></span>${esc(c.name)}</span>`;
    const stats = (c.state === "running" && c.mem != null);
    const memRel = stats ? (c.mem / maxMem) * 100 : 0;      // vs the biggest container
    const memCls = HL[health(c.mem || 0, 5e8, 2e9)];
    const cpuHl  = HL[health(c.cpu || 0, 50, 80)];
    const open = openNames.has(c.name) ? " open" : "";
    const main = stats
      ? name
        + `<span class="scpubar${(c.cpu || 0) > 0.5 ? "" : " flat"}"><i data-w="${(c.cpu || 0) > 0.5 ? clamp(c.cpu, 1, 100) : 0}"></i></span>`
        + `<span class="scpu ${cpuHl}">${c.cpu == null ? "–" : c.cpu.toFixed(c.cpu < 10 ? 1 : 0) + "%"}</span>`
        + `<span class="smem ${memCls}" title="resident memory · ${memRel.toFixed(0)}% of the largest">${fmtBytes(c.mem)}</span>`
      : name + `<span class="sstate">${esc(c.state)}</span>`;
    return `<div class="svc ${cpuClass(c.cpu)}${open}" data-name="${esc(c.name)}" `
      + `title="${esc(c.name)} — ${esc(c.status || "")}">`
      + `<div class="svc-main">${main}</div>`
      + ctlButtons(c)
      + `</div>`;
  };
  $("#docker-list").innerHTML = [...shown, ...others].map(row).join("");

  const more = $("#svc-more");
  if (!svcExpanded && hidden > 0) {
    more.textContent = `show ${hidden} more ▾`; more.classList.remove("hidden");
  } else if (svcExpanded && running.length > SVC_LIMIT) {
    more.textContent = "show less ▴"; more.classList.remove("hidden");
  } else {
    more.classList.add("hidden");
  }
}

/* container actions */
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = isErr ? "show err" : "show";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = "", 2600);
}
let confirmResolve = null;
function confirmDialog(msg, { title = "confirm", note = "", yes = "confirm", danger = false } = {}) {
  $("#confirm-title").textContent = title;
  $("#confirm-msg").innerHTML = esc(msg) + (note ? `<span class="cq">${esc(note)}</span>` : "");
  const y = $("#confirm-yes");
  y.textContent = yes;
  y.classList.toggle("danger", danger);
  $("#confirm-overlay").classList.add("open");
  y.focus();
  return new Promise(res => { confirmResolve = res; });
}
function closeConfirm(v) {
  $("#confirm-overlay").classList.remove("open");
  const r = confirmResolve; confirmResolve = null;
  if (r) r(v);
}

async function containerAction(name, action, btn) {
  if (action === "stop" && !await confirmDialog(`Stop “${name}”?`, {
    title: "stop container", yes: "stop " + name, danger: true,
    note: "It won't start again until you start it or the host reboots.",
  })) return;
  if (btn) { btn.disabled = true; }
  try {
    const r = await fetch(`/__ctl/container/${encodeURIComponent(name)}/${action}${nodeQuery()}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || `${action} failed (${r.status})`, true); return; }
    toast(`${name}: ${action} ok`);
    refreshNow();                       // pick up the new state
  } catch (e) {
    toast(`${action} failed`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function showLogs(name) {
  $("#logs-title").textContent = name + " · logs";
  $("#logs-body").textContent = "loading…";
  $("#logs-overlay").classList.add("open");
  try {
    const r = await fetch(`/__ctl/container/${encodeURIComponent(name)}/logs${nodeQuery()}`);
    const txt = await r.text();
    $("#logs-body").textContent = r.ok ? (txt || "(no output)") : `error: ${txt}`;
    const b = $("#logs-body"); b.scrollTop = b.scrollHeight;
  } catch (e) {
    $("#logs-body").textContent = "failed to fetch logs";
  }
}

/* ------------------------------------------------------------------ render: clocks */
function renderClocks() {
  const host = $("#clocks");
  host.innerHTML = (cfg.clocks || []).map((c, i) =>
    `<div class="clock" data-i="${i}"><div class="cl">${esc(c.label)}</div>
     <div class="ct">--:--:--</div><div class="cdte"></div></div>`).join("");
  tickClocks();
}
function tickClocks() {
  const now = new Date();
  $("#headclock").textContent = fmtTime(now);
  $("#headdate").textContent = now.toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  $$("#clocks .clock").forEach(el => {
    const c = cfg.clocks[+el.dataset.i];
    if (!c) return;
    try {
      el.querySelector(".ct").textContent =
        fmtTime(now, c.tz);
      el.querySelector(".cdte").textContent =
        now.toLocaleDateString("en-GB", { timeZone: c.tz, weekday: "short", day: "numeric", month: "short" });
    } catch (e) { el.querySelector(".ct").textContent = "bad tz"; }
  });
}

/* ------------------------------------------------------------------ render: weather */
const WMO = {
  0: ["☀️", "clear"], 1: ["\u{1f324}️", "mainly clear"], 2: ["⛅", "partly cloudy"],
  3: ["☁️", "overcast"], 45: ["\u{1f32b}️", "fog"], 48: ["\u{1f32b}️", "rime fog"],
  51: ["\u{1f326}️", "light drizzle"], 53: ["\u{1f326}️", "drizzle"], 55: ["\u{1f327}️", "dense drizzle"],
  61: ["\u{1f327}️", "light rain"], 63: ["\u{1f327}️", "rain"], 65: ["\u{1f327}️", "heavy rain"],
  71: ["\u{1f328}️", "light snow"], 73: ["\u{1f328}️", "snow"], 75: ["❄️", "heavy snow"],
  80: ["\u{1f326}️", "showers"], 81: ["\u{1f327}️", "rain showers"], 82: ["⛈️", "violent showers"],
  95: ["⛈️", "thunderstorm"], 96: ["⛈️", "thunderstorm"], 99: ["⛈️", "hailstorm"]
};
let wxCache = { at: 0, html: "" };

async function renderWeather(force) {
  const host = $("#weather");
  const locs = cfg.weather || [];
  if (!locs.length) { host.innerHTML = '<span class="muted">no locations — add in settings</span>'; return; }
  if (!force && Date.now() - wxCache.at < 10 * 60 * 1000 && wxCache.html) { host.innerHTML = wxCache.html; return; }
  try {
    const parts = await Promise.all(locs.map(async l => {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${l.latitude}&longitude=${l.longitude}`
        + `&current=temperature_2m,apparent_temperature,weather_code`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`;
      const r = await (await fetch(u)).json();
      const w = WMO[r.current.weather_code] || ["\u{1f321}️", ""];
      const d = r.daily, dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const fc = (d.time || []).slice(1, 4).map((iso, i) => {
        const n = i + 1, fw = WMO[d.weather_code[n]] || ["", ""];
        const day = dow[new Date(iso + "T12:00").getDay()];
        return `<span class="fc"><span class="fcd">${day}</span> ${fw[0]}
          <span class="fct">${fmtTemp(d.temperature_2m_max[n])}<span class="fcl">${fmtTemp(d.temperature_2m_min[n])}</span></span></span>`;
      }).join("");
      return `<div class="wc">
        <div class="wnow">
          <span class="wicon">${w[0]}</span>
          <span>
            <span class="wname">${esc(l.name)}</span> <span class="wtemp">${fmtTemp(r.current.temperature_2m)}</span><br>
            <span class="wsub">${w[1]} · feels ${fmtTemp(r.current.apparent_temperature)}
            · H ${fmtTemp(d.temperature_2m_max[0])} L ${fmtTemp(d.temperature_2m_min[0])}</span>
          </span>
        </div>
        <div class="wfc">${fc}</div>
      </div>`;
    }));
    wxCache = { at: Date.now(), html: parts.join("") };
    host.innerHTML = wxCache.html;
  } catch (e) {
    host.innerHTML = '<span class="muted">weather unavailable (no internet?)</span>';
  }
}

/* ------------------------------------------------------------------ loop
   The agent only samples on demand (it wakes on the /__ctl/refresh trigger),
   so the page drives the cadence: one refresh on load, then every refreshSec
   while the tab is visible. When it's hidden nothing polls, and the agent
   falls back to its own slow INTERVAL heartbeat. */
let loopTimer = null, clockTimer = null, wxTimer = null;

function scheduleLoop() {
  clearInterval(loopTimer);
  loopTimer = setInterval(() => { if (!document.hidden) refreshNow(true); },
                          (cfg.refreshSec || 60) * 1000);
}
function startLoop() { scheduleLoop(); refreshNow(true); }

function startTimers() {
  stopTimers();                    // idempotent — never stack intervals
  scheduleLoop();
  clockTimer = setInterval(tickClocks, 1000);
  wxTimer    = setInterval(() => renderWeather(), 60 * 1000);
}
function stopTimers() {
  [loopTimer, clockTimer, wxTimer].forEach(clearInterval);
  loopTimer = clockTimer = wxTimer = null;
}

let refreshing = false;
async function refreshNow(silent) {
  if (!silent) {
    const dot = $("#statusdot");
    dot.classList.remove("flash"); void dot.offsetWidth; dot.classList.add("flash");
  }
  if (refreshing) return;
  refreshing = true;
  await tick();                                   // show the current snapshot first
  if (view === "fleet") {
    try { await fetch("/__ctl/refresh?node=all", { method: "POST" }); } catch (e) {}
    await new Promise(r => setTimeout(r, 2500));  // agents answer a wake within about 2 s
    await tick();
    refreshing = false;
    return;
  }
  const before = lastData ? lastData.ts : 0;
  try { await fetch("/__ctl/refresh" + nodeQuery(), { method: "POST" }); } catch (e) {}
  // then poll until the agent publishes one newer than that (or give up ~7 s)
  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, 500));
    await tick();
    if (lastData && lastData.ts > before) break;
  }
  refreshing = false;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTimers();
  else { startTimers(); tickClocks(); renderWeather(); refreshNow(true); }
});

/* ------------------------------------------------------------------ settings, loaded on first use (spec 10.5) */
let whoUser = "";
let panelFor = "all";   // "all" or a node id
// an import not saved is undone when settings close
let beforeImport = null;
function closeSettings() {
  if (beforeImport) { cfg = beforeImport; beforeImport = null; }
  applyLayout();
  $("#overlay").classList.remove("open");
}
let settingsReady = null;
function openSettings() {
  settingsReady = settingsReady || new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "js/settings.js";
    // a file that loads but sets nothing up (the hub sent its login page because the session
    // ended, or the hub was upgraded under this page) is not appended again: reload
    s.onload = () => {
      try {
        if (typeof initSettings !== "function") throw new Error("settings.js did not load");
        initSettings(); ok();
      } catch (e) { fail(e); }
    };
    s.onerror = () => { settingsReady = null; fail(new Error("settings.js")); };
    document.head.appendChild(s);
  });
  return settingsReady.then(() => showSettings(),
    () => toast("could not open the settings: the session may have ended, reload the page", true));
}

/* ------------------------------------------------------------------ boot */
(async function () {
  applyStrings(document);
  await loadConfig();
  $("#ps1").textContent = "visitor@" + (cfg.title || "host");
  applyAppearanceDefaults();
  applyBranding();
  renderClocks();
  applyLayout();
  renderWeather();
  tickClocks();
  await loadNodes();
  route();
  window.addEventListener("hashchange", () => { route(); refreshNow(true); });
  startKiosk();
  $("#tabs").onclick = e => {
    const b = e.target.closest("button[data-go]");
    if (b) location.hash = b.dataset.go === "fleet" ? "#fleet" : "#node=" + b.dataset.go;
  };
  $("#fleet").onclick = e => {
    const c = e.target.closest(".ncard[data-node]");
    if (c) location.hash = "#node=" + c.dataset.node;
  };
  startTimers();
  refreshNow(true);       // a fresh sample for the first view, not a stale data.json

  $("#btn-settings").onclick = openSettings;
  $("#settings-close").onclick = closeSettings;
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-style").onclick = toggleStyle;
  $("#btn-refresh").onclick = refreshNow;
  $("#svc-more").onclick = () => { svcExpanded = !svcExpanded; renderDocker(); };
  $$(".svsort").forEach(s => s.onclick = () => { svcSort = s.dataset.s; renderDocker(); });
  $("#overlay").onclick = e => { if (e.target === $("#overlay")) closeSettings(); };

  // container controls: is this client allowed?
  try {
    const w = await (await fetch("/__ctl/whoami")).json();
    ctlAllowed = !!w.controls;
    whoUser = w.user || "";
    applyVersion(w.version);
  } catch (e) { ctlAllowed = false; }
  if (dockerData) renderDocker();

  $("#docker-list").addEventListener("click", e => {
    const btn = e.target.closest("button.sb");
    if (btn) {
      const name = btn.closest(".svc")?.dataset.name;
      const a = btn.dataset.a;
      if (!name || !a) return;
      if (a === "logs") showLogs(name);
      else containerAction(name, a, btn);
      return;
    }
    // click the row (not a link) to reveal / hide its controls
    if (e.target.closest("a")) return;
    const main = e.target.closest(".svc-main");
    if (main && ctlAllowed) {
      const row = main.parentElement, wasOpen = row.classList.contains("open");
      $$(".svc.open", $("#docker-list")).forEach(el => el.classList.remove("open"));
      row.classList.toggle("open", !wasOpen);   // one open at a time
    }
  });
  $("#logs-close").onclick = () => $("#logs-overlay").classList.remove("open");
  $("#logs-overlay").onclick = e => { if (e.target === $("#logs-overlay")) $("#logs-overlay").classList.remove("open"); };
  $("#confirm-yes").onclick = () => closeConfirm(true);
  $("#confirm-no").onclick = () => closeConfirm(false);
  $("#confirm-x").onclick = () => closeConfirm(false);
  $("#confirm-overlay").onclick = e => { if (e.target === $("#confirm-overlay")) closeConfirm(false); };

  // network bar tooltip + 30d/24h toggle
  const tip = $("#nettip");
  $("#net-bars").addEventListener("mousemove", e => {
    const d = e.target.closest(".d");
    if (!d) { tip.classList.remove("show"); return; }
    const rx = +d.dataset.rx, tx = +d.dataset.tx;
    tip.innerHTML = `<div class="nd">${esc(d.dataset.t)}</div>`
      + `<span class="rx">↓ ${fmtBytes(rx)}</span>  <span class="tx">↑ ${fmtBytes(tx)}</span>`
      + `  <span class="muted">= ${fmtBytes(rx + tx)}</span>`;
    tip.classList.add("show");
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 12, y = e.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
    if (y < 8) y = e.clientY + 16;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  $("#net-bars").addEventListener("mouseleave", () => tip.classList.remove("show"));
  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });

  // the installable app (spec 10.3): browsers allow a service worker over HTTPS (and on this machine)
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  // logging out leaves no copy of the page behind
  $(".logout-form").addEventListener("submit", () => { if (window.caches) caches.keys().then(keys => keys.forEach(k => caches.delete(k))); });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if ($("#confirm-overlay").classList.contains("open")) {
      if (e.key === "Escape") closeConfirm(false);
      if (e.key === "Enter") { e.preventDefault(); closeConfirm(true); }
      return;
    }
    if (e.key === "s") { e.preventDefault(); $("#overlay").classList.contains("open") ? closeSettings() : openSettings(); }
    if (e.key === "t") toggleTheme();
    if (e.key === "y") toggleStyle();
    if (e.key === "r") { e.preventDefault(); refreshNow(); }
    if (e.key === "f" && fleetNodes.length > 1) location.hash = "#fleet";
    if (e.key === "Escape") { closeSettings(); $("#logs-overlay").classList.remove("open"); }
  });
})();
