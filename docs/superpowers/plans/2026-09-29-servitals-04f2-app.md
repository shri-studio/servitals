# servitals Installable App (sub-project 4f-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install servitals on a phone or desktop (spec 10.3): a web app manifest, icons, and a service worker that keeps an offline copy of the page, which then says plainly that the hub cannot be reached.

**Architecture:** `packaging/make-icons.py` draws the favicon's four bars into three PNGs with the Python standard library (no image tools on the build host). `www/manifest.webmanifest` names them; the hub serves the manifest and the icons without login (browsers fetch them without cookies; nothing in them is private), by exact path. `www/sw.js` caches the shell for this version, answers the shell network first with the cache as fallback, never touches data or API answers, and drops older caches. The page registers it in a secure context only (HTTPS, or the machine itself), empties the caches on logout, and its fleet status line says "hub unreachable" or "logged out" when the node list does not come.

**Tech Stack:** vanilla JS (service worker, page), Python 3 standard library (icons), Node.js ≥ 18 (hub, tests), Playwright (the worker and the offline shell in a real browser).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 10.3 (installable phone app: `manifest.json`, `sw.js` for push and an offline shell; needs HTTPS, section 8.5), 10.5 (the policy from 4f-1 already allows `'self'` manifests and workers).

**Scope:** Web Push in the worker arrives with the alerts of sub-project 6. 4f-3 (the i18n dictionary) follows.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (f958990) on 2026-09-29: node suite 279 tests, the budget, and `test/screens.sh` (the worker activates, and with the network off the page opens from its copy and says the hub is unreachable).

## Global Constraints

- Everything from sub-projects 1-4f-1 still holds: zero runtime dependencies, the strict CSP (no inline script or style; the manifest and worker are `'self'`), Node 18 compatibility, SPDX headers, lintian clean, the lightness budget (the worker and the icons are not part of the first page load).
- The worker never caches or answers data, settings or API requests (`/data.json`, `/config.json`, `/link`, `/__…`, `/api/…`), never anything but same-origin `GET`, and always tries the network first: an upgrade shows at once when the hub can be reached.
- The cache name is `servitals-<VERSION>`; `www/sw.js`'s `const VERSION` equals the `VERSION` file (a test checks; the release steps say to bump both).
- Only the manifest and the three icons are public, by exact path; everything else keeps needing the login.
- Registration only when `window.isSecureContext` (browsers refuse it elsewhere; a LAN hub over plain HTTP simply does without).
- Work in a worktree `.claude/worktrees/servitals-app` on branch `feat/app` from `main` (f958990).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **A cached answer where a live one is needed** (data, settings saves, the login redirect, `/link`, API calls, another origin such as the weather service): the worker must stay out of the way. Test: Task 2 "service worker: data and API answers never go through the cache…".
2. **A stale page after an upgrade** (the worker keeps an old shell): network first, the versioned cache name, old caches dropped on activate. Tests: Task 2 "install keeps the shell for this version; activate drops older versions", "the worker's cache name follows the VERSION file".
3. **Public files beyond the manifest and icons** (path tricks like `/icons/../index.html`, a directory, a similar name): the login must still be required. Test: Task 1 "the manifest and icons are public…; nothing else is".
4. **Offline without saying so** (an empty fleet that looks healthy): the status line must say the hub is unreachable, or that the session ended. Test: Task 2's offline check in `test/screens.sh` (the page opens from the worker's copy with the network off and says "unreachable").
5. **What a shared device keeps after logout**: the page copy is removed on logout. Test: Task 2 "the page registers the worker only in a secure context…, and logging out empties its cache".

---

### Task 1: Icons, the manifest, and the files the hub serves without login

**Files:**
- Create: `packaging/make-icons.py`, `www/manifest.webmanifest`, `test/pwa.test.js`; the script creates `www/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`
- Modify: `www/index.html`, `hub/server.js`

**Interfaces:**
- Produces: `PUBLIC_FILES` in `hub/server.js` (exactly `/manifest.webmanifest`, `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png`; `GET` only; served by the static server, or the upstream in Docker mode); the page's `<link rel="manifest">`, `<meta name="theme-color">`, `<link rel="apple-touch-icon">`. Task 2's worker caches the manifest and the 192 px icon.

