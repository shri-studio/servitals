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
const { startHub, request, login, cookieFrom } = require("./helpers/hub");
const { MARKUP, JS } = require("./helpers/page");

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
