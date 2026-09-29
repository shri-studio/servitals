// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* the settings panel and the login form: loaded by openSettings() in app.js */
/* ------------------------------------------------------------------ settings UI */
const COMMON_TZ = ["UTC",
  "America/Chicago","America/Denver","America/Los_Angeles","America/Mexico_City","America/New_York",
  "America/Sao_Paulo","America/Toronto",
  "Africa/Cairo","Africa/Johannesburg","Africa/Lagos",
  "Asia/Bangkok","Asia/Dubai","Asia/Hong_Kong","Asia/Jakarta","Asia/Jerusalem","Asia/Karachi",
  "Asia/Kolkata","Asia/Muscat","Asia/Shanghai","Asia/Singapore","Asia/Tehran","Asia/Tokyo",
  "Australia/Sydney","Pacific/Auckland",
  "Europe/Berlin","Europe/Istanbul","Europe/London","Europe/Madrid","Europe/Moscow","Europe/Paris"];

// settings import: an exported file back in, known settings only, each of the right kind
function importSettings(text) {
  if (typeof text !== "string" || text.length > 512 * 1024) return { ok: false, error: tr("set.importBig") };
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: tr("set.importNotJson") }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: tr("set.importNotSettings") };
  const kinds = { title: "string", favicon: "string", portainerUrl: "string", style: "string", mode: "string",
                  density: "string", refreshSec: "number", kioskSec: "number", kiosk: "boolean", portainerEndpoint: "number",
                  weather: "array", clocks: "array", panelOrder: "array",
                  panels: "object", panelSize: "object", nodePanels: "object", units: "object", fleet: "object", disks: "object" };
  const kindOf = v => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  const UNSAFE = ["__proto__", "constructor", "prototype"];
  // nested objects: own keys only, never the ones that reach Object.prototype
  const plain = o => Object.fromEntries(Object.entries(o).filter(([k]) => !UNSAFE.includes(k))
    .map(([k, v]) => [k, kindOf(v) === "object" ? plain(v) : v]));
  const words = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : undefined);
  const clean = {
    fleet: f => Object.fromEntries(Object.entries(f).map(([k, v]) =>
      [k, ["pinned", "hidden", "card"].includes(k) ? words(v) : k === "sort" && typeof v === "string" ? v
        : k === "group" && typeof v === "boolean" ? v : undefined]).filter(([, v]) => v !== undefined)),
    nodePanels: n => plain(Object.fromEntries(Object.entries(n).filter(([, v]) => kindOf(v) === "object" && kindOf(v.panels) === "object"))),
  };
  const out = {}, skipped = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!Object.prototype.hasOwnProperty.call(kinds, k)) { skipped.push(k); continue; }
    if (kindOf(v) !== kinds[k]) return { ok: false, error: tr("set.importKind", { key: k, kind: tr("set.kind." + kinds[k]) }) };
    out[k] = clean[k] ? clean[k](v) : kinds[k] === "object" ? plain(v) : v;
  }
  return { ok: true, cfg: out, skipped };
}

