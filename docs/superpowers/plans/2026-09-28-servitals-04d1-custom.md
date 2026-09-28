# servitals Customization (sub-project 4d-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person shape the dashboard (spec 10.4): units, the fleet's order, grouping and card numbers, renaming, tagging, pinning, hiding and revoking servers from the page, panel sets per server, and settings import.

**Architecture:** Units live in `cfg.units` and every number on the page goes through `units()`, `fmtTemp`, `tempUnit`, `fmtBytes`, `fmtRate` and `fmtTime` (temperatures stay Celsius inside the page). The hub gets `POST /__ctl/node/<id>` (name, tags) and `POST /__ctl/node/<id>/revoke` (LAN only, never the hub's own node). The fleet is laid out by a pure `arrangeFleet(nodes, cfg.fleet)` (hide, pin, sort, group by first tag) and `cardNumbers()`; settings get a "servers" section with one row per server. `panelSet(id)` returns a server's own panel set (`cfg.nodePanels[id]`) or the shared one; the panel editor edits either, and the shared order gets up and down buttons. `importSettings(text)` checks an exported file key by key before it fills the form.

**Tech Stack:** the single page (`www/index.html`, vanilla JS), Node.js ≥ 18 built-ins for the hub and tests, Playwright screenshots from sub-project 4c.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 10.4 (customization), 6.4 (local-only powers), 11 (audit events).

**Scope (4d-1 of sub-project 4):** 4d-2 (config as code: `/etc/servitals/conf.d/*.json`, "managed by file", `servitals-ctl config check`) follows as its own plan. "First day of the week" from spec 10.4 waits for the history charts of sub-project 6: nothing on the page shows weeks yet, and a setting with no effect would only confuse. Agent collection per node is already set in each agent's `agent.env` (sub-project 2).

**Proven before writing:** every code block was built and run in a scratch copy of `feat/link` (6fbebea) on 2026-09-28: node suite 231 tests, the budget (first page load 29.5 KB gz), `test/screens.sh` (every style and mode, the settings checks at 1280 and 390 px, the customized fleet shot, no page errors).

## Global Constraints

- Everything from sub-projects 1-4b still holds: zero runtime dependencies, Node 18 compatibility (no `fetch` in `hub/` or `test/`), SPDX headers, lintian clean, the lightness budget (first page load ≤ 60 KB gzipped; this plan takes it from about 25 KB to about 29.5 KB).
- Settings stay in `config.json` exactly as before: every new key (`units`, `fleet`, `nodePanels`) is optional, and a page without them behaves as today (°C, 1024, bytes per second, the browser's clock, fleet by name, shared panels).
- Temperatures are Celsius inside the page (health colours, meters, sparklines); only text changes with the unit.
- Node names and tags follow `nodes.js`: names 1-64 printable characters, tags `^[a-z0-9][a-z0-9._-]{0,31}$`. Revoking needs a LAN (whitelisted) client unless `CTL_LAN_ONLY=0`, never touches the local node, and is audited (`node.revoked`; renames and tags `node.changed`).
- Everything a server sends (names, tags) is escaped before it reaches markup (`esc()`).
- The live dashboard runs on this host (native install, port 20002). Tests run in temp dirs and containers only.
- Work in a worktree `.claude/worktrees/servitals-custom` on branch `feat/custom` from `feat/link` (6fbebea), or from `main` once PR #9 is merged.
- Never run `git stash` (shared between worktrees); use a WIP commit.
- Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers. OpenWolf: log fixed bugs in `.wolf/buglog.json`.

## Review Focus

1. **A setting from an older or hand-edited `config.json`** (missing keys, unknown values such as `temp: "k"`, a `panelOrder` with duplicates or unknown panels, pinned or hidden ids of revoked servers) must fall back quietly, never break the page. Tests: Task 1 "units: … unknown values fall back"; Task 4 "the panel order always lists every panel once, also after an import"; Task 3 arrangeFleet with unknown ids.
2. **Revoking the wrong thing or from the wrong place**: the hub's own node, from outside the LAN, a node id that does not exist, and the snapshot and fleet entry left behind. Test: Task 2 "the page renames, tags and revokes a node…".
3. **Server-supplied names and tags in the new settings rows and fleet group titles** must be escaped. Test: Task 3 "names and tags from servers are escaped in the servers section and the fleet's group titles".
4. **An imported file that is not a servitals settings file** (not JSON, an array, wrong kinds, huge, `__proto__` keys) must be refused or trimmed before it reaches `cfg`. Test: Task 4 "settings import takes an exported file…".
5. **Phones and every style** with the longer settings panel and the new fleet group headings: nothing squeezed or cut off, no page errors. Test: Task 5, `test/screens.sh` (settings checks at 1280 and 390 px, the customized fleet shot).

---

### Task 1: Units

**Files:**
- Modify: `www/index.html`, `test/page.test.js`

**Interfaces:**
- Produces (in the page): `UNIT_CHOICES = { temp: ["c","f"], size: ["binary","decimal"], rate: ["bytes","bits"], clock: ["auto","24h","12h"] }` (the first choice is the default); `units() → { temp, size, rate, clock }` from `cfg.units`, unknown values replaced by the default; `tempUnit() → "°C"|"°F"`; `fmtTemp(celsius, withUnit) → "48°" | "48°C" | "–"`; `fmtTime(date, timeZone?)`; `fmtBytes(n)` (divides by 1000 for `decimal`); `fmtRate(bytesPerSecond)` (`bits`: always powers of 1000, `bit/s … Gbit/s`). Settings fields `#cfg-u-temp #cfg-u-size #cfg-u-rate #cfg-u-clock`; `saveSettings` writes `cfg.units`. Tasks 3-5 use `fmtTemp` for fleet cards.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js

test("snapshot times are milliseconds", () => {
  assert.match(HTML, /const age = \(Date\.now\(\) - \(ts \|\| 0\)\) \/ 1000;/);
  assert.match(HTML, /new Date\(ts \|\| 0\)\.toLocaleTimeString\(\)/);
});

test("fleet numbers show a dash when unknown", () => {
```

   with

```js

test("snapshot times are milliseconds", () => {
  assert.match(HTML, /const age = \(Date\.now\(\) - \(ts \|\| 0\)\) \/ 1000;/);
  assert.match(HTML, /fmtTime\(new Date\(ts \|\| 0\)\)/);
});

test("fleet numbers show a dash when unknown", () => {
```

2. Replace

```js
  assert.match(block(':root:not([data-theme="light"])'), /color-scheme: dark;/, "system dark");
});

```

   with

```js
  assert.match(block(':root:not([data-theme="light"])'), /color-scheme: dark;/, "system dark");
});

test("units: temperature, sizes, network rates and the clock follow the settings", () => {
  const u = (over) => () => Object.assign({ temp: "c", size: "binary", rate: "bytes", clock: "auto" }, over);
  const fmtTemp = (over) => pageFn("fmtTemp", { units: u(over), tempUnit: pageFn("tempUnit", { units: u(over) }) });
  assert.strictEqual(fmtTemp()(48.4), "48°");
  assert.strictEqual(fmtTemp()(48.4, true), "48°C");
  assert.strictEqual(fmtTemp({ temp: "f" })(48.4, true), "119°F");
  assert.strictEqual(fmtTemp({ temp: "f" })(-40), "-40°");
  assert.strictEqual(fmtTemp()(null), "–");

  const fmtBytes = (over) => pageFn("fmtBytes", { units: u(over) });
  assert.strictEqual(fmtBytes()(1024 ** 3 * 4.7), "4.7G");
  assert.strictEqual(fmtBytes({ size: "decimal" })(1e12), "1.0T", "a 1 TB drive reads 1.0T");
  assert.strictEqual(fmtBytes()(1e12), "931G");

  const fmtRate = (over) => pageFn("fmtRate", { units: u(over) });
  assert.strictEqual(fmtRate()(1536), "1.5 KB/s");
  assert.strictEqual(fmtRate({ size: "decimal" })(1500), "1.5 KB/s");
  assert.strictEqual(fmtRate({ rate: "bits" })(1.25e6), "10 Mbit/s", "bits are always powers of 1000");
  assert.strictEqual(fmtRate({ rate: "bits" })(0), "0 bit/s");

  const seen = [];
  const Date_ = class { toLocaleTimeString(loc, o) { seen.push(o); return "t"; } };
  const fmtTime = (over) => pageFn("fmtTime", { units: u(over) });
  fmtTime()(new Date_()); fmtTime({ clock: "24h" })(new Date_()); fmtTime({ clock: "12h" })(new Date_(), "Asia/Kolkata");
  assert.deepStrictEqual(seen, [{ timeZone: undefined, hour12: undefined }, { timeZone: undefined, hour12: false },
                                { timeZone: "Asia/Kolkata", hour12: true }]);

  const UNIT_CHOICES = new Function(`${/const UNIT_CHOICES = [^\n]+/.exec(HTML)[0]}; return UNIT_CHOICES;`)();
  const units = pageFn("units", { cfg: { units: { temp: "k", clock: "12h" } }, UNIT_CHOICES });
  assert.deepStrictEqual(units(), { temp: "c", size: "binary", rate: "bytes", clock: "12h" }, "unknown values fall back");
});

test("every temperature and time on the page goes through the unit helpers", () => {
  const script = HTML.slice(HTML.indexOf('<script>\n"use strict"')).replace(/function (tempUnit|fmtTemp)\([\s\S]*?\n}\n/g, "");
  assert.doesNotMatch(script, /\+ "°"|\}°|°C"/, "no hand-made degree signs");
  assert.doesNotMatch(script.replace(/function fmtTime[\s\S]*?\n}\n/, ""), /toLocaleTimeString\(/, "times through fmtTime");
  for (const id of ["cfg-u-temp", "cfg-u-size", "cfg-u-rate", "cfg-u-clock"]) assert.ok(HTML.includes(`id="${id}"`), id);
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 3 tests: "snapshot times are milliseconds" (the page still calls `toLocaleTimeString()` directly), "units: …" (`fmtTemp` is not found), "every temperature and time on the page goes through the unit helpers".

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html
    <div class="panel" data-panel="temp">
      <h2>thermal</h2>
      <div class="big"><span id="temp-pkg">--</span><span class="unit">&deg;C package</span></div>
      <div id="temp-bar"></div>
      <div class="sparkmini" id="temp-spark"></div>
```

   with

```html
    <div class="panel" data-panel="temp">
      <h2>thermal</h2>
      <div class="big"><span id="temp-pkg">--</span><span class="unit" id="temp-unit">&deg;C package</span></div>
      <div id="temp-bar"></div>
      <div class="sparkmini" id="temp-spark"></div>
```

2. Replace

```html

      <section>
        <label>appearance</label>
        <p class="hint">changes this browser at once</p>
```

   with

```html

      <section>
        <label>units</label>
        <div class="fields">
          <label class="field"><span>temperature</span><select id="cfg-u-temp"><option value="c">°C</option><option value="f">°F</option></select></label>
          <label class="field"><span>sizes</span><select id="cfg-u-size"><option value="binary">1024 (like df -h)</option><option value="decimal">1000 (like drive labels)</option></select></label>
          <label class="field"><span>network</span><select id="cfg-u-rate"><option value="bytes">bytes per second</option><option value="bits">bits per second</option></select></label>
          <label class="field"><span>clock</span><select id="cfg-u-clock"><option value="auto">browser default</option><option value="24h">24 hour</option><option value="12h">12 hour</option></select></label>
        </div>
      </section>

      <section>
        <label>appearance</label>
        <p class="hint">changes this browser at once</p>
```

3. Replace

```html
const tempPct = t => clamp((t - 30) / 65 * 100, 0, 100);

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + u[i];
}
function fmtRate(Bps) {
  Bps = Number(Bps) || 0;
  const u = ["B/s", "KB/s", "MB/s", "GB/s"];
  let i = 0;
  while (Bps >= 1024 && i < u.length - 1) { Bps /= 1024; i++; }
  return (Bps < 10 && i > 0 ? Bps.toFixed(1) : Math.round(Bps)) + " " + u[i];
}
function fmtDur(sec) {
```

   with

```html
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
  return date.toLocaleTimeString(undefined, { timeZone, hour12: c === "12h" ? true : c === "24h" ? false : undefined });
}
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
```

4. Replace

```html
      + `<div class="kv"><span><small>cpu</small>${fmtVal(s.cpu, "%")}</span>`
      + `<span><small>mem</small>${fmtVal(s.mem, "%")}</span>`
      + `<span><small>temp</small>${fmtVal(s.temp, "°C")}</span></div>`
      + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
      + (disk ? meter(disk.pct, dcls) : "")
```

   with

```html
      + `<div class="kv"><span><small>cpu</small>${fmtVal(s.cpu, "%")}</span>`
      + `<span><small>mem</small>${fmtVal(s.mem, "%")}</span>`
      + `<span><small>temp</small>${fmtTemp(s.temp, true)}</span></div>`
      + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
      + (disk ? meter(disk.pct, dcls) : "")
```

5. Replace

```html
  $("#hostname").textContent = cfg.title || "servitals";
  $("#hostmeta").textContent = `${fleetNodes.length} nodes · ${online} online`;
  $("#lastupdate").textContent = `fleet · ${new Date().toLocaleTimeString()}`;
}

```

   with

```html
  $("#hostname").textContent = cfg.title || "servitals";
  $("#hostmeta").textContent = `${fleetNodes.length} nodes · ${online} online`;
  $("#lastupdate").textContent = `fleet · ${fmtTime(new Date())}`;
}

```

6. Replace

```html
  else { label = "online"; }
  $("#lastupdate").textContent = label + " · " +
    new Date(ts || 0).toLocaleTimeString();
}

