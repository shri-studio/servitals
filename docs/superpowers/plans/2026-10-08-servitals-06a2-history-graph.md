# servitals History Graph (sub-project 6a-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each node's view gets a "history" panel (spec 10.1). It charts any of the node's series over 1 h, 24 h, 7 d, 30 d or 90 d with an average line, a low-high band, and shaded gaps. The data comes from 6a-1's `GET /__ctl/history`.

**Why:** 6a-1 keeps the history; this lets people see it. "Was the disk busy last night?" and "when did memory start to climb?" are the questions an operator asks first.

**Architecture:**
- **`www/js/history.js` (new),** loaded on first use like `settings.js`, per spec 10.5:
  - `kindOf(series)` gives the unit: pct, temp, net, io, bytes or num. `fmtKind` formats it with the page's own formatters, so network figures follow the network unit and I/O is always bytes.
  - `seriesLabel(series)` gives the name in words: base series from `hist.s.*`, and disks, devices and containers by name.
  - `historyChart(points, kind, range)` draws a 1000×200 SVG that stretches to the panel, with `preserveAspectRatio="none"` and a non-scaling stroke:
    - a `hband` polygon (low-high) and a `hline` polyline (average) per run of points with data;
    - a `hgap` rect per run without data;
    - the scale's high and low and the first and last times as HTML, so the text never stretches;
    - percent series on 0-100.
  - `initHistory()` wires the series picker and the range buttons. `loadHistory(force)` fetches the series list on a new node, then the chosen series and range at most once a minute unless forced, and writes "avg · low · high" below the chart. The series and range are remembered per browser.
- **`www/js/app.js`:**
  - The panel `hist` joins `DEFAULTS` (after "thermal", full width).
  - `showHistory()` loads the script once when a node view shows the panel and calls `loadHistory()` after every node tick.
- **`www/index.html`:** the panel, with the picker and the ranges in its title line.
- **`www/sw.js`:** the offline copy keeps `js/history.js`.
- **`test/screens/demo-hub.js`:** seeds a day of history for the local node and the nas, including a two-hour gap, so the screenshots show a real chart.

**Tech Stack:** vanilla JS and SVG (page), Node.js ≥ 18 (tests), Playwright (screenshots).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- 10.1: the history graph with a range picker, average line and min-max band, gaps shaded;
- 10.5: history charts load on first use;
- 10.3: every word from the dictionary;
- 7: the API.

**Scope:** 6a-2 completes 6a. No zoom or hover readout yet. Alerts (6b) come next.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (c419626) on 2026-10-08:
- node suite 357 tests;
- the budget (first page load 36676 bytes; `history.js` is not part of it);
- `test/screens.sh`: the nas chart shows its two-hour gap.

## Global Constraints

- The strict CSP: no inline script or style attribute. The chart is SVG markup with classes, and the script is a `'self'` file.
- Every word from `hub/lib/i18n.js`; names from the host are escaped.
- The first page load stays within 60 KB gzip: `history.js` loads after it.
- Everything from sub-projects 1-6a-1 still holds.
- Work in a worktree `.claude/worktrees/servitals-graph` on branch `feat/history-graph` from `main` (c419626).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Gaps and edges:**
   - a range that starts or ends in a gap;
   - a single point;
   - all points equal;
   - no data at all.

   The chart must stay drawable and honest. Test: "history chart: the average line and the low-high band per run of data…".
2. **Hostile names in the picker** (a mount or container with `<` or quotes): escaped in the value and the label. Read `loadHistory`; labels are tested in "history: each series reads in its unit…".
3. **A node with no history, an older hub without the API, a container series asked for 7 d** (404): the panel says "no history yet" rather than breaking. Read `loadHistory`.
4. **Switching nodes and ranges quickly**: the right node's data is shown; check for stale answers drawn over newer ones.
5. **Layout**:
   - the full-width panel at 390 px and in kiosk;
   - the picker in the title line.

   Test: `test/screens.sh` (fails on clipped panels).

---

### Task 1: The history panel