- [ ] **Step 1: Write the failing tests**

Create `test/pwa.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The installable app (spec 10.3): a manifest, icons, and a service worker that
 * keeps an offline shell. Data and API answers are never cached.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { startHub, request } = require("./helpers/hub");
const { MARKUP } = require("./helpers/page");

const WWW = path.join(__dirname, "..", "www");
const pngSize = (f) => { const b = fs.readFileSync(f); assert.strictEqual(b.subarray(1, 4).toString(), "PNG", f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("the manifest describes an installable app, and every icon it names exists at its size", () => {
  const m = JSON.parse(fs.readFileSync(path.join(WWW, "manifest.webmanifest"), "utf8"));
  assert.deepStrictEqual([m.name, m.short_name, m.start_url, m.scope, m.display], ["servitals", "servitals", "/", "/", "standalone"]);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/);
  const purposes = new Set(m.icons.map((i) => i.purpose || "any"));
  assert.ok(purposes.has("any") && purposes.has("maskable"));
  for (const i of m.icons) {
    const [w, h] = pngSize(path.join(WWW, i.src));
    assert.strictEqual(i.sizes, `${w}x${h}`, i.src);
    assert.strictEqual(i.type, "image/png");
  }
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512"));
  assert.match(MARKUP, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(MARKUP, /<meta name="theme-color" content="#[0-9a-f]{6}">/);
  assert.match(MARKUP, /<link rel="apple-touch-icon" href="icons\/icon-192\.png">/);
});

test("the manifest and icons are public (browsers fetch them without cookies); nothing else is", async () => {
  const hub = await startHub({ UPSTREAM: "" });
  try {
    for (const [p, type] of [["/manifest.webmanifest", "application/manifest+json"], ["/icons/icon-192.png", "image/png"],
                             ["/icons/icon-maskable-512.png", "image/png"]]) {
      const r = await request(hub.port, { path: p });
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.headers["content-type"], type, p);
    }
    for (const p of ["/", "/js/app.js", "/sw.js", "/icons/", "/icons/../index.html", "/manifest.webmanifest.bak"]) {
      const r = await request(hub.port, { path: p });
      assert.match(r.body, /authentication required|not found|Not Found/i, p);
      assert.ok(!/application\/manifest|image\/png|javascript/.test(r.headers["content-type"] || ""), p);
    }
  } finally { await hub.stop(); }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/pwa.test.js`
Expected: FAIL, 2 tests: `ENOENT … www/manifest.webmanifest`, and `/manifest.webmanifest` answers with the login page.

- [ ] **Step 3: The icons**

Create `packaging/make-icons.py`:

```python
#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# The app icons (sub-project 4f-2), drawn from the favicon's four bars with the
# Python standard library only: www/icons/icon-192.png, icon-512.png and
# icon-maskable-512.png (content inside the 80 % safe zone). Run from the repo root.
import struct
import zlib

BG = (0x0b, 0x0e, 0x13)
BAR = (0x6b, 0xd8, 0x8a)
# the favicon on its 16 x 16 grid: (x, y, width, height)
BARS = [(2, 9, 2, 5), (5, 6, 2, 8), (8, 3, 2, 11), (11, 7, 2, 7)]


def png(path, size, inset):
    """inset: the share of each side left empty around the 16-unit drawing"""
    pad = size * inset
    unit = (size - 2 * pad) / 16
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")   # filter type 0 for every row
        for x in range(size):
            gx, gy = (x + 0.5 - pad) / unit, (y + 0.5 - pad) / unit
            on = any(bx <= gx < bx + bw and by <= gy < by + bh for bx, by, bw, bh in BARS)
            row += bytes(BAR if on else BG)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", raw))
        f.write(chunk(b"IEND", b""))


png("www/icons/icon-192.png", 192, 0.06)
png("www/icons/icon-512.png", 512, 0.06)
png("www/icons/icon-maskable-512.png", 512, 0.18)   # the bars stay inside the maskable safe zone
print("icons: www/icons/icon-192.png, icon-512.png, icon-maskable-512.png")
```

