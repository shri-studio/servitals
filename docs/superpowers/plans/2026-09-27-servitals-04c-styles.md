# servitals Styles, Modes and Kiosk (sub-project 4c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ten styles (classic, 8bit, phosphor, e-ink, high contrast, nord, gruvbox, dracula, catppuccin, solarized), each loaded only when chosen; a light/dark/system mode switch; density; a hub-wide default look; and a kiosk mode for wall screens, with screenshots of every style and mode in CI.

**Architecture:** Every style but classic is one file `www/styles/<id>.css` (at most 3 KB gzipped) holding a light token set `:root[data-style="<id>"]`, a dark set `:root[data-theme="dark"][data-style="<id>"]`, the same dark set for a system in dark mode, and optional extra rules. A small script at the top of `<head>` applies the browser's stored style, mode, density and `?kiosk` before the first paint and writes the style's `<link>`; after `config.json` loads, the hub's saved defaults fill in whatever this browser has not chosen. The page keeps a registry `STYLES` that the settings panel and the `y` key use. The hub carries `?kiosk` through its login page and tells browsers to revalidate static files. A demo hub with three servers and a Playwright container take screenshots of every style and mode at six widths and fail on any page error or panel whose content does not fit.

**Tech Stack:** HTML/CSS/vanilla JS (single page), Node.js ≥ 18 built-ins for tests, Playwright 1.55 in its Docker image (CI only), fonttools (once, to subset VT323).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` sections 10.2 (styles and modes, the registry, contrast), 10.3 (density, kiosk), 13.1 (bundled fonts), 16 (visual checks), 18 (lightness budget: 3 KB per style).

**Scope (4c of sub-project 4):** 4f (ES modules with a strict CSP, i18n dictionary, PWA shell) follows as its own plan. 4b, 4d and 4e are unchanged.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (0ef135a) on 2026-09-27: node suite 195 tests, shellcheck at CI settings, budget (page 25.0 KB gz, styles 495-1021 bytes gz), Docker smoke test, both series built and lintian clean, autopkgtest, and `test/screens.sh` (94 screenshots, no page errors, nothing cut off). A second copy rebuilt from this plan's text alone matched the first byte for byte.

## Global Constraints

- Everything from sub-projects 1-4a still holds: zero runtime dependencies (hub: Node built-ins; agent: bash, coreutils, jq, curl), Node 18 compatibility (no `fetch` in `hub/` or `test/`), SPDX headers, lintian clean, `.deb` ≤ 500 KB, the lightness budget (first page load ≤ 60 KB gzipped without fonts).
- Each style file ≤ 3072 bytes gzipped (`gzip -9`), starts with `/* SPDX-License-Identifier: AGPL-3.0-or-later */`, and defines every colour token in light and dark: `--bg --bg-panel --border --dim --fg --fg-bright --green --cyan --amber --red --magenta --blue --track --spark --shadow --glow`.
- Contrast (WCAG 2.x relative luminance): text (`--fg` on `--bg` and `--bg-panel`, `--dim` and `--fg-bright` on `--bg-panel`) at least 4.5:1, status colours at least 3:1 on `--bg-panel`; the high-contrast style at least 7:1 and 4.5:1.
- Style ids match `/^[a-z0-9-]{1,32}$/`; only such a name ever reaches a URL. `localStorage` keys stay `servitals.style`, `servitals.theme` (values `light`/`dark`, absent for system) and new `servitals.density`, so earlier choices keep working.
- Nothing in the page may fetch from another origin (fonts are bundled, `url('../fonts/…')`).
- Playwright and its browsers live only in the CI container; nothing from them is shipped or added to `package.json` (there is none).
- The live dashboard runs on this host (native install, port 20002). All tests run in temp dirs and containers; do not touch `/etc/servitals`, `/var/lib/servitals` or the running units.
- Work in a worktree `.claude/worktrees/servitals-styles` on branch `feat/styles` from `main` (0ef135a).
- Docker Hub may time out on this host: `IMAGE_PREFIX=mirror.gcr.io/library/` for the package scripts.
- Every `local` variable used in an `EXIT` trap is a bug (twice in this project): use a global.
- Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers. OpenWolf: log fixed bugs in `.wolf/buglog.json`.

## Review Focus

1. **A stored style name that is odd, hostile or no longer shipped** (edited `localStorage`, an older version's choice, a removed style): nothing but a plain name may reach the `<link>`, and the page must fall back to classic without errors; older `theme` values `light`/`dark` and style `8bit` keep working. Test: Task 2, "the early script applies a stored look and refuses odd style names".
2. **A wall screen with no keyboard**: `/?kiosk` must survive the login page and a later expired session, and a screen must have a way out when an admin turns kiosk on for every screen. Tests: Task 2, "?kiosk turns kiosk on and is remembered; ?kiosk=0 turns it off…"; Task 3, "/?kiosk survives the login page, with only a fixed value in the redirect" (including an odd request path and a hostile value).
3. **Unreadable text in some style and mode**, including the system-dark path that a person never picks explicitly. Test: Task 1, "text is readable in every style and mode" and "its system-dark block matches its dark block".
4. **Narrow screens, large density and kiosk zoom**: phones, tablets and a 1280 px wall screen must not cut off or overlap values, and a script error in one style or mode must not go unseen. Test: Task 4, `test/screens.sh` checks 390, 600, 768, 1024, 1280 and 1920 px in every density and kiosk, and fails on any page error or panel wider than its box.
5. **Works from the checkout but not after install or upgrade** (a style or font file not packaged, a font URL that 404s, a browser keeping the old page after an upgrade). Tests: Task 1, "every font a style file asks for is shipped" and "the package ships the style files and the VT323 font"; Task 3, the `cache-control: no-cache` assertion; Task 4, autopkgtest.

---

### Task 1: Style files, the VT323 font, packaging

**Files:**
- Create: `test/styles.test.js`, `www/styles/{8bit,phosphor,eink,contrast,nord,gruvbox,dracula,catppuccin,solarized}.css`, `www/fonts/vt323-400.woff2`, `www/fonts/OFL-VT323.txt`
- Modify: `test/packaging.test.js`, `test/license.test.js`, `test/budget.sh`, `debian/servitals.install`, `debian/copyright`, `packaging/install-local.sh`

**Interfaces:**
- Produces: the style files (ids above); each defines the three token blocks named in the Architecture. `phosphor.css` loads `fonts/vt323-400.woff2`, `8bit.css` loads `fonts/press-start-2p-400.woff2` (already shipped). Task 2 links them as `styles/<id>.css` and adds the registry test to `test/styles.test.js`. The page still carries its own 8bit block until Task 2; both agree, so nothing changes on screen yet.

- [ ] **Step 1: Write the failing tests**

Create `test/styles.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The style registry (spec 10.2): every style is a light and a dark token set
 * plus optional CSS, at most 3 KB gzipped, loaded only when chosen. Text must
 * stay readable: WCAG AA (4.5:1) for text and 3:1 for status colours in every
 * style and mode; the high-contrast style meets AAA (7:1).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const WWW = path.join(__dirname, "..", "www");
const HTML = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
const TOKENS = ["bg", "bg-panel", "border", "dim", "fg", "fg-bright", "green", "cyan", "amber", "red",
                "magenta", "blue", "track", "spark", "shadow", "glow"];
const STATUS = ["green", "amber", "red", "blue", "cyan", "magenta"];

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
function blockAfter(css, selector) {
  const i = css.indexOf(selector + " {");
  assert.ok(i >= 0, `missing ${selector}`);
  return tokens(css.slice(i, css.indexOf("}", i)));
}
function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// every style, both modes: [style, mode, tokens]
function allSets() {
  const sets = [];
  const classicLight = tokens(HTML.slice(HTML.indexOf(":root {"), HTML.indexOf("}", HTML.indexOf(":root {"))));
  const classicDark = blockAfter(HTML, ':root[data-theme="dark"]');
  sets.push(["classic", "light", classicLight], ["classic", "dark", classicDark]);
  for (const f of fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css"))) {
    const id = f.replace(/\.css$/, "");
    const css = fs.readFileSync(path.join(WWW, "styles", f), "utf8");
    sets.push([id, "light", blockAfter(css, `:root[data-style="${id}"]`)],
              [id, "dark", blockAfter(css, `:root[data-theme="dark"][data-style="${id}"]`)]);
  }
  return sets;
}

test("every style file is small, and its system-dark block matches its dark block", () => {
  for (const f of fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css"))) {
    const id = f.replace(/\.css$/, "");
    const css = fs.readFileSync(path.join(WWW, "styles", f), "utf8");
    assert.ok(zlib.gzipSync(css, { level: 9 }).length <= 3072, `${f} is over 3 KB gzipped`);
    assert.match(css, /SPDX-License-Identifier: AGPL-3.0-or-later/);
    assert.deepStrictEqual(blockAfter(css, `:root:not([data-theme="light"])[data-style="${id}"]`),
                           blockAfter(css, `:root[data-theme="dark"][data-style="${id}"]`), f);
  }
});

test("every style defines every colour token in light and dark", () => {
  for (const [id, mode, t] of allSets()) {
    for (const k of TOKENS) assert.ok(t[k] !== undefined, `${id} ${mode}: --${k} missing`);
  }
});