**Files:**
- Create: `www/js/history.js`
- Modify: `www/index.html`, `www/js/app.js`, `www/app.css`, `www/sw.js`, `hub/lib/i18n.js`, `test/helpers/page.js`, `test/page.test.js`, `test/i18n.test.js`, `test/screens/demo-hub.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `GET /__ctl/history` (6a-1).
- Produces:
  - `kindOf`, `fmtKind`, `seriesLabel`, `fmtTimeOrDay`, `historyChart`, `initHistory`, `loadHistory` in `www/js/history.js`;
  - `showHistory()` in `www/js/app.js`;
  - panel key `hist`;
  - dictionary keys `panel.hist` and `hist.*`;
  - CSS `.hplot`, `.hy`, `.hx`, `.hband`, `.hline`, `.hgap`, `.hnote`, `.hrange`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/page.js` (the page's scripts now include `history.js`):

1. Replace

```js
const BOOT = read("boot.js");
const I18N = fs.readFileSync(path.join(__dirname, "..", "..", "hub", "lib", "i18n.js"), "utf8");
const JS = I18N + "\n" + read("js/app.js") + "\n" + read("js/settings.js");
const PAGE = [MARKUP, CSS, BOOT, JS].join("\n");

```

   with

```js
const BOOT = read("boot.js");
const I18N = fs.readFileSync(path.join(__dirname, "..", "..", "hub", "lib", "i18n.js"), "utf8");
const JS = I18N + "\n" + read("js/app.js") + "\n" + read("js/settings.js") + "\n" + read("js/history.js");
const PAGE = [MARKUP, CSS, BOOT, JS].join("\n");

```

In `test/page.test.js`:

1. Replace

```js
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates", "battery"];
```

   with

```js
});

test("history: each series reads in its unit, and has a name in words", () => {
  const kindOf = pageFunction("kindOf");
  assert.deepStrictEqual(["cpu", "mem", "swap", "iowait", "psi.io", "disk./srv.used", "ctr.web.cpu", "temp", "net.rx", "io.sda1.read",
    "ctr.web.mem", "load1"].map(kindOf), ["pct", "pct", "pct", "pct", "pct", "pct", "pct", "temp", "net", "io", "bytes", "num"]);
  const { STRINGS } = require("../hub/lib/i18n");
  const seriesLabel = pageFn("seriesLabel", { STRINGS });
  assert.deepStrictEqual(["cpu", "net.rx", "disk./srv.used", "io.sda1.write", "ctr.web.mem", "weird"].map(seriesLabel),
    ["cpu", "network in", "disk /srv", "sda1 write", "web memory", "weird"]);
});

test("history chart: the average line and the low-high band per run of data; a gap is shaded; no data says so", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const historyChart = pageFn("historyChart", { esc, fmtKind: (k, v) => (v == null ? "–" : v + "%"),
    fmtTime: () => "12:00", fmtTimeOrDay: () => "12:00" });
  const pts = [[0, 10, 5, 20], [60, 20, 10, 30], [120, null, null, null], [180, null, null, null], [240, 40, 30, 50]];
  const svg = historyChart(pts, "pct", "1h");
  assert.strictEqual((svg.match(/<polyline class="hline"/g) || []).length, 2, "two runs of data: two lines");
  assert.strictEqual((svg.match(/<polygon class="hband"/g) || []).length, 2);
  assert.strictEqual((svg.match(/<rect class="hgap"/g) || []).length, 1, "the gap between them is shaded");
  assert.match(svg, /<span>100%<\/span><span>0%<\/span>/, "a share reads on 0 to 100");
  assert.match(svg, /points="0\.0,180\.0 250\.0,160\.0"/, "the line: x across the range, y from the average");
  assert.strictEqual(historyChart([[0, null, null, null]], "pct", "1h"), '<div class="muted">no history yet</div>');
  assert.doesNotMatch(svg, /style=/, "the strict CSP: no style attributes");
});

test("the history panel is in the node view and loads its script when shown", () => {
  for (const id of ["hist-series", "hist-chart", "hist-note"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /data-panel="hist"/);
  assert.match(HTML, /class="hrange" data-r="24h"/);
  assert.match(JS, /s\.src = "js\/history\.js";/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "www", "sw.js"), "utf8"), /"\/js\/history\.js"/, "kept for the offline copy");
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates", "battery"];
```

2. Replace

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

   with

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "hist", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

In `test/i18n.test.js`:

1. Replace

```js
  assert.deepStrictEqual(taggedWithChildren('<h2 data-i18n="panel.mem">memory <span id="mem-note"></span></h2>'), ["panel.mem"]);
});

test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
  for (const k of asked) if (!k.endsWith(".")) assert.ok(Object.prototype.hasOwnProperty.call(STRINGS, k), `missing from the dictionary: ${k}`);
```

   with

```js
  assert.deepStrictEqual(taggedWithChildren('<h2 data-i18n="panel.mem">memory <span id="mem-note"></span></h2>'), ["panel.mem"]);
});

test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"), read("js/history.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
  for (const k of asked) if (!k.endsWith(".")) assert.ok(Object.prototype.hasOwnProperty.call(STRINGS, k), `missing from the dictionary: ${k}`);
```

2. Replace

```js
    assert.ok(asked.has(k) || prefixes.some((p) => k.startsWith(p)), `never used: ${k}`);
  }
});

```

   with

```js
    assert.ok(asked.has(k) || prefixes.some((p) => k.startsWith(p)), `never used: ${k}`);
  }
});

test("history.js puts no words on the page except through tr()", () => {
  assert.deepStrictEqual(wordsOutsideTr(read("js/history.js")), []);
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/*.test.js`
Expected: FAIL. Every file that reads the page fails as a whole (`ENOENT … www/js/history.js`): `test/page.test.js`, `test/i18n.test.js`, `test/pwa.test.js` and `test/styles.test.js`. So does "dashboard has the branding footer and the update notice", which reads the page directly.

- [ ] **Step 3: The panel's script**

Create `www/js/history.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* the history panel (spec 7, 10.1): a series, a range, and the chart of its average with
   its low-high band, gaps shaded. Loaded by showHistory() in app.js when a node view
   first shows the panel; the data comes from GET /__ctl/history. */
const HIST_ORDER = ["cpu", "mem", "temp", "load1", "iowait", "psi.cpu", "psi.mem", "psi.io", "swap", "net.rx", "net.tx"];
const histState = { node: null, series: lsGet("hist.series") || "cpu", range: lsGet("hist.range") || "24h", at: 0 };

// how a series' numbers read
function kindOf(name) {
  if (/^(cpu|mem|swap|iowait)$|^psi\.|^disk\..*\.used$|^ctr\..*\.cpu$/.test(name)) return "pct";
  if (name === "temp") return "temp";
  if (/^net\./.test(name)) return "net";
  if (/^io\./.test(name)) return "io";
  if (/^ctr\..*\.mem$/.test(name)) return "bytes";
  return "num";
}
function fmtKind(kind, v) {
  if (v == null) return "–";
  if (kind === "pct") return fmtShare(v);
  if (kind === "temp") return fmtTemp(v, true);
  if (kind === "net") return fmtRate(v);
  if (kind === "io") return fmtRate(v, true);
  if (kind === "bytes") return fmtBytes(v);
  return String(Math.round(v * 100) / 100);
}
// a series' name in words: the base ones from the dictionary, disks, devices and containers by name
function seriesLabel(name) {
  let m;
  if (STRINGS["hist.s." + name]) return tr("hist.s." + name);
  if ((m = /^disk\.(.*)\.used$/.exec(name))) return tr("hist.disk", { mount: m[1] });
  if ((m = /^io\.(.*)\.(read|write)$/.exec(name))) return tr("hist.io." + m[2], { device: m[1] });
  if ((m = /^ctr\.(.*)\.(cpu|mem)$/.exec(name))) return tr("hist.ctr." + m[2], { name: m[1] });
  return name;
}
// a point's time: the clock for a day or less, the date beyond
function fmtTimeOrDay(t, range) {
  const d = new Date(t * 1000);
  return range === "1h" || range === "24h" ? fmtTime(d) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// the chart: per run of points with data, the low-high band and the average line; a run
// without data is shaded. Drawn in a 1000 x 200 box that stretches; the words are HTML.
function historyChart(points, kind, range) {
  const data = points.filter(p => p[1] != null);
  if (!data.length) return `<div class="muted">${esc(tr("hist.empty"))}</div>`;
  const W = 1000, H = 200, n = points.length, step = n > 1 ? W / (n - 1) : W;
  let lo = kind === "pct" ? 0 : Math.min(0, ...data.map(p => p[2]));
  let hi = kind === "pct" ? 100 : Math.max(...data.map(p => p[3]));
  if (kind === "temp") { lo = Math.min(...data.map(p => p[2])) - 2; hi += 2; }
  if (!(hi > lo)) hi = lo + 1;
  const x = i => (n > 1 ? i * step : W / 2).toFixed(1);
  const y = v => (H - ((v - lo) / (hi - lo)) * H).toFixed(1);
  let gaps = "", bands = "", lines = "";
  for (let i = 0; i < n;) {
    const has = points[i][1] != null;
    let j = i;
    while (j < n && (points[j][1] != null) === has) j++;
    if (has) {
      const run = points.slice(i, j).map((p, k) => [i + k, p]);
      bands += `<polygon class="hband" points="${run.map(([k, p]) => x(k) + "," + y(p[3])).join(" ")} `
        + `${run.slice().reverse().map(([k, p]) => x(k) + "," + y(p[2])).join(" ")}"/>`;
      lines += `<polyline class="hline" vector-effect="non-scaling-stroke" points="${run.map(([k, p]) => x(k) + "," + y(p[1])).join(" ")}"/>`;
    } else {
      const x0 = Math.max(0, i * step - step / 2), x1 = Math.min(W, (j - 1) * step + step / 2);
      gaps += `<rect class="hgap" x="${x0.toFixed(1)}" y="0" width="${(x1 - x0).toFixed(1)}" height="${H}"/>`;
    }
    i = j;
  }
  return `<div class="hplot"><div class="hy"><span>${esc(fmtKind(kind, hi))}</span><span>${esc(fmtKind(kind, lo))}</span></div>`
    + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${gaps}${bands}${lines}</svg></div>`
    + `<div class="hx"><span>${esc(fmtTimeOrDay(points[0][0], range))}</span><span>${esc(fmtTimeOrDay(points[n - 1][0], range))}</span></div>`;
}

// wiring, once, when this file has loaded
function initHistory() {
  $("#hist-series").onchange = e => { histState.series = e.target.value; lsSet("hist.series", histState.series); loadHistory(true); };
  $$(".hrange").forEach(b => b.onclick = () => { histState.range = b.dataset.r; lsSet("hist.range", histState.range); loadHistory(true); });
}

// fetch and draw: on a new node, a new series or range, else at most once a minute
async function loadHistory(force) {
  const node = currentNode || localNode;
  if (!node) return;
  const fresh = node !== histState.node;
  if (!force && !fresh && Date.now() - histState.at < 60000) return;
  histState.at = Date.now();
  const q = s => fetch(`/__ctl/history?node=${encodeURIComponent(node)}&${s}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (fresh) {
    histState.node = node;
    const list = await q("series=list");
    const names = (list && Array.isArray(list.series) ? list.series : []).filter(s => typeof s === "string");
    names.sort((a, b) => ((HIST_ORDER.indexOf(a) + 1 || 99) - (HIST_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
    if (!names.includes(histState.series)) histState.series = names.includes("cpu") ? "cpu" : (names[0] || "cpu");
    $("#hist-series").innerHTML = names.map(s => `<option value="${esc(s)}">${esc(seriesLabel(s))}</option>`).join("");
    $("#hist-series").value = histState.series;
  }
  $$(".hrange").forEach(b => b.classList.toggle("on", b.dataset.r === histState.range));
  const d = await q(`series=${encodeURIComponent(histState.series)}&range=${histState.range}`);
  const kind = kindOf(histState.series);
  $("#hist-chart").innerHTML = historyChart(d && Array.isArray(d.points) ? d.points : [[0, null, null, null]], kind, histState.range);
  const vals = d && Array.isArray(d.points) ? d.points.filter(p => p[1] != null) : [];
  $("#hist-note").textContent = vals.length ? tr("hist.summary", {
    avg: fmtKind(kind, vals.reduce((a, p) => a + p[1], 0) / vals.length),
    lo: fmtKind(kind, Math.min(...vals.map(p => p[2]))), hi: fmtKind(kind, Math.max(...vals.map(p => p[3]))),
  }) : "";
}
```

- [ ] **Step 4: The panel, its loader, words and style**

In `www/index.html`:

1. Replace

```html
      <div class="row mt10"><span class="k" data-i18n="temp.range">range (session)</span><span class="v" id="temp-range">--</span></div>
      <div class="row"><span class="k" data-i18n="temp.sensors">sensors</span><span class="v" id="temp-cores">--</span></div>
    </div>

```

   with

```html
      <div class="row mt10"><span class="k" data-i18n="temp.range">range (session)</span><span class="v" id="temp-range">--</span></div>
      <div class="row"><span class="k" data-i18n="temp.sensors">sensors</span><span class="v" id="temp-cores">--</span></div>
    </div>

    <div class="panel" data-panel="hist">
      <h2><span data-i18n="panel.hist">history</span>
        <span class="h2note">
          <select id="hist-series" aria-label="series" data-i18n-aria-label="hist.seriesLabel"></select>
          <span class="hrange" data-r="1h" data-i18n="hist.r.1h">1h</span>
          <span class="hrange" data-r="24h" data-i18n="hist.r.24h">24h</span>
          <span class="hrange" data-r="7d" data-i18n="hist.r.7d">7d</span>
          <span class="hrange" data-r="30d" data-i18n="hist.r.30d">30d</span>
          <span class="hrange" data-r="90d" data-i18n="hist.r.90d">90d</span>
        </span>
      </h2>
      <div id="hist-chart" class="hchart"></div>
      <div id="hist-note" class="hnote"></div>
    </div>

```

In `www/js/app.js`:

1. Replace

```js
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, storage: 1, network: 1, docker: 1, procs: 1, system: 1, hw: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", storage: "wide",
                 network: "wide", docker: "full", procs: "wide", system: "normal", hw: "normal", clocks: "normal", weather: "normal" }
  };
