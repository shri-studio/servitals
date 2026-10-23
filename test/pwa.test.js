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
function worker(fetchFn = async () => { throw new Error("offline"); }) {
  const listeners = {};
  const cached = new Map();
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting: () => {}, clients: { claim: () => {} },
                 location: { origin: "https://hub.example" } };
  const caches = {
    open: async () => ({ addAll: async (list) => list.forEach((u) => cached.set(u, "shell")), put: async (r, res) => cached.set(typeof r === "string" ? r : new URL(r.url).pathname, res) }),
    match: async (r) => cached.get(typeof r === "string" ? r : new URL(r.url).pathname),
    keys: async () => ["servitals-old", "servitals-" + fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim()],
    delete: async (k) => cached.set("deleted:" + k, true),
  };
  const src = fs.readFileSync(path.join(WWW, "sw.js"), "utf8");
  const exports = new Function("self", "caches", "fetch", `${src}; return { route, SHELL };`)(self, caches, fetchFn);
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

// one fetch through the worker: what the page gets back, and what the cache holds after
async function through(w, p, mode = "cors") {
  let answer;
  w.listeners.fetch({ request: { url: "https://hub.example" + p, method: "GET", mode }, respondWith: (x) => { answer = x; }, waitUntil: () => {} });
  const res = await answer;
  await new Promise((ok) => setImmediate(ok));
  return res;
}
const answer = (status, type, extra = {}) => ({ ok: status >= 200 && status < 300, status, type: "basic",
  headers: new Headers({ "content-type": type, ...extra }), clone() { return this; } });
async function installed(fetchFn) {
  const w = worker(fetchFn);
  let done;
  w.listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
  return w;
}

test("service worker: a proxy's 5xx while the hub is down gets the last copy, as when offline", async () => {
  const w = await installed(async () => answer(502, "text/html"));
  assert.strictEqual(await through(w, "/", "navigate"), "shell", "the page");
  assert.strictEqual(await through(w, "/js/app.js"), "shell", "a file of the page");
  assert.strictEqual((await through(w, "/styles/gruvbox.css")).status, 502, "nothing cached: the answer as it came");
});

test("service worker: offline, only a page load falls back to the page; a missing file stays missing", async () => {
  const w = await installed();
  assert.strictEqual(await through(w, "/?kiosk", "navigate"), "shell");
  assert.strictEqual((await through(w, "/styles/gruvbox.css")).type, "error");
});

test("service worker: the login page and no-store answers are never kept as the shell", async () => {
  const login = answer(200, "text/html", { "cache-control": "no-store" });
  let w = await installed(async () => login);
  await through(w, "/", "navigate");
  assert.strictEqual(w.cached.get("/"), "shell", "a no-store page is not kept");
  w = await installed(async () => answer(200, "text/html"));
  await through(w, "/js/settings.js");
  await through(w, "/styles/nord.css");
  assert.strictEqual(w.cached.get("/js/settings.js"), "shell", "HTML is never kept for a script");
  assert.ok(!w.cached.has("/styles/nord.css"), "nor for a style");
  const js = answer(200, "text/javascript; charset=utf-8");
  w = await installed(async () => js);
  await through(w, "/js/settings.js");
  assert.strictEqual(w.cached.get("/js/settings.js"), js, "a real script is kept");
});

test("the login, blocked and link pages are sent with no-store", async () => {
  const hub = await startHub({ UPSTREAM: "" });
  try {
    for (const p of ["/", "/js/settings.js", "/__auth/login"]) {
      const r = await request(hub.port, { path: p });
      assert.match(r.headers["content-type"], /text\/html/, p);
      assert.strictEqual(r.headers["cache-control"], "no-store", p);
    }
  } finally { await hub.stop(); }
});