Run: `mkdir -p www/icons && python3 packaging/make-icons.py`
Expected: `icons: www/icons/icon-192.png, icon-512.png, icon-maskable-512.png` (about 0.6, 2.8 and 2.3 KB). Look at `www/icons/icon-maskable-512.png`: four green bars in the middle of a dark square.

- [ ] **Step 4: The manifest**

Create `www/manifest.webmanifest`:

```json
{
  "name": "servitals",
  "short_name": "servitals",
  "description": "Your servers at a glance",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0b0e13",
  "theme_color": "#0b0e13",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

In `www/index.html`:

1. Replace

```html
<title>servitals</title>
<link rel="icon" id="favicon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3Crect x='2' y='9' width='2' height='5' fill='%236bd88a'/%3E%3Crect x='5' y='6' width='2' height='8' fill='%236bd88a'/%3E%3Crect x='8' y='3' width='2' height='11' fill='%236bd88a'/%3E%3Crect x='11' y='7' width='2' height='7' fill='%236bd88a'/%3E%3C/svg%3E">
<script src="boot.js"></script>
<link rel="stylesheet" href="app.css">
```

   with

```html
<title>servitals</title>
<link rel="icon" id="favicon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3Crect x='2' y='9' width='2' height='5' fill='%236bd88a'/%3E%3Crect x='5' y='6' width='2' height='8' fill='%236bd88a'/%3E%3Crect x='8' y='3' width='2' height='11' fill='%236bd88a'/%3E%3Crect x='11' y='7' width='2' height='7' fill='%236bd88a'/%3E%3C/svg%3E">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#0b0e13">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<script src="boot.js"></script>
<link rel="stylesheet" href="app.css">
```

- [ ] **Step 5: The hub serves them without login**

In `hub/server.js`:

1. Replace

```js
}

/* ---------- proxy ---------- */
function proxy(req, res) {
```

   with

```js
}

const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]);