```

   with

```html
  else { label = "online"; }
  $("#lastupdate").textContent = label + " · " +
    fmtTime(new Date(ts || 0));
}

```

7. Replace

```html
    if (pkg != null) pushHist("temp", pkg);
    const hc = HCLS[pkg == null ? "ok" : health(pkg, 70, 85)];
    $("#temp-pkg").textContent = pkg != null ? Math.round(pkg) : "—";
    $("#temp-pkg").closest(".big").className = "big " + hc;
    const tp = pkg != null ? tempPct(pkg) : 0;
    $("#temp-bar").innerHTML = meter(tp, hc).replace(/<span class="pct">.*?<\/span>/,
      `<span class="pct">${pkg != null ? Math.round(pkg) + "°" : "--"}</span>`);
    $("#temp-spark").innerHTML = sparkSvg(hist.temp.map(tempPct));
    if (hist.temp.length) {
      const lo = Math.min(...hist.temp), hi = Math.max(...hist.temp);
      const av = hist.temp.reduce((a, b) => a + b, 0) / hist.temp.length;
      $("#temp-range").textContent = `${Math.round(lo)}° – ${Math.round(hi)}°  ·  avg ${Math.round(av)}°`;
    }
    const cores = (t.sensors || []).filter(s => /core/i.test(s.label));
    $("#temp-cores").textContent = cores.length
      ? cores.map(s => s.label.replace(/^Core /, "c") + " " + Math.round(s.value) + "°").join("  ")
      : (t.sensors || []).map(s => s.label + " " + Math.round(s.value) + "°").join("  ");
  }