// several page functions sharing one scope, with hubState as the page keeps it
function pageScope(names, stubs) {
  const src = names.map((n) => {
    let i = JS.indexOf(`function ${n}(`);
    if (JS.slice(i - 6, i) === "async ") i -= 6;
    let depth = 0, j = JS.indexOf("{", i);
    for (let k = j; k < JS.length; k++) {
      if (JS[k] === "{") depth++;
      if (JS[k] === "}" && --depth === 0) { j = k + 1; break; }
    }
    return JS.slice(i, j);
  }).join("\n");
  stubs = { tr: require("../hub/lib/i18n").tr, ...stubs };
  return new Function(...Object.keys(stubs), `let hubState = "ok"; ${src}; return { ${names.join(", ")}, state: () => hubState };`)(...Object.values(stubs));
}

test("the node view says when the hub cannot be reached or the session ended, not that the agent is down", async () => {
  const run = async (fetchFn, onLine = true) => {
    const el = {};
    const $ = (sel) => (el[sel] = el[sel] || { textContent: "", classList: { add() {}, remove() {} } });
    const s = pageScope(["hubStateOf", "hubText", "tick", "setStatus"], {
      $, fetch: fetchFn, navigator: { onLine }, view: "node", currentNode: null, lastData: null, cfg: {},
      renderMetrics() {}, loadNodes() {}, renderFleet() {}, fmtTime: () => "12:00", fmtDur: () => "1m",
      nodesAt: Date.now(), loadAlertsIfOpen() {},
    });
    await s.tick();
    return [s.state(), el["#lastupdate"].textContent];
  };
  const [st1, t1] = await run(async () => { throw new TypeError("Failed to fetch"); }, false);
  assert.strictEqual(st1, "down");
  assert.match(t1, /^hub unreachable \(this device is offline\)/);
  const html = (status) => async () => ({ ok: status === 200, status, headers: new Headers({ "content-type": "text/html" }),
                                          json: async () => { throw new SyntaxError("Unexpected token <"); } });
  const [st2, t2] = await run(html(200));
  assert.strictEqual(st2, "login");
  assert.match(t2, /^logged out/);
  const [st3, t3] = await run(html(502));
  assert.strictEqual(st3, "down");
  assert.match(t3, /^hub unreachable/);
  const [st4, t4] = await run(async () => ({ ok: false, status: 503, headers: new Headers({ "content-type": "application/json" }),
                                             json: async () => ({ error: "no snapshot" }) }));
  assert.strictEqual(st4, "ok", "the hub answered: the agent is the one missing");
  assert.match(t4, /^agent unreachable/);
});

test("the node view asks for the fleet (lamps, badges) at most every 30 s, and refreshes an open alerts view", async () => {
  const run = async (nodesAt) => {
    const calls = [];
    const $ = () => ({ textContent: "", classList: { add() {}, remove() {} } });
    const s = pageScope(["hubStateOf", "hubText", "tick", "setStatus"], {
      $, fetch: async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ts: Date.now() }) }),
      navigator: { onLine: true }, view: "node", currentNode: null, lastData: null, cfg: {}, showHistory() {},
      renderMetrics() {}, loadNodes() { calls.push("nodes"); }, renderFleet() {}, fmtTime: () => "12:00", fmtDur: () => "1m",
      nodesAt, loadAlertsIfOpen() { calls.push("alerts"); },
    });
    await s.tick();
    return calls;
  };
  assert.deepStrictEqual(await run(Date.now() - 31000), ["nodes", "alerts"]);
  assert.deepStrictEqual(await run(Date.now() - 5000), ["alerts"]);
});

// Web Push (spec 8.5) in the service worker: what a push shows, where a tap goes
function pushWorker(windows = []) {
  const listeners = {}, shown = [], opened = [], navigated = [];
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: "https://hub.example" },
    registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); } },
    clients: { claim: () => {}, openWindow: async (u) => { opened.push(u); },
      matchAll: async () => windows.map((w) => ({ url: w, focus: async () => {}, navigate: async (u) => { navigated.push(u); } })) } };
  new Function("self", "caches", "fetch", fs.readFileSync(path.join(WWW, "sw.js"), "utf8"))(self, {}, async () => {});
  return { listeners, shown, opened, navigated };
}
const pushEvent = (body) => { let p; return { e: { data: { json: () => JSON.parse(body), text: () => body }, waitUntil: (x) => { p = x; } }, done: () => p }; };