// what the servers section shows now, saved or not
function readServersForm() {
  const rows = $$("#cfg-servers .srv");
  return {
    sort: $("#cfg-f-sort").value, group: $("#cfg-f-group").checked,
    card: $$("#cfg-f-card input:checked").map(i => i.value),
    pinned: rows.filter(r => $(".srv-pin", r).checked).map(r => r.dataset.id),
    hidden: rows.filter(r => $(".srv-hide", r).checked).map(r => r.dataset.id),
    names: Object.fromEntries(rows.map(r => [r.dataset.id, { name: $(".srv-name", r).value, tags: $(".srv-tags", r).value }])),
  };
}
// settings → servers: fleet order and card numbers, and one row per server.
// keep: redraw for a changed server list without losing what the person has not saved yet
function renderServers({ keep = false } = {}) {
  const drawn = keep && $$("#cfg-servers .srv").length > 0;
  const f = drawn ? readServersForm() : { ...(cfg.fleet || {}), card: cardNumbers(), names: {} };
  const list = v => (Array.isArray(v) ? v : []);
  $("#cfg-f-sort").value = f.sort || "name";
  $("#cfg-f-group").checked = !!f.group;
  const cards = list(f.card);
  $("#cfg-f-card").innerHTML = CARD_KEYS.map(k => `<label class="check"><input type="checkbox" value="${k}"`
    + `${cards.includes(k) ? " checked" : ""}> <span>${esc(tr("set.card." + k))}</span></label>`).join("");
  const pinned = new Set(list(f.pinned)), hidden = new Set(list(f.hidden));
  const typed = (n, k, saved) => (f.names[n.id] ? f.names[n.id][k] : saved);
  const byFile = ` disabled title="${esc(tr("set.managedName"))}"`;
  $("#cfg-servers").innerHTML = fleetNodes.map(n => `<div class="srv" data-id="${esc(n.id)}" data-managed="${esc((n.managed || []).join(" "))}">`
    + `<input type="text" class="srv-name" value="${esc(typed(n, "name", n.name))}" maxlength="64" aria-label="${esc(tr("set.srvName", { name: n.name }))}"`
    + `${(n.managed || []).includes("name") ? byFile : ""}>`
    + `<input type="text" class="srv-tags" value="${esc(typed(n, "tags", (n.tags || []).join(", ")))}" placeholder="${esc(tr("set.srvTagsPh"))}" aria-label="${esc(tr("set.srvTags", { name: n.name }))}"`
    + `${(n.managed || []).includes("tags") ? byFile : ""}>`
    + `<label class="check"><input type="checkbox" class="srv-pin"${pinned.has(n.id) ? " checked" : ""}> <span>${esc(tr("set.srvPin"))}</span></label>`
    + `<label class="check"><input type="checkbox" class="srv-hide"${hidden.has(n.id) ? " checked" : ""}> <span>${esc(tr("set.srvHide"))}</span></label>`
    + (n.local ? `<span class="local">${esc(tr("set.srvThisHub"))}</span>` : `<button class="srv-revoke">${esc(tr("set.srvRevoke"))}</button>`)
    + `</div>`).join("");
  markManaged();
}
async function saveServer(row) {
  // a field a conf.d file manages is never sent (the hub would refuse the whole change)
  const managed = (row.dataset.managed || "").split(" ");
  const body = {};
  if (!managed.includes("name")) body.name = $(".srv-name", row).value;
  if (!managed.includes("tags")) body.tags = $(".srv-tags", row).value.split(/[\s,]+/).filter(Boolean);
  const r = await fetch(`/__ctl/node/${row.dataset.id}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || tr("set.srvNotSaved"), true);
  toast(tr("set.srvSaved"));
  await loadNodes();
}
async function revokeServer(row) {
  const name = $(".srv-name", row).value;
  const ok = await confirmDialog(tr("set.revokeQ", { name }), { title: tr("set.revokeTitle"), yes: tr("set.srvRevoke"), danger: true,
    note: tr("set.revokeNote") });
  if (!ok) return;
  const r = await fetch(`/__ctl/node/${row.dataset.id}/revoke`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || tr("set.revokeFailed"), true);
  toast(tr("set.revoked", { name }));
  await loadNodes();
  route();   // the page may have been showing that server
  if (view === "fleet") renderFleet();
  renderServers({ keep: true });
  drawPanelCfg();
}

function showSettings() {
  $("#tzlist").innerHTML = COMMON_TZ.map(t => `<option value="${t}">`).join("");
  drawWeatherCfg();
  drawClockCfg();
  drawPanelCfg();
  $("#cfg-name").value = cfg.title || "";
  $("#fav-preview").src = cfg.favicon || $("#favicon").href;
  $("#fav-emoji").value = "";
  $("#cfg-refresh").value = cfg.refreshSec;
  $("#export-wrap").classList.add("hidden");
  $("#acct-user").value = whoUser;
  $("#cfg-style").innerHTML = STYLE_GROUPS.map(g => `<optgroup label="${esc(tr("styles." + g))}">`
    + STYLES.filter(x => x.group === g).map(x => `<option value="${x.id}">${esc(tr("style." + x.id))}</option>`).join("")
    + "</optgroup>").join("");
  $("#cfg-mode").innerHTML = MODES.map(m => `<option value="${m}">${esc(tr("mode." + m))}</option>`).join("");
  $("#cfg-density").innerHTML = DENSITIES.map(n => `<option value="${n}">${esc(tr("density." + n))}</option>`).join("");
  $("#cfg-style").value = currentStyle();
  $("#cfg-mode").value = currentMode();
  $("#cfg-density").value = currentDensity();
  $("#cfg-lookdefault").checked = false;
  $("#cfg-kiosk").checked = !!cfg.kiosk;
  $("#cfg-kiosksec").value = cfg.kioskSec || 20;
  for (const [k, v] of Object.entries(units())) $("#cfg-u-" + k).value = v;
  renderServers();
  loadNodes().then(() => renderServers({ keep: true }));
  markManaged();
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
}

/* ------------------------------------------------------------------ login
   Name and password live in the hub (admin.json). Changing them needs the
   current password and logs out every other session. */
async function saveAccount() {
  const msg = $("#acct-msg");
  const user = $("#acct-user").value.trim();
  const password = $("#acct-new").value;
  if (password !== $("#acct-new2").value) { msg.textContent = tr("set.loginDiffer"); return; }
  let r, d;
  try {
    r = await fetch("/__ctl/account", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: $("#acct-current").value, user, password }),
    });
    d = await r.json();
  } catch (e) { msg.textContent = tr("set.loginUnreachable"); return; }
  if (!r.ok) { msg.textContent = d.error || tr("set.loginNotSaved"); return; }
  whoUser = d.user;
  ["#acct-current", "#acct-new", "#acct-new2"].forEach(sel => { $(sel).value = ""; });
  msg.textContent = tr("set.loginSaved", { user: d.user });
}

/* panels: order (drag, or the up and down buttons) is shared; which panels show
   and their sizes can be one server's own (spec 10.4) */
let dragPanel = null;
function editedSet() {
  if (panelFor === "all") return panelSet(null);
  return panelSet(panelFor);
}
// a server's own set starts as a copy of the shared one, on its first change
function ownSet() {
  if (panelFor === "all") return panelSet(null);
  cfg.nodePanels = cfg.nodePanels || {};
  if (!cfg.nodePanels[panelFor]) cfg.nodePanels[panelFor] = structuredClone(panelSet(null));
  return cfg.nodePanels[panelFor];
}
function drawPanelFor() {
  const sel = $("#cfg-p-for");
  sel.innerHTML = `<option value="all">${esc(tr("set.panelsAll"))}</option>` + fleetNodes.map(n =>
    `<option value="${esc(n.id)}">${esc(cfg.nodePanels && cfg.nodePanels[n.id] ? tr("set.panelsOwn", { name: n.name }) : n.name)}</option>`).join("");
  if (panelFor !== "all" && !fleetNodes.some(n => n.id === panelFor)) panelFor = "all";
  sel.value = panelFor;
  $("#cfg-p-reset").classList.toggle("hidden", !(panelFor !== "all" && cfg.nodePanels && cfg.nodePanels[panelFor]));
}
function drawPanelCfg() {
  const host = $("#cfg-panels");
  const set = editedSet();
  const orderManaged = managedPaths().includes("panelOrder");
  drawPanelFor();
  host.innerHTML = cfg.panelOrder.map(p => {
    const on = set.panels[p] !== false;
    const sz = (set.panelSize && set.panelSize[p]) || "normal";
    const opt = s => `<option value="${s}" ${sz === s ? "selected" : ""}>${esc(tr("size." + s))}</option>`;
    return `<div class="pcf ${on ? "" : "off"}" draggable="${orderManaged ? "false" : "true"}" data-p="${p}">
      <span class="grip">⠿</span>
      <span class="pn">${esc(tr("panel." + p))}</span>
      <button data-up aria-label="${esc(tr("set.panelUp", { panel: tr("panel." + p) }))}">&uarr;</button><button data-down aria-label="${esc(tr("set.panelDown", { panel: tr("panel." + p) }))}">&darr;</button>
      <select data-sz aria-label="${esc(tr("set.panelSize", { panel: tr("panel." + p) }))}">${opt("normal")}${opt("wide")}${opt("full")}</select>
      <label><input type="checkbox" data-vis ${on ? "checked" : ""}> <span>${esc(tr("set.panelShow"))}</span></label>
    </div>`;
  }).join("");
  const move = (p, by) => {
    const from = cfg.panelOrder.indexOf(p), to = from + by;
    if (from < 0 || to < 0 || to >= cfg.panelOrder.length) return;
    cfg.panelOrder.splice(to, 0, cfg.panelOrder.splice(from, 1)[0]);
    drawPanelCfg();
  };
  $$(".pcf", host).forEach(row => {
    row.ondragstart = e => {
      if (orderManaged) return;
      dragPanel = row.dataset.p; e.dataTransfer.effectAllowed = "move";
    };
    row.ondragover  = e => { e.preventDefault(); row.classList.add("drag-over"); };
    row.ondragleave = () => row.classList.remove("drag-over");
    row.ondrop = e => {
      e.preventDefault(); row.classList.remove("drag-over");
      if (orderManaged) return;
      const from = cfg.panelOrder.indexOf(dragPanel), to = cfg.panelOrder.indexOf(row.dataset.p);
      if (from < 0 || to < 0 || from === to) return;
      cfg.panelOrder.splice(to, 0, cfg.panelOrder.splice(from, 1)[0]);
      drawPanelCfg();
    };
    row.querySelector("[data-up]").onclick = () => move(row.dataset.p, -1);
    row.querySelector("[data-down]").onclick = () => move(row.dataset.p, 1);
    row.querySelector("[data-vis]").onchange = e => {
      ownSet().panels[row.dataset.p] = e.target.checked;
      row.classList.toggle("off", !e.target.checked);
      drawPanelFor();
    };
    row.querySelector("[data-sz]").onchange = e => {
      const set = ownSet();
      (set.panelSize = set.panelSize || {})[row.dataset.p] = e.target.value;
      drawPanelFor();
    };
  });
  markManaged();
}

function drawWeatherCfg() {
  $("#cfg-weather").innerHTML = (cfg.weather || []).map((l, i) =>
    `<div class="item"><span class="txt">${esc(l.name)} <span class="muted">(${(+l.latitude).toFixed(2)}, ${(+l.longitude).toFixed(2)})</span></span>
     <span class="rm" data-wxrm="${i}">x</span></div>`).join("") || `<span class="muted">${esc(tr("set.none"))}</span>`;
  $$("[data-wxrm]").forEach(b => b.onclick = () => { cfg.weather.splice(+b.dataset.wxrm, 1); drawWeatherCfg(); });
}
function drawClockCfg() {
  $("#cfg-clocks").innerHTML = (cfg.clocks || []).map((c, i) =>
    `<div class="item"><span class="txt">${esc(c.label)} <span class="muted">${esc(c.tz)}</span></span>
     <span class="rm" data-clkrm="${i}">x</span></div>`).join("") || `<span class="muted">${esc(tr("set.none"))}</span>`;
  $$("[data-clkrm]").forEach(b => b.onclick = () => { cfg.clocks.splice(+b.dataset.clkrm, 1); drawClockCfg(); });
}

async function wxSearch() {
  const q = $("#wx-search").value.trim();
  if (!q) return;
  $("#wx-results").textContent = tr("set.wxSearching");
  try {
    const r = await (await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6`)).json();
    const res = (r.results || [])
      .filter(x => Number.isFinite(x.latitude) && Number.isFinite(x.longitude))
      .map(x => ({
        name: x.name + (x.admin1 ? ", " + x.admin1 : "") + (x.country_code ? " (" + x.country_code + ")" : ""),
        country: x.country || "", latitude: +x.latitude, longitude: +x.longitude,
      }));
    $("#wx-results").innerHTML = res.length
      ? res.map((x, i) => `<div data-i="${i}">${esc(x.name)} <span class="muted">· ${esc(x.country)}</span></div>`).join("")
      : `<span class="muted">${esc(tr("set.wxNoMatch"))}</span>`;
    $$("#wx-results div[data-i]").forEach(el => el.onclick = () => {
      const { name, latitude, longitude } = res[+el.dataset.i];
      cfg.weather.push({ name, latitude, longitude });
      $("#wx-results").innerHTML = ""; $("#wx-search").value = "";
      drawWeatherCfg();
    });
  } catch (e) { $("#wx-results").textContent = tr("set.wxFailed"); }
}