```

   with

```html
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

```

8. Replace

```html
function tickClocks() {
  const now = new Date();
  $("#headclock").textContent = now.toLocaleTimeString();
  $("#headdate").textContent = now.toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short", year: "numeric" });
```

   with

```html
function tickClocks() {
  const now = new Date();
  $("#headclock").textContent = fmtTime(now);
  $("#headdate").textContent = now.toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short", year: "numeric" });
```

9. Replace

```html
    try {
      el.querySelector(".ct").textContent =
        now.toLocaleTimeString("en-GB", { timeZone: c.tz });
      el.querySelector(".cdte").textContent =
        now.toLocaleDateString("en-GB", { timeZone: c.tz, weekday: "short", day: "numeric", month: "short" });
```

   with

```html
    try {
      el.querySelector(".ct").textContent =
        fmtTime(now, c.tz);
      el.querySelector(".cdte").textContent =
        now.toLocaleDateString("en-GB", { timeZone: c.tz, weekday: "short", day: "numeric", month: "short" });
```

10. Replace

```html
        const day = dow[new Date(iso + "T12:00").getDay()];
        return `<span class="fc"><span class="fcd">${day}</span> ${fw[0]}
          <span class="fct">${Math.round(d.temperature_2m_max[n])}°<span class="fcl">${Math.round(d.temperature_2m_min[n])}°</span></span></span>`;
      }).join("");
      return `<div class="wc">
```

   with

```html
        const day = dow[new Date(iso + "T12:00").getDay()];
        return `<span class="fc"><span class="fcd">${day}</span> ${fw[0]}
          <span class="fct">${fmtTemp(d.temperature_2m_max[n])}<span class="fcl">${fmtTemp(d.temperature_2m_min[n])}</span></span></span>`;
      }).join("");
      return `<div class="wc">
```

11. Replace

```html
          <span class="wicon">${w[0]}</span>
          <span>
            <span class="wname">${esc(l.name)}</span> <span class="wtemp">${Math.round(r.current.temperature_2m)}°</span><br>
            <span class="wsub">${w[1]} · feels ${Math.round(r.current.apparent_temperature)}°
            · H ${Math.round(d.temperature_2m_max[0])}° L ${Math.round(d.temperature_2m_min[0])}°</span>
          </span>
        </div>
```

   with

```html
          <span class="wicon">${w[0]}</span>
          <span>
            <span class="wname">${esc(l.name)}</span> <span class="wtemp">${fmtTemp(r.current.temperature_2m)}</span><br>
            <span class="wsub">${w[1]} · feels ${fmtTemp(r.current.apparent_temperature)}
            · H ${fmtTemp(d.temperature_2m_max[0])} L ${fmtTemp(d.temperature_2m_min[0])}</span>
          </span>
        </div>
```

12. Replace

```html
  $("#cfg-kiosk").checked = !!cfg.kiosk;
  $("#cfg-kiosksec").value = cfg.kioskSec || 20;
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

   with

```html
  $("#cfg-kiosk").checked = !!cfg.kiosk;
  $("#cfg-kiosksec").value = cfg.kioskSec || 20;
  for (const [k, v] of Object.entries(units())) $("#cfg-u-" + k).value = v;
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

13. Replace

```html
  if (cfg.kiosk && !was && lsGet("kiosk") === null) lsSet("kiosk", "0");
  cfg.kioskSec = clamp(+$("#cfg-kiosksec").value || 20, 5, 600);
  // panels/order/size/favicon are already updated live by the settings widgets

```

   with

```html
  if (cfg.kiosk && !was && lsGet("kiosk") === null) lsSet("kiosk", "0");
  cfg.kioskSec = clamp(+$("#cfg-kiosksec").value || 20, 5, 600);
  cfg.units = Object.fromEntries(Object.keys(UNIT_CHOICES).map((k) => [k, $("#cfg-u-" + k).value]));
  // panels/order/size/favicon are already updated live by the settings widgets

```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (2 new tests).

- [ ] **Step 5: Commit**

```bash
git add www/index.html test/page.test.js
git commit -m "feat(ui): units for temperature, sizes, network rates and the clock" -m "Settings gain a units section: °C or °F, sizes in powers of 1024 or 1000, network in bytes or bits per second, a 12 or 24 hour clock. Every temperature and time on the page goes through the new helpers; temperatures stay Celsius inside the page."
```

---

### Task 2: Rename, tag and revoke a node from the page

**Files:**
- Modify: `hub/lib/nodes.js`, `hub/server.js`, `test/multinode.test.js`

**Interfaces:**
- Consumes: `createNodeStore` with `check`, `rename`, `revoke` (sub-projects 4a, 4b).
- Produces: store method `setTags(id, tags)` (a list of strings, each checked, duplicates removed); `POST /__ctl/node/<id>` with JSON `{ name?, tags? }` → `200 { ok: true }`, `400 { error }` (nothing changes unless both are valid), `404` for an unknown node; `POST /__ctl/node/<id>/revoke` → `200`, `403` from outside the LAN (with `CTL_LAN_ONLY`), `400` for the local node, `404` unknown; revoking also drops the node's latest snapshot and `snapshots/<id>.json`. Audit events `node.changed`, `node.revoked`. Task 3's settings rows call both.

- [ ] **Step 1: Write the failing test**

In `test/multinode.test.js`:

1. Replace

```js
    assert.strictEqual((await getJSON(hub, cookie, `/__ctl/node/${nas.id}`)).status, 404);
  } finally { await hub.stop(); }
});

```

   with

```js
    assert.strictEqual((await getJSON(hub, cookie, `/__ctl/node/${nas.id}`)).status, 404);
  } finally { await hub.stop(); }
});

test("the page renames, tags and revokes a node; revoking is LAN-only and never the hub's own", async () => {
  const hub = await startHub();
  try {
    const c = addNode(hub, "nas");
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 200);
    const cookie = cookieFrom(await login(hub.port));
    const node = (id) => getJSON(hub, cookie, "/__ctl/nodes").then((r) => r.body.find((n) => n.id === id));

    let r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ name: "  big nas ", tags: ["home", "storage"] }));
    assert.strictEqual(r.status, 200, r.body);
    assert.deepStrictEqual(((n) => [n.name, n.tags])(await node(c.id)), ["big nas", ["home", "storage"]]);
    r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ tags: ["Bad Tag"] }));
    assert.deepStrictEqual([r.status, /tag/.test(JSON.parse(r.body).error)], [400, true]);
    r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ name: "" }));
    assert.strictEqual(r.status, 400);
    r = await ctlPost(hub.port, cookie, "/__ctl/node/aaaaaaaaaaaa", JSON.stringify({ name: "x" }));
    assert.strictEqual(r.status, 404);

    const revoke = (id, from) => request(hub.port, { method: "POST", path: `/__ctl/node/${id}/revoke`,
      headers: { cookie, origin: `http://127.0.0.1:${hub.port}`, "x-forwarded-for": from } });
    assert.strictEqual((await revoke(c.id, "203.0.113.5")).status, 403, "not from outside the LAN");
    const local = (await getJSON(hub, cookie, "/__ctl/nodes")).body.find((n) => n.local);
    assert.strictEqual((await revoke(local.id, "192.168.1.10")).status, 400, "never the hub's own node");

    assert.strictEqual((await revoke(c.id, "192.168.1.10")).status, 200);
    assert.strictEqual(await node(c.id), undefined, "gone from the fleet");
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 401, "its agent is refused");
    assert.ok(!fs.existsSync(path.join(hub.dataDir, "snapshots", c.id + ".json")), "its snapshot is gone");
    assert.match(fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8"), /node\.revoked/);
  } finally { await hub.stop(); }
});