/* ---------- proxy ---------- */
function proxy(req, res) {
```

2. Replace

```js
  const authed = validCookie(getCookie(req, "sv_session"));
  const pathname = (req.url || "/").split("?")[0];

  // a person approves a linking server here (spec 6.1.1)
```

   with

```js
  const authed = validCookie(getCookie(req, "sv_session"));
  const pathname = (req.url || "/").split("?")[0];

  // the app manifest and its icons: browsers fetch them without cookies (spec 10.3), and
  // nothing in them is private. Exact paths only.
  if (req.method === "GET" && PUBLIC_FILES.has(pathname)) return UP ? proxy(req, res) : serveStatic(req, res);

  // a person approves a linking server here (spec 6.1.1)
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (2 new tests).

- [ ] **Step 7: Commit**

```bash
git add packaging/make-icons.py www/icons www/manifest.webmanifest www/index.html hub/server.js test/pwa.test.js
git commit -m "feat(ui): a web app manifest and icons; the hub serves them without login" -m "packaging/make-icons.py draws the favicon's bars into 192, 512 and maskable 512 px PNGs with the Python standard library. Browsers fetch the manifest and icons without cookies, so exactly those four paths are public; nothing in them is private."
```

---

### Task 2: The service worker and an honest offline page

**Files:**
- Create: `www/sw.js`
- Modify: `www/js/app.js`, `test/pwa.test.js`, `test/screens/shoot.js`

**Interfaces:**
- Consumes: the manifest and icons (Task 1).
- Produces: `www/sw.js` with `VERSION`, `CACHE = "servitals-" + VERSION`, `SHELL` (the page's files, the manifest and the 192 px icon), `route(request) → "shell" | "network"`, install / activate / fetch listeners; in `js/app.js`: registration when `window.isSecureContext`, a logout `submit` listener that deletes every cache, `hubState` (`"ok"`, `"down"`, `"login"`) set by `loadNodes()` and shown by `fleetStatus()`.

- [ ] **Step 1: Write the failing tests**

In `test/pwa.test.js`:

1. Replace

```js
const fs = require("node:fs");
const path = require("node:path");
const { startHub, request } = require("./helpers/hub");
const { MARKUP } = require("./helpers/page");

const WWW = path.join(__dirname, "..", "www");
```

   with

```js
const fs = require("node:fs");
const path = require("node:path");
const { startHub, request, login, cookieFrom } = require("./helpers/hub");
const { MARKUP, JS } = require("./helpers/page");

const WWW = path.join(__dirname, "..", "www");
```

2. Replace

```js
      assert.ok(!/application\/manifest|image\/png|javascript/.test(r.headers["content-type"] || ""), p);
    }
  } finally { await hub.stop(); }
});

```

   with

```js
      assert.ok(!/application\/manifest|image\/png|javascript/.test(r.headers["content-type"] || ""), p);
    }
    const cookie = cookieFrom(await login(hub.port));
    assert.strictEqual((await request(hub.port, { path: "/sw.js", headers: { cookie } })).headers["content-type"], "text/javascript; charset=utf-8");
  } finally { await hub.stop(); }
});

// the service worker's code, run with a fake worker scope
function worker() {
  const listeners = {};
  const cached = new Map();
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting: () => {}, clients: { claim: () => {} },
                 location: { origin: "https://hub.example" } };
  const caches = {
    open: async () => ({ addAll: async (list) => list.forEach((u) => cached.set(u, "shell")), put: async (r, res) => cached.set(r.url || r, res) }),
    match: async (r) => cached.get(typeof r === "string" ? r : new URL(r.url).pathname),
    keys: async () => ["servitals-old", "servitals-" + fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim()],
    delete: async (k) => cached.set("deleted:" + k, true),
  };
  const src = fs.readFileSync(path.join(WWW, "sw.js"), "utf8");
  const exports = new Function("self", "caches", "fetch", `${src}; return { route, SHELL };`)(self, caches, async () => { throw new Error("offline"); });
  return { ...exports, listeners, cached };
}

test("service worker: data and API answers never go through the cache; the shell does, network first", () => {
  const { route } = worker();
  const req = (p, method = "GET", mode = "cors") => ({ url: "https://hub.example" + p, method, mode });
  for (const p of ["/data.json", "/config.json", "/__ctl/nodes", "/__ctl/node/abcdefghijkm", "/api/v1/agent/push", "/__auth/logout", "/link"]) {
    assert.strictEqual(route(req(p)), "network", p);
  }
  assert.strictEqual(route(req("/", "POST", "navigate")), "network", "never a POST");
  assert.strictEqual(route({ url: "https://api.open-meteo.com/v1/forecast", method: "GET", mode: "cors" }), "network", "another origin");
  for (const p of ["/", "/app.css", "/boot.js", "/js/app.js", "/js/settings.js", "/styles/nord.css", "/fonts/jetbrains-mono-400.woff2"]) {
    assert.strictEqual(route(req(p, "GET", p === "/" ? "navigate" : "cors")), "shell", p);
  }
});

test("service worker: install keeps the shell for this version; activate drops older versions", async () => {
  const w = worker();
  assert.ok(w.SHELL.includes("/") && w.SHELL.includes("/js/app.js") && w.SHELL.includes("/app.css"));
  assert.ok(!w.SHELL.some((p) => /data\.json|config\.json|__ctl|\/api\//.test(p)), "no data in the shell");
  let done;
  w.listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
  assert.strictEqual(w.cached.get("/js/app.js"), "shell");
  w.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(w.cached.get("deleted:servitals-old"));
  assert.ok(![...w.cached.keys()].some((k) => /deleted:servitals-\d/.test(k)), "the current version stays");
});

test("the page registers the worker only in a secure context (HTTPS or this machine), and logging out empties its cache", () => {
  assert.match(JS, /if \("serviceWorker" in navigator && window\.isSecureContext\) navigator\.serviceWorker\.register\("sw\.js"\)/);
  assert.match(JS, /\$\("\.logout-form"\)\.addEventListener\("submit", \(\) => \{ if \(window\.caches\) caches\.keys\(\)\.then/);
});

test("the worker's cache name follows the VERSION file", () => {
  const v = fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  assert.match(fs.readFileSync(path.join(WWW, "sw.js"), "utf8"), new RegExp(`^const VERSION = "${v.replace(/\./g, "\\.")}";`, "m"));
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/pwa.test.js`
Expected: FAIL, 5 tests (`ENOENT … www/sw.js`, no registration in the page, `/sw.js` answers with the login page).

- [ ] **Step 3: The worker**

Create `www/sw.js` (set `VERSION` to the `VERSION` file's content):

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* The installable app's service worker (spec 10.3): an offline shell. The page and its
   files come from the network first, and from the cache only when the hub cannot be
   reached; data, settings and every API answer always come from the network. The
   cache name carries the version, so an upgrade replaces the old shell. */
const VERSION = "0.1.0";   // keep equal to the VERSION file (test/pwa.test.js checks)
const CACHE = "servitals-" + VERSION;
const SHELL = ["/", "/app.css", "/boot.js", "/js/app.js", "/js/settings.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// "shell": network first, the cache when offline; "network": as if there were no worker
function route(request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return "network";
  const p = url.pathname;
  if (p === "/data.json" || p === "/config.json" || p === "/link" || p.startsWith("/__") || p.startsWith("/api/")) return "network";
  return "shell";
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("servitals-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (route(e.request) !== "shell") return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("/"))));
});
```

- [ ] **Step 4: Register it, clear it on logout, say when the hub cannot be reached**

In `www/js/app.js`:

1. Replace

```js
const nodeQuery = () => (currentNode ? "?node=" + encodeURIComponent(currentNode) : "");

async function loadNodes() {
  try {
    const r = await fetch("/__ctl/nodes?t=" + Date.now());
    if (!r.ok) return;
    fleetNodes = await r.json();
  } catch (e) { return; }
  const local = fleetNodes.find(n => n.local);
  localNode = local ? local.id : null;
```

   with

```js
const nodeQuery = () => (currentNode ? "?node=" + encodeURIComponent(currentNode) : "");

// "ok", "down" (no answer: offline, or the hub is gone) or "login" (the session ended)
let hubState = "ok";
async function loadNodes() {
  try {
    const r = await fetch("/__ctl/nodes?t=" + Date.now());
    if (!r.ok) { hubState = r.status === 401 ? "login" : "down"; return; }
    fleetNodes = await r.json();
    hubState = "ok";
  } catch (e) { hubState = "down"; return; }
  const local = fleetNodes.find(n => n.local);
  localNode = local ? local.id : null;
```

2. Replace

```js
  $("#hostname").textContent = cfg.title || "servitals";
  $("#hostmeta").textContent = `${shown.length} nodes · ${online} online`;
  $("#lastupdate").textContent = `fleet · ${fmtTime(new Date())}`;
}
```

   with

```js
  $("#hostname").textContent = cfg.title || "servitals";
  $("#hostmeta").textContent = `${shown.length} nodes · ${online} online`;
  // the installable app opens from its copy when the hub cannot be reached: say so
  if (hubState !== "ok") {
    dot.classList.add("down");
    $("#hostmeta").textContent = hubState === "login" ? "logged out: reload the page to log in"
      : "hub unreachable" + (navigator.onLine === false ? " (this device is offline)" : "")
        + (shown.length ? " · showing the last known servers" : "");
  }
  $("#lastupdate").textContent = `fleet · ${fmtTime(new Date())}`;
}
```

3. Replace

```js
  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
```

   with

```js
  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });

  // the installable app (spec 10.3): browsers allow a service worker over HTTPS (and on this machine)
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  // logging out leaves no copy of the page behind
  $(".logout-form").addEventListener("submit", () => { if (window.caches) caches.keys().then(keys => keys.forEach(k => caches.delete(k))); });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
```

- [ ] **Step 5: The worker and the offline page in a real browser**

In `test/screens/shoot.js`:

1. Replace

```js
  await page.evaluate(() => localStorage.clear());

  const sheet = await ctx.newPage();
  await sheet.setViewportSize({ width: 1600, height: 1000 });
```

   with

```js
  await page.evaluate(() => localStorage.clear());

  // the installable app: the worker takes over, and the page opens from its copy with the network off
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/?shot=sw#fleet`);
  const active = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active));
  if (!active) errors.push("the service worker did not activate");
  const seen = errors.length;
  await ctx.setOffline(true);
  await page.goto(`${base}/?shot=offline#fleet`).catch((e) => errors.push(`offline: ${e.message}`));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/offline.png` });
  const shell = await page.evaluate(() => !!document.querySelector("#fleet") && document.title.length > 0);
  const says = await page.evaluate(() => document.querySelector("#hostmeta").textContent);
  errors.splice(seen);   // offline, the data requests fail by design
  if (!shell) errors.push("offline: the page did not open from the worker's copy");
  if (!/unreachable/.test(says)) errors.push(`offline: the page does not say the hub is unreachable (${says})`);
  await ctx.setOffline(false);

  const sheet = await ctx.newPage();
  await sheet.setViewportSize({ width: 1600, height: 1000 });
```

