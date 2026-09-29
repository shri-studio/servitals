# servitals Strict CSP and a Split Page (sub-project 4f-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the dashboard under a strict Content-Security-Policy (spec 10.5): no inline script, no inline styles, only the hub and the weather service, with the settings panel loaded when first opened.

**Architecture:** A one-off script (`packaging/split-page.py`) moves the page's inline CSS and scripts into files: `www/index.html` (markup), `www/app.css`, `www/boot.js` (the 4c early script, still before the first paint), `www/js/app.js` (everything the dashboard needs at once, `defer`) and `www/js/settings.js` (the settings panel and the login form, loaded by `openSettings()` on first use and wired by `initSettings()`). Generated markup carries no `style` attributes: sizes travel as `data-w`/`data-h` and one `MutationObserver` sets them through the CSSOM before the next paint; SVG stops and the former static style attributes become classes. The hub sends `PAGE_CSP` with every static HTML file, the login, ban and `/link` pages send `FORM_CSP` (no script at all), and Docker's nginx sends the same page policy.

**Tech Stack:** HTML/CSS/vanilla JS, Python 3 (the one-off move), Node.js ≥ 18 built-ins, nginx (Docker install), Playwright screenshots (the CSP check in a real browser).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 10.5 (page weight: shell plus code loaded on first use; no inline script, handlers or style attributes; the same CSP self-hosted and hosted; `connect-src` the hub and the weather service), 18 (budget).

**Ruling (recorded here, binding for this plan):** the scripts are classic scripts sharing one global scope, not ES modules. The page's code reassigns shared state across sections (`cfg = …`, `view`, `fleetNodes`), which ES module bindings cannot do without rewriting most of it; the spec's outcomes (no inline script, a strict CSP, a smaller first load, settings on first use) do not depend on the module syntax. Cost if wrong: an import graph later, when the page is split further (after 1.0, or for the hosted service). Also: `connect-src` names `geocoding-api.open-meteo.com` next to `api.open-meteo.com`, because the weather search uses it.

**Scope (4f-1 of 4f):** 4f-2 (the i18n dictionary and the PWA shell: manifest, service worker, offline shell) follows as its own plan.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (165a29d) on 2026-09-29: node suite 269 tests, the budget (first load 26.5 KB gz), and `test/screens.sh` under the policy (no console errors; a mutation check proves a CSP violation fails it).

## Global Constraints

- Everything from sub-projects 1-4e still holds: zero runtime dependencies, Node 18 compatibility (hub, tests), SPDX headers (now also on `.css` files), lintian clean, the lightness budget (the first page load, now `index.html` + `app.css` + `boot.js` + `js/app.js`, ≤ 60 KB gzipped).
- The page policy, exactly: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Never `unsafe-inline` or `unsafe-eval` for the dashboard.
- The move changes no behaviour: the page's code moves verbatim except the seams the split script lists; every existing test keeps passing once it reads the page's files (`test/helpers/page.js`).
- Nothing in the page may evaluate strings (`eval`, `new Function`, string timers).
- The live dashboard runs on this host. Tests run in temp dirs and containers only.
- Work in a worktree `.claude/worktrees/servitals-csp` on branch `feat/csp` from `main` (165a29d).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **A style or script the policy blocks that no unit test sees** (an inline style in generated markup, a handler attribute, a script string): the browser refuses it silently apart from a console error. Test: Task 2's source test, and Task 4's screenshot run, which fails on any console error (a mutation check proves it catches a CSP violation).
2. **Settings used before `settings.js` has loaded** (a key press, an import, the kiosk, a deep link): every path into settings goes through `openSettings()`, and closing works without it. Test: Task 1's split (only `closeSettings`, `whoUser`, `panelFor`, `beforeImport` stay in `app.js`), the screenshot run's settings shots at 1280 and 390 px.
3. **Sizes that no longer apply** (meters, per-core bars, network bars, container CPU bars) because a node was added outside the observer's reach or before it started. Test: Task 2's `applySizes` and the screenshots.
4. **The first paint** (style, mode, density, kiosk) must still happen before the stylesheet, from `boot.js` in `<head>`. Test: Task 1 keeps the 4c early-script tests running against `boot.js`.
5. **Docker installs and the package**: the new files must ship, and nginx must send the same policy. Tests: Task 1 "the page's files ship…", Task 3 "Docker's nginx sends the same policy as the hub"; Task 4 build-deb and the compose smoke test.

---

### Task 1: Move the page into files

**Files:**
- Create: `packaging/split-page.py`, `test/helpers/page.js`; the script creates `www/app.css`, `www/boot.js`, `www/js/app.js`, `www/js/settings.js` and rewrites `www/index.html`
- Modify: `test/page.test.js`, `test/styles.test.js`, `test/version.test.js`, `test/license.test.js`, `test/rename.test.js`, `test/packaging.test.js`, `debian/servitals.install`, `packaging/install-local.sh`

**Interfaces:**
- Produces: the files above; `test/helpers/page.js` exports `{ WWW, MARKUP, CSS, BOOT, JS, PAGE }` (`PAGE` is all of them in load order); in `js/app.js`: `openSettings()` (loads `js/settings.js` once, then calls `showSettings()`; a load failure toasts and allows a retry), `closeSettings()`, `whoUser`, `panelFor`, `beforeImport`; in `js/settings.js`: `showSettings()` (the former `openSettings`) and `initSettings()` (the settings wiring moved out of the boot code).

- [ ] **Step 1: Point the tests at the page's files, and write the failing packaging test**

Create `test/helpers/page.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The dashboard is several files since the strict CSP (spec 10.5): the markup,
 * the stylesheet, the early boot script and the scripts. Tests that read "the
 * page" read them together, in load order.
 */
const fs = require("fs");
const path = require("path");

const WWW = path.join(__dirname, "..", "..", "www");
const read = (f) => fs.readFileSync(path.join(WWW, f), "utf8");
const MARKUP = read("index.html");
const CSS = read("app.css");
const BOOT = read("boot.js");
const JS = read("js/app.js") + "\n" + read("js/settings.js");
const PAGE = [MARKUP, CSS, BOOT, JS].join("\n");

module.exports = { WWW, MARKUP, CSS, BOOT, JS, PAGE };
```

In `test/page.test.js`:

1. Replace