```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --test-name-pattern="renames, tags" test/multinode.test.js`
Expected: FAIL: `404 !== 200` (the page cannot change nodes yet).

- [ ] **Step 3: The node store**

In `hub/lib/nodes.js`:

1. Replace

```js
  }
  const rename = (id, name) => change(id, (n) => { n.name = checkName(name); });
  const revoke = (id) => change(id, (n) => {
    if (n.local) throw new Error("the local node cannot be revoked");
```

   with

```js
  }
  const rename = (id, name) => change(id, (n) => { n.name = checkName(name); });
  const setTags = (id, tags) => change(id, (n) => {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) throw new Error("tags: a list of words");
    check(n.name, tags);
    n.tags = [...new Set(tags)];
  });
  const revoke = (id) => change(id, (n) => {
    if (n.local) throw new Error("the local node cannot be revoked");
```

2. Replace

```js
  }

  return { get, localId, ensureLocal, check, add, rename, revoke, list, all: load };
}

```

   with

```js
  }

  return { get, localId, ensureLocal, check, add, rename, setTags, revoke, list, all: load };
}

```

- [ ] **Step 4: The hub**

In `hub/server.js`:

1. Replace

```js
    }

    // does this client get container controls?
    if (req.url === "/__ctl/whoami") {
```

   with

```js
    }

    // rename or tag a node from the page (spec 10.4); revoke it: LAN only, never the hub's own
    const em = /^\/__ctl\/node\/([a-z2-7]{12})(\/revoke)?$/.exec(pathname);
    if (req.method === "POST" && em) {
      const id = em[1];
      if (!nodes.get(id)) return json(404, { error: "no such node" });
      if (em[2]) {
        if (CTL_LAN_ONLY && !wl) return json(403, { error: "revoking a node is LAN-only" });
        try { nodes.revoke(id); } catch (e) { return json(400, { error: e.message }); }
        latest.delete(id);
        try { fs.unlinkSync(path.join(SNAP_DIR, id + ".json")); } catch (_) { /* never pushed */ }
        log.audit("node.revoked", { ip, node: id });
        return json(200, { ok: true });
      }
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 4096)); } catch (_) { /* answered below */ }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid json" });
      try {
        // check both before changing either
        const name = body.name !== undefined ? nodes.check(body.name) : nodes.get(id).name;
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) throw new Error("tags: a list of words");
          nodes.check(name, body.tags);
        }
        if (body.name !== undefined) nodes.rename(id, name);
        if (body.tags !== undefined) nodes.setTags(id, body.tags);
      } catch (e) { return json(400, { error: e.message }); }
      log.audit("node.changed", { ip, node: id });
      return json(200, { ok: true });
    }

    // does this client get container controls?
    if (req.url === "/__ctl/whoami") {
```

Note: a request straight from loopback without a forwarding header is not LAN (`hub/lib/clientip.js` treats it as a proxy), which is why the test sends `x-forwarded-for: 192.168.1.10` for the allowed revokes.

- [ ] **Step 5: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test).

- [ ] **Step 6: Commit**

```bash
git add hub/lib/nodes.js hub/server.js test/multinode.test.js
git commit -m "feat(hub): rename, tag and revoke nodes from the page" -m "POST /__ctl/node/<id> changes a node's name and tags (both checked before either changes). POST /__ctl/node/<id>/revoke is LAN-only, refuses the hub's own node, and drops the node's snapshot. Both are audited."
```

---

### Task 3: The fleet: order, groups, card numbers and the servers section

**Files:**
- Modify: `www/index.html`, `test/page.test.js`

**Interfaces:**
- Consumes: `fmtTemp` (Task 1); the Task 2 endpoints; `confirmDialog`, `toast`, `loadNodes`, `esc` (existing page helpers).
- Produces: `arrangeFleet(nodes, fleetCfg) → [{ title, nodes }]` (`fleetCfg` = `{ sort: "name"|"status"|"cpu"|"mem"|"temp"|"disk", group, pinned: [ids], hidden: [ids] }`; titles `""`, `"pinned"`, a tag, `"untagged"`); `cardNumbers() → [..]` from `cfg.fleet.card` (subset of `cpu mem temp disk containers`, at most 4, default `cpu mem temp`); `renderFleet` → `fleetCard(n)` + `fleetStatus()`; `renderServers()`, `saveServer(row)`, `revokeServer(row)`; settings ids `#cfg-f-sort #cfg-f-group #cfg-f-card #cfg-servers`; `saveSettings` writes `cfg.fleet`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js
  for (const id of ["cfg-u-temp", "cfg-u-size", "cfg-u-rate", "cfg-u-clock"]) assert.ok(HTML.includes(`id="${id}"`), id);
});

```

   with

```js
  for (const id of ["cfg-u-temp", "cfg-u-size", "cfg-u-rate", "cfg-u-clock"]) assert.ok(HTML.includes(`id="${id}"`), id);
});

test("the fleet: hidden nodes go, pinned ones lead, then the chosen order, optionally grouped by first tag", () => {
  const arrange = pageFn("arrangeFleet", {});
  const n = (id, name, over = {}) => ({ id, name, status: "online", tags: [], summary: { cpu: 10, mem: 10, temp: 40, disk: { pct: 50 } }, ...over });
  const nodes = [
    n("a", "alpha", { tags: ["home"], summary: { cpu: 5, mem: 80, temp: null, disk: { pct: 91 } } }),
    n("b", "bravo", { status: "offline", summary: null }),
    n("c", "charlie", { tags: ["lab", "home"], summary: { cpu: 70, mem: 20, temp: 60, disk: null } }),
    n("d", "delta", { tags: ["home"], status: "stale" }),
  ];
  const ids = (groups) => groups.map((g) => [g.title, g.nodes.map((x) => x.id).join("")]);
  assert.deepStrictEqual(ids(arrange(nodes, {})), [["", "abcd"]], "by name by default");
  assert.deepStrictEqual(ids(arrange(nodes, { sort: "cpu" })), [["", "cdab"]], "busiest first, unknown last");
  assert.deepStrictEqual(ids(arrange(nodes, { sort: "disk" })), [["", "adbc"]]);
  assert.deepStrictEqual(ids(arrange(nodes, { sort: "status" })), [["", "bdac"]], "trouble first");
  assert.deepStrictEqual(ids(arrange(nodes, { hidden: ["b"], pinned: ["d"] })), [["", "dac"]]);
  assert.deepStrictEqual(ids(arrange(nodes, { group: true })), [["home", "ad"], ["lab", "c"], ["untagged", "b"]]);
  assert.deepStrictEqual(ids(arrange(nodes, { group: true, pinned: ["c"] })), [["pinned", "c"], ["home", "ad"], ["untagged", "b"]]);
  assert.deepStrictEqual(ids(arrange([], {})), []);
  assert.deepStrictEqual(ids(arrange(nodes, { pinned: ["gone", "a"], hidden: ["gone"] })), [["", "abcd"]], "ids of revoked servers match nothing");
});

test("names and tags from servers are escaped in the servers section and the fleet's group titles", () => {
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /value="\$\{esc\(n\.name\)\}"/);
  assert.match(fn("renderServers"), /value="\$\{esc\(\(n\.tags \|\| \[\]\)\.join\(", "\)\)\}"/);
  assert.match(fn("renderFleet"), /<div class="fgroup">\$\{esc\(g\.title\)\}<\/div>/);
  assert.doesNotMatch(fn("renderServers") + fn("renderFleet"), /\$\{(n\.name|g\.title|n\.tags)/, "nothing unescaped");
});