test("a push shows its alert, one per alert, and a tap opens its node's view; nothing else can choose where", async () => {
  const w = pushWorker();
  const ev = pushEvent(JSON.stringify({ title: "warning: disk full /srv on nas", body: "value 92%", tag: "disk_full|nodeaaaaaaaa|/srv", url: "/#node=nodeaaaaaaaa" }));
  w.listeners.push(ev.e);
  await ev.done();
  assert.deepStrictEqual(w.shown, [{ title: "warning: disk full /srv on nas", body: "value 92%", tag: "disk_full|nodeaaaaaaaa|/srv", renotify: true,
    data: { url: "/#node=nodeaaaaaaaa" }, icon: "/icons/icon-192.png" }]);
  const evil = pushEvent(JSON.stringify({ title: "x", url: "https://evil.example/" }));
  w.listeners.push(evil.e);
  await evil.done();
  assert.strictEqual(w.shown[1].data.url, "/", "only this hub's own views");
  const odd = pushEvent("not json");
  w.listeners.push(odd.e);
  await odd.done();
  assert.strictEqual(w.shown[2].title, "not json");
  let closed = false, p;
  w.listeners.notificationclick({ notification: { close: () => { closed = true; }, data: { url: "/#node=nodeaaaaaaaa" } }, waitUntil: (x) => { p = x; } });
  await p;
  assert.deepStrictEqual([closed, w.opened], [true, ["/#node=nodeaaaaaaaa"]], "no window open: open one");
  const open = pushWorker(["https://hub.example/#fleet"]);
  open.listeners.notificationclick({ notification: { close() {}, data: { url: "/#node=nodeaaaaaaaa" } }, waitUntil: (x) => { p = x; } });
  await p;
  assert.deepStrictEqual([open.navigated, open.opened], [["/#node=nodeaaaaaaaa"], []], "a window open: it goes there");
});

test("settings: notifications need HTTPS (with the guide), a browser that can, permission; enabling subscribes with the hub's key", async () => {
  const el = {};
  const $ = (s) => (el[s] = el[s] || { textContent: "", classList: { hidden: true, add() { this.hidden = true; }, toggle(c, v) { this.hidden = v; } } });
  const sent = [], toasts = [];
  let sub = null;
  const key = require("node:crypto").createECDH("prime256v1");
  key.generateKeys();
  const reg = { pushManager: { getSubscription: async () => sub,
    subscribe: async (o) => { sub = { endpoint: "https://push.example/1", o, toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }), unsubscribe: async () => { sub = null; } }; return sub; } } };
  const env = (o) => pageScope(["pushSupport", "deviceLabel", "pushSub", "drawPush", "enablePush", "disablePush", "endpointId", "alertWhenOr"], {
    $, toast: (m, err) => toasts.push([m, !!err]), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    b64uBytes: (s) => Uint8Array.from(Buffer.from(s, "base64url")),
    // the hub lists a device once it subscribed, until it unsubscribes
    fetch: async (url, opt) => { if (opt) sent.push([url, JSON.parse(opt.body)]);
      const listed = sent.length && sent[sent.length - 1][0].endsWith("/subscribe");
      return { ok: true, json: async () => ({ publicKey: key.getPublicKey().toString("base64url"),
        devices: listed ? [{ id: require("node:crypto").createHash("sha256").update("https://push.example/1").digest("hex").slice(0, 12), label: "x", service: "push.example", created: 1 }] : [] }) }; },
    crypto: { subtle: { digest: async (alg, d) => require("node:crypto").createHash("sha256").update(Buffer.from(d)).digest() } }, TextEncoder, esc: (x) => String(x), alertWhen: () => "",
    setTimeout, ...o });
  const http = env({ window: { isSecureContext: false }, navigator: {}, Notification: undefined });
  await http.drawPush();
  assert.match(el["#push-msg"].textContent, /^Notifications need servitals over HTTPS/);
  assert.strictEqual(el["#push-guide"].classList.hidden, false, "with a link to the HTTPS guide");
  const nav = { serviceWorker: { ready: Promise.resolve(reg) }, userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36" };
  const ok = env({ window: { isSecureContext: true, PushManager: function () {} }, navigator: nav, Notification: { permission: "default", requestPermission: async () => "granted" } });
  ok.PushManager = true;
  await ok.drawPush();
  assert.strictEqual(el["#push-msg"].textContent, "Off for this device.");
  assert.strictEqual(el["#push-on"].classList.hidden, false);
  await ok.enablePush();
  assert.deepStrictEqual(sent[0], ["/__ctl/push/subscribe", { subscription: { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }, label: "Android Chrome" }]);
  assert.deepStrictEqual(Buffer.from(sub.o.applicationServerKey), key.getPublicKey(), "subscribed with the hub's public key");
  assert.strictEqual(sub.o.userVisibleOnly, true);
  assert.strictEqual(el["#push-msg"].textContent, "On for this device. The channels tab sets which alerts it gets.");
  await ok.disablePush();
  assert.deepStrictEqual([sent[1], sub], [["/__ctl/push/unsubscribe", { endpoint: "https://push.example/1" }], null]);
  const no = env({ window: { isSecureContext: true, PushManager: function () {} }, navigator: nav, Notification: { permission: "default", requestPermission: async () => "denied" } });
  await no.enablePush();
  assert.match(el["#push-msg"].textContent, /blocked for this site/);
  assert.strictEqual(sent.length, 2, "nothing subscribed");
});