test("text is readable in every style and mode (AA; AAA for high contrast)", () => {
  const problems = [];
  for (const [id, mode, t] of allSets()) {
    const text = id === "contrast" ? 7 : 4.5;
    const status = id === "contrast" ? 4.5 : 3;
    for (const [a, b, min] of [["fg", "bg", text], ["fg", "bg-panel", text], ["dim", "bg-panel", text], ["dim", "bg", text], ["fg-bright", "bg-panel", text],
                               ...STATUS.map((s) => [s, "bg-panel", status])]) {
      const c = contrast(t[a], t[b]);
      if (c < min) problems.push(`${id} ${mode}: --${a} on --${b} is ${c.toFixed(2)} (needs ${min})`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test("every font a style file asks for is shipped", () => {
  for (const f of fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css"))) {
    const css = fs.readFileSync(path.join(WWW, "styles", f), "utf8");
    for (const m of css.matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)) {
      assert.ok(fs.existsSync(path.join(WWW, "fonts", m[1])), `${f}: fonts/${m[1]} is missing`);
    }
  }
});
```

Append to `test/packaging.test.js`:

```js
test("the package ships the style files and the VT323 font", () => {
  assert.match(read("debian/servitals.install"), /^www\/styles\/\*\.css usr\/share\/servitals\/www\/styles\/$/m);
  assert.match(read("debian/servitals.install"), /^www\/fonts\/\*\.woff2 /m);
  assert.match(read("debian/copyright"), /^Files: www\/fonts\/vt323-\*\.woff2$/m);
  for (const p of ["nord", "gruvbox", "dracula", "catppuccin", "solarized"]) {
    assert.match(read("debian/copyright"), new RegExp(`^Files: www/styles/${p}\\.css\nCopyright: .+\n .+\nLicense: AGPL-3\\.0-or-later and Expat$`, "m"), p);
  }
  assert.match(read("packaging/install-local.sh"), /cp -r "\$SRC\/www\/styles" "\$SHARE\/www\/styles"/);
});
```

In `test/license.test.js`:

1. Replace

```js
test("LICENSE is the AGPL v3 and font licenses are present", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
  for (const f of ["OFL-JetBrainsMono.txt", "OFL-PressStart2P.txt"]) {
    assert.match(fs.readFileSync(path.join(ROOT, "www", "fonts", f), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/i);
  }
```

   with

```js
test("LICENSE is the AGPL v3 and font licenses are present", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
  for (const f of ["OFL-JetBrainsMono.txt", "OFL-PressStart2P.txt", "OFL-VT323.txt"]) {
    assert.match(fs.readFileSync(path.join(ROOT, "www", "fonts", f), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/i);
  }
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/styles.test.js test/packaging.test.js test/license.test.js`
Expected: FAIL: `ENOENT … www/styles`, the packaging test (`www/styles/*.css` not in `debian/servitals.install`) and the license test (`OFL-VT323.txt` missing).

- [ ] **Step 3: Write the style files**

`www/styles/8bit.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* 8bit: PICO-8 palette, pixel headings, hard shadows, scanlines, blinking lamp */
:root[data-style="8bit"] { --bg:#FFF1E8; --bg-panel:#ffffff; --border:#5F574F; --dim:#7E2553; --fg:#1D2B53; --fg-bright:#000000; --green:#008751; --cyan:#1D6FA8; --amber:#AB5236; --red:#C4003A; --magenta:#7E2553; --blue:#1D2B53; --track:#C2C3C7; --spark:#83769C; --shadow:4px 4px 0 var(--border); --glow:none; --border-w:3px; }
:root[data-theme="dark"][data-style="8bit"] { --bg:#1D2B53; --bg-panel:#14142b; --border:#5F574F; --dim:#A99BC4; --fg:#FFF1E8; --fg-bright:#ffffff; --green:#00E436; --cyan:#29ADFF; --amber:#FFA300; --red:#FF004D; --magenta:#FF77A8; --blue:#29ADFF; --track:#2b2b45; --spark:#5F574F; --shadow:4px 4px 0 #000000; --glow:none; --border-w:3px; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="8bit"] { --bg:#1D2B53; --bg-panel:#14142b; --border:#5F574F; --dim:#A99BC4; --fg:#FFF1E8; --fg-bright:#ffffff; --green:#00E436; --cyan:#29ADFF; --amber:#FFA300; --red:#FF004D; --magenta:#FF77A8; --blue:#29ADFF; --track:#2b2b45; --spark:#5F574F; --shadow:4px 4px 0 #000000; --glow:none; --border-w:3px; }
}
@font-face { font-family: 'Press Start 2P'; font-style: normal; font-weight: 400; font-display: swap; src: url('../fonts/press-start-2p-400.woff2') format('woff2'); }
:root[data-style="8bit"] .head, :root[data-style="8bit"] .panel { image-rendering: pixelated; }
:root[data-style="8bit"] .head .title, :root[data-style="8bit"] .panel > h2, :root[data-style="8bit"] .keyhint b,
:root[data-style="8bit"] .modal h3, :root[data-style="8bit"] .ps1, :root[data-style="8bit"] .sb,
:root[data-style="8bit"] button, :root[data-style="8bit"] .ncard .nhead { font-family: 'Press Start 2P', monospace; letter-spacing: 0; }
:root[data-style="8bit"] .head .title { font-size: 12px; line-height: 1.8; }
:root[data-style="8bit"] .panel > h2, :root[data-style="8bit"] .ncard .nhead { font-size: 9px; line-height: 1.9; }
:root[data-style="8bit"] .keyhint b, :root[data-style="8bit"] .tabs button { font-size: 9px; line-height: 2.2; }
:root[data-style="8bit"] .modal h3 { font-size: 9px; line-height: 2; }
:root[data-style="8bit"] .head .dot, :root[data-style="8bit"] .lamp { border-radius: 0; }
:root[data-style="8bit"] .head .dot { animation: blink8bit 1s steps(1) infinite; }
@keyframes blink8bit { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }
:root[data-style="8bit"] body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 999;
  background: repeating-linear-gradient(to bottom, rgba(0,0,0,.12) 0px, rgba(0,0,0,.12) 1px, transparent 1px, transparent 3px); mix-blend-mode: multiply; }
:root[data-theme="dark"][data-style="8bit"] body::after { mix-blend-mode: overlay; }
@media (prefers-reduced-motion: reduce) { :root[data-style="8bit"] .head .dot { animation: none; } }
```

`www/styles/phosphor.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* phosphor: CRT terminal, green phosphor in dark mode, amber in light mode, VT323 and scanlines */
:root[data-style="phosphor"] { --bg:#140c02; --bg-panel:#1c1204; --border:#6b4a12; --dim:#d9a03a; --fg:#ffb940; --fg-bright:#ffe2a8; --green:#ffb940; --cyan:#ffcf7a; --amber:#ffe2a8; --red:#ff6b4a; --magenta:#ffe2a8; --blue:#ffb940; --track:#2e1f07; --spark:#8a6420; --shadow:none; --glow:0 0 6px rgba(255,185,64,.5); }
:root[data-theme="dark"][data-style="phosphor"] { --bg:#030a05; --bg-panel:#06120a; --border:#1d5c2e; --dim:#4fbf70; --fg:#5cff8a; --fg-bright:#b9ffcb; --green:#5cff8a; --cyan:#8affad; --amber:#ffd75c; --red:#ff6b5c; --magenta:#b9ffcb; --blue:#5cff8a; --track:#0d2615; --spark:#2c8a47; --shadow:none; --glow:0 0 6px rgba(92,255,138,.55); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="phosphor"] { --bg:#030a05; --bg-panel:#06120a; --border:#1d5c2e; --dim:#4fbf70; --fg:#5cff8a; --fg-bright:#b9ffcb; --green:#5cff8a; --cyan:#8affad; --amber:#ffd75c; --red:#ff6b5c; --magenta:#b9ffcb; --blue:#5cff8a; --track:#0d2615; --spark:#2c8a47; --shadow:none; --glow:0 0 6px rgba(92,255,138,.55); }
}
@font-face { font-family: 'VT323'; font-style: normal; font-weight: 400; font-display: swap; src: url('../fonts/vt323-400.woff2') format('woff2'); }
:root[data-style="phosphor"] body { font-family: 'VT323', monospace; font-size: 17px; line-height: 1.2; color-scheme: dark; }
:root[data-style="phosphor"] body * { text-shadow: var(--glow); }
:root[data-style="phosphor"] body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 999;
  background: repeating-linear-gradient(to bottom, rgba(0,0,0,.18) 0px, rgba(0,0,0,.18) 1px, transparent 1px, transparent 3px); }
```

`www/styles/eink.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* e-ink: pure black and white for e-ink wall displays; warnings use weight, underline and borders instead of colour */
:root[data-style="eink"] { --bg:#ffffff; --bg-panel:#ffffff; --border:#000000; --dim:#333333; --fg:#000000; --fg-bright:#000000; --green:#000000; --cyan:#000000; --amber:#000000; --red:#000000; --magenta:#000000; --blue:#000000; --track:#d0d0d0; --spark:#000000; --shadow:none; --glow:none; --border-w:2px; }
:root[data-theme="dark"][data-style="eink"] { --bg:#000000; --bg-panel:#000000; --border:#ffffff; --dim:#cccccc; --fg:#ffffff; --fg-bright:#ffffff; --green:#ffffff; --cyan:#ffffff; --amber:#ffffff; --red:#ffffff; --magenta:#ffffff; --blue:#ffffff; --track:#3a3a3a; --spark:#ffffff; --shadow:none; --glow:none; --border-w:2px; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="eink"] { --bg:#000000; --bg-panel:#000000; --border:#ffffff; --dim:#cccccc; --fg:#ffffff; --fg-bright:#ffffff; --green:#ffffff; --cyan:#ffffff; --amber:#ffffff; --red:#ffffff; --magenta:#ffffff; --blue:#ffffff; --track:#3a3a3a; --spark:#ffffff; --shadow:none; --glow:none; --border-w:2px; }
}
:root[data-style="eink"] *, :root[data-style="eink"] *::before, :root[data-style="eink"] *::after { transition: none !important; animation: none !important; }
:root[data-style="eink"] .c-amber, :root[data-style="eink"] .hl-amber { font-weight: 700; }
:root[data-style="eink"] .c-red, :root[data-style="eink"] .hl-red { font-weight: 700; text-decoration: underline; }
:root[data-style="eink"] .ncard.stale, :root[data-style="eink"] .ncard.offline, :root[data-style="eink"] .ncard.waiting { opacity: 1; border-style: dashed; }
:root[data-style="eink"] .lamp.stale, :root[data-style="eink"] .lamp.waiting { background: transparent; box-shadow: inset 0 0 0 2px var(--fg); }
:root[data-style="eink"] .lamp.offline { border-radius: 0; }
```

`www/styles/contrast.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* high contrast: WCAG AAA text, colour-blind-safe Okabe-Ito status colours, shaped status lamps, larger text */
:root[data-style="contrast"] { --bg:#ffffff; --bg-panel:#ffffff; --border:#000000; --dim:#1a1a1a; --fg:#000000; --fg-bright:#000000; --green:#005a8c; --cyan:#005a8c; --amber:#7a4f00; --red:#9c3300; --magenta:#7a2a5e; --blue:#005a8c; --track:#9a9a9a; --spark:#000000; --shadow:none; --glow:none; --border-w:2px; }
:root[data-theme="dark"][data-style="contrast"] { --bg:#000000; --bg-panel:#000000; --border:#ffffff; --dim:#e0e0e0; --fg:#ffffff; --fg-bright:#ffffff; --green:#56b4e9; --cyan:#56b4e9; --amber:#e69f00; --red:#ff8a5c; --magenta:#e3a3c9; --blue:#56b4e9; --track:#666666; --spark:#ffffff; --shadow:none; --glow:none; --border-w:2px; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="contrast"] { --bg:#000000; --bg-panel:#000000; --border:#ffffff; --dim:#e0e0e0; --fg:#ffffff; --fg-bright:#ffffff; --green:#56b4e9; --cyan:#56b4e9; --amber:#e69f00; --red:#ff8a5c; --magenta:#e3a3c9; --blue:#56b4e9; --track:#666666; --spark:#ffffff; --shadow:none; --glow:none; --border-w:2px; }
}
:root[data-style="contrast"] body { font-size: 15px; }
:root[data-style="contrast"] .lamp.stale { border-radius: 0; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
:root[data-style="contrast"] .lamp.offline { border-radius: 0; }
:root[data-style="contrast"] .lamp.waiting { background: transparent; box-shadow: inset 0 0 0 2px var(--fg); }
:root[data-style="contrast"] .ncard.stale .nhead::after { content: " stale"; font-weight: 700; }
:root[data-style="contrast"] .ncard.offline .nhead::after { content: " offline"; font-weight: 700; }
:root[data-style="contrast"] :focus-visible { outline: 3px solid var(--fg); outline-offset: 2px; }
```

`www/styles/nord.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* nord: arctic palette (Nord by Arctic Ice Studio and Sven Greb, MIT) */
:root[data-style="nord"] { --bg:#eceff4; --bg-panel:#e5e9f0; --border:#c9d0dc; --dim:#4c566a; --fg:#2e3440; --fg-bright:#242933; --green:#3f6b2c; --cyan:#2f6a7a; --amber:#7a5b10; --red:#9a3a43; --magenta:#7a4a70; --blue:#4c6d97; --track:#d8dee9; --spark:#81a1c1; --shadow:none; --glow:none; }
:root[data-theme="dark"][data-style="nord"] { --bg:#2e3440; --bg-panel:#3b4252; --border:#4c566a; --dim:#d8dee9; --fg:#e5e9f0; --fg-bright:#eceff4; --green:#a3be8c; --cyan:#8fbcbb; --amber:#ebcb8b; --red:#e08a92; --magenta:#c9a3c1; --blue:#88c0d0; --track:#434c5e; --spark:#81a1c1; --shadow:none; --glow:none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="nord"] { --bg:#2e3440; --bg-panel:#3b4252; --border:#4c566a; --dim:#d8dee9; --fg:#e5e9f0; --fg-bright:#eceff4; --green:#a3be8c; --cyan:#8fbcbb; --amber:#ebcb8b; --red:#e08a92; --magenta:#c9a3c1; --blue:#88c0d0; --track:#434c5e; --spark:#81a1c1; --shadow:none; --glow:none; }
}
:root[data-style="nord"] .panel, :root[data-style="nord"] .tabs button, :root[data-style="nord"] .modal { border-radius: 6px; }
```

`www/styles/gruvbox.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* gruvbox: warm retro palette (gruvbox by Pavel Pertsev, MIT) */
:root[data-style="gruvbox"] { --bg:#fbf1c7; --bg-panel:#f2e5bc; --border:#d5c4a1; --dim:#665c54; --fg:#3c3836; --fg-bright:#282828; --green:#6b660c; --cyan:#3c6e4e; --amber:#935d10; --red:#9d0006; --magenta:#8f3f71; --blue:#076678; --track:#ebdbb2; --spark:#928374; --shadow:none; --glow:none; }
:root[data-theme="dark"][data-style="gruvbox"] { --bg:#282828; --bg-panel:#3c3836; --border:#504945; --dim:#bdae93; --fg:#ebdbb2; --fg-bright:#fbf1c7; --green:#b8bb26; --cyan:#8ec07c; --amber:#fabd2f; --red:#fb4934; --magenta:#d3869b; --blue:#83a598; --track:#504945; --spark:#928374; --shadow:none; --glow:none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="gruvbox"] { --bg:#282828; --bg-panel:#3c3836; --border:#504945; --dim:#bdae93; --fg:#ebdbb2; --fg-bright:#fbf1c7; --green:#b8bb26; --cyan:#8ec07c; --amber:#fabd2f; --red:#fb4934; --magenta:#d3869b; --blue:#83a598; --track:#504945; --spark:#928374; --shadow:none; --glow:none; }
}
:root[data-style="gruvbox"] .panel, :root[data-style="gruvbox"] .tabs button, :root[data-style="gruvbox"] .modal { border-radius: 6px; }
```

`www/styles/dracula.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* dracula: purple-accented palette (Dracula Theme, MIT) */
:root[data-style="dracula"] { --bg:#fffbeb; --bg-panel:#ffffff; --border:#cfcfde; --dim:#534d85; --fg:#1f1f1f; --fg-bright:#000000; --green:#14710a; --cyan:#036a96; --amber:#9a4812; --red:#b52f21; --magenta:#a3144d; --blue:#5a3fbf; --track:#ecebf5; --spark:#a3144d; --shadow:none; --glow:none; }
:root[data-theme="dark"][data-style="dracula"] { --bg:#282a36; --bg-panel:#21222c; --border:#44475a; --dim:#a4acd6; --fg:#f8f8f2; --fg-bright:#ffffff; --green:#50fa7b; --cyan:#8be9fd; --amber:#ffb86c; --red:#ff6e6e; --magenta:#ff79c6; --blue:#bd93f9; --track:#44475a; --spark:#ff79c6; --shadow:none; --glow:none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="dracula"] { --bg:#282a36; --bg-panel:#21222c; --border:#44475a; --dim:#a4acd6; --fg:#f8f8f2; --fg-bright:#ffffff; --green:#50fa7b; --cyan:#8be9fd; --amber:#ffb86c; --red:#ff6e6e; --magenta:#ff79c6; --blue:#bd93f9; --track:#44475a; --spark:#ff79c6; --shadow:none; --glow:none; }
}
:root[data-style="dracula"] .panel, :root[data-style="dracula"] .tabs button, :root[data-style="dracula"] .modal { border-radius: 6px; }
```

`www/styles/catppuccin.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* catppuccin: soft pastel palette, Latte light and Mocha dark (Catppuccin, MIT) */
:root[data-style="catppuccin"] { --bg:#eff1f5; --bg-panel:#e6e9ef; --border:#ccd0da; --dim:#5c5f77; --fg:#4c4f69; --fg-bright:#1e1e2e; --green:#2e7d20; --cyan:#04709c; --amber:#9a5a0a; --red:#c10d36; --magenta:#a8408c; --blue:#1e5fe0; --track:#ccd0da; --spark:#8839ef; --shadow:none; --glow:none; }
:root[data-theme="dark"][data-style="catppuccin"] { --bg:#1e1e2e; --bg-panel:#181825; --border:#313244; --dim:#a6adc8; --fg:#cdd6f4; --fg-bright:#ffffff; --green:#a6e3a1; --cyan:#89dceb; --amber:#f9e2af; --red:#f38ba8; --magenta:#f5c2e7; --blue:#89b4fa; --track:#313244; --spark:#cba6f7; --shadow:none; --glow:none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="catppuccin"] { --bg:#1e1e2e; --bg-panel:#181825; --border:#313244; --dim:#a6adc8; --fg:#cdd6f4; --fg-bright:#ffffff; --green:#a6e3a1; --cyan:#89dceb; --amber:#f9e2af; --red:#f38ba8; --magenta:#f5c2e7; --blue:#89b4fa; --track:#313244; --spark:#cba6f7; --shadow:none; --glow:none; }
}
:root[data-style="catppuccin"] .panel, :root[data-style="catppuccin"] .tabs button, :root[data-style="catppuccin"] .modal { border-radius: 6px; }
```

`www/styles/solarized.css`:

```css
/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* solarized: precise light and dark palette (Solarized by Ethan Schoonover, MIT) */
:root[data-style="solarized"] { --bg:#fdf6e3; --bg-panel:#eee8d5; --border:#93a1a1; --dim:#4f6169; --fg:#475b62; --fg-bright:#073642; --green:#5e6d00; --cyan:#1b7a73; --amber:#7f6000; --red:#b8261f; --magenta:#a6245f; --blue:#1e6fa8; --track:#e4ddc8; --spark:#2aa198; --shadow:none; --glow:none; }
:root[data-theme="dark"][data-style="solarized"] { --bg:#002b36; --bg-panel:#073642; --border:#586e75; --dim:#a6b3b3; --fg:#b4bfbf; --fg-bright:#eee8d5; --green:#9fb000; --cyan:#2aa198; --amber:#c9a000; --red:#f0514d; --magenta:#e05a92; --blue:#4a9ee0; --track:#0a4452; --spark:#2aa198; --shadow:none; --glow:none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-style="solarized"] { --bg:#002b36; --bg-panel:#073642; --border:#586e75; --dim:#a6b3b3; --fg:#b4bfbf; --fg-bright:#eee8d5; --green:#9fb000; --cyan:#2aa198; --amber:#c9a000; --red:#f0514d; --magenta:#e05a92; --blue:#4a9ee0; --track:#0a4452; --spark:#2aa198; --shadow:none; --glow:none; }
}
:root[data-style="solarized"] .panel, :root[data-style="solarized"] .tabs button, :root[data-style="solarized"] .modal { border-radius: 6px; }
```

- [ ] **Step 4: Add the VT323 font (OFL-1.1), subset like the other fonts**

The source is pinned to a google/fonts commit and checked by hash:

```bash
tmp=$(mktemp -d)
base=https://raw.githubusercontent.com/google/fonts/eb8781e516576b414603df8cd267c0f21c9b4ee2/ofl/vt323
curl -fsSL -o "$tmp/VT323-Regular.ttf" "$base/VT323-Regular.ttf"
curl -fsSL -o www/fonts/OFL-VT323.txt "$base/OFL.txt"
printf '%s  %s\n' cf4de751ada78ceac033dbe16a687742939995b77bc2a052ae17a4957958594d "$tmp/VT323-Regular.ttf" \
                   27d9af34210253e7ca1251fbace86c6f65b40031d6ce1a75493a1b2093631298 www/fonts/OFL-VT323.txt | sha256sum -c
pipx run --spec 'fonttools[woff]' pyftsubset "$tmp/VT323-Regular.ttf" \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+2190-2193,U+25B2-25BC,U+2588,U+00B0" \
  --flavor=woff2 --output-file=www/fonts/vt323-400.woff2
rm -rf "$tmp"
ls -l www/fonts/vt323-400.woff2
```

Expected: both lines `OK`; the file is about 16 KB (16488 bytes with fonttools 4.60; another version may differ by a few bytes).

- [ ] **Step 5: Package the styles and the font**

In `debian/servitals.install`:

1. Replace

```
www/config.example.json usr/share/servitals/www/
www/fonts/*.woff2 usr/share/servitals/www/fonts/
bin/servitals-ctl usr/bin/
packaging/etc/hub.env etc/servitals/
```

   with

```
www/config.example.json usr/share/servitals/www/
www/fonts/*.woff2 usr/share/servitals/www/fonts/
www/styles/*.css usr/share/servitals/www/styles/
bin/servitals-ctl usr/bin/
packaging/etc/hub.env etc/servitals/
```

In `packaging/install-local.sh`:

1. Replace

```bash
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
chmod -R u=rwX,go=rX "$SHARE/www/fonts"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
```

   with

```bash
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
cp -r "$SRC/www/styles" "$SHARE/www/styles"
chmod -R u=rwX,go=rX "$SHARE/www/fonts" "$SHARE/www/styles"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
```

In `debian/copyright`:

1. Replace

```
Copyright: 2012 The Press Start 2P Project Authors (cody@zone38.net)
License: OFL-1.1

License: AGPL-3.0-or-later
```

   with

```
Copyright: 2012 The Press Start 2P Project Authors (cody@zone38.net)
License: OFL-1.1

Files: www/fonts/vt323-*.woff2
Copyright: 2011 The VT323 Project Authors (peter.hull@oikoi.com)
License: OFL-1.1

Files: www/styles/nord.css
Copyright: 2026 Rishabha Garg
 2016 Arctic Ice Studio and Sven Greb
License: AGPL-3.0-or-later and Expat
Comment: The style file is part of servitals; the colour values of the
 Nord palette come from its authors under the Expat licence.

Files: www/styles/gruvbox.css
Copyright: 2026 Rishabha Garg
 2012 Pavel Pertsev
License: AGPL-3.0-or-later and Expat
Comment: The style file is part of servitals; the colour values of the
 gruvbox palette come from its authors under the Expat licence.

Files: www/styles/dracula.css
Copyright: 2026 Rishabha Garg
 2016 Dracula Theme
License: AGPL-3.0-or-later and Expat
Comment: The style file is part of servitals; the colour values of the
 Dracula palette come from its authors under the Expat licence.

Files: www/styles/catppuccin.css
Copyright: 2026 Rishabha Garg
 2021 Catppuccin
License: AGPL-3.0-or-later and Expat
Comment: The style file is part of servitals; the colour values of the
 Latte and Mocha palettes come from its authors under the Expat licence.

Files: www/styles/solarized.css
Copyright: 2026 Rishabha Garg
 2011 Ethan Schoonover
License: AGPL-3.0-or-later and Expat
Comment: The style file is part of servitals; the colour values of the
 Solarized palette come from its authors under the Expat licence.

License: Expat
 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:
 .
 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.
 .
 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.

License: AGPL-3.0-or-later
```

In `test/budget.sh`:

1. Replace

```bash
page=$(gzip -9 -c www/index.html | wc -c)
check "first page load (gzip, no fonts)" "$page" 61440 "bytes"

# 3. gateway steady-state anonymous memory
```

   with

```bash
page=$(gzip -9 -c www/index.html | wc -c)
check "first page load (gzip, no fonts)" "$page" 61440 "bytes"

# 2b. every optional style, gzipped (spec 18: at most 3 KB each)
for css in www/styles/*.css; do
  check "style $(basename "$css" .css) (gzip)" "$(gzip -9 -c "$css" | wc -c)" 3072 "bytes"
done

# 3. gateway steady-state anonymous memory
```

- [ ] **Step 6: Run the tests and the budget**

Run: `node --test test/*.test.js && bash test/budget.sh | grep style`
Expected: PASS (6 new tests); nine `ok    style <id> (gzip)` lines, each at most 3072 bytes.

- [ ] **Step 7: Commit**

```bash
git add test/styles.test.js test/packaging.test.js test/license.test.js test/budget.sh www/styles www/fonts/vt323-400.woff2 www/fonts/OFL-VT323.txt debian/servitals.install debian/copyright packaging/install-local.sh
git commit -m "feat(ui): style files for eight new styles and 8bit, with contrast tests" -m "Each style is a light and a dark token set in www/styles/<id>.css, at most 3 KB gzipped. Tests check that every token is defined and that text meets WCAG AA (AAA for high contrast) in every style and mode. Phosphor bundles VT323 (OFL-1.1). The package and install-local.sh ship the files."
```

---

### Task 2: Load styles on demand; mode, density, kiosk and the settings panel

**Files:**
- Modify: `www/index.html`, `test/page.test.js`, `test/styles.test.js`

**Interfaces:**
- Consumes: the style files from Task 1.
- Produces: in the page, `STYLES` (array of `{ id, label, group }`, group `v1`/`access`/`palette`), `MODES = ["system", "light", "dark"]`, `DENSITIES = ["compact", "comfortable", "large"]`, `applyStyle(id)`, `applyMode(m)`, `applyDensity(n)`, `applyAppearanceDefaults()` (also remembers the hub's defaults as `servitals.hub.style|mode|density|kiosk`), `startKiosk()`; `localStorage` `servitals.kiosk` (`1`/`0`, set by `?kiosk` / `?kiosk=0`); the settings controls `#cfg-style #cfg-mode #cfg-density #cfg-kiosk #cfg-kiosksec`; `config.json` keys `style`, `mode`, `density`, `kiosk` (boolean), `kioskSec` (5..600, default 20). Task 3 makes the login page pass `?kiosk=1|0` on; Task 4's screenshots drive the page through `localStorage` and `?kiosk`, and fix narrow-screen layout in the same file.

- [ ] **Step 1: Write the failing tests**

Append to `test/styles.test.js`:

```js
test("the registry in the page lists exactly the style files, plus classic", () => {
  const listed = [...HTML.matchAll(/\{ id: "([a-z0-9-]+)", label: "[^"]+", group: "[a-z0-9]+" \}/g)].map((m) => m[1]).sort();
  const files = fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css")).map((x) => x.replace(/\.css$/, ""));
  assert.deepStrictEqual(listed, ["classic", ...files].sort());
  assert.deepStrictEqual(listed.sort(), ["8bit", "catppuccin", "classic", "contrast", "dracula", "eink", "gruvbox", "nord", "phosphor", "solarized"]);
});
```

Append to `test/page.test.js`:

```js
test("style, mode, density and kiosk are applied before the first paint", () => {
  const head = HTML.slice(0, HTML.indexOf("<style>"));
  assert.match(head, /localStorage\.getItem\("servitals\." \+ k\)/);
  assert.match(head, /\/\^\[a-z0-9-\]\{1,32\}\$\/\.test\(style\)/, "only a plain style name reaches the link");
  assert.match(head, /d\.setAttribute\("data-kiosk", ""\)/);
  assert.doesNotMatch(HTML.slice(0, 200), /data-theme="dark"/, "no forced dark mode: the default is the system's");
});

test("8bit lives in its own file, not in the first page load", () => {
  assert.doesNotMatch(HTML, /data-style="8bit"\]/);
  assert.doesNotMatch(HTML, /press-start-2p-400\.woff2/);
});

test("the settings panel sets style, mode, density and kiosk", () => {
  for (const id of ["cfg-style", "cfg-mode", "cfg-density", "cfg-kiosk", "cfg-kiosksec"]) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /cfg\.style = currentStyle\(\);/);
  assert.match(HTML, /applyStyle\(lsGet\("style"\) \|\| cfg\.style \|\| "classic"\)/);
  assert.match(HTML, /\.modal input\[type=password\]/, "password fields look like the other fields");
});

// runs the early <head> script against a fake document, as a browser would
function early({ search = "", stored = {} } = {}) {
  const src = HTML.slice(HTML.indexOf("<script>") + 8, HTML.indexOf("</script>"));
  const attrs = {}; const written = [];
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
    write: (s) => written.push(s),
  };
  const localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = String(v); } };
  new Function("document", "localStorage", "location", src)(document, localStorage, { search });
  return { attrs, written, stored };
}

test("the early script applies a stored look and refuses odd style names", () => {
  const r = early({ stored: { "servitals.style": "nord", "servitals.theme": "light", "servitals.density": "large" } });
  assert.deepStrictEqual(r.attrs, { "data-theme": "light", "data-density": "large", "data-style": "nord" });
  assert.deepStrictEqual(r.written, ['<link rel="stylesheet" id="style-css" href="styles/nord.css">']);
  for (const bad of ['x"><script>alert(1)</script>', "../../etc", "Nord"]) {
    assert.deepStrictEqual(early({ stored: { "servitals.style": bad } }).written, [], bad);
  }
  assert.deepStrictEqual(early({ stored: { "servitals.theme": "system", "servitals.density": "huge" } }).attrs, {});
});

test("the hub's default look from the last visit paints at once; this browser's own choice wins", () => {
  const hub = { "servitals.hub.style": "phosphor", "servitals.hub.mode": "dark", "servitals.hub.density": "compact" };
  const r = early({ stored: { ...hub } });
  assert.deepStrictEqual(r.attrs, { "data-theme": "dark", "data-density": "compact", "data-style": "phosphor" });
  const own = early({ stored: { ...hub, "servitals.style": "nord", "servitals.theme": "light" } });
  assert.strictEqual(own.attrs["data-style"], "nord");
  assert.strictEqual(own.attrs["data-theme"], "light");
  assert.match(HTML, /lsSet\("hub\." \+ k, cfg\[k\] \|\| ""\)/, "the page remembers the hub's defaults");
});

test("?kiosk turns kiosk on and is remembered; ?kiosk=0 turns it off, even when the hub turns it on for everyone", () => {
  const on = early({ search: "?kiosk" });
  assert.strictEqual(on.attrs["data-kiosk"], "");
  assert.strictEqual(on.stored["servitals.kiosk"], "1");
  assert.strictEqual(early({ search: "?a=1&kiosk=1" }).attrs["data-kiosk"], "");
  assert.strictEqual(early({ stored: { "servitals.kiosk": "1" } }).attrs["data-kiosk"], "", "back after the session ran out");
  const off = early({ search: "?kiosk=0", stored: { "servitals.kiosk": "1" } });
  assert.strictEqual(off.attrs["data-kiosk"], undefined);
  assert.strictEqual(off.stored["servitals.kiosk"], "0");
  assert.strictEqual(early({ stored: { "servitals.hub.kiosk": "1" } }).attrs["data-kiosk"], "");
  assert.strictEqual(early({ stored: { "servitals.hub.kiosk": "1", "servitals.kiosk": "0" } }).attrs["data-kiosk"], undefined);
  assert.strictEqual(early({ search: "?kioskx" }).attrs["data-kiosk"], undefined);
  assert.match(HTML, /if \(cfg\.kiosk && lsGet\("kiosk"\) !== "0"\) document\.documentElement\.setAttribute\("data-kiosk", ""\);/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/styles.test.js test/page.test.js`
Expected: FAIL, 7 tests: the registry test (the page lists no `{ id, label, group }` entries) and the six new page tests (no early script, 8bit still in the page, no appearance section, no remembered hub look or kiosk).

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html
<!DOCTYPE html>
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
```

   with

```html
<!DOCTYPE html>
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<html lang="en">
<head>
<meta charset="UTF-8">
```

2. Replace

```html
<title>servitals</title>
<link rel="icon" id="favicon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3Crect x='2' y='9' width='2' height='5' fill='%236bd88a'/%3E%3Crect x='5' y='6' width='2' height='8' fill='%236bd88a'/%3E%3Crect x='8' y='3' width='2' height='11' fill='%236bd88a'/%3E%3Crect x='11' y='7' width='2' height='7' fill='%236bd88a'/%3E%3C/svg%3E">
<style>
  @font-face {
```

   with

```html
<title>servitals</title>
<link rel="icon" id="favicon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3Crect x='2' y='9' width='2' height='5' fill='%236bd88a'/%3E%3Crect x='5' y='6' width='2' height='8' fill='%236bd88a'/%3E%3Crect x='8' y='3' width='2' height='11' fill='%236bd88a'/%3E%3Crect x='11' y='7' width='2' height='7' fill='%236bd88a'/%3E%3C/svg%3E">
<script>
  /* style, mode, density and kiosk before the first paint, so the page never
     flashes the default look (the hub's defaults apply once config.json loads) */
  (function () {
    var d = document.documentElement, get = function (k) {
      try { return localStorage.getItem("servitals." + k); } catch (e) { return null; }
    };
    // this browser's choice, else the hub's default remembered from the last visit
    var style = get("style") || get("hub.style"), mode = get("theme") || get("hub.mode"),
        density = get("density") || get("hub.density");
    if (mode === "light" || mode === "dark") d.setAttribute("data-theme", mode);
    if (density === "compact" || density === "large") d.setAttribute("data-density", density);
    // ?kiosk and ?kiosk=0 are remembered, so kiosk survives a new login
    var q = /[?&]kiosk(?:=([^&]*))?(?:&|$)/.exec(location.search), kiosk = get("kiosk");
    if (q) {
      kiosk = q[1] === "0" ? "0" : "1";
      try { localStorage.setItem("servitals.kiosk", kiosk); } catch (e) { /* private mode */ }
    }
    if (kiosk === "1" || (kiosk !== "0" && get("hub.kiosk") === "1")) d.setAttribute("data-kiosk", "");
    if (style && style !== "classic" && /^[a-z0-9-]{1,32}$/.test(style)) {
      d.setAttribute("data-style", style);
      document.write('<link rel="stylesheet" id="style-css" href="styles/' + style + '.css">');
    }
  })();
</script>
<style>
  @font-face {
```

3. Replace

```html
    font-family: 'JetBrains Mono'; font-style: normal; font-weight: 700;
    font-display: swap; src: url('fonts/jetbrains-mono-700.woff2') format('woff2');
  }
  @font-face {
    font-family: 'Press Start 2P'; font-style: normal; font-weight: 400;
    font-display: swap; src: url('fonts/press-start-2p-400.woff2') format('woff2');
  }

```

   with

```html
    font-family: 'JetBrains Mono'; font-style: normal; font-weight: 700;
    font-display: swap; src: url('fonts/jetbrains-mono-700.woff2') format('woff2');
  }

```

4. Replace

```html
  }

  /* ---- 8bit retro style: layered on top of dark/light via data-style ---- */
  :root[data-style="8bit"] {
    --border-w: 3px;
    --bg:        #FFF1E8;
    --bg-panel:  #ffffff;
    --border:    #5F574F;
    --dim:       #7E2553;
    --fg:        #1D2B53;
    --fg-bright: #000000;
    --green:  #008751;
    --cyan:   #29ADFF;
    --amber:  #AB5236;
    --red:    #FF004D;
    --magenta:#7E2553;
    --blue:   #1D2B53;
    --track:  #C2C3C7;
    --spark:  #83769C;
    --shadow: 4px 4px 0 var(--border);
    --glow: none;
  }
  :root[data-theme="dark"][data-style="8bit"] {
    --bg:        #1D2B53;
    --bg-panel:  #14142b;
    --border:    #5F574F;
    --dim:       #83769C;
    --fg:        #FFF1E8;
    --fg-bright: #ffffff;
    --green:  #00E436;
    --cyan:   #29ADFF;
    --amber:  #FFA300;
    --red:    #FF004D;
    --magenta:#FF77A8;
    --blue:   #29ADFF;
    --track:  #2b2b45;
    --spark:  #5F574F;
    --shadow: 4px 4px 0 #000000;
    --glow: none;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"])[data-style="8bit"] {
      --bg:#1D2B53; --bg-panel:#14142b; --border:#5F574F; --dim:#83769C;
      --fg:#FFF1E8; --fg-bright:#ffffff; --green:#00E436; --cyan:#29ADFF;
      --amber:#FFA300; --red:#FF004D; --magenta:#FF77A8; --blue:#29ADFF;
      --track:#2b2b45; --spark:#5F574F; --shadow:4px 4px 0 #000000; --glow:none;
    }
  }
  :root[data-style="8bit"] .head,
  :root[data-style="8bit"] .panel {
    image-rendering: pixelated;
  }
  :root[data-style="8bit"] .head .title,
  :root[data-style="8bit"] .panel > h2,
  :root[data-style="8bit"] .keyhint b,
  :root[data-style="8bit"] .modal h3,
  :root[data-style="8bit"] .ps1,
  :root[data-style="8bit"] .sb,
  :root[data-style="8bit"] button {
    font-family: 'Press Start 2P', monospace;
    letter-spacing: 0;
  }
  :root[data-style="8bit"] .head .title { font-size: 12px; line-height: 1.8; }
  :root[data-style="8bit"] .panel > h2 { font-size: 9px; line-height: 1.9; }
  :root[data-style="8bit"] .keyhint b { font-size: 9px; line-height: 2.2; }
  :root[data-style="8bit"] .modal h3 { font-size: 9px; line-height: 2; }
  :root[data-style="8bit"] .head .dot {
    border-radius: 0;
    animation: blink8bit 1s steps(1) infinite;
  }
  @keyframes blink8bit { 0%,49%{opacity:1} 50%,100%{opacity:0} }
  :root[data-style="8bit"] body::after {
    content: "";
    position: fixed; inset: 0; pointer-events: none; z-index: 999;
    background: repeating-linear-gradient(
      to bottom, rgba(0,0,0,.12) 0px, rgba(0,0,0,.12) 1px,
      transparent 1px, transparent 3px
    );
    mix-blend-mode: multiply;
  }
  :root[data-theme="dark"][data-style="8bit"] body::after { mix-blend-mode: overlay; }

  .logout-form { display: inline; }
```

   with

```html
  }

  /* ---- other styles live in styles/<name>.css and load only when chosen ---- */
  .modal label.inline { display: inline-flex; align-items: center; gap: 6px; text-transform: none; letter-spacing: 0; margin: 0; }

  /* ---- density (spec 10.3): compact, comfortable (default), large ---- */
  :root[data-density="compact"] body { zoom: .88; }
  :root[data-density="compact"] .grid, :root[data-density="compact"] .fleet { gap: 10px; }
  @media (min-width: 720px) { :root[data-density="large"] body { zoom: 1.18; } }   /* a phone has no room to grow */

  /* ---- kiosk (/?kiosk or settings): big type, no controls ---- */
  :root[data-kiosk] body { cursor: none; }
  @media (min-width: 960px) { :root[data-kiosk] body { zoom: 1.3; } }
  :root[data-kiosk] .keyhint, :root[data-kiosk] .prompt, :root[data-kiosk] .brand-foot,
  :root[data-kiosk] .svc-ctl, :root[data-kiosk] #tabs, :root[data-kiosk] .update-note { display: none !important; }

  .logout-form { display: inline; }
```

5. Replace

```html
  .modal .item .txt { flex: 1; color: var(--fg); }
  .modal .item .rm { color: var(--red); cursor: pointer; border: var(--border-w, 1px) solid var(--border); padding: 0 7px; }
  .modal input[type=text], .modal input[type=number], .modal select {
    background: var(--bg); border: var(--border-w, 1px) solid var(--border); color: var(--fg-bright);
    font-family: inherit; font-size: 12px; padding: 5px 8px; width: 100%;
```

   with

```html
  .modal .item .txt { flex: 1; color: var(--fg); }
  .modal .item .rm { color: var(--red); cursor: pointer; border: var(--border-w, 1px) solid var(--border); padding: 0 7px; }
  .modal input[type=text], .modal input[type=password], .modal input[type=number], .modal select {
    background: var(--bg); border: var(--border-w, 1px) solid var(--border); color: var(--fg-bright);
    font-family: inherit; font-size: 12px; padding: 5px 8px; width: 100%;
```

6. Replace

```html

      <section>
        <label>login &mdash; name and password</label>
        <div class="addrow">
```

   with

```html

      <section>
        <label>appearance &mdash; changes this browser now; save to make it everyone's default</label>
        <div class="addrow">
          <select id="cfg-style" aria-label="style"></select>
          <select id="cfg-mode" aria-label="mode"></select>
          <select id="cfg-density" aria-label="density"></select>
        </div>
        <div class="addrow">
          <label class="inline"><input type="checkbox" id="cfg-kiosk"> kiosk on every screen, next node every</label>
          <input type="number" id="cfg-kiosksec" min="5" max="600" style="max-width:80px"> s
        </div>
      </section>

      <section>
        <label>login &mdash; name and password</label>
        <div class="addrow">
```

7. Replace

```html
}

/* ------------------------------------------------------------------ theme */
function currentTheme() {
  return document.documentElement.getAttribute("data-theme")
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  $("#btn-theme").textContent = `[t] ${next}`;
  lsSet("theme", next);
}
(function initTheme() {
  let t = null;
  t = lsGet("theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
})();

const STYLES = ["classic", "8bit"];   // orthogonal to theme; append future styles here
function currentStyle() {
  return document.documentElement.getAttribute("data-style") || "classic";
}
function toggleStyle() {
  const next = STYLES[(STYLES.indexOf(currentStyle()) + 1) % STYLES.length];
  if (next === "classic") document.documentElement.removeAttribute("data-style");
  else document.documentElement.setAttribute("data-style", next);
  $("#btn-style").textContent = `[y] ${next}`;
  lsSet("style", next);
}
(function initStyle() {
  let s = null;
  s = lsGet("style");
  if (STYLES.includes(s) && s !== "classic") document.documentElement.setAttribute("data-style", s);
})();

/* ------------------------------------------------------------------ render: metrics */
```

   with

```html
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
  // ?kiosk=0 keeps a screen out of kiosk mode when the hub turns it on for everyone
  if (cfg.kiosk && lsGet("kiosk") !== "0") document.documentElement.setAttribute("data-kiosk", "");
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
    if (fleetNodes.length < 2) return;
    const ids = fleetNodes.map(n => n.id);
    const now = view === "fleet" ? -1 : ids.indexOf(currentNode || localNode);
    location.hash = "#node=" + ids[(now + 1) % ids.length];
  }, clamp(+cfg.kioskSec || 20, 5, 600) * 1000);
}

/* ------------------------------------------------------------------ render: metrics */
```

8. Replace

```html
  $("#export-wrap").classList.add("hidden");
  $("#acct-user").value = whoUser;
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

   with

```html
  $("#export-wrap").classList.add("hidden");
  $("#acct-user").value = whoUser;
  const groups = { v1: "styles", access: "accessibility", palette: "palettes" };
  $("#cfg-style").innerHTML = Object.entries(groups).map(([g, name]) => `<optgroup label="${name}">`
    + STYLES.filter(x => x.group === g).map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join("")
    + "</optgroup>").join("");
  $("#cfg-mode").innerHTML = MODES.map(m => `<option value="${m}">${m}</option>`).join("");
  $("#cfg-density").innerHTML = DENSITIES.map(n => `<option value="${n}">${n}</option>`).join("");
  $("#cfg-style").value = currentStyle();
  $("#cfg-mode").value = currentMode();
  $("#cfg-density").value = currentDensity();
  $("#cfg-kiosk").checked = !!cfg.kiosk;
  $("#cfg-kiosksec").value = cfg.kioskSec || 20;
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

9. Replace

```html
  cfg.title = $("#cfg-name").value.trim() || "servitals";
  cfg.refreshSec = clamp(+$("#cfg-refresh").value || 60, 5, 900);
  // panels/order/size/favicon are already updated live by the settings widgets

```

   with

```html
  cfg.title = $("#cfg-name").value.trim() || "servitals";
  cfg.refreshSec = clamp(+$("#cfg-refresh").value || 60, 5, 900);
  // this browser's look becomes the hub's default for everyone
  cfg.style = currentStyle();
  cfg.mode = currentMode();
  cfg.density = currentDensity();
  cfg.kiosk = $("#cfg-kiosk").checked;
  cfg.kioskSec = clamp(+$("#cfg-kiosksec").value || 20, 5, 600);
  // panels/order/size/favicon are already updated live by the settings widgets

```

10. Replace

```html
  await loadConfig();
  $("#ps1").textContent = "visitor@" + (cfg.title || "host");
  $("#btn-theme").textContent = `[t] ${currentTheme()}`;
  $("#btn-style").textContent = `[y] ${currentStyle()}`;
  applyBranding();
  renderClocks();
```

   with

```html
  await loadConfig();
  $("#ps1").textContent = "visitor@" + (cfg.title || "host");
  applyAppearanceDefaults();
  applyBranding();
  renderClocks();
```

11. Replace

```html
  route();
  window.addEventListener("hashchange", () => { route(); refreshNow(true); });
  $("#tabs").onclick = e => {
    const b = e.target.closest("button[data-go]");
```

   with

```html
  route();
  window.addEventListener("hashchange", () => { route(); refreshNow(true); });
  startKiosk();
  $("#tabs").onclick = e => {
    const b = e.target.closest("button[data-go]");
```

12. Replace

```html
  $("#settings-close").onclick = closeSettings;
  $("#acct-save").onclick = saveAccount;
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-style").onclick = toggleStyle;
```

   with

```html
  $("#settings-close").onclick = closeSettings;
  $("#acct-save").onclick = saveAccount;
  $("#cfg-style").onchange = e => { applyStyle(e.target.value); lsSet("style", e.target.value); };
  $("#cfg-mode").onchange = e => { applyMode(e.target.value); lsSet("theme", e.target.value); };
  $("#cfg-density").onchange = e => { applyDensity(e.target.value); lsSet("density", e.target.value); };
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-style").onclick = toggleStyle;
```

- [ ] **Step 4: Run all tests**

Run: `node --test test/*.test.js && bash test/budget.sh | grep "first page"`
Expected: PASS (7 new tests); first page load about 25 KB gzipped (limit 60 KB).

- [ ] **Step 5: Commit**

```bash
git add www/index.html test/page.test.js test/styles.test.js
git commit -m "feat(ui): styles load on demand; system mode, density, kiosk, hub-wide defaults" -m "A script at the top of the page applies the stored style, mode and density before the first paint and links only the chosen style. Mode cycles system, light, dark and follows the system by default. Settings gain an appearance section; saving makes the current look the default for everyone. /?kiosk shows big type without controls and moves to the next server every 20 s; the browser remembers it, and /?kiosk=0 turns it off even when the hub turns kiosk on for everyone. The hub's defaults are remembered so the next load paints them at once. Large density and kiosk zoom only on screens wide enough for them. Password fields in settings get the input style."
```

---

### Task 3: The hub keeps `?kiosk` through login; browsers revalidate static files

**Files:**
- Modify: `hub/server.js`, `hub/lib/static.js`, `test/helpers/hub.js`, `test/hub.test.js`, `test/static.test.js`

**Interfaces:**
- Consumes: the page's `?kiosk` / `?kiosk=0` handling from Task 2.
- Produces: `loginPage(msg, kiosk = "")` adds `<input type="hidden" name="kiosk" value="1|0">` when the request asked for kiosk; a successful login redirects to `/?kiosk=1` or `/?kiosk=0`, else `/`. Only `1` or `0` ever reaches the form or the redirect. Every static response (200 and 304) carries `cache-control: no-cache`. The test helper `login(port, { form })` sends extra form fields.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/hub.js`:

1. Replace

```js
}

async function login(port, { user = "admin", pass = DEFAULT_PASS, headers = {}, origin } = {}) {
  const body = formBody({ username: user, password: pass });
  const h = {
    "content-type": "application/x-www-form-urlencoded",
```

   with

```js
}

async function login(port, { user = "admin", pass = DEFAULT_PASS, headers = {}, origin, form = {} } = {}) {
  const body = formBody({ username: user, password: pass, ...form });
  const h = {
    "content-type": "application/x-www-form-urlencoded",
```

Append to `test/hub.test.js`:

```js
test("/?kiosk survives the login page, with only a fixed value in the redirect", async () => {
  await withHub({}, async (hub) => {
    const page = await request(hub.port, { path: "/?kiosk" });
    assert.match(page.body, /<input type="hidden" name="kiosk" value="1">/);
    assert.match((await request(hub.port, { path: "/?kiosk=0" })).body, /name="kiosk" value="0"/);
    assert.doesNotMatch((await request(hub.port, { path: "/" })).body, /name="kiosk"/);
    const odd = await request(hub.port, { path: "//[?kiosk" });
    assert.strictEqual(odd.status, 200, "an odd path still gets the login page");
    assert.match(odd.body, /name="kiosk" value="1"/);
    assert.strictEqual((await login(hub.port, { form: { kiosk: "1" } })).headers.location, "/?kiosk=1");
    assert.strictEqual((await login(hub.port, { form: { kiosk: "0" } })).headers.location, "/?kiosk=0");
    assert.strictEqual((await login(hub.port, { form: { kiosk: "//evil.example" } })).headers.location, "/?kiosk=1");
    assert.strictEqual((await login(hub.port)).headers.location, "/");
    const bad = await login(hub.port, { pass: "wrong", form: { kiosk: "1" } });
    assert.match(bad.body, /name="kiosk" value="1"/, "a failed attempt keeps kiosk for the next one");
  });
});
```

In `test/static.test.js`:

1. Replace

```js
    assert.ok(r.headers.etag);
    assert.ok(r.headers["last-modified"]);
    const again = await request(port, { path: "/", headers: { "if-none-match": r.headers.etag } });
    assert.strictEqual(again.status, 304);
```

   with

```js
    assert.ok(r.headers.etag);
    assert.ok(r.headers["last-modified"]);
    assert.strictEqual(r.headers["cache-control"], "no-cache", "browsers check for a newer page after an upgrade");
    const again = await request(port, { path: "/", headers: { "if-none-match": r.headers.etag } });
    assert.strictEqual(again.status, 304);
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/hub.test.js test/static.test.js`
Expected: FAIL: "/?kiosk survives the login page…" (no hidden `kiosk` field) and "serves index.html for / with type and validators" (`cache-control` is `undefined`).

- [ ] **Step 3: Carry kiosk through the login page**

In `hub/server.js`:

1. Replace

```js
</style></head><body><div class="box">${inner}</div></body></html>`;

const loginPage = (msg) => SHELL(SITE + " · login", `
  <h1>${SITE} · authentication required</h1>
  <form class="body" method="POST" action="/__auth/login">
    <label>username</label><input name="username" autocomplete="username" autofocus>
    <label>password</label><input name="password" type="password" autocomplete="current-password">
```

   with

```js
</style></head><body><div class="box">${inner}</div></body></html>`;

// a wall screen opened at /?kiosk keeps kiosk through the login (spec 10.3);
// only "1" or "0" ever reaches the form and the redirect
const kioskValue = (v) => (v === null ? "" : v === "0" ? "0" : "1");
const kioskFromUrl = (url) => {
  const m = /[?&]kiosk(?:=([^&#]*))?(?:[&#]|$)/.exec(url || "");
  return m ? kioskValue(m[1] || "") : "";
};
const loginPage = (msg, kiosk = "") => SHELL(SITE + " · login", `
  <h1>${SITE} · authentication required</h1>
  <form class="body" method="POST" action="/__auth/login">
    ${kiosk ? `<input type="hidden" name="kiosk" value="${kiosk}">` : ""}
    <label>username</label><input name="username" autocomplete="username" autofocus>
    <label>password</label><input name="password" type="password" autocomplete="current-password">
```

2. Replace

```js
    const user = params.get("username") || "";
    const ok = await checkPass(user, params.get("password") || "");
    if (ok) {
      clearFails(ip);
```

   with

```js
    const user = params.get("username") || "";
    const ok = await checkPass(user, params.get("password") || "");
    const kiosk = kioskValue(params.get("kiosk"));
    if (ok) {
      clearFails(ip);
```

3. Replace

```js
      res.writeHead(302, {
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
        location: "/",
      });
      return res.end();
```

   with

```js
      res.writeHead(302, {
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
        location: kiosk ? `/?kiosk=${kiosk}` : "/",
      });
      return res.end();
```

4. Replace

```js
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg));
  }

```

   with

```js
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg, kiosk));
  }

```

5. Replace

```js

  res.writeHead(200, { "content-type": "text/html" });
  res.end(loginPage(null));
}

```

   with

```js

  res.writeHead(200, { "content-type": "text/html" });
  res.end(loginPage(null, kioskFromUrl(req.url)));
}

```

The URL is read with a regular expression, not `new URL()`: `new URL("//[?kiosk", base)` throws, and the test's odd path checks that.

- [ ] **Step 4: Revalidate static files**

In `hub/lib/static.js`:

1. Replace

```js
    const ims = Date.parse(req.headers["if-modified-since"] || "");
    if (inm ? inm === etag : (Number.isFinite(ims) && mtime * 1000 <= ims)) {
      res.writeHead(304, { etag, "last-modified": st.mtime.toUTCString() });
      return res.end();
    }
```

   with

```js
    const ims = Date.parse(req.headers["if-modified-since"] || "");
    if (inm ? inm === etag : (Number.isFinite(ims) && mtime * 1000 <= ims)) {
      res.writeHead(304, { etag, "last-modified": st.mtime.toUTCString(), "cache-control": "no-cache" });
      return res.end();
    }
```

2. Replace

```js
      "last-modified": st.mtime.toUTCString(),
      etag,
      "x-content-type-options": "nosniff",
    });
```

   with

```js
      "last-modified": st.mtime.toUTCString(),
      etag,
      // revalidate every time (a 304 is cheap), so an upgrade shows at once
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
```

- [ ] **Step 5: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test, 195 in total).

- [ ] **Step 6: Commit**

```bash
git add hub/server.js hub/lib/static.js test/helpers/hub.js test/hub.test.js test/static.test.js
git commit -m "fix(hub): keep /?kiosk through the login page; browsers revalidate static files" -m "A wall screen opened at /?kiosk used to land on / after logging in. The login form now carries kiosk=1 or 0 (nothing else) to the redirect. Static files get cache-control: no-cache, so a browser asks for a newer page after an upgrade instead of guessing from Last-Modified."
```

---

### Task 4: Screenshots at every width in CI, narrow-screen fixes, docs

**Files:**
- Create: `test/screens/demo-hub.js`, `test/screens/shoot.js`, `test/screens.sh`
- Modify: `www/index.html`, `.github/workflows/ci.yml`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the page from Task 2 (`localStorage` keys, `?kiosk`, `#btn-settings`), `hub/server.js` environment (`STATE_DIR`, `WWW_DIR`, `PORT`, `NODE_ENV`) and `hub/lib/nodes.js` from sub-project 4a.
- Produces: `bash test/screens.sh` writes `build/screens/<view>-<style>-<mode>.png` (view `fleet` or `node`), `<width>-<density or kiosk>-<fleet or node>.png` (widths 390, 600, 768, 1024, 1280, 1920), `kiosk.png`, `settings.png` and contact sheets `sheet-fleet-1.png`, `sheet-fleet-2.png`, `sheet-node-1.png`, `sheet-node-2.png`; it exits non-zero on any page error, console error, sideways scrolling, or panel (`.panel`, `.ncard`, `.head`, network table cell) whose content is wider than its box. `demo-hub.js <port>` prints `READY <port>` and logs in as `demo` / `demo-pass-1`.

- [ ] **Step 1: Write the demo hub and the screenshot script**

Create `test/screens/demo-hub.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * A throwaway hub with three demo servers, for screenshots:
 *   node test/screens/demo-hub.js <port>
 * The local node's snapshot is this machine's (servitals-agent test); "nas"
 * and "pi-garage" are variations of it. Prints READY when all three pushed
 * three times (so rates and sparklines exist). Login: demo / demo-pass-1.
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..", "..");
const PORT = Number(process.argv[2] || 20090);
const { signRequest } = require(path.join(REPO, "hub/lib/agentsig"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-demo-"));
const hub = spawn(process.execPath, [path.join(REPO, "hub/server.js")], {
  env: { PATH: process.env.PATH, PORT: String(PORT), STATE_DIR: state, UPSTREAM: "", AUTH_USER: "demo",
         AUTH_PASS: "demo-pass-1", LOG_LEVEL: "error" },
  stdio: "inherit",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function push(c, body) {
  const ts = String(Date.now());
  const buf = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/v1/agent/push", headers: {
      "content-type": "application/json", "content-length": buf.length, "x-servitals-proto": "1", "x-servitals-node": c.id,
      "x-servitals-ts": ts, "x-servitals-sig": signRequest(c.secret, "POST", "/api/v1/agent/push", ts, buf) } },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject);
    r.end(buf);
  });
}

function variant(base, c, i, round) {
  const s = JSON.parse(JSON.stringify(base));
  s.ts = Date.now();
  if (c.name) {
    s.host.name = c.name;
    s.cpu.usage = [0, 4, 23][i] + round;
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
    s.disks = [{ mount: "/", mounted: true, source: "/dev/sda1", fstype: "ext4", size: 500e9,
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
  if (s.net) { s.net.rxBytes += round * 5e6 * (i + 1); s.net.txBytes += round * 1e6; }
  for (const d of s.docker || []) if (d.cpuUsec != null) d.cpuUsec += round * 2e6;
  return JSON.stringify(s);
}

(async () => {
  await sleep(800);
  const base = JSON.parse(execFileSync("bash", [path.join(REPO, "bin/servitals-agent"), "test"],
    { env: { ...process.env, AGENT_ENV: "/nonexistent", DOCKER_SOCK: process.env.DOCKER_SOCK || "/var/run/docker.sock" } }).toString());
  const local = fs.readFileSync(path.join(state, "local-agent.env"), "utf8");
  const creds = [{ id: /NODE_ID=(.*)/.exec(local)[1], secret: /NODE_SECRET=(.*)/.exec(local)[1], name: null }];
  for (const name of ["nas", "pi-garage"]) {
    const n = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "hub/lib/nodes.js"), path.join(state, "nodes.json"), "add", name, "home"]).toString());
    creds.push({ ...n, name });
  }
  for (let round = 0; round < 3; round++) {
    for (const [i, c] of creds.entries()) {
      const code = await push(c, variant(base, c, i, round));
      if (code !== 200) throw new Error(`push ${c.name || "local"}: HTTP ${code}`);
    }
    if (round < 2) await sleep(5200);
  }
  console.log("READY", PORT);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
process.on("SIGTERM", () => { hub.kill(); fs.rmSync(state, { recursive: true, force: true }); process.exit(0); });
```

Create `test/screens/shoot.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Screenshots of every style in dark and light, for the fleet and the node
 * view, plus kiosk and settings; contact sheets of them all. Exits 1 on any
 * page error or console error. Runs inside the Playwright image:
 *   node shoot.js <base-url> <out-dir>
 */
const { chromium } = require("playwright");
const fs = require("fs");

const errors = [];
const STYLES = ["classic", "8bit", "phosphor", "eink", "contrast", "nord", "gruvbox", "dracula", "catppuccin", "solarized"];

(async () => {
  const [base, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto(base + "/");
  await page.fill("input[name=username]", "demo");
  await page.fill("input[name=password]", "demo-pass-1");
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  await page.waitForTimeout(1500);
  const local = await page.evaluate(() => localNode);
  const shots = { fleet: [], node: [] };
  for (const style of STYLES) for (const mode of ["dark", "light"]) {
    await page.evaluate(([s, m]) => { localStorage.setItem("servitals.style", s); localStorage.setItem("servitals.theme", m); }, [style, mode]);
    for (const view of ["fleet", "node"]) {
      await page.goto(`${base}/?shot=${style}-${mode}-${view}${view === "node" ? "#node=" + local : "#fleet"}`);
      await page.waitForTimeout(1500);
      const f = `${out}/${view}-${style}-${mode}.png`;
      await page.screenshot({ path: f });
      shots[view].push([`${style} · ${mode}`, fs.readFileSync(f).toString("base64")]);
    }
  }
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/?kiosk#fleet`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/kiosk.png` });
  await page.evaluate(() => localStorage.clear());   // ?kiosk is remembered
  await page.goto(`${base}/#fleet`);
  await page.waitForTimeout(1200);
  await page.keyboard.press("s");
  await page.locator("#cfg-style").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/settings.png` });

  // a phone and a desktop in every density and in kiosk: nothing cut off
  for (const width of [390, 600, 768, 1024, 1280, 1920]) for (const [density, q] of [["compact", ""], ["comfortable", ""], ["large", ""], ["comfortable", "?kiosk"]]) {
    for (const hash of ["#fleet", "#node=" + local]) {
      await page.evaluate((d) => { localStorage.clear(); localStorage.setItem("servitals.density", d); }, density);
      await page.setViewportSize({ width, height: 844 });
      const name = `${width}-${q ? "kiosk" : density}-${hash === "#fleet" ? "fleet" : "node"}`;
      await page.goto(`${base}/?shot=${name}${q ? "&kiosk" : ""}${hash}`);   // a new query: a real reload
      await page.waitForTimeout(1200);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      // content cut off or overlapping inside a panel
      const clipped = await page.evaluate(() => [...document.querySelectorAll(".panel:not(.hidden), .ncard, .head, .nettab td, .nettab th")]
        .filter((p) => p.offsetParent && p.scrollWidth > p.clientWidth + 1)
        .map((p) => (p.dataset.panel || `${p.tagName.toLowerCase()}.${p.className} "${p.textContent.trim().slice(0, 16)}"`)
          + " +" + (p.scrollWidth - p.clientWidth) + "px"));
      if (clipped.length) errors.push(`${name}: wider than its box: ${clipped.join(", ")}`);
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
      if (wide > 0) errors.push(`${name}: ${wide}px wider than the screen`);
    }
  }
  await page.evaluate(() => localStorage.clear());

  const sheet = await ctx.newPage();
  await sheet.setViewportSize({ width: 1600, height: 1000 });
  for (const view of Object.keys(shots)) for (let i = 0; i < shots[view].length; i += 10) {
    await sheet.setContent(`<body style="margin:0;background:#888;font:14px sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px">`
      + shots[view].slice(i, i + 10).map(([t, b]) => `<figure style="margin:0"><img style="width:100%" src="data:image/png;base64,${b}">`
        + `<figcaption style="background:#fff">${t}</figcaption></figure>`).join("") + "</body>");
    await sheet.screenshot({ path: `${out}/sheet-${view}-${i / 10 + 1}.png`, fullPage: true });
  }
  await browser.close();
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`screenshots in ${out}: no page errors`);
})().catch((e) => {
  // a page error usually makes a later step time out: show it first
  console.error([...errors, String(e)].join("\n"));
  process.exit(1);
});
```

Create `test/screens.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Screenshot the page in every style and mode (spec 16) with a demo hub of
# three servers, in the Playwright image. Fails on any page or console error.
# Look at build/screens/sheet-*.png (CI uploads them as an artifact).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.55.0-noble}"
PORT="${SCREENS_PORT:-20090}"
OUT="$SRC/build/screens"
rm -rf "$OUT"
mkdir -p "$OUT"
log=$(mktemp)
node "$SRC/test/screens/demo-hub.js" "$PORT" > "$log" 2>&1 &
hub=$!
trap 'kill "$hub" 2>/dev/null; rm -f "$log"' EXIT
for _ in $(seq 1 60); do grep -q READY "$log" && break; kill -0 "$hub" 2>/dev/null || break; sleep 1; done
grep -q READY "$log" || { cat "$log"; echo "demo hub did not start"; exit 1; }
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$SRC/test/screens:/screens:ro" -v "$OUT:/out" "$IMAGE" \
  bash -c 'cd /tmp && npm init -y >/dev/null && npm install --silent --no-audit --no-fund playwright@1.55.0 >/dev/null && cp /screens/shoot.js . && node shoot.js "$0" /out' \
  "http://127.0.0.1:$PORT"
```

- [ ] **Step 2: Run it to see what does not fit yet**

Run: `bash test/screens.sh; echo "exit=$?"`
Expected: FAIL, `exit=1`, with lines like `600-comfortable-node: wider than its box: cpu +41px, temp +25px, network +4px, th. "total" +2px, td.rx "318 KB/s" +18px, …` for node views at 390 to 1280 px: the `cpu` and `temp` panels (their `.row` values never wrap), the network table cells (`nowrap` in fixed-width columns), `th "total"` at 600 px, and `weather` in kiosk at 1024 px. The pixel counts depend on the host's own data; no `pageerror` lines.

- [ ] **Step 3: Let long values wrap**

In `www/index.html`:

1. Replace

```html

  .row { display: flex; justify-content: space-between; gap: 10px; white-space: nowrap; }
  .row + .row { margin-top: 3px; }
  .k { color: var(--dim); }
```

   with

```html

  .row { display: flex; justify-content: space-between; gap: 10px; white-space: nowrap; }
  /* a long value wraps instead of spilling out of a narrow panel */
  .row > .v { white-space: normal; text-align: right; min-width: 0; }
  .row + .row { margin-top: 3px; }
  .k { color: var(--dim); }
```

2. Replace

```html
  .nettab th {
    font-weight: 400; color: var(--dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: .06em; text-align: right; padding: 0 0 8px; white-space: nowrap;
  }
  .nettab td { text-align: right; padding: 7px 0; color: var(--fg-bright); white-space: nowrap; }
  .nettab th:first-child, .nettab td:first-child {
    text-align: left; color: var(--dim);
```

   with

```html
  .nettab th {
    font-weight: 400; color: var(--dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: .06em; text-align: right; padding: 0 0 8px;
  }
  .nettab td { text-align: right; padding: 7px 0; color: var(--fg-bright); }
  @media (max-width: 700px) { .nettab th { letter-spacing: 0; } }   /* "total" fits its column */
  .nettab th:first-child, .nettab td:first-child {
    text-align: left; color: var(--dim);
```

3. Replace

```html
  .clock .cdte { font-size: 12px; color: var(--dim); }

  .wx { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px 24px; }
  .wx .wc { display: flex; flex-direction: column; height: 100%; }
  .wx .wnow { display: flex; gap: 10px; align-items: baseline; }
```

   with

```html
  .clock .cdte { font-size: 12px; color: var(--dim); }

  .wx { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px 24px; }
  .wx .wc { display: flex; flex-direction: column; height: 100%; }
  .wx .wnow { display: flex; gap: 10px; align-items: baseline; }
```

- [ ] **Step 4: Run it again and look**

Run: `bash test/screens.sh && ls build/screens | wc -l`
Expected: `screenshots in /out: no page errors`, then `94`. Open the four `build/screens/sheet-*.png`, `kiosk.png`, `settings.png`, `390-large-node.png`, `600-comfortable-node.png` and `1280-kiosk-node.png` and check by eye: readable text, status colours distinct, nothing overlapping, phosphor in VT323, 8bit in Press Start 2P, the settings shot not in kiosk mode.

To see that it catches script errors: temporarily change `$("#btn-style")` to `$("#btn-stylex")` in `applyStyle`, run `bash test/screens.sh; echo $?`, expect a `pageerror: TypeError …` line and `1`, and undo the change.

- [ ] **Step 5: Add the CI job**

In `.github/workflows/ci.yml`:

1. Replace

```yaml
      - name: shellcheck
        run: |
          shellcheck -S warning agent/collect.sh agent/lib/*.sh bin/servitals-agent packaging/install-local.sh packaging/*.sh packaging/docker/*.sh test/deb-migrate.sh debian/servitals.postinst debian/servitals.postrm debian/servitals-agent.postrm debian/tests/smoke debian/tests/purge
          shellcheck -S error bin/servitals-ctl bin/bans bin/unban bin/whitelist test/budget.sh test/compose-smoke.sh
      - name: node --check
```

   with

```yaml
      - name: shellcheck
        run: |
          shellcheck -S warning agent/collect.sh agent/lib/*.sh bin/servitals-agent packaging/install-local.sh packaging/*.sh packaging/docker/*.sh test/deb-migrate.sh test/screens.sh debian/servitals.postinst debian/servitals.postrm debian/servitals-agent.postrm debian/tests/smoke debian/tests/purge
          shellcheck -S error bin/servitals-ctl bin/bans bin/unban bin/whitelist test/budget.sh test/compose-smoke.sh
      - name: node --check
```

2. Replace

```yaml
        run: packaging/ppa-upload.sh ppa:prabzo/servitals

```

   with

```yaml
        run: packaging/ppa-upload.sh ppa:prabzo/servitals

  screens:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
      - name: Install agent tools
        run: sudo apt-get update && sudo apt-get install -y jq
      - name: Screenshots in every style and mode (fails on page errors)
        run: bash test/screens.sh
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        if: always()
        with:
          name: screens
          path: build/screens/

```

- [ ] **Step 6: Docs**

In `README.md`:

1. Replace

```markdown
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Sensors and network history
```

   with

```markdown
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Styles, modes and kiosk

Ten styles: classic, 8bit, phosphor (green CRT in dark mode, amber in
light), e-ink (pure black and white for e-ink wall displays), high contrast
(WCAG AAA, colour-blind-safe status colours, shaped status lamps), and the
nord, gruvbox, dracula, catppuccin and solarized palettes. `y` cycles the
style and `t` the mode (system, light, dark) for this browser; settings →
appearance also sets the density (compact, comfortable, large; large needs a
screen at least 720 px wide), and saving makes the current look everyone's
default. Open `/?kiosk` for a wall screen: big type, no controls, and it
moves to the next server every 20 seconds. The screen remembers it, also
across a new login; `/?kiosk=0` turns it off again, even when settings →
appearance turns kiosk on for every screen.

## Sensors and network history
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Watch several servers: `servitals-ctl node add|list|rename|revoke` and
  `servitals-agent join|status`. The dashboard shows a fleet grid and node
```

   with

```markdown

### Added
- Styles: phosphor, e-ink, high contrast, nord, gruvbox, dracula,
  catppuccin and solarized join classic and 8bit. Each loads only when chosen
  (at most 3 KB); text contrast is checked for every style and mode.
- Mode switch with a system setting (the default), density (compact,
  comfortable, large), a hub-wide default look, and kiosk mode (`/?kiosk`).
- CI takes screenshots of every style and mode and fails on page errors.
- Watch several servers: `servitals-ctl node add|list|rename|revoke` and
  `servitals-agent join|status`. The dashboard shows a fleet grid and node
```

2. Replace

```markdown

### Changed
- Agent protocol: snapshots are fully validated (schema 1); agents send
  counters and the hub derives network rates, container CPU and the trend.
```

   with

```markdown

### Changed
- The page follows the system's light or dark setting until someone picks a
  mode (it used to start dark). The 8bit style moved out of the page into
  `styles/8bit.css`; its light colours are darker so text stays readable.
- Agent protocol: snapshots are fully validated (schema 1); agents send
  counters and the hub derives network rates, container CPU and the trend.
```

3. Replace

```markdown

### Fixed
- Without vnStat and `NET_IFACE`, the network panel disappeared; the agent
  now takes the interface of the default route, and the panel shows the live
```

   with

```markdown

### Fixed
- Password fields in settings look like the other fields.
- Long values (load, sensors, network totals) wrap instead of spilling out of
  narrow panels on phones and tablets.
- Browsers check for a newer page and style files on every load
  (`cache-control: no-cache`), so an upgrade shows at once.
- Without vnStat and `NET_IFACE`, the network panel disappeared; the agent
  now takes the interface of the default route, and the panel shows the live
```

- [ ] **Step 7: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                         # Expected: all pass (195)
pipx run --spec shellcheck-py shellcheck -S warning test/screens.sh packaging/install-local.sh
pipx run --spec shellcheck-py shellcheck -S error test/budget.sh
bash test/budget.sh                                # Expected: every line ok
bash test/compose-smoke.sh                         # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh   # Expected: both series, no lintian E:/W:
dpkg-deb -c build/deb/noble/servitals_*_all.deb | grep -c 'www/styles/.*\.css'   # Expected: 9
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh # Expected: smoke PASS, purge PASS on both series
```

- [ ] **Step 8: Log the bugs and commit**

In the main checkout's `.wolf/buglog.json`, add three entries (error_message, root_cause, fix, tags): values spilling out of narrow panels (`.row` and network cells never wrapped; fixed with wrapping, width-gated zoom and `test/screens.sh` checking six widths), browsers keeping an old page after an upgrade (no `cache-control` on static files; fixed with `no-cache` in Task 3), and unstyled password fields in settings (missing from the input rule; fixed in Task 2).

```bash
git add www/index.html test/screens test/screens.sh .github/workflows/ci.yml README.md CHANGELOG.md
git commit -m "test(ui): screenshots of every style, mode and width in CI; long values wrap" -m "test/screens.sh starts a demo hub with three servers and runs Playwright in its Docker image. It fails on any page or console error and on any panel whose content is wider than the panel, at 390 to 1920 px in every density and in kiosk. Load, sensor and network values now wrap. CI uploads the screenshots as an artifact."
```