test("fleet cards show the numbers chosen in settings", () => {
  const cardNumbers = pageFn("cardNumbers", { cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
  assert.deepStrictEqual(cardNumbers(), ["disk", "containers"]);
  assert.deepStrictEqual(pageFn("cardNumbers", { cfg: {} })(), ["cpu", "mem", "temp"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 3 tests: `arrangeFleet`, `cardNumbers` and `renderServers` are not found.

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html
  .ncard .nhead { display: flex; align-items: center; gap: 8px; color: var(--fg-bright);
    text-transform: uppercase; letter-spacing: .1em; font-size: 11.5px; }
  .ncard .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; font-variant-numeric: tabular-nums; }
  .ncard .kv small { display: block; color: var(--dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .ncard .foot { display: flex; justify-content: space-between; gap: 6px; color: var(--dim); font-size: 12px; }
```

   with

```html
  .ncard .nhead { display: flex; align-items: center; gap: 8px; color: var(--fg-bright);
    text-transform: uppercase; letter-spacing: .1em; font-size: 11.5px; }
  .ncard .kv { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; font-variant-numeric: tabular-nums; }
  .fleet .fgroup { grid-column: 1 / -1; color: var(--dim); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; margin-top: 6px; }
  .modal .checks { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; }
  .modal .checks .check { margin-top: 0; }
  .srv { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px; margin-top: 6px;
         background: var(--bg); border: var(--border-w, 1px) solid var(--border); }
  .srv input[type=text] { flex: 1 1 140px; min-width: 0; }
  .srv .local { color: var(--dim); font-size: 11px; }
  .ncard .kv small { display: block; color: var(--dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .ncard .foot { display: flex; justify-content: space-between; gap: 6px; color: var(--dim); font-size: 12px; }
```

2. Replace

```html

      <section>
        <label>weather locations</label>
        <div id="cfg-weather"></div>
```

   with

```html

      <section>
        <label>servers</label>
        <div class="fields">
          <label class="field"><span>sort the fleet by</span><select id="cfg-f-sort">
            <option value="name">name</option><option value="status">status (trouble first)</option>
            <option value="cpu">cpu</option><option value="mem">memory</option>
            <option value="temp">temperature</option><option value="disk">fullest disk</option></select></label>
        </div>
        <label class="check"><input type="checkbox" id="cfg-f-group"> group the fleet by each server's first tag</label>
        <p class="hint">numbers on each card (up to 4)</p>
        <div class="checks" id="cfg-f-card"></div>
        <p class="hint">name and tags save at once; pin and hide with the other settings</p>
        <div id="cfg-servers"></div>
      </section>

      <section>
        <label>weather locations</label>
        <div id="cfg-weather"></div>
```

3. Replace

```html
function fmtVal(v, unit) { return v == null ? "–" : Math.round(v) + unit; }

function renderFleet() {
  $("#fleet").innerHTML = fleetNodes.map(n => {
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
      + `<div class="kv"><span><small>cpu</small>${fmtVal(s.cpu, "%")}</span>`
      + `<span><small>mem</small>${fmtVal(s.mem, "%")}</span>`
      + `<span><small>temp</small>${fmtTemp(s.temp, true)}</span></div>`
      + `<div class="sparkmini">${sparkSvg(s.trend || [])}</div>`
      + (disk ? meter(disk.pct, dcls) : "")
      + `<div class="foot"><span>${foot}</span><span>${cont}</span></div></div>`;
  }).join("");
  const online = fleetNodes.filter(n => n.status === "online").length;
  const dot = $("#statusdot");
```

   with

```html
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
  const hidden = new Set(f.hidden || []), pinned = new Set(f.pinned || []);
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
  const online = fleetNodes.filter(n => n.status === "online").length;
  const dot = $("#statusdot");
```

4. Replace

```html
  "Europe/Berlin","Europe/Istanbul","Europe/London","Europe/Madrid","Europe/Moscow","Europe/Paris"];

function openSettings() {
  $("#tzlist").innerHTML = COMMON_TZ.map(t => `<option value="${t}">`).join("");
```

   with

```html
  "Europe/Berlin","Europe/Istanbul","Europe/London","Europe/Madrid","Europe/Moscow","Europe/Paris"];

// settings → servers: fleet order and card numbers, and one row per server
function renderServers() {
  const f = cfg.fleet || {};
  $("#cfg-f-sort").value = f.sort || "name";
  $("#cfg-f-group").checked = !!f.group;
  const cards = cardNumbers(), names = { mem: "memory", temp: "temperature", disk: "fullest disk" };
  $("#cfg-f-card").innerHTML = Object.keys(CARD_LABEL).map(k => `<label class="check"><input type="checkbox" value="${k}"`
    + `${cards.includes(k) ? " checked" : ""}> ${names[k] || k}</label>`).join("");
  const pinned = new Set(f.pinned || []), hidden = new Set(f.hidden || []);
  $("#cfg-servers").innerHTML = fleetNodes.map(n => `<div class="srv" data-id="${esc(n.id)}">`
    + `<input type="text" class="srv-name" value="${esc(n.name)}" maxlength="64" aria-label="name of ${esc(n.name)}">`
    + `<input type="text" class="srv-tags" value="${esc((n.tags || []).join(", "))}" placeholder="tags" aria-label="tags of ${esc(n.name)}">`
    + `<label class="check"><input type="checkbox" class="srv-pin"${pinned.has(n.id) ? " checked" : ""}> pin</label>`
    + `<label class="check"><input type="checkbox" class="srv-hide"${hidden.has(n.id) ? " checked" : ""}> hide</label>`
    + (n.local ? `<span class="local">this hub</span>` : `<button class="srv-revoke">revoke</button>`)
    + `</div>`).join("");
}
async function saveServer(row) {
  const body = { name: $(".srv-name", row).value,
                 tags: $(".srv-tags", row).value.split(/[\s,]+/).filter(Boolean) };
  const r = await fetch(`/__ctl/node/${row.dataset.id}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || "could not save that server", true);
  toast("saved");
  await loadNodes();
}
async function revokeServer(row) {
  const name = $(".srv-name", row).value;
  const ok = await confirmDialog(`revoke "${name}"?`, { title: "revoke a server", yes: "revoke", danger: true,
    note: "Its agent is refused from now on and it leaves the fleet. Pair it again to bring it back." });
  if (!ok) return;
  const r = await fetch(`/__ctl/node/${row.dataset.id}/revoke`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || "could not revoke that server", true);
  toast(`revoked ${name}`);
  await loadNodes();
  renderServers();
}

function openSettings() {
  $("#tzlist").innerHTML = COMMON_TZ.map(t => `<option value="${t}">`).join("");
```

5. Replace

```html
  $("#cfg-kiosksec").value = cfg.kioskSec || 20;
  for (const [k, v] of Object.entries(units())) $("#cfg-u-" + k).value = v;
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

   with

```html
  $("#cfg-kiosksec").value = cfg.kioskSec || 20;
  for (const [k, v] of Object.entries(units())) $("#cfg-u-" + k).value = v;
  renderServers();
  loadNodes().then(renderServers);
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

6. Replace

```html
  cfg.kioskSec = clamp(+$("#cfg-kiosksec").value || 20, 5, 600);
  cfg.units = Object.fromEntries(Object.keys(UNIT_CHOICES).map((k) => [k, $("#cfg-u-" + k).value]));
  // panels/order/size/favicon are already updated live by the settings widgets

```

   with

```html
  cfg.kioskSec = clamp(+$("#cfg-kiosksec").value || 20, 5, 600);
  cfg.units = Object.fromEntries(Object.keys(UNIT_CHOICES).map((k) => [k, $("#cfg-u-" + k).value]));
  const rows = $$("#cfg-servers .srv"), prev = cfg.fleet || {};
  cfg.fleet = {
    sort: $("#cfg-f-sort").value, group: $("#cfg-f-group").checked,
    card: $$("#cfg-f-card input:checked").map(i => i.value).slice(0, 4),
    // without the server list (the hub did not answer) keep what was saved
    pinned: rows.length ? rows.filter(r => $(".srv-pin", r).checked).map(r => r.dataset.id) : prev.pinned || [],
    hidden: rows.length ? rows.filter(r => $(".srv-hide", r).checked).map(r => r.dataset.id) : prev.hidden || [],
  };
  // panels/order/size/favicon are already updated live by the settings widgets

```

7. Replace

```html
  $("#settings-close").onclick = closeSettings;
  $("#acct-save").onclick = saveAccount;
  $("#cfg-style").onchange = e => { applyStyle(e.target.value); lsSet("style", e.target.value); };
  $("#cfg-mode").onchange = e => { applyMode(e.target.value); lsSet("theme", e.target.value); };
```

   with

```html
  $("#settings-close").onclick = closeSettings;
  $("#acct-save").onclick = saveAccount;
  $("#cfg-servers").addEventListener("change", e => {
    if (e.target.matches(".srv-name, .srv-tags")) saveServer(e.target.closest(".srv"));
  });
  $("#cfg-servers").addEventListener("click", e => {
    if (e.target.matches(".srv-revoke")) revokeServer(e.target.closest(".srv"));
  });
  $("#cfg-style").onchange = e => { applyStyle(e.target.value); lsSet("style", e.target.value); };
  $("#cfg-mode").onchange = e => { applyMode(e.target.value); lsSet("theme", e.target.value); };
```

- [ ] **Step 4: Run the tests and look**

Run: `node --test test/*.test.js && bash test/screens.sh`
Expected: PASS (3 new tests); `screenshots in /out: no page errors`. In `build/screens/settings-390.png` the servers section shows one row per demo server, the hub's own marked "this hub" without a revoke button.

- [ ] **Step 5: Commit**

```bash
git add www/index.html test/page.test.js
git commit -m "feat(ui): fleet order, groups and card numbers; a servers section in settings" -m "The fleet can be sorted by name, trouble first, CPU, memory, temperature or fullest disk, grouped by each server's first tag, and show up to four chosen numbers per card. Settings list every server: rename and tag it (saved at once), pin or hide it, or revoke it after a confirmation."
```

---

### Task 4: Panel sets per server, arrow buttons, settings import

**Files:**
- Modify: `www/index.html`, `test/page.test.js`

**Interfaces:**
- Consumes: `fleetNodes`, `currentNode`, `localNode`, `deepMerge`, `DEFAULTS`, `openSettings` (existing).
- Produces: `panelSet(id) → { panels, panelSize }` (`cfg.nodePanels[id]` or the shared set); `applyLayout` and the render step read `panelSet(currentNode || localNode)`; the editor's `panelFor` (`"all"` or a node id), `editedSet()`, `ownSet()` (copies the shared set on a server's first change), `drawPanelFor()`, `#cfg-p-for`, `#cfg-p-reset`, `[data-up]`/`[data-down]` buttons; `fixPanelOrder()`; `importSettings(text) → { ok: true, cfg, skipped } | { ok: false, error }`; `#cfg-import` with `#cfg-import-file`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| cfg\.panels\[panel\] === false\)/);
});

test("without vnStat the network panel shows the live rate and says how to get history", () => {
```

   with

```js

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| shown\[panel\] === false\)/);
});

test("without vnStat the network panel shows the live rate and says how to get history", () => {
```

2. Replace

```js
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
});

```

   with

```js
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
});

test("a server can have its own panel set and sizes; every other server uses the shared one", () => {
  const cfg = { panels: { mem: true, cpu: true, docker: true }, panelSize: { mem: "normal", docker: "full" },
                nodePanels: { nasnasnasnas: { panels: { mem: true, cpu: true, docker: false }, panelSize: { mem: "wide", docker: "full" } } } };
  const panelSet = pageFn("panelSet", { cfg });
  assert.deepStrictEqual(panelSet("nasnasnasnas"), cfg.nodePanels.nasnasnasnas);
  assert.deepStrictEqual(panelSet("othernode234"), { panels: cfg.panels, panelSize: cfg.panelSize });
  assert.deepStrictEqual(panelSet(null), { panels: cfg.panels, panelSize: cfg.panelSize });
  assert.match(HTML, /const set = panelSet\(currentNode \|\| localNode\);/, "the layout uses the shown server's set");
  assert.doesNotMatch(HTML.slice(HTML.indexOf("function applyLayout")), /cfg\.panels\[(p|panel)\] === false|cfg\.panels\.network === false/);
  assert.ok(HTML.includes('id="cfg-p-for"'));
  assert.match(HTML, /data-up/, "order also with buttons, not only drag (touch screens)");
});

test("settings import takes an exported file, keeps only known settings and refuses anything else", () => {
  const importSettings = pageFn("importSettings", {});
  const ok = importSettings(JSON.stringify({ title: "home", units: { temp: "f" }, fleet: { sort: "cpu" }, nodes: "x", __proto__x: 1 }));
  assert.deepStrictEqual(ok, { ok: true, cfg: { title: "home", units: { temp: "f" }, fleet: { sort: "cpu" } }, skipped: ["nodes", "__proto__x"] });
  for (const bad of ["", "nope", "[1,2]", "null", "42", JSON.stringify({ title: 5 }), JSON.stringify({ units: [] })]) {
    const r = importSettings(bad);
    assert.strictEqual(r.ok, false, bad);
    assert.match(r.error, /./);
  }
  assert.strictEqual(importSettings("x".repeat(600 * 1024)).ok, false, "too big");
  assert.ok(HTML.includes('id="cfg-import"'));
});

test("the panel order always lists every panel once, also after an import", () => {
  const cfg = { panelOrder: ["cpu", "cpu", "bogus", "mem"] };
  pageFn("fixPanelOrder", { cfg, DEFAULTS: { panels: { mem: 1, cpu: 1, temp: 1 } } })();
  assert.deepStrictEqual(cfg.panelOrder, ["cpu", "mem", "temp"]);
  assert.match(HTML, /cfg = deepMerge\(structuredClone\(DEFAULTS\), r\.cfg\);\n    fixPanelOrder\(\);/);
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 4 tests: "a panel whose group the node does not send…" (the render step still reads `cfg.panels`), "a server can have its own panel set…", "settings import…", "the panel order always lists every panel once…".

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html

  .panelcfg { display: flex; flex-direction: column; gap: 3px; }
  .pcf {
    display: grid; grid-template-columns: 18px 1fr auto auto; gap: 8px; align-items: center;
    padding: 5px 8px; background: var(--bg); border: var(--border-w, 1px) solid var(--border);
  }
```

   with

```html

  .panelcfg { display: flex; flex-direction: column; gap: 3px; }
  #overlay .pcf button { padding: 1px 7px; }
  .pcf {
    display: grid; grid-template-columns: 18px 1fr auto auto auto auto; gap: 8px; align-items: center;
    padding: 5px 8px; background: var(--bg); border: var(--border-w, 1px) solid var(--border);
  }
```

2. Replace

```html

      <section>
        <label>panels &mdash; drag to reorder</label>
        <div id="cfg-panels" class="panelcfg"></div>
      </section>

```

   with

```html

      <section>
        <label>panels</label>
        <div class="fields">
          <label class="field"><span>which panels and sizes, for</span><select id="cfg-p-for"></select></label>
        </div>
        <p class="hint">the order is shared by every server: drag, or use the arrows</p>
        <div id="cfg-panels" class="panelcfg"></div>
        <div class="addrow"><button id="cfg-p-reset" class="hidden">use the shared set for this server</button></div>
      </section>

```

3. Replace

```html
      <button id="cfg-reset">reset to defaults</button>
      <button id="cfg-export">export json</button>
    </div>
    <div class="body hidden" id="export-wrap">
```

   with

```html
      <button id="cfg-reset">reset to defaults</button>
      <button id="cfg-export">export json</button>
      <button id="cfg-import">import json</button>
      <input type="file" id="cfg-import-file" accept="application/json,.json" hidden>
    </div>
    <div class="body hidden" id="export-wrap">
```

4. Replace

```html
  try { saved = JSON.parse(lsGet("cfg") || "null"); } catch (e) {}
  cfg = saved ? deepMerge(structuredClone(DEFAULTS), saved) : structuredClone(DEFAULTS);
  // make sure every panel appears exactly once in the order list
  const known = Object.keys(DEFAULTS.panels);
  cfg.panelOrder = [...(cfg.panelOrder || []).filter(p => known.includes(p)),
                    ...known.filter(p => !(cfg.panelOrder || []).includes(p))];
}

```

   with

```html
  try { saved = JSON.parse(lsGet("cfg") || "null"); } catch (e) {}
  cfg = saved ? deepMerge(structuredClone(DEFAULTS), saved) : structuredClone(DEFAULTS);
  fixPanelOrder();
}
// every panel appears exactly once in the order list
function fixPanelOrder() {
  const known = Object.keys(DEFAULTS.panels);
  const order = Array.isArray(cfg.panelOrder) ? cfg.panelOrder : [];
  cfg.panelOrder = [...new Set(order.filter(p => known.includes(p))), ...known.filter(p => !order.includes(p))];
}

```

5. Replace

```html
  if (cfg.favicon) $("#favicon").href = cfg.favicon;
}
function applyLayout() {
  const grid = $("#grid");
  const order = (cfg.panelOrder && cfg.panelOrder.length) ? cfg.panelOrder : Object.keys(DEFAULTS.panels);
  order.forEach((p, i) => {
```

   with

```html
  if (cfg.favicon) $("#favicon").href = cfg.favicon;
}
// the panel set of one server: its own when it has one, else the shared one (spec 10.4)
function panelSet(id) {
  const own = id && cfg.nodePanels && cfg.nodePanels[id];
  return own || { panels: cfg.panels, panelSize: cfg.panelSize };
}
function applyLayout() {
  const grid = $("#grid");
  const set = panelSet(currentNode || localNode);
  const order = (cfg.panelOrder && cfg.panelOrder.length) ? cfg.panelOrder : Object.keys(DEFAULTS.panels);
  order.forEach((p, i) => {
```

6. Replace

```html
    if (!el) return;
    el.style.order = i;
    const size = (cfg.panelSize && cfg.panelSize[p]) || "normal";
    el.classList.remove("p-normal", "p-wide", "p-full");
    el.classList.add("p-" + size);
    el.classList.toggle("hidden", cfg.panels[p] === false);
  });
}
```

   with

```html
    if (!el) return;
    el.style.order = i;
    const size = (set.panelSize && set.panelSize[p]) || "normal";
    el.classList.remove("p-normal", "p-wide", "p-full");
    el.classList.add("p-" + size);
    el.classList.toggle("hidden", set.panels[p] === false);
  });
}
```

7. Replace

```html
    renderNetBars();
  }
  $("[data-panel=network]").classList.toggle("hidden",
    !d.net || cfg.panels.network === false);

  // docker — stash and render (sort / expand handled separately)