- [ ] **Step 6: Run the tests and the browser check**

Run: `node --test test/*.test.js && bash test/screens.sh`
Expected: PASS (4 new tests); `screenshots in /out: no page errors`. `build/screens/offline.png` shows the page opened from the worker's copy with a red status dot and "hub unreachable (this device is offline)". (The demo hub runs on `http://127.0.0.1`, a secure context, so the worker registers there.)

- [ ] **Step 7: Commit**

```bash
git add www/sw.js www/js/app.js test/pwa.test.js test/screens/shoot.js
git commit -m "feat(ui): a service worker with an offline shell; the page says when the hub cannot be reached" -m "sw.js keeps this version's shell and answers it network first, the cache only when offline; data, settings and API requests never touch it, and older versions' caches are dropped. The page registers it in a secure context, empties the caches on logout, and its status line says 'hub unreachable' or 'logged out' instead of showing an empty, healthy-looking fleet."
```

---

### Task 3: Packaging, docs, full validation

**Files:**
- Modify: `debian/servitals.install`, `packaging/install-local.sh`, `docs/release.md`, `README.md`, `CHANGELOG.md`, `test/packaging.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/packaging.test.js`:

```js
test("the installable app's files ship (package and install-local)", () => {
  const inst = read("debian/servitals.install");
  assert.match(inst, /^www\/manifest\.webmanifest www\/sw\.js usr\/share\/servitals\/www\/$/m);
  assert.match(inst, /^www\/icons\/\*\.png usr\/share\/servitals\/www\/icons\/$/m);
  assert.match(read("packaging/install-local.sh"), /"\$SRC\/www\/manifest\.webmanifest" "\$SRC\/www\/sw\.js"/);
  assert.match(read("packaging/install-local.sh"), /cp -r "\$SRC\/www\/icons" "\$SHARE\/www\/icons"/);
  assert.match(read("docs/release.md"), /www\/sw\.js/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/packaging.test.js`