```js
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");

// pull one top-level function out of the page's script and run it here
function pageFunction(name) {
  const m = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(HTML);
  assert.ok(m, `function ${name} not found in www/index.html`);
  return new Function(`${m[0]}; return ${name};`)();
}

```

   with

```js
const fs = require("node:fs");
const path = require("node:path");

// the page's markup, stylesheet, boot script and scripts, in load order
const { PAGE: HTML, BOOT, JS } = require("./helpers/page");

// pull one top-level function out of the page's script and run it here
function pageFunction(name) {
  const m = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(HTML);
  assert.ok(m, `function ${name} not found in the page`);
  return new Function(`${m[0]}; return ${name};`)();
}

```

2. Replace

```js
});

test("style, mode, density and kiosk are applied before the first paint", () => {
  const head = HTML.slice(0, HTML.indexOf("<style>"));
  assert.match(head, /localStorage\.getItem\("servitals\." \+ k\)/);
  assert.match(head, /\/\^\[a-z0-9-\]\{1,32\}\$\/\.test\(style\)/, "only a plain style name reaches the link");
  assert.match(head, /d\.setAttribute\("data-kiosk", ""\)/);
```

   with

```js
});

test("style, mode, density and kiosk are applied before the first paint", () => {
  const head = BOOT;   // runs in <head>, before the stylesheet and the scripts
  assert.match(head, /localStorage\.getItem\("servitals\." \+ k\)/);
  assert.match(head, /\/\^\[a-z0-9-\]\{1,32\}\$\/\.test\(style\)/, "only a plain style name reaches the link");
  assert.match(head, /d\.setAttribute\("data-kiosk", ""\)/);
```

3. Replace

```js

// runs the early <head> script against a fake document, as a browser would
function early({ search = "", stored = {} } = {}) {
  const src = HTML.slice(HTML.indexOf("<script>") + 8, HTML.indexOf("</script>"));
  const attrs = {}; const written = [];
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
```

   with

```js

// runs the early <head> script against a fake document, as a browser would
function early({ search = "", stored = {} } = {}) {
  const src = BOOT;
  const attrs = {}; const written = [];
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
```

4. Replace

```js
});

test("every temperature and time on the page goes through the unit helpers", () => {
  const script = HTML.slice(HTML.indexOf('<script>\n"use strict"')).replace(/function (tempUnit|fmtTemp)\([\s\S]*?\n}\n/g, "");
  assert.doesNotMatch(script, /\+ "°"|\}°|°C"/, "no hand-made degree signs");
  assert.doesNotMatch(script.replace(/function fmtTime[\s\S]*?\n}\n/, ""), /toLocaleTimeString\(/, "times through fmtTime");
  for (const id of ["cfg-u-temp", "cfg-u-size", "cfg-u-rate", "cfg-u-clock"]) assert.ok(HTML.includes(`id="${id}"`), id);
```

   with

```js
});

test("every temperature and time on the page goes through the unit helpers", () => {
  const script = JS.replace(/function (tempUnit|fmtTemp)\([\s\S]*?\n}\n/g, "");
  assert.doesNotMatch(script, /\+ "°"|\}°|°C"/, "no hand-made degree signs");
  assert.doesNotMatch(script.replace(/function fmtTime[\s\S]*?\n}\n/, ""), /toLocaleTimeString\(/, "times through fmtTime");
  for (const id of ["cfg-u-temp", "cfg-u-size", "cfg-u-rate", "cfg-u-clock"]) assert.ok(HTML.includes(`id="${id}"`), id);
```

5. Replace

```js
  const state = pageFn("readServersForm", { $, $$ })();
  assert.deepStrictEqual(state, { sort: "cpu", group: true, card: ["disk"], pinned: ["aaaaaaaaaaaa"], hidden: ["bbbbbbbbbbbb"],
    names: { aaaaaaaaaaaa: { name: "nas2", tags: "x" }, bbbbbbbbbbbb: { name: "b", tags: "" } } });
  assert.match(fn("openSettings"), /loadNodes\(\)\.then\(\(\) => renderServers\(\{ keep: true \}\)\)/);
});

test("review: a cancelled import changes nothing; zone clocks stay 24 hour unless asked", () => {
```

   with

```js
  const state = pageFn("readServersForm", { $, $$ })();
  assert.deepStrictEqual(state, { sort: "cpu", group: true, card: ["disk"], pinned: ["aaaaaaaaaaaa"], hidden: ["bbbbbbbbbbbb"],
    names: { aaaaaaaaaaaa: { name: "nas2", tags: "x" }, bbbbbbbbbbbb: { name: "b", tags: "" } } });
  assert.match(fn("showSettings"), /loadNodes\(\)\.then\(\(\) => renderServers\(\{ keep: true \}\)\)/);
});

test("review: a cancelled import changes nothing; zone clocks stay 24 hour unless asked", () => {
```

6. Replace

```js
  assert.match(HTML, /cfg = saved \? deepMerge\(structuredClone\(DEFAULTS\), saved\) : structuredClone\(DEFAULTS\);\n  applyManaged\(\);/);
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /\(n\.managed \|\| \[\]\)\.includes\("tags"\) \? " disabled/, "file-managed tags cannot be edited");
  assert.match(fn("openSettings"), /markManaged\(\);/);
});

test("conf.d review: a file with a few panels keeps the built-in panel list and sizes (fresh hub)", async () => {
```

   with

```js
  assert.match(HTML, /cfg = saved \? deepMerge\(structuredClone\(DEFAULTS\), saved\) : structuredClone\(DEFAULTS\);\n  applyManaged\(\);/);
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /\(n\.managed \|\| \[\]\)\.includes\("tags"\) \? " disabled/, "file-managed tags cannot be edited");
  assert.match(fn("showSettings"), /markManaged\(\);/);
});

test("conf.d review: a file with a few panels keeps the built-in panel list and sizes (fresh hub)", async () => {
```

7. Replace

```js
  assert.deepStrictEqual(disabled, ["title"], "a server's own panel set is not what files set");
});


```

   with

```js
  assert.deepStrictEqual(disabled, ["title"], "a server's own panel set is not what files set");
});

```

In `test/styles.test.js`:

1. Replace