```

   with

```html
    renderNetBars();
  }
  const shown = panelSet(currentNode || localNode).panels;
  $("[data-panel=network]").classList.toggle("hidden",
    !d.net || shown.network === false);

  // docker — stash and render (sort / expand handled separately)
```

8. Replace

```html
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || cfg.panels[panel] === false);
  }
}
```

   with

```html
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
  }
}
```

9. Replace

```html
  "Europe/Berlin","Europe/Istanbul","Europe/London","Europe/Madrid","Europe/Moscow","Europe/Paris"];

// settings → servers: fleet order and card numbers, and one row per server
function renderServers() {
```

   with

```html
  "Europe/Berlin","Europe/Istanbul","Europe/London","Europe/Madrid","Europe/Moscow","Europe/Paris"];

// settings import: an exported file back in, known settings only, each of the right kind
function importSettings(text) {
  if (typeof text !== "string" || text.length > 512 * 1024) return { ok: false, error: "the file is empty or larger than 512 KB" };
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: "that is not a JSON file" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "that is not a servitals settings file" };
  const kinds = { title: "string", favicon: "string", portainerUrl: "string", style: "string", mode: "string",
                  density: "string", refreshSec: "number", kioskSec: "number", kiosk: "boolean",
                  weather: "array", clocks: "array", panelOrder: "array",
                  panels: "object", panelSize: "object", nodePanels: "object", units: "object", fleet: "object", disks: "object" };
  const kindOf = v => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  const out = {}, skipped = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!Object.prototype.hasOwnProperty.call(kinds, k)) { skipped.push(k); continue; }
    if (kindOf(v) !== kinds[k]) return { ok: false, error: `"${k}" should be ${kinds[k] === "array" ? "a list" : "a " + kinds[k]}` };
    out[k] = v;
  }
  return { ok: true, cfg: out, skipped };
}