```

   with

```js
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, hist: 1, storage: 1, network: 1, docker: 1, procs: 1, system: 1, hw: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "hist", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", hist: "full", storage: "wide",
                 network: "wide", docker: "full", procs: "wide", system: "normal", hw: "normal", clocks: "normal", weather: "normal" }
  };
```

2. Replace

```js
    lastData = d;
    renderMetrics(d);
    setStatus(d.ts);
  } catch (e) {
```

   with

```js
    lastData = d;
    renderMetrics(d);
    showHistory();
    setStatus(d.ts);
  } catch (e) {
```

3. Replace

```js
  $("#overlay").classList.remove("open");
}
let settingsReady = null;
function openSettings() {
```

   with

```js
  $("#overlay").classList.remove("open");
}
/* ------------------------------------------------------------------ history, loaded on first use (spec 10.5) */
let historyReady = null;
function showHistory() {
  const panel = $("[data-panel=hist]");
  if (view !== "node" || !panel || panel.classList.contains("hidden")) return;
  historyReady = historyReady || new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "js/history.js";
    s.onload = () => (typeof initHistory === "function" ? (initHistory(), ok()) : fail(new Error("history.js")));
    s.onerror = () => { historyReady = null; fail(new Error("history.js")); };
    document.head.appendChild(s);
  });
  historyReady.then(() => loadHistory(), () => {});
}