```js

const WWW = path.join(__dirname, "..", "www");
const HTML = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
const TOKENS = ["bg", "bg-panel", "border", "dim", "fg", "fg-bright", "green", "cyan", "amber", "red",
                "magenta", "blue", "track", "spark", "shadow", "glow"];
```

   with

```js

const WWW = path.join(__dirname, "..", "www");
// classic's tokens are in app.css, the registry in js/app.js
const { PAGE: HTML } = require("./helpers/page");
const TOKENS = ["bg", "bg-panel", "border", "dim", "fg", "fg-bright", "green", "cyan", "amber", "red",
                "magenta", "blue", "track", "spark", "shadow", "glow"];
```

In `test/version.test.js`:

1. Replace

```js

test("dashboard has the branding footer and the update notice", () => {
  const html = fs.readFileSync(path.join(ROOT, "www", "index.html"), "utf8");
  for (const id of ["brandfoot", "sv-version", "updnote", "updver", "upddismiss"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
```

   with

```js

test("dashboard has the branding footer and the update notice", () => {
  const html = require("./helpers/page").PAGE;   // markup, stylesheet and scripts
  for (const id of ["brandfoot", "sv-version", "updnote", "updver", "upddismiss"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
```

In `test/license.test.js`:

1. Replace

```js

test("every tracked source file carries an SPDX identifier", () => {
  const files = execFileSync("git", ["ls-files", "hub", "agent", "bin", "test", "www/index.html",
    "docker-compose.example.yml", "nginx.conf"], { cwd: ROOT }).toString().split("\n").filter(Boolean);
  const missing = files.filter((f) => /\.(js|sh|html|yml|conf)$|Dockerfile$|^bin\//.test(f))
    .filter((f) => !fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").slice(0, 5)
      .some((l) => l.includes("SPDX-License-Identifier: AGPL-3.0-or-later")));
```

   with

```js

test("every tracked source file carries an SPDX identifier", () => {
  const files = execFileSync("git", ["ls-files", "hub", "agent", "bin", "test", "www/index.html", "www/app.css", "www/boot.js", "www/js",
    "docker-compose.example.yml", "nginx.conf"], { cwd: ROOT }).toString().split("\n").filter(Boolean);
  const missing = files.filter((f) => /\.(js|css|sh|html|yml|conf)$|Dockerfile$|^bin\//.test(f))
    .filter((f) => !fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").slice(0, 5)
      .some((l) => l.includes("SPDX-License-Identifier: AGPL-3.0-or-later")));
```

In `test/rename.test.js`:

1. Replace

```js

const ROOT = path.join(__dirname, "..");
const FILES = ["hub/server.js", "agent/collect.sh", "www/index.html", "docker-compose.example.yml", ".env.example", "README.md"];

test("old names only remain on lines marked legacy-name", () => {
```

   with

```js

const ROOT = path.join(__dirname, "..");
const FILES = ["hub/server.js", "agent/collect.sh", "www/index.html", "www/boot.js", "www/js/app.js", "www/js/settings.js",
               "docker-compose.example.yml", ".env.example", "README.md"];

test("old names only remain on lines marked legacy-name", () => {
```

In `test/packaging.test.js`:

1. Replace

```js
  assert.match(read("debian/tests/smoke"), /for u in servitals servitals-agent servitals-backup; do/);
});

```

   with

```js
  assert.match(read("debian/tests/smoke"), /for u in servitals servitals-agent servitals-backup; do/);
});

test("the page's files ship: app.css, boot.js and js/*.js (package and install-local)", () => {
  const inst = read("debian/servitals.install");
  assert.match(inst, /^www\/app\.css www\/boot\.js usr\/share\/servitals\/www\/$/m);
  assert.match(inst, /^www\/js\/\*\.js usr\/share\/servitals\/www\/js\/$/m);
  assert.match(read("packaging/install-local.sh"), /"\$SRC\/www\/app\.css" "\$SRC\/www\/boot\.js"/);
  assert.match(read("packaging/install-local.sh"), /cp -r "\$SRC\/www\/js" "\$SHARE\/www\/js"/);
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/*.test.js`
Expected: FAIL: every test file that requires `./helpers/page` stops with `ENOENT … www/app.css` (page, styles, version), and "the page's files ship…" fails.

- [ ] **Step 3: The split script**

Create `packaging/split-page.py`:

```python
#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# One-off move for sub-project 4f-1 (spec 10.5): the page's inline CSS and
# scripts become files, so the hub can send a strict Content-Security-Policy.
#   www/index.html  markup only, <link> app.css, <script src> boot.js and js/app.js
#   www/app.css     the former <style> block
#   www/boot.js     the former early <head> script (style, mode, density, kiosk)
#   www/js/app.js   everything the dashboard needs at once
#   www/js/settings.js  the settings panel and the login form, loaded when opened
# Nothing is rewritten except the seams listed below; run it once from the repo root.
import re
import sys

PAGE = "www/index.html"
html = open(PAGE).read()


def cut(text, start, end):
    """text between two unique markers (exclusive), and the text with that span removed"""
    assert text.count(start) == 1, start
    i = text.index(start) + len(start)
    j = text.index(end, i)
    return text[i:j], text[:i - len(start)] + text[j + len(end):]


def dedent(block, n=2):
    return "\n".join(l[n:] if l.startswith(" " * n) else l for l in block.strip("\n").split("\n")) + "\n"


# 1. the early head script and the style block (the first <script> and the <style> in <head>)
a = html.index("<script>\n")
b = html.index("</script>\n<style>\n", a)
c = html.index("</style>\n", b)
early = html[a + len("<script>\n"):b]
css = html[b + len("</script>\n<style>\n"):c]
html = (html[:a] + '<script src="boot.js"></script>\n<link rel="stylesheet" href="app.css">\n'
        + '<script src="js/app.js" defer></script>\n' + html[c + len("</style>\n"):])

# 2. the app script
app, html = cut(html, '<script>\n"use strict";\n', "</script>\n")
SECTION = "/* ------------------------------------------------------------------ "
sections = re.split(r"(?m)^(?=/\* -{66} )", app)
lazy_names = ("settings UI", "login")
eager, lazy = [], []
for s in sections:
    name = s[len(SECTION):].split("\n")[0].strip(" */") if s.startswith(SECTION) else ""
    (lazy if name.startswith(lazy_names) else eager).append(s)
core = "".join(eager)
settings = "".join(lazy)

# 3. seams between the two files
def move(text, block):
    assert text.count(block) == 1, block[:60]
    return text.replace(block, "")

# shared state and the always-there helpers live in app.js
for decl in ('let whoUser = "";\n', 'let panelFor = "all";   // "all" or a node id\n'):
    settings = move(settings, decl)
close_fn = re.search(r"// an import not saved is undone when settings close\nlet beforeImport = null;\nfunction closeSettings\(\) \{\n.*?\n\}\n", settings, re.S).group(0)
settings = move(settings, close_fn)
settings = settings.replace("function openSettings() {", "function showSettings() {", 1)

# the boot code's settings wiring runs once, when settings.js has loaded
wiring_a, core = cut(core, '  $("#acct-save").onclick = saveAccount;\n',
                     '  $("#btn-theme").onclick = toggleTheme;\n')
core = core.replace('  $("#settings-close").onclick = closeSettings;\n',
                    '  $("#settings-close").onclick = closeSettings;\n  $("#btn-theme").onclick = toggleTheme;\n', 1)
wiring_b, core = cut(core, '  $("#wx-add").onclick = wxSearch;\n', '\n  document.addEventListener("keydown", e => {\n')
core = core.replace('  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });\n',
                    '  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });\n\n'
                    '  document.addEventListener("keydown", e => {\n', 1)
wiring = ('  $("#acct-save").onclick = saveAccount;\n' + wiring_a
          + '  $("#wx-add").onclick = wxSearch;\n' + wiring_b.rstrip("\n") + "\n")

loader = '''/* ------------------------------------------------------------------ settings, loaded on first use (spec 10.5) */
let whoUser = "";
let panelFor = "all";   // "all" or a node id
''' + close_fn + '''let settingsReady = null;
function openSettings() {
  settingsReady = settingsReady || new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "js/settings.js";
    s.onload = () => { initSettings(); ok(); };
    s.onerror = () => { settingsReady = null; fail(new Error("settings.js")); };
    document.head.appendChild(s);
  });
  return settingsReady.then(() => showSettings(), () => toast("could not load the settings; reload the page", true));
}

'''
boot_at = core.index(SECTION + "boot */")
core = core[:boot_at] + loader + core[boot_at:]

open("www/boot.js", "w").write("// SPDX-License-Identifier: AGPL-3.0-or-later\n" + dedent(early))
open("www/app.css", "w").write("/* SPDX-License-Identifier: AGPL-3.0-or-later */\n" + dedent(css))
open("www/js/app.js", "w").write('// SPDX-License-Identifier: AGPL-3.0-or-later\n"use strict";\n' + core.strip("\n") + "\n")
open("www/js/settings.js", "w").write(
    '// SPDX-License-Identifier: AGPL-3.0-or-later\n"use strict";\n'
    "/* the settings panel and the login form: loaded by openSettings() in app.js */\n"
    + settings.strip("\n") + "\n\n"
    "// wiring for the settings controls, once, when this file has loaded\n"
    "function initSettings() {\n" + wiring + "}\n")
open(PAGE, "w").write(html)
print("split: www/index.html, www/app.css, www/boot.js, www/js/app.js, www/js/settings.js")
```

- [ ] **Step 4: Run it once**

Run: `mkdir -p www/js && python3 packaging/split-page.py && for f in www/boot.js www/js/app.js www/js/settings.js; do node --check "$f"; done && wc -l www/index.html www/app.css www/boot.js www/js/*.js`
Expected: `split: www/index.html, www/app.css, www/boot.js, www/js/app.js, www/js/settings.js`, no `node --check` output, and about 287 / 511 / 24 / 1083 / 398 lines.

- [ ] **Step 5: Ship the new files**

In `debian/servitals.install`:

1. Replace

```
VERSION usr/share/servitals/
www/index.html usr/share/servitals/www/
www/config.example.json usr/share/servitals/www/
www/fonts/*.woff2 usr/share/servitals/www/fonts/
```

   with

```
VERSION usr/share/servitals/
www/index.html usr/share/servitals/www/
www/app.css www/boot.js usr/share/servitals/www/
www/js/*.js usr/share/servitals/www/js/
www/config.example.json usr/share/servitals/www/
www/fonts/*.woff2 usr/share/servitals/www/fonts/
```

In `packaging/install-local.sh`:

1. Replace

```bash
# shipped web files only, never a Docker install's config.json or data.json
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
cp -r "$SRC/www/styles" "$SHARE/www/styles"
chmod -R u=rwX,go=rX "$SHARE/www/fonts" "$SHARE/www/styles"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
```

   with

```bash
# shipped web files only, never a Docker install's config.json or data.json
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
install -m 644 "$SRC/www/app.css" "$SRC/www/boot.js" "$SHARE/www/"
cp -r "$SRC/www/js" "$SHARE/www/js"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
cp -r "$SRC/www/styles" "$SHARE/www/styles"
chmod -R u=rwX,go=rX "$SHARE/www/fonts" "$SHARE/www/styles" "$SHARE/www/js"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test; every earlier test passes against the moved code).

- [ ] **Step 7: Commit**

```bash
git add packaging/split-page.py www/index.html www/app.css www/boot.js www/js test/helpers/page.js test/page.test.js test/styles.test.js test/version.test.js test/license.test.js test/rename.test.js test/packaging.test.js debian/servitals.install packaging/install-local.sh
git commit -m "refactor(ui): the page's CSS and scripts move into files; settings load when opened" -m "packaging/split-page.py moves the inline style block to app.css, the early head script to boot.js, and the scripts to js/app.js (loaded with the page) and js/settings.js (loaded by openSettings on first use). The code moves verbatim apart from the seams the script lists. Tests read the page's files through test/helpers/page.js."
```

---

### Task 2: No inline styles; sizes through the CSSOM

**Files:**
- Modify: `www/index.html`, `www/js/app.js`, `www/app.css`, `test/page.test.js`

**Interfaces:**
- Produces: `applySizes(root)` and a `MutationObserver` on `document.documentElement` in `js/app.js`: every added element with `data-w` / `data-h` (percent) gets `style.width` / `style.height`; classes `mt8 mt10 w110 w130 dimnote m860 m400 s-green s-amber s-red` in `app.css`.

- [ ] **Step 1: Write the failing test**

In `test/page.test.js`:

1. Replace

```js
  assert.deepStrictEqual(disabled, ["title"], "a server's own panel set is not what files set");
});