// settings → servers: fleet order and card numbers, and one row per server
function renderServers() {
```

10. Replace

```html
}

/* panels: reorderable list with drag, size, show/hide */
let dragPanel = null;
function drawPanelCfg() {
  const host = $("#cfg-panels");
  host.innerHTML = cfg.panelOrder.map(p => {
    const on = cfg.panels[p] !== false;
    const sz = (cfg.panelSize && cfg.panelSize[p]) || "normal";
    const opt = s => `<option value="${s}" ${sz === s ? "selected" : ""}>${s}</option>`;
    return `<div class="pcf ${on ? "" : "off"}" draggable="true" data-p="${p}">
      <span class="grip">⠿</span>
      <span class="pn">${p}</span>
      <select data-sz>${opt("normal")}${opt("wide")}${opt("full")}</select>
      <label><input type="checkbox" data-vis ${on ? "checked" : ""}> show</label>
    </div>`;
  }).join("");
  $$(".pcf", host).forEach(row => {
    row.ondragstart = e => { dragPanel = row.dataset.p; e.dataTransfer.effectAllowed = "move"; };
```

   with

```html
}

/* panels: order (drag, or the up and down buttons) is shared; which panels show
   and their sizes can be one server's own (spec 10.4) */
let dragPanel = null;
let panelFor = "all";   // "all" or a node id
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
  sel.innerHTML = `<option value="all">every server</option>` + fleetNodes.map(n =>
    `<option value="${esc(n.id)}">${esc(n.name)}${cfg.nodePanels && cfg.nodePanels[n.id] ? " (own set)" : ""}</option>`).join("");
  if (panelFor !== "all" && !fleetNodes.some(n => n.id === panelFor)) panelFor = "all";
  sel.value = panelFor;
  $("#cfg-p-reset").classList.toggle("hidden", !(panelFor !== "all" && cfg.nodePanels && cfg.nodePanels[panelFor]));
}
function drawPanelCfg() {
  const host = $("#cfg-panels");
  const set = editedSet();
  drawPanelFor();
  host.innerHTML = cfg.panelOrder.map(p => {
    const on = set.panels[p] !== false;
    const sz = (set.panelSize && set.panelSize[p]) || "normal";
    const opt = s => `<option value="${s}" ${sz === s ? "selected" : ""}>${s}</option>`;
    return `<div class="pcf ${on ? "" : "off"}" draggable="true" data-p="${p}">
      <span class="grip">⠿</span>
      <span class="pn">${p}</span>
      <button data-up aria-label="move ${p} up">&uarr;</button><button data-down aria-label="move ${p} down">&darr;</button>
      <select data-sz aria-label="size of ${p}">${opt("normal")}${opt("wide")}${opt("full")}</select>
      <label><input type="checkbox" data-vis ${on ? "checked" : ""}> show</label>
    </div>`;
  }).join("");
  const move = (p, by) => {
    const from = cfg.panelOrder.indexOf(p), to = from + by;
    if (from < 0 || to < 0 || to >= cfg.panelOrder.length) return;
    cfg.panelOrder.splice(to, 0, cfg.panelOrder.splice(from, 1)[0]);
    drawPanelCfg();
  };
  $$(".pcf", host).forEach(row => {
    row.ondragstart = e => { dragPanel = row.dataset.p; e.dataTransfer.effectAllowed = "move"; };
```

11. Replace

```html
      drawPanelCfg();
    };
    row.querySelector("[data-vis]").onchange = e => {
      cfg.panels[row.dataset.p] = e.target.checked;
      row.classList.toggle("off", !e.target.checked);
    };
    row.querySelector("[data-sz]").onchange = e => {
      (cfg.panelSize = cfg.panelSize || {})[row.dataset.p] = e.target.value;
    };
  });
```

   with

```html
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
```

12. Replace

```html
  $("#settings-close").onclick = closeSettings;
  $("#acct-save").onclick = saveAccount;
  $("#cfg-servers").addEventListener("change", e => {
    if (e.target.matches(".srv-name, .srv-tags")) saveServer(e.target.closest(".srv"));
```

   with

```html
  $("#settings-close").onclick = closeSettings;
  $("#acct-save").onclick = saveAccount;
  $("#cfg-p-for").onchange = e => { panelFor = e.target.value; drawPanelCfg(); };
  $("#cfg-p-reset").onclick = () => { delete cfg.nodePanels[panelFor]; drawPanelCfg(); };
  $("#cfg-servers").addEventListener("change", e => {
    if (e.target.matches(".srv-name, .srv-tags")) saveServer(e.target.closest(".srv"));
```

13. Replace

```html
  };

  // favicon / name widgets
  $("#fav-upload").onclick = () => $("#fav-file").click();
```

   with

```html
  };

  // import: fills the form; nothing is saved until the person presses save
  $("#cfg-import").onclick = () => $("#cfg-import-file").click();
  $("#cfg-import-file").onchange = async e => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const r = importSettings(await f.text().catch(() => ""));
    if (!r.ok) return toast(r.error, true);
    cfg = deepMerge(structuredClone(DEFAULTS), r.cfg);
    fixPanelOrder();
    openSettings();
    toast(`imported${r.skipped.length ? " (skipped " + r.skipped.join(", ") + ")" : ""}: check, then save`);
  };

  // favicon / name widgets
  $("#fav-upload").onclick = () => $("#fav-file").click();
```

- [ ] **Step 4: Run the tests and look**

Run: `node --test test/*.test.js && bash test/screens.sh`
Expected: PASS (3 new tests); `screenshots in /out: no page errors`; `build/screens/settings-1280.png` shows "which panels and sizes, for: every server" and arrow buttons on every panel row.

- [ ] **Step 5: Commit**

```bash
git add www/index.html test/page.test.js
git commit -m "feat(ui): panel sets per server, arrow buttons for the order, settings import" -m "The panel editor edits the shared set or one server's own (created from the shared one on its first change, dropped again with one button). The order stays shared and gets up and down buttons for touch screens. An exported settings file can be imported: known keys of the right kind fill the form, the rest is skipped, nothing is saved until save."
```

---

### Task 5: A customized fleet in the screenshots, docs, full validation

**Files:**
- Modify: `test/screens/shoot.js`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Screenshot a customized fleet**

In `test/screens/shoot.js`:

1. Replace

```js
  await page.screenshot({ path: `${out}/kiosk.png` });
  await page.evaluate(() => localStorage.clear());   // ?kiosk is remembered
  await page.goto(`${base}/#fleet`);
  await page.waitForTimeout(1200);
```

   with

```js
  await page.screenshot({ path: `${out}/kiosk.png` });
  await page.evaluate(() => localStorage.clear());   // ?kiosk is remembered

  // a customized fleet: grouped by tag, °F, bits, other card numbers (spec 10.4)
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "containers", "temp"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/fleet-custom.png` });
  await page.goto(`${base}/?shot=custom-node#node=${local}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/node-custom.png` });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/#fleet`);
  await page.waitForTimeout(1200);
```

- [ ] **Step 2: Docs**

In `README.md`:

1. Replace

```markdown
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Styles, modes and kiosk
```

   with

```markdown
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Customize

Settings (`s`) has everything in one place:

- **Units**: °C or °F, sizes in powers of 1024 (like `df -h`) or 1000 (like
  drive labels), network in bytes or bits per second, a 12 or 24 hour clock.
- **Servers**: rename a server or change its tags (saved at once), pin it to
  the front of the fleet, hide it from the fleet, or revoke it (LAN only;
  its agent is refused from then on). Sort the fleet by name, trouble first,
  CPU, memory, temperature or fullest disk, group it by each server's first
  tag, and pick up to four numbers for the cards.
- **Panels**: which panels show and how wide, for every server or only one;
  the order is shared (drag, or the arrow buttons on touch screens).
- **Export and import** the settings as one JSON file. An imported file fills
  the form; nothing changes until you save.

## Styles, modes and kiosk
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Link a server by code on HTTPS hubs: `servitals-agent link https://hub`
  prints a short code, a person approves it on the hub's `/link` page, and the
```

   with

```markdown

### Added
- Customize (spec 10.4): units (°C/°F, 1024/1000 sizes, bits or bytes per
  second, 12/24 hour clock); rename, tag, pin, hide and revoke servers from
  settings; sort and group the fleet and choose the numbers on its cards;
  panels and sizes per server; up and down buttons for the panel order;
  import settings from an exported file.
- Link a server by code on HTTPS hubs: `servitals-agent link https://hub`
  prints a short code, a person approves it on the hub's `/link` page, and the
```

- [ ] **Step 3: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                         # Expected: all pass (231)
bash test/budget.sh                                # Expected: every line ok; first page load about 29.5 KB
bash test/screens.sh                               # Expected: screenshots in /out: no page errors
bash test/compose-smoke.sh                         # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh   # Expected: both series, no lintian E:/W:
```

Open `build/screens/fleet-custom.png`: groups "home" and "untagged", disk / up / temp numbers with °F; and `node-custom.png`: °F in the thermal panel, `Mbit/s` rates, a 12 hour clock.

- [ ] **Step 4: Commit**

```bash
git add test/screens/shoot.js README.md CHANGELOG.md
git commit -m "test(ui): screenshot a customized fleet; docs for customization"
```