async function saveSettings() {
  beforeImport = null;   // an import is kept once saved
  cfg.title = $("#cfg-name").value.trim() || "servitals";
  cfg.refreshSec = clamp(+$("#cfg-refresh").value || 60, 5, 900);
  // this browser's look becomes everyone's default only when asked
  if ($("#cfg-lookdefault").checked) {
    cfg.style = currentStyle();
    cfg.mode = currentMode();
    cfg.density = currentDensity();
  }
  const was = !!cfg.kiosk;
  cfg.kiosk = $("#cfg-kiosk").checked;
  // whoever turns kiosk on for everyone keeps the controls in this browser
  if (cfg.kiosk && !was && lsGet("kiosk") === null) lsSet("kiosk", "0");
  cfg.kioskSec = clamp(+$("#cfg-kiosksec").value || 20, 5, 600);
  cfg.units = Object.fromEntries(Object.keys(UNIT_CHOICES).map((k) => [k, $("#cfg-u-" + k).value]));
  const form = readServersForm(), drawn = $$("#cfg-servers .srv").length > 0, prev = cfg.fleet || {};
  cfg.fleet = {
    sort: form.sort, group: form.group, card: form.card.slice(0, 4),
    // without the server list (the hub did not answer) keep what was saved
    pinned: drawn ? form.pinned : prev.pinned || [],
    hidden: drawn ? form.hidden : prev.hidden || [],
  };
  // panels/order/size/favicon are already updated live by the settings widgets

  applyBranding();
  applyLayout();
  renderClocks();
  renderWeather(true);
  startLoop();
  closeSettings();

  // persist: server-side (all viewers) if we can, else per-browser
  const { favicon, ...rest } = cfg;   // put favicon last so config.json stays readable
  const payload = { ...rest, favicon };
  try {
    const r = await fetch("/__ctl/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok) { lsDel("cfg"); toast(tr("set.saved")); return; }
    const j = await r.json().catch(() => ({}));
    saveConfig(); toast(j.error ? tr("set.savedLocalWhy", { error: j.error }) : tr("set.savedLocal"));
  } catch (e) {
    saveConfig(); toast(tr("set.savedLocal"));
  }
}

// wiring for the settings controls, once, when this file has loaded
function initSettings() {
  $("#acct-save").onclick = saveAccount;
  $("#cfg-p-for").onchange = e => { panelFor = e.target.value; drawPanelCfg(); };
  $("#cfg-p-reset").onclick = () => { delete cfg.nodePanels[panelFor]; drawPanelCfg(); };
  $("#cfg-servers").addEventListener("change", e => {
    if (e.target.matches(".srv-name, .srv-tags")) saveServer(e.target.closest(".srv"));
  });
  $("#cfg-servers").addEventListener("click", e => {
    if (e.target.matches(".srv-revoke")) revokeServer(e.target.closest(".srv"));
  });
  $("#cfg-style").onchange = e => { applyStyle(e.target.value); lsSet("style", e.target.value); };
  $("#cfg-mode").onchange = e => { applyMode(e.target.value); lsSet("theme", e.target.value); };
  $("#cfg-density").onchange = e => { applyDensity(e.target.value); lsSet("density", e.target.value); };
  $("#wx-add").onclick = wxSearch;
  $("#wx-search").onkeydown = e => { if (e.key === "Enter") wxSearch(); };
  $("#clk-add").onclick = () => {
    const label = $("#clk-label").value.trim(), tz = $("#clk-tz").value.trim();
    if (!label || !tz) return;
    try { new Date().toLocaleString("en-GB", { timeZone: tz }); } catch (e) { alert(tr("set.clockBadTz")); return; }
    cfg.clocks.push({ label, tz });
    $("#clk-label").value = ""; $("#clk-tz").value = "";
    drawClockCfg();
  };
  $("#cfg-save").onclick = saveSettings;
  $("#cfg-reset").onclick = () => {
    lsDel("cfg");
    cfg = structuredClone(DEFAULTS);
    applyBranding(); openSettings(); renderClocks(); applyLayout(); renderWeather(true); startLoop();
  };
  $("#cfg-export").onclick = () => {
    $("#export-wrap").classList.remove("hidden");
    $("#export-lbl").textContent = tr("set.exportNote");
    $("#export-text").value = JSON.stringify(cfg, null, 2);
    $("#export-text").select();
  };

  // import: fills the form; nothing is saved until the person presses save
  $("#cfg-import").onclick = () => $("#cfg-import-file").click();
  $("#cfg-import-file").onchange = async e => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const r = importSettings(await f.text().catch(() => ""));
    if (!r.ok) return toast(r.error, true);
    if (!beforeImport) beforeImport = cfg;
    cfg = deepMerge(structuredClone(DEFAULTS), r.cfg);
    fixPanelOrder();
    openSettings();
    toast(r.skipped.length ? tr("set.importedSkipped", { keys: r.skipped.join(", ") }) : tr("set.imported"));
  };

  // favicon / name widgets
  $("#fav-upload").onclick = () => $("#fav-file").click();
  $("#fav-file").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 200 * 1024) { toast(tr("set.iconTooBig"), true); return; }
    const rd = new FileReader();
    rd.onload = () => { cfg.favicon = rd.result; $("#fav-preview").src = rd.result; };
    rd.readAsDataURL(f);
  };
  $("#fav-emoji").oninput = e => {
    const em = e.target.value.trim();
    if (!em) return;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d");
    x.font = "52px serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(em, 32, 36);
    cfg.favicon = c.toDataURL("image/png");
    $("#fav-preview").src = cfg.favicon;
  };
  $("#fav-clear").onclick = () => {
    cfg.favicon = ""; $("#fav-emoji").value = "";
    $("#fav-preview").src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  };
}