test("the hub's key in base64url becomes the bytes the browser wants", () => {
  const line = /^const b64uBytes = .*$/m.exec(JS)[0];
  const b64uBytes = new Function("atob", `${line}; return b64uBytes;`)((s) => Buffer.from(s, "base64").toString("binary"));
  const raw = require("node:crypto").randomBytes(65);
  assert.deepStrictEqual(Buffer.from(b64uBytes(raw.toString("base64url"))), raw);
});

test("settings: a subscription the hub does not know shows as off; the hub's devices are listed with a remove; a missing worker is not a hang", async () => {
  const el = {};
  const $ = (s) => (el[s] = el[s] || { textContent: "", innerHTML: "", classList: { hidden: true, add() { this.hidden = true; }, toggle(c, v) { this.hidden = v; } } });
  const sent = [];
  let devices = [];
  const sub = { endpoint: "https://push.example/mine", unsubscribe: async () => {} };
  const reg = { pushManager: { getSubscription: async () => sub } };
  const subtle = { digest: async (alg, data) => require("node:crypto").createHash("sha256").update(Buffer.from(data)).digest() };
  const mine = require("node:crypto").createHash("sha256").update(sub.endpoint).digest("hex").slice(0, 12);
  const env = (nav) => pageScope(["pushSupport", "pushSub", "drawPush", "removeDevice", "endpointId", "alertWhenOr"], {
    $, toast() {}, esc: (x) => String(x), alertWhen: () => "Oct 11", crypto: { subtle }, TextEncoder,
    fetch: async (url, opt) => { if (opt) { sent.push([url, JSON.parse(opt.body)]); devices = []; } return { ok: true, json: async () => ({ publicKey: "k", devices }) }; },
    window: { isSecureContext: true, PushManager: function () {} }, navigator: nav, Notification: { permission: "granted" }, setTimeout });
  const s = env({ serviceWorker: { ready: Promise.resolve(reg) } });
  await s.drawPush();
  assert.strictEqual(el["#push-msg"].textContent, "Off for this device.", "the browser has one, the hub does not: off, so enable renews it");
  devices = [{ id: mine, label: "Android Chrome", service: "fcm.googleapis.com", created: 1 }, { id: "aaaaaaaaaaaa", label: "old <laptop>", service: "updates.push.services.mozilla.com", created: 1 }];
  await s.drawPush();
  assert.strictEqual(el["#push-msg"].textContent, "On for this device. The channels tab sets which alerts it gets.");
  assert.match(el["#push-devices"].innerHTML, /Android Chrome · fcm\.googleapis\.com · Oct 11 \(this device\)/);
  assert.match(el["#push-devices"].innerHTML, /<button data-device="aaaaaaaaaaaa">remove<\/button>/);
  await s.removeDevice("aaaaaaaaaaaa");
  assert.deepStrictEqual(sent[0], ["/__ctl/push/unsubscribe", { endpoint: "aaaaaaaaaaaa" }]);
  const stuck = env({ serviceWorker: { ready: new Promise(() => {}) } });
  const t0 = Date.now();
  await stuck.drawPush();
  assert.strictEqual(el["#push-msg"].textContent, "This browser cannot get notifications. On iPhone and iPad, add servitals to the home screen first (iOS 16.4 or later).");
  assert.ok(Date.now() - t0 < 7000);
});