Expected: FAIL: the manifest and worker are not in `debian/servitals.install`.

- [ ] **Step 3: Ship the files; the release steps**

In `debian/servitals.install`:

1. Replace

```
www/index.html usr/share/servitals/www/
www/app.css www/boot.js usr/share/servitals/www/
www/js/*.js usr/share/servitals/www/js/
www/config.example.json usr/share/servitals/www/
```

   with

```
www/index.html usr/share/servitals/www/
www/app.css www/boot.js usr/share/servitals/www/
www/manifest.webmanifest www/sw.js usr/share/servitals/www/
www/icons/*.png usr/share/servitals/www/icons/
www/js/*.js usr/share/servitals/www/js/
www/config.example.json usr/share/servitals/www/
```

In `packaging/install-local.sh`:

1. Replace

```bash
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
install -m 644 "$SRC/www/app.css" "$SRC/www/boot.js" "$SHARE/www/"
cp -r "$SRC/www/js" "$SHARE/www/js"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
cp -r "$SRC/www/styles" "$SHARE/www/styles"
chmod -R u=rwX,go=rX "$SHARE/www/fonts" "$SHARE/www/styles" "$SHARE/www/js"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
```

   with

```bash
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
install -m 644 "$SRC/www/app.css" "$SRC/www/boot.js" "$SHARE/www/"
install -m 644 "$SRC/www/manifest.webmanifest" "$SRC/www/sw.js" "$SHARE/www/"
cp -r "$SRC/www/js" "$SHARE/www/js"
cp -r "$SRC/www/icons" "$SHARE/www/icons"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
cp -r "$SRC/www/styles" "$SHARE/www/styles"
chmod -R u=rwX,go=rX "$SHARE/www/fonts" "$SHARE/www/styles" "$SHARE/www/js" "$SHARE/www/icons"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
```