let settingsReady = null;
function openSettings() {
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "panel.system": "system",
  "panel.hw": "hardware",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

   with

```js
  "panel.system": "system",
  "panel.hw": "hardware",
  "panel.hist": "history",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

2. Replace

```js
  "hw.bat.notcharging": "not charging",
  "hw.bat.unknown": "unknown",

  // dialogs
```

   with

```js
  "hw.bat.notcharging": "not charging",
  "hw.bat.unknown": "unknown",

  // history: series names, ranges, the chart's words
  "hist.seriesLabel": "series",
  "hist.r.1h": "1h", "hist.r.24h": "24h", "hist.r.7d": "7d", "hist.r.30d": "30d", "hist.r.90d": "90d",
  "hist.s.cpu": "cpu", "hist.s.mem": "memory", "hist.s.temp": "temperature", "hist.s.load1": "load 1m",
  "hist.s.iowait": "iowait", "hist.s.swap": "swap", "hist.s.psi.cpu": "pressure cpu", "hist.s.psi.mem": "pressure memory",
  "hist.s.psi.io": "pressure io", "hist.s.net.rx": "network in", "hist.s.net.tx": "network out",
  "hist.disk": "disk {mount}",
  "hist.io.read": "{device} read", "hist.io.write": "{device} write",
  "hist.ctr.cpu": "{name} cpu", "hist.ctr.mem": "{name} memory",
  "hist.empty": "no history yet",
  "hist.summary": "avg {avg} · low {lo} · high {hi}",

  // dialogs
```

In `www/app.css`:

1. Replace

```css
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sysunits { color: var(--dim); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }
```

   with

```css
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sysunits { color: var(--dim); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
/* history: the chart stretches to the panel; its words are HTML, so they never stretch */
.hplot { display: flex; gap: 8px; align-items: stretch; height: 160px; }
.hplot .hy { display: flex; flex-direction: column; justify-content: space-between; color: var(--dim); font-size: 11px; min-width: 44px; text-align: right; }
.hplot svg { flex: 1; min-width: 0; height: 100%; }
.hchart .hx { display: flex; justify-content: space-between; color: var(--dim); font-size: 11px; margin: 4px 0 0 52px; }
.hband { fill: var(--cyan); fill-opacity: .18; }
.hline { fill: none; stroke: var(--cyan); stroke-width: 1.6; }
.hgap { fill: var(--dim); fill-opacity: .12; }
.hnote { color: var(--dim); font-size: 12px; margin-top: 6px; }
.hrange { cursor: pointer; margin-left: 6px; }
.hrange.on { color: var(--fg-bright); text-decoration: underline; }
#hist-series { font: inherit; font-size: 11px; }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }
```

In `www/sw.js`:

1. Replace

```js
const VERSION = "0.1.0";   // keep equal to the VERSION file (test/pwa.test.js checks)
const CACHE = "servitals-" + VERSION;
const SHELL = ["/", "/app.css", "/boot.js", "/js/i18n.js", "/js/app.js", "/js/settings.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// "shell": network first, the cache when offline; "network": as if there were no worker
```

   with

```js
const VERSION = "0.1.0";   // keep equal to the VERSION file (test/pwa.test.js checks)
const CACHE = "servitals-" + VERSION;
const SHELL = ["/", "/app.css", "/boot.js", "/js/i18n.js", "/js/app.js", "/js/settings.js", "/js/history.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// "shell": network first, the cache when offline; "network": as if there were no worker
```

- [ ] **Step 5: A day of history in the screenshots**

In `test/screens/demo-hub.js`:

1. Replace

```js
}

(async () => {
  await sleep(800);
```

   with

```js
}

// a day of history for the local node and the nas (the nas was off for two hours),
// written straight into the hub's history files before the pushes start
function seedHistory(creds) {
  const { createHistory } = require(path.join(REPO, "hub/lib/history"));
  const start = Math.floor(Date.now() / 60000) - 1440;
  let minute = start;
  const h = createHistory(path.join(state, "history"), { now: () => minute * 60000 });
  for (; minute < start + 1440; minute++) {
    const m = minute - start;
    for (const [i, c] of creds.slice(0, 2).entries()) {
      if (i === 1 && m > 900 && m < 1020) continue;   // the nas: two hours offline
      const wave = Math.sin(m / 90 + i) * 15, spike = m % 360 < 20 ? 30 : 0;
      h.add(c.id, { cpu: Math.max(1, 25 + wave + spike + (m % 7)), mem: 40 + i * 20 + Math.sin(m / 300) * 5,
                    temp: 45 + wave / 3, "net.rx": 2e6 + Math.abs(wave) * 1e5 });
    }
  }
  h.flush();
}

(async () => {
  await sleep(800);
```

2. Replace

```js
    creds.push({ ...n, name });
  }
  for (let round = 0; round < 3; round++) {
    for (const [i, c] of creds.entries()) {
```

   with

```js
    creds.push({ ...n, name });
  }
  seedHistory(creds);
  for (let round = 0; round < 3; round++) {
    for (const [i, c] of creds.entries()) {
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- History (spec 7): the hub keeps every node's series (cpu, memory, swap,
  temperature, load, iowait, pressure, network, each disk's use and I/O,
```

   with

```markdown

### Added
- History graph (spec 10.1): a "history" panel in each node's view charts
  any of its series (cpu, memory, temperature, load, iowait, pressure,
  network, each disk and device, each container) over 1 h, 24 h, 7 d, 30 d
  or 90 d: the average line, the low-high band, and gaps shaded. Its script
  loads when the panel is first shown.
- History (spec 7): the hub keeps every node's series (cpu, memory, swap,
  temperature, load, iowait, pressure, network, each disk's use and I/O,
```

- [ ] **Step 6: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/screens.sh`
Expected:
- PASS, 357 tests;
- the budget passes (first page load about 36700 bytes);
- `screenshots in /out: no page errors`;
- `build/screens/1280-comfortable-nas.png` shows "history" with the cpu line over 24 h and a shaded two-hour gap.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` (`compose smoke test passed`);
- `bash packaging/build-deb.sh` (both packages `ok`; `www/js/history.js` is installed with the other `www/js` files);
- `bash packaging/autopkgtest.sh` (smoke and purge PASS).

- [ ] **Step 7: Commit**

```bash
git add www/js/history.js www/index.html www/js/app.js www/app.css www/sw.js hub/lib/i18n.js test/helpers/page.js test/page.test.js test/i18n.test.js test/screens/demo-hub.js CHANGELOG.md
git commit -m "feat(ui): a history panel: any series over 1 h to 90 d, its average, low-high band and gaps"
```