```

   with

```js
  assert.deepStrictEqual(disabled, ["title"], "a server's own panel set is not what files set");
});


test("strict CSP (spec 10.5): no inline script, no event-handler attributes, no style attributes", () => {
  const { MARKUP } = require("./helpers/page");
  for (const tag of MARKUP.match(/<script\b[^>]*>/g)) assert.match(tag, /\ssrc="[^"]+"/, `inline script: ${tag}`);
  assert.doesNotMatch(MARKUP, /<style\b/, "no inline stylesheet");
  assert.doesNotMatch(MARKUP, /\son[a-z]+="/, "no event-handler attributes");
  assert.doesNotMatch(MARKUP, /\sstyle="/, "no style attributes in the markup");
  assert.doesNotMatch(JS, /\sstyle="|\sstyle=\\"/, "none in generated markup either: sizes go through data-w / data-h");
  assert.doesNotMatch(JS + BOOT, /\beval\(|new Function\(|setTimeout\("/, "no string evaluation");
  // the settings panel and the login form load when opened, not with the page
  assert.doesNotMatch(MARKUP, /js\/settings\.js/);
  assert.match(JS, /s\.src = "js\/settings\.js";/);
});

```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 1 test: "strict CSP (spec 10.5)…" (`no style attributes in the markup`).

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html
      <div id="mem-bar"></div>
      <div class="sparkmini" id="mem-spark"></div>
      <div class="row" style="margin-top:8px"><span class="k">used</span><span class="v" id="mem-used2">--</span></div>
      <div class="row"><span class="k">cache/buffers</span><span class="v" id="mem-cache">--</span></div>
      <div class="row"><span class="k">available</span><span class="v" id="mem-avail">--</span></div>
```

   with

```html
      <div id="mem-bar"></div>
      <div class="sparkmini" id="mem-spark"></div>
      <div class="row mt8"><span class="k">used</span><span class="v" id="mem-used2">--</span></div>
      <div class="row"><span class="k">cache/buffers</span><span class="v" id="mem-cache">--</span></div>
      <div class="row"><span class="k">available</span><span class="v" id="mem-avail">--</span></div>
```

2. Replace

```html
      <div id="cpu-bar"></div>
      <div class="sparkmini" id="cpu-spark"></div>
      <div class="row" style="margin-top:8px"><span class="k">load 1m / 5m / 15m</span><span class="v" id="cpu-load">-- / -- / --</span></div>
      <div class="row"><span class="k">load / core</span><span class="v" id="cpu-loadn">--</span></div>
      <div id="cpu-cores-wrap">
```

   with

```html
      <div id="cpu-bar"></div>
      <div class="sparkmini" id="cpu-spark"></div>
      <div class="row mt8"><span class="k">load 1m / 5m / 15m</span><span class="v" id="cpu-load">-- / -- / --</span></div>
      <div class="row"><span class="k">load / core</span><span class="v" id="cpu-loadn">--</span></div>
      <div id="cpu-cores-wrap">
```

3. Replace

```html
      <div id="temp-bar"></div>
      <div class="sparkmini" id="temp-spark"></div>
      <div class="row" style="margin-top:10px"><span class="k">range (session)</span><span class="v" id="temp-range">--</span></div>
      <div class="row"><span class="k">sensors</span><span class="v" id="temp-cores" style="white-space:normal;text-align:right">--</span></div>
    </div>

```

   with

```html
      <div id="temp-bar"></div>
      <div class="sparkmini" id="temp-spark"></div>
      <div class="row mt10"><span class="k">range (session)</span><span class="v" id="temp-range">--</span></div>
      <div class="row"><span class="k">sensors</span><span class="v" id="temp-cores">--</span></div>
    </div>

```

4. Replace

```html
          <button id="fav-upload">upload image</button>
          <input type="file" id="fav-file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" hidden>
          <input type="text" id="fav-emoji" placeholder="or an emoji" maxlength="4" style="max-width:110px">
          <button id="fav-clear">clear</button>
        </div>
```

   with

```html
          <button id="fav-upload">upload image</button>
          <input type="file" id="fav-file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" hidden>
          <input type="text" id="fav-emoji" placeholder="or an emoji" maxlength="4" class="w110">
          <button id="fav-clear">clear</button>
        </div>
```

5. Replace

```html
        <div id="cfg-clocks"></div>
        <div class="addrow">
          <input type="text" id="clk-label" placeholder="label" style="max-width:130px">
          <input type="text" id="clk-tz" list="tzlist" placeholder="Area/City timezone">
          <button id="clk-add">add</button>
```

   with

```html
        <div id="cfg-clocks"></div>
        <div class="addrow">
          <input type="text" id="clk-label" placeholder="label" class="w130">
          <input type="text" id="clk-tz" list="tzlist" placeholder="Area/City timezone">
          <button id="clk-add">add</button>
```

6. Replace

```html
    </div>
    <div class="body hidden" id="export-wrap">
      <label id="export-lbl" style="color:var(--dim);font-size:12px"></label>
      <textarea id="export-text" readonly></textarea>
    </div>
```

   with

```html
    </div>
    <div class="body hidden" id="export-wrap">
      <label id="export-lbl" class="dimnote"></label>
      <textarea id="export-text" readonly></textarea>
    </div>
```

7. Replace

```html
<!-- container logs -->
<div class="overlay" id="logs-overlay">
  <div class="modal" style="max-width:860px">
    <h3><span id="logs-title">logs</span> <span class="x" id="logs-close">[esc]</span></h3>
    <pre id="logs-body">loading&hellip;</pre>
```

   with

```html
<!-- container logs -->
<div class="overlay" id="logs-overlay">
  <div class="modal m860">
    <h3><span id="logs-title">logs</span> <span class="x" id="logs-close">[esc]</span></h3>
    <pre id="logs-body">loading&hellip;</pre>
```

8. Replace

```html
<!-- confirm -->
<div class="overlay mid" id="confirm-overlay">
  <div class="modal" style="max-width:400px">
    <h3><span id="confirm-title">confirm</span> <span class="x" id="confirm-x">[esc]</span></h3>
    <div id="confirm-msg"></div>
```

   with

```html
<!-- confirm -->
<div class="overlay mid" id="confirm-overlay">
  <div class="modal m400">
    <h3><span id="confirm-title">confirm</span> <span class="x" id="confirm-x">[esc]</span></h3>
    <div id="confirm-msg"></div>
```

In `www/js/app.js`:

1. Replace

```js
  return date.toLocaleTimeString(locale, { timeZone, hour12: c === "12h" ? true : c === "24h" ? false : undefined });
}
function fmtBytes(n) {
  n = Number(n) || 0;
```

   with

```js
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
```

2. Replace

```js
  pct = clamp(pct, 0, 100);
  const cls = forceCls || HCLS[health(pct, 70, 90)];
  return `<div class="meter ${cls}"><div class="track"><i style="width:${pct.toFixed(1)}%"></i></div>`
    + `<span class="pct">${Math.round(pct)}%</span></div>`;
}
```

   with

```js
  pct = clamp(pct, 0, 100);
  const cls = forceCls || HCLS[health(pct, 70, 90)];
  return `<div class="meter ${cls}"><div class="track"><i data-w="${pct.toFixed(1)}"></i></div>`
    + `<span class="pct">${Math.round(pct)}%</span></div>`;
}
```

3. Replace

```js
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<defs><linearGradient id="${id}" x1="0" y1="${H}" x2="0" y2="0" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" style="stop-color:var(--green)"/>`
    + `<stop offset="0.62" style="stop-color:var(--green)"/>`
    + `<stop offset="0.78" style="stop-color:var(--amber)"/>`
    + `<stop offset="0.92" style="stop-color:var(--red)"/></linearGradient></defs>`
    + `<polyline points="${pts}" fill="none" stroke="url(#${id})" stroke-width="1.5" `
    + `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
```

   with

```js
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<defs><linearGradient id="${id}" x1="0" y1="${H}" x2="0" y2="0" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" class="s-green"/>`
    + `<stop offset="0.62" class="s-green"/>`
    + `<stop offset="0.78" class="s-amber"/>`
    + `<stop offset="0.92" class="s-red"/></linearGradient></defs>`
    + `<polyline points="${pts}" fill="none" stroke="url(#${id})" stroke-width="1.5" `
    + `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
```

4. Replace

```js
    $("#cpu-cores").innerHTML = per.map(v => {
      const cls = v >= 85 ? "max" : v >= 55 ? "hot" : "";
      return `<span class="cbar ${cls}" title="${v}%"><i style="height:${clamp(v, 2, 100)}%"></i></span>`;
    }).join("");
    $("#cpu-cores-wrap").classList.toggle("hidden", !per.length);
```

   with

```js
    $("#cpu-cores").innerHTML = per.map(v => {
      const cls = v >= 85 ? "max" : v >= 55 ? "hot" : "";
      return `<span class="cbar ${cls}" title="${v}%"><i data-h="${clamp(v, 2, 100)}"></i></span>`;
    }).join("");
    $("#cpu-cores-wrap").classList.toggle("hidden", !per.length);
```

5. Replace

```js
  $("#net-bars").innerHTML = rows.map(x =>
    `<span class="d" data-t="${esc(x.title)}" data-rx="${x.rx}" data-tx="${x.tx}">`
    + `<span class="up" style="height:${(x.tx / peak) * 100}%"></span>`
    + `<span class="dn" style="height:${(x.rx / peak) * 100}%"></span></span>`).join("");
  if (!rows.length) { $("#net-days-range").textContent = ""; return; }
  const busy = rows.reduce((a, x) => (x.rx + x.tx) > (a.rx + a.tx) ? x : a);
```

   with

```js
  $("#net-bars").innerHTML = rows.map(x =>
    `<span class="d" data-t="${esc(x.title)}" data-rx="${x.rx}" data-tx="${x.tx}">`
    + `<span class="up" data-h="${((x.tx / peak) * 100).toFixed(2)}"></span>`
    + `<span class="dn" data-h="${((x.rx / peak) * 100).toFixed(2)}"></span></span>`).join("");
  if (!rows.length) { $("#net-days-range").textContent = ""; return; }
  const busy = rows.reduce((a, x) => (x.rx + x.tx) > (a.rx + a.tx) ? x : a);
```

6. Replace

```js
    const main = stats
      ? name
        + `<span class="scpubar${(c.cpu || 0) > 0.5 ? "" : " flat"}"><i style="width:${(c.cpu || 0) > 0.5 ? clamp(c.cpu, 1, 100) : 0}%"></i></span>`
        + `<span class="scpu ${cpuHl}">${c.cpu == null ? "–" : c.cpu.toFixed(c.cpu < 10 ? 1 : 0) + "%"}</span>`
        + `<span class="smem ${memCls}" title="resident memory · ${memRel.toFixed(0)}% of the largest">${fmtBytes(c.mem)}</span>`
```

   with

```js
    const main = stats
      ? name
        + `<span class="scpubar${(c.cpu || 0) > 0.5 ? "" : " flat"}"><i data-w="${(c.cpu || 0) > 0.5 ? clamp(c.cpu, 1, 100) : 0}"></i></span>`
        + `<span class="scpu ${cpuHl}">${c.cpu == null ? "–" : c.cpu.toFixed(c.cpu < 10 ? 1 : 0) + "%"}</span>`
        + `<span class="smem ${memCls}" title="resident memory · ${memRel.toFixed(0)}% of the largest">${fmtBytes(c.mem)}</span>`
```

In `www/app.css`:

1. Replace

```css
}
.hidden { display: none !important; }

.meter .track i, .cores .cbar i, .stat-bar-fill { transition: width .5s ease, height .5s ease; }
```

   with

```css
}
.hidden { display: none !important; }
/* what used to be style attributes (a strict CSP allows none) */
.row.mt8 { margin-top: 8px; }
.row.mt10 { margin-top: 10px; }
.modal input.w110 { max-width: 110px; }
.modal input.w130 { max-width: 130px; }
.dimnote { color: var(--dim); font-size: 12px; }
.modal.m860 { max-width: 860px; }
.modal.m400 { max-width: 400px; }
.s-green { stop-color: var(--green); }
.s-amber { stop-color: var(--amber); }
.s-red { stop-color: var(--red); }

.meter .track i, .cores .cbar i, .stat-bar-fill { transition: width .5s ease, height .5s ease; }
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test).

- [ ] **Step 5: Commit**

```bash
git add www/index.html www/js/app.js www/app.css test/page.test.js
git commit -m "refactor(ui): no style attributes in the page; sizes set through the CSSOM" -m "Meters and bars carry data-w/data-h and a MutationObserver sets their sizes before the next paint; SVG stops and the former static style attributes are classes. A strict style-src 'self' can now apply."
```

---

### Task 3: The hub sends the policies

**Files:**
- Modify: `hub/lib/static.js`, `hub/server.js`, `nginx.conf`, `test/static.test.js`, `test/hub.test.js`, `test/packaging.test.js`

**Interfaces:**
- Produces: `PAGE_CSP` exported from `hub/lib/static.js`, sent with every `.html` file the hub serves; `FORM_CSP` in `hub/server.js` (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`) on the login, ban and `/link` pages; nginx's `location /` sends `PAGE_CSP`.

- [ ] **Step 1: Write the failing tests**

In `test/static.test.js`:

1. Replace

```js
  assert.throws(() => createStatic(path.join(os.tmpdir(), "sv-no-such-dir-" + process.pid)));
});

```

   with

```js
  assert.throws(() => createStatic(path.join(os.tmpdir(), "sv-no-such-dir-" + process.pid)));
});

test("pages carry a strict Content-Security-Policy (spec 10.5); other files do not need one", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { path: "/" });
    const csp = r.headers["content-security-policy"];
    assert.ok(csp, "the page has a policy");
    for (const want of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
                        "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com",
                        "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) {
      assert.ok(csp.split(/;\s*/).includes(want), want);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.strictEqual((await request(port, { path: "/fonts/a.woff2" })).headers["content-security-policy"], undefined);
  });
});

```

In `test/hub.test.js`:

1. Replace

```js
    assert.match(bad.body, /name="kiosk" value="1"/, "a failed attempt keeps kiosk for the next one");
  });
});

```

   with

```js
    assert.match(bad.body, /name="kiosk" value="1"/, "a failed attempt keeps kiosk for the next one");
  });
});

test("the login page runs no script at all: its policy allows only its own inline styles", async () => {
  await withHub({}, async (hub) => {
    const r = await request(hub.port, { path: "/" });
    assert.match(r.body, /authentication required/);
    const csp = r.headers["content-security-policy"] || "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /script-src/);
  });
});

```

In `test/packaging.test.js`:

1. Replace

```js
  assert.match(read("packaging/install-local.sh"), /cp -r "\$SRC\/www\/js" "\$SHARE\/www\/js"/);
});

```

   with

```js
  assert.match(read("packaging/install-local.sh"), /cp -r "\$SRC\/www\/js" "\$SHARE\/www\/js"/);
});

test("Docker's nginx sends the same policy as the hub", () => {
  const { PAGE_CSP } = require("../hub/lib/static");
  assert.ok(read("nginx.conf").includes(`add_header Content-Security-Policy "${PAGE_CSP}" always;`));
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/static.test.js test/hub.test.js test/packaging.test.js`
Expected: FAIL, 3 tests: no `content-security-policy` header on the page or the login page, and `PAGE_CSP` is not exported.

- [ ] **Step 3: The hub and nginx**

In `hub/lib/static.js`:

1. Replace

```js
const fs = require("fs");
const path = require("path");

const TYPES = {
```

   with

```js
const fs = require("fs");
const path = require("path");

// the dashboard's policy (spec 10.5): its own files only, plus the weather service
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const TYPES = {
```

2. Replace

```js
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
```

   with

```js
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      ...(path.extname(real).toLowerCase() === ".html" ? { "content-security-policy": PAGE_CSP } : {}),
    });
    if (req.method === "HEAD") return res.end();
```

3. Replace

```js
}

module.exports = { createStatic, TYPES };

```

   with

```js
}

module.exports = { createStatic, TYPES, PAGE_CSP };

```

In `hub/server.js`:

1. Replace

```js

/* ---------- pages ---------- */
const SHELL = (title, inner, wide = false) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
```

   with

```js

/* ---------- pages ---------- */
// login, ban and /link pages are rendered here: no script at all, only their own inline styles
const FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";
const SHELL = (title, inner, wide = false) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
```

2. Replace

```js
  const html = (body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
                         "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
    res.end(body);
  };
```

   with

```js
  const html = (body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
                         "x-frame-options": "DENY", "content-security-policy": FORM_CSP });
    res.end(body);
  };
```

3. Replace

```js
  if (!wl) {
    const b = banInfo(ip);
    if (b) { res.writeHead(403, { "content-type": "text/html" }); return res.end(bannedPage(ip, b)); }
  }

```

   with

```js
  if (!wl) {
    const b = banInfo(ip);
    if (b) { res.writeHead(403, { "content-type": "text/html", "content-security-policy": FORM_CSP }); return res.end(bannedPage(ip, b)); }
  }

```

4. Replace

```js
      if (r.banned) {
        log.audit("auth.banned", { ip, hours: BAN_HOURS });
        res.writeHead(403, { "content-type": "text/html" });
        return res.end(bannedPage(ip, banInfo(ip) || {}));
      }
```

   with

```js
      if (r.banned) {
        log.audit("auth.banned", { ip, hours: BAN_HOURS });
        res.writeHead(403, { "content-type": "text/html", "content-security-policy": FORM_CSP });
        return res.end(bannedPage(ip, banInfo(ip) || {}));
      }
```

5. Replace

```js
      log.audit("auth.login_fail", { ip, user, whitelisted: true });
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg, kiosk, next));
  }
```

   with

```js
      log.audit("auth.login_fail", { ip, user, whitelisted: true });
    }
    res.writeHead(401, { "content-type": "text/html", "content-security-policy": FORM_CSP });
    return res.end(loginPage(msg, kiosk, next));
  }
```

6. Replace

```js
    if (authed) return linkRoute(req, res, client);
    if (req.method === "POST") { res.writeHead(401, { "content-type": "text/plain" }); return res.end("login required"); }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(loginPage(null, "", "link"));
  }
```

   with

```js
    if (authed) return linkRoute(req, res, client);
    if (req.method === "POST") { res.writeHead(401, { "content-type": "text/plain" }); return res.end("login required"); }
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": FORM_CSP });
    return res.end(loginPage(null, "", "link"));
  }
```

7. Replace

```js
  if (authed) return UP ? proxy(req, res) : serveStatic(req, res);

  res.writeHead(200, { "content-type": "text/html" });
  res.end(loginPage(null, kioskFromUrl(req.url)));
}
```

   with

```js
  if (authed) return UP ? proxy(req, res) : serveStatic(req, res);

  res.writeHead(200, { "content-type": "text/html", "content-security-policy": FORM_CSP });
  res.end(loginPage(null, kioskFromUrl(req.url)));
}
```

In `nginx.conf`:

1. Replace

```nginx
    location / {
        add_header Cache-Control "no-cache" always;   # a browser asks for a newer page after an upgrade
        try_files $uri $uri/ =404;
    }
```

   with

```nginx
    location / {
        add_header Cache-Control "no-cache" always;   # a browser asks for a newer page after an upgrade
        # the same policy the native hub sends (hub/lib/static.js PAGE_CSP)
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
        try_files $uri $uri/ =404;
    }
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (3 new tests).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/static.js hub/server.js nginx.conf test/static.test.js test/hub.test.js test/packaging.test.js
git commit -m "feat(hub): a strict Content-Security-Policy for the dashboard; no script on the login pages" -m "The dashboard's policy allows only the hub and the weather service, no inline script or style, no framing. The login, ban and /link pages run no script at all. Docker's nginx sends the same page policy."
```

---

### Task 4: Budget, docs, the browser check, full validation

**Files:**
- Modify: `test/budget.sh`, `CHANGELOG.md`, `docs/threat-model.md`

- [ ] **Step 1: The budget counts the whole first load**

In `test/budget.sh`:

1. Replace

```bash
check "runtime dependencies" "$deps" 0 "packages"

# 2. first page load, gzipped, fonts excluded
page=$(gzip -9 -c www/index.html | wc -c)
check "first page load (gzip, no fonts)" "$page" 61440 "bytes"

```

   with

```bash
check "runtime dependencies" "$deps" 0 "packages"

# 2. first page load, gzipped, fonts excluded: the markup, the stylesheet and the
#    scripts that load with it (js/settings.js and the styles load later)
page=$(( $(gzip -9 -c www/index.html | wc -c) + $(gzip -9 -c www/app.css | wc -c) \
       + $(gzip -9 -c www/boot.js | wc -c) + $(gzip -9 -c www/js/app.js | wc -c) ))
check "first page load (gzip, no fonts)" "$page" 61440 "bytes"

```

- [ ] **Step 2: Docs**

In `CHANGELOG.md`:

1. Replace

```markdown

### Security
- An address that keeps failing agent authentication gets `429` for a
  minute. The last accepted request time per node survives a hub restart,
```

   with

```markdown

### Security
- The dashboard runs under a strict Content-Security-Policy (spec 10.5): no
  inline script, no inline styles, only the hub itself and the weather service
  (`api.open-meteo.com`, `geocoding-api.open-meteo.com`). The page is now
  `index.html` (markup), `app.css`, `boot.js` and `js/app.js`; the settings
  panel (`js/settings.js`) loads when first opened. Login, ban and `/link`
  pages run no script at all. Docker's nginx sends the same policy.
- An address that keeps failing agent authentication gets `429` for a
  minute. The last accepted request time per node survives a hub restart,
```

In `docs/threat-model.md`:

1. Replace

```markdown
| release pipeline | supply chain | malicious package | GPG signing key only in CI secrets; signed `SHA256SUMS`; GitHub Actions pinned by commit; zero dependencies |
| user privacy (hosted) | operator, breach | exposure of infrastructure details | latest snapshot plus capped history only; no analytics; IPs kept 30 days; inactive accounts deleted |

## Known and accepted risks
```

   with

```markdown
| release pipeline | supply chain | malicious package | GPG signing key only in CI secrets; signed `SHA256SUMS`; GitHub Actions pinned by commit; zero dependencies |
| user privacy (hosted) | operator, breach | exposure of infrastructure details | latest snapshot plus capped history only; no analytics; IPs kept 30 days; inactive accounts deleted |

## Browser hardening

The dashboard is served with a strict Content-Security-Policy: scripts,
styles, fonts and images only from the hub (plus `data:` images for the
favicon), network requests only to the hub and the weather service, no inline
script or style, no framing, no `<base>`, forms only to the hub. Anything a
server reports reaches the page as text; even a markup injection could not run
script or load anything from elsewhere. The login, ban and `/link` pages run no
script at all (`default-src 'none'`).

## Known and accepted risks
```

- [ ] **Step 3: The policy in a real browser**

Run: `bash test/screens.sh`
Expected: `screenshots in /out: no page errors` (every style and mode, the settings panel loaded lazily at 1280 and 390 px, kiosk, the customized fleet). Look at `build/screens/1280-comfortable-node.png`: meters, disk bars, per-core bars, network history bars and service CPU bars have their sizes.

To see that it catches a violation: in `www/js/app.js` change `<i data-w="${pct.toFixed(1)}"></i>` back to `<i style="width:${pct.toFixed(1)}%"></i>`, run `bash test/screens.sh; echo $?`, expect `console: Refused to apply inline style because it violates the following Content Security Policy directive: "style-src 'self'"` and `1`, and undo the change.

- [ ] **Step 4: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                          # Expected: all pass (269)
pipx run --spec shellcheck-py shellcheck -S warning packaging/install-local.sh
pipx run --spec shellcheck-py shellcheck -S error test/budget.sh
bash test/budget.sh                                 # Expected: every line ok; first page load about 26.5 KB
bash test/compose-smoke.sh                          # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh    # Expected: both series, no lintian E:/W:
dpkg-deb -c build/deb/noble/servitals_*_all.deb | grep -cE 'www/(app\.css|boot\.js|js/app\.js|js/settings\.js)'   # Expected: 4
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh  # Expected: smoke PASS, purge PASS on both series
```

- [ ] **Step 5: Commit**

```bash
git add test/budget.sh CHANGELOG.md docs/threat-model.md
git commit -m "docs: the dashboard's Content-Security-Policy; the budget counts every file of the first load"
```