In `docs/release.md`:

1. Replace

```markdown
   entry `servitals (0.2.0-1) resolute; urgency=medium` (`dch -v 0.2.0-1`).
   `test/version.test.js` checks that `VERSION` and `debian/changelog` agree.
2. `packaging/build-deb.sh && packaging/autopkgtest.sh`: both series build,
   lintian is clean, the autopkgtests pass.
```

   with

```markdown
   entry `servitals (0.2.0-1) resolute; urgency=medium` (`dch -v 0.2.0-1`).
   `test/version.test.js` checks that `VERSION` and `debian/changelog` agree.
   Set the same version in `www/sw.js` (`const VERSION`), so installed apps
   replace their offline copy; `test/pwa.test.js` checks it.
2. `packaging/build-deb.sh && packaging/autopkgtest.sh`: both series build,
   lintian is clean, the autopkgtests pass.
```

- [ ] **Step 4: Docs**

In `README.md`:

1. Replace

```markdown
within a few seconds. `/etc/servitals/conf.d/README` has an example and every
allowed value. Docker installs: mount a directory and set `CONFD_DIR`.

## Backups and rotation
```

   with

```markdown
within a few seconds. `/etc/servitals/conf.d/README` has an example and every
allowed value. Docker installs: mount a directory and set `CONFD_DIR`.

## On your phone

Over HTTPS (a tunnel, a reverse proxy with TLS, or Tailscale with a
certificate; browsers allow it on nothing else but the machine itself), open the dashboard in the phone's browser and choose "Install"
or "Add to Home Screen": servitals opens full screen like an app. When the hub
cannot be reached it still opens, from its last copy, and shows that it is
offline. Settings and data always come live from the hub; logging out removes
the copy.

## Backups and rotation
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Backups and rotation (spec 17): `servitals-ctl backup [--encrypt]`,
  `restore [--etc]` (stops and starts the hub, keeps the state it replaces),
```

   with

```markdown

### Added
- Install servitals on a phone or desktop (spec 10.3): a web app manifest,
  icons and a service worker that keeps an offline copy of the page (network
  first; data and API answers are never cached). Over HTTPS (or on the hub
  itself) only; logging out removes the copy.
- Backups and rotation (spec 17): `servitals-ctl backup [--encrypt]`,
  `restore [--etc]` (stops and starts the hub, keeps the state it replaces),
```

- [ ] **Step 5: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                          # Expected: all pass (279)
pipx run --spec shellcheck-py shellcheck -S warning packaging/install-local.sh
bash test/budget.sh                                 # Expected: every line ok
bash test/screens.sh                                # Expected: screenshots in /out: no page errors
bash test/compose-smoke.sh                          # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh    # Expected: both series, no lintian E:/W:
dpkg-deb -c build/deb/noble/servitals_*_all.deb | grep -cE 'www/(manifest\.webmanifest|sw\.js|icons/icon)'   # Expected: 5
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh  # Expected: smoke PASS, purge PASS on both series
```

- [ ] **Step 6: Commit**

```bash
git add debian/servitals.install packaging/install-local.sh docs/release.md README.md CHANGELOG.md test/packaging.test.js
git commit -m "docs: install servitals on a phone; ship the manifest, the worker and the icons"
```