test("a tap on a window this worker does not control still opens the view", async () => {
  const listeners = {}, opened = [];
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: "https://hub.example" },
    clients: { claim() {}, openWindow: async (u) => { opened.push(u); },
      matchAll: async () => [{ url: "https://hub.example/", focus: async () => {}, navigate: async () => { throw new TypeError("not controlled"); } }] } };
  new Function("self", "caches", "fetch", fs.readFileSync(path.join(WWW, "sw.js"), "utf8"))(self, {}, async () => {});
  let p;
  listeners.notificationclick({ notification: { close() {}, data: { url: "/#node=nodeaaaaaaaa" } }, waitUntil: (x) => { p = x; } });
  await p;
  assert.deepStrictEqual(opened, ["/#node=nodeaaaaaaaa"]);
});

test("no snapshot ever seen: the status line gives no 1970 time", async () => {
  const el = {};
  const $ = (sel) => (el[sel] = el[sel] || { textContent: "", classList: { add() {}, remove() {} } });
  const s = pageScope(["hubStateOf", "hubText", "setStatus"], { $, navigator: { onLine: true }, lastData: null, cfg: {}, fmtTime: () => "01:00", fmtDur: () => "1m" });
  s.setStatus(0, true);
  assert.strictEqual(el["#lastupdate"].textContent, "agent unreachable");
  s.setStatus(Date.now(), false);
  assert.strictEqual(el["#lastupdate"].textContent, "online · 01:00");
});

test("a page load the network never answers gets the cached page after a few seconds, not a white screen", async () => {
  const listeners = {}, cached = new Map([["/", "shell page"]]);
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} }, location: { origin: "https://hub.example" } };
  const caches = { open: async () => ({ put: async () => {} }), match: async (r) => cached.get(typeof r === "string" ? r : new URL(r.url).pathname) };
  const fast = (f, ms) => setTimeout(f, Math.min(ms, 20));   // the worker's timeout, quicker
  new Function("self", "caches", "fetch", "setTimeout", fs.readFileSync(path.join(WWW, "sw.js"), "utf8"))(self, caches, () => new Promise(() => {}), fast);
  let answer;
  listeners.fetch({ request: { url: "https://hub.example/", method: "GET", mode: "navigate" }, respondWith: (x) => { answer = x; }, waitUntil() {} });
  const late = new Promise((r) => { const t = setTimeout(() => r("still waiting"), 2000); t.unref(); });
  assert.strictEqual(await Promise.race([answer, late]), "shell page");
});

test("the fleet comes back when the hub does, after the app started offline", async () => {
  const calls = [];
  const s = pageScope(["loadNodes"], {
    fetch: async () => ({ ok: true, json: async () => [{ id: "nodeaaaaaaaa", local: true }, { id: "nodebbbbbbbb" }] }),
    fleetNodes: [], localNode: null, nodesAt: 0, location: { hash: "" },
    renderTabs() {}, renderAlertCount() {}, route() { calls.push("route"); } });
  await s.loadNodes();
  assert.deepStrictEqual(calls, ["route"], "two servers where there were none: the fleet view");
});
