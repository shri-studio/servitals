# servitals Alert Channels and Outbound Proxy (sub-project 6c-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alerts leave the hub. ntfy and generic webhooks receive every alert at or above their minimum severity; quiet hours hold warnings and send one summary when they end; info events go to one digest a day; failed sends are retried. Every outbound call goes through `HTTPS_PROXY` when `hub.env` sets one.

**Why:** since 6b the hub fires, resolves and shows alerts, but a person only learns of them by opening the page. A channel is what turns a full disk at 3 am into a phone notification at 7 am (or at once, when it is critical).

**Architecture:**
- **`hub/lib/proxy.js` (new):** `createOutbound({env})` → `request(url, {method, headers, body, timeoutMs, maxBytes, ca})`, `proxyFor(url)`, `describe()`.
  - Node's `http`/`https`, not `fetch` (same on Node 18 and 22).
  - `HTTPS_PROXY` for `https://`, `HTTP_PROXY` for `http://`, upper or lower case; only `http://` proxy URLs; `user:password@` as `Proxy-Authorization: Basic`.
  - `https://` through a `CONNECT` tunnel, then TLS to the destination with the usual certificate checks (an `https.Agent` whose `createConnection` hands over the tunnel's TLS socket; `agent: false` would dial again); `http://` as an absolute-form request.
  - `NO_PROXY`: names, suffixes, IPv4 CIDRs, IPv6 addresses, `*`; `localhost`, `127.0.0.1`, `::1` always direct.
  - Errors carry a code: `ETIMEDOUT`, `EPROXY`, `ETOOBIG`, `EURL`, or the socket's. Every socket is closed once the answer is read. `describe()` never shows credentials.
- **`hub/lib/notify.js` (new):** `createNotifier({dir, outbound, now, log, sleep, env})` → `onEvent(e)`, `tick()`, `test(id)`, `setConfig(input)`, `view()`, `flush()`; `checkChannels(input, old)`.
  - `<state>/alerts/channels.json` (mode 0600): `{channels: [{id, type, name, min, on, digest?, config}], quiet: null | {from, to}, digestAt}`.
  - Adapters: **ntfy** (JSON publishing to the server root: topic, title, message, priority 5/4/3, tags; optional bearer token) and **webhook** (JSON POST; with a secret, `X-Servitals-Signature: sha256=<HMAC>`). The webhook URL is a secret (Discord, Slack and Teams URLs carry tokens).
  - Routing: warning and critical go to channels whose `min` they meet; info goes to the digest. Quiet hours (hub local time, the window may wrap midnight) hold warnings; critical goes through. When the window ends, one summary lists, per alert, what still fires and the ends of alerts told before the window; an alert that fired and ended inside it stays in the alert log only. The digest goes out once a day at `digestAt` to every channel that is on, unless `digest: false`.
  - What is held, the digest and the last digest day survive a restart (`notify-state.json`, 0600).
  - A failed send is tried again after 2, 10 and 30 s, then logged `alert.notify_failed {channel, type, error}`: never a URL or a token. Each channel's last success and last error are kept for the page.
  - `view()` masks secrets as `********`; a save that sends `********` back keeps the old value. A config value `$NAME` is read from the environment when sent.
  - Message words come from the dictionary (`notify.*`).
- **`hub/lib/alerts.js`:** events carry the rule's `metric`, so a message shows the value in its unit.
- **`hub/server.js`:** one outbound client (its proxy logged at start as `outbound.proxy`, host only); the notifier gets every alert event and ticks with the minute timer; `GET`/`POST /__ctl/alerts/channels` (audited `alert.channels_saved`) and `POST /__ctl/alerts/channels/test`.
- `packaging/etc/hub.env`, `docs/networking.md`: the hub's proxy settings.

**Tech Stack:** Node.js ≥ 18 built-ins only (`http`, `https`, `net`, `tls`, `crypto`).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- 8.3: routing by minimum severity, quiet hours, the digest at 07:00 local;
- 8.4: channels, the outbound proxy, "send test" and the last error, secrets kept 0600 and never logged, `$NAME` from the environment, three retries then `alert.notify_failed`.

**Scope:** 6c-1. Later: the page's channel settings (6c-2); Gotify, Telegram, Discord, Slack, Teams, Pushover and Matrix adapters (6c-2); email over SMTP and Apprise (6c-3); Web Push (6d); the hosted service's email cap and SSRF guard.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (a81f54d) on 2026-10-09: node suite 424 tests; budget, screens, compose smoke, both packages and autopkgtest pass.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6b still holds.
- No outbound call outside `hub/lib/proxy.js`. Never log a token, a password, a channel URL or proxy credentials.
- An alert channel that fails never breaks a push or the minute timer: errors are logged.
- Work in a worktree `.claude/worktrees/servitals-channels` on branch `feat/channels` from `main` (a81f54d).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **The proxy:** CONNECT refused (407), a proxy that is down, a certificate for another name or nobody's, `NO_PROXY` edge cases (suffix against look-alike names, CIDR, IPv6), credentials with `@` or `:`. Tests: test/outbound.test.js.
2. **Quiet hours across time:** a window over midnight, a restart inside it, an alert that fires and ends inside, an end told before it, quiet hours turned off while something is held. Test: "quiet hours hold warnings…".
3. **Retries and failures:** a channel down for minutes, a slow channel (timeout), a 4xx that will never work, many alerts at once. Test: "a failed send is tried again…".
4. **Secrets:** masked in `view()`, kept across a save, never in logs (including a webhook URL with its token), the file's mode, `$NAME`. Tests: "send test answers at once…", "alert channels: …" (agentapi).
5. **Messages:** a custom rule's name with markup, a value without unit (offline, reboot), the hub's time zone. Test: "an alert goes to each channel…".

---

### Task 1: Outbound calls through a proxy

**Files:**
- Create: `hub/lib/proxy.js`, `test/outbound.test.js`
- Modify: `packaging/etc/hub.env`, `docs/networking.md`

**Interfaces:**
- Produces: `createOutbound({env})` → `{request(url, {method, headers, body, timeoutMs, maxBytes, ca}) → Promise<{status, headers, body}>, proxyFor(url), describe() → {https, http}}`; `noProxy(list, host)`; `parseProxy(url)`. Task 2's channels send through `request`.

- [ ] **Step 1: Write the failing tests**

Create `test/outbound.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The hub's outbound calls (spec 8.4): direct, or through an HTTP proxy from HTTPS_PROXY /
 * HTTP_PROXY with NO_PROXY; https through a CONNECT tunnel with the destination's
 * certificate checked; credentials never shown. The proxy and the destinations run in
 * this process.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createOutbound, noProxy, parseProxy } = require("../hub/lib/proxy");

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (...srvs) => Promise.all(srvs.map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); })));

function certFor(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-out-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { stdio: "ignore" });
  const c = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

// a destination that answers with what it was sent
const echo = (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(201, { "content-type": "application/json", "x-seen": "yes" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
};

// an HTTP proxy: absolute-form requests and CONNECT tunnels, every name to 127.0.0.1;
// remembers what it saw; answers 407 without the right credentials when asked to
async function startProxy({ auth = null } = {}) {
  const seen = [];
  const ok = (req) => !auth || req.headers["proxy-authorization"] === "Basic " + Buffer.from(auth).toString("base64");
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (!ok(req)) { res.writeHead(407); res.end(); return; }
    const u = new URL(req.url);
    const up = http.request({ host: "127.0.0.1", port: u.port, method: req.method, path: u.pathname + u.search, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  srv.on("connect", (req, sock) => {
    seen.push({ method: "CONNECT", url: req.url, headers: req.headers });
    if (!ok(req)) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
    const port = Number(req.url.split(":").pop());
    const up = net.connect(port, "127.0.0.1", () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
    up.on("close", () => sock.destroy());
    sock.on("close", () => up.destroy());
  });
  const port = await listen(srv);
  return { srv, port, seen };
}

test("NO_PROXY: names, suffixes, CIDRs, IPv6, *; this host is always direct", () => {
  const list = ".corp.example, example.org:443, 10.0.0.0/8, [fd00::1], intranet";
  const cases = { "localhost": true, "127.0.0.1": true, "::1": true, "a.corp.example": true, "corp.example": true,
    "example.org": true, "www.example.org": true, "notexample.org": false, "10.4.5.6": true, "11.0.0.1": false,
    "fd00::1": true, "fd00::2": false, "intranet": true, "ntfy.sh": false, "A.CORP.EXAMPLE": true };
  for (const [host, want] of Object.entries(cases)) assert.strictEqual(noProxy(list, host), want, host);
  assert.strictEqual(noProxy("*", "ntfy.sh"), true);
  assert.strictEqual(noProxy("", "ntfy.sh"), false);
  assert.strictEqual(noProxy("10.0.0.0/33, 1.2.3/8", "1.2.3.4"), false, "a CIDR that is not one matches nothing");
});

test("only http:// proxy URLs are used; credentials become Basic; a missing port is 80", () => {
  assert.strictEqual(parseProxy("https://p.example:3128"), null);
  assert.strictEqual(parseProxy("socks5://p.example:1080"), null);
  assert.strictEqual(parseProxy("not a url"), null);
  assert.deepStrictEqual(parseProxy("http://p.example"), { host: "p.example", port: 80, auth: null });
  assert.deepStrictEqual(parseProxy("http://us%40er:p%3Ass@p.example:3128"),
    { host: "p.example", port: 3128, auth: "Basic " + Buffer.from("us@er:p:ss").toString("base64") });
  const o = createOutbound({ env: { https_proxy: "http://u:secret@p.example:3128", HTTP_PROXY: "http://q.example:8080", NO_PROXY: ".lan" } });
  assert.strictEqual(o.proxyFor("https://ntfy.sh/x").host, "p.example", "lower case works too");
  assert.strictEqual(o.proxyFor("http://hooks.example/x").host, "q.example");
  assert.strictEqual(o.proxyFor("https://nas.lan/x"), null);
  assert.deepStrictEqual(o.describe(), { https: "p.example:3128", http: "q.example:8080" });
  assert.doesNotMatch(JSON.stringify(o.describe()), /secret/, "never the credentials");
  assert.deepStrictEqual(createOutbound({ env: {} }).describe(), { https: "direct", http: "direct" });
});

test("a direct call: method, headers and body go out; status, headers and body come back", async () => {
  const dest = http.createServer(echo);
  const port = await listen(dest);
  try {
    const r = await createOutbound({ env: {} }).request(`http://127.0.0.1:${port}/a?b=1`, { method: "POST", headers: { "x-k": "v" }, body: "héllo" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.headers["x-seen"], "yes");
    const got = JSON.parse(r.body);
    assert.deepStrictEqual([got.method, got.url, got.headers["x-k"], got.headers["content-length"], got.body], ["POST", "/a?b=1", "v", "6", "héllo"]);
  } finally { await close(dest); }
});

test("http through the proxy: an absolute-form request with Proxy-Authorization", async () => {
  const dest = http.createServer(echo);
  const dport = await listen(dest);
  const p = await startProxy({ auth: "u:pw" });
  try {
    const o = createOutbound({ env: { HTTP_PROXY: `http://u:pw@127.0.0.1:${p.port}` } });
    const r = await o.request(`http://hooks.test:${dport}/hook`, { method: "POST", body: "{}" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(p.seen[0].url, `http://hooks.test:${dport}/hook`);
    assert.strictEqual(p.seen[0].headers.host, `hooks.test:${dport}`);
    assert.strictEqual(JSON.parse(r.body).url, "/hook");
  } finally { await close(dest, p.srv); }
});

test("https through the proxy: a CONNECT tunnel, then TLS with the destination's certificate checked", async () => {
  const c = certFor("svc.test");
  const dest = https.createServer(c, echo);
  const dport = await listen(dest);
  const p = await startProxy({ auth: "u:pw" });
  try {
    const o = createOutbound({ env: { HTTPS_PROXY: `http://u:pw@127.0.0.1:${p.port}` } });
    const r = await o.request(`https://svc.test:${dport}/push`, { method: "POST", body: "x", ca: c.cert });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([p.seen[0].method, p.seen[0].url], ["CONNECT", `svc.test:${dport}`]);
    assert.strictEqual(p.seen[0].headers["proxy-authorization"], "Basic " + Buffer.from("u:pw").toString("base64"));
    assert.strictEqual(JSON.parse(r.body).headers["proxy-authorization"], undefined, "the destination never sees the proxy's credentials");
    await assert.rejects(o.request(`https://svc.test:${dport}/push`), (e) => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code), "a certificate nobody vouches for");
    await assert.rejects(o.request(`https://other.test:${dport}/push`, { ca: c.cert }), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID", "a certificate for another name");
  } finally { await close(dest, p.srv); }
});

test("a proxy that refuses, a destination too slow or too talkative: an error that says which", async () => {
  const p = await startProxy({ auth: "u:pw" });
  const slow = http.createServer(() => {});
  const big = http.createServer((req, res) => { res.end(Buffer.alloc(3000, 97)); });
  const [sport, bport] = [await listen(slow), await listen(big)];
  try {
    const wrong = createOutbound({ env: { HTTPS_PROXY: `http://u:nope@127.0.0.1:${p.port}` } });
    await assert.rejects(wrong.request("https://svc.test/x"), (e) => e.code === "EPROXY" && /407/.test(e.message));
    const o = createOutbound({ env: {} });
    await assert.rejects(o.request(`http://127.0.0.1:${sport}/`, { timeoutMs: 200 }), (e) => e.code === "ETIMEDOUT");
    await assert.rejects(o.request(`http://127.0.0.1:${bport}/`, { maxBytes: 1000 }), (e) => e.code === "ETOOBIG");
    await assert.rejects(o.request("ftp://x.test/"), (e) => e.code === "EURL");
    await assert.rejects(o.request("::"), (e) => e.code === "EURL");
    const down = createOutbound({ env: { HTTP_PROXY: "http://127.0.0.1:1" } });
    await assert.rejects(down.request("http://hooks.test/"), (e) => e.code === "ECONNREFUSED");
  } finally { await close(p.srv, slow, big); }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/outbound.test.js`
Expected: FAIL, the file as a whole (`Cannot find module '../hub/lib/proxy'`).

- [ ] **Step 3: The outbound client**

Create `hub/lib/proxy.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Every outbound call the hub makes (alert channels, Web Push, the relay) goes through
 * here (spec 8.4): Node's http and https modules, not fetch, and an HTTP proxy when
 * hub.env sets one, since Node 18 and 22 ignore HTTPS_PROXY.
 *   - HTTPS_PROXY for https:// destinations, HTTP_PROXY for http:// ones (either case);
 *     only http:// proxy URLs, with optional user:password@ sent as Proxy-Authorization.
 *   - https:// goes through a CONNECT tunnel, then TLS to the destination with the usual
 *     certificate checks: the proxy never sees the content. http:// is an absolute-form
 *     request through the proxy.
 *   - NO_PROXY: host names and domain suffixes (.example.com; example.com also matches its
 *     subdomains), IPv4 CIDRs, exact IPv6 addresses, and *. localhost, 127.0.0.1 and ::1
 *     are always direct.
 *   - Credentials are never logged: describe() shows the proxy's host only.
 *   createOutbound({ env }) → { request(url, { method, headers, body, timeoutMs, maxBytes, ca }),
 *     proxyFor(url), describe() }
 *   request resolves { status, headers, body } (body a string, at most maxBytes) or rejects
 *   with an Error whose code says what failed (ETIMEDOUT, EPROXY, ETOOBIG, or the socket's).
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const ALWAYS_DIRECT = new Set(["localhost", "127.0.0.1", "::1"]);

const pick = (env, name) => env[name] || env[name.toLowerCase()] || "";

// an http:// proxy URL, or null (anything else is not used)
function parseProxy(s) {
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== "http:" || !u.hostname) return null;
  const auth = u.username ? "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64") : null;
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 80, auth };
}

const ipv4 = (s) => (net.isIPv4(s) ? s.split(".").reduce((n, o) => n * 256 + Number(o), 0) : null);
function inCidr(host, cidr) {
  const [base, bits] = cidr.split("/");
  const h = ipv4(host), b = ipv4(base), n = Number(bits);
  if (h === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((h & mask) >>> 0) === ((b & mask) >>> 0);
}

// does NO_PROXY send this host direct?
function noProxy(list, host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (ALWAYS_DIRECT.has(host)) return true;
  for (let e of list.split(",")) {
    e = e.trim().toLowerCase();
    if (!e) continue;
    if (e === "*") return true;
    if (e.includes("/")) { if (inCidr(host, e)) return true; continue; }
    e = e.replace(/^\[|\]$/g, "");
    if (net.isIP(e)) { if (e === host) return true; continue; }
    e = e.replace(/:\d+$/, "");
    if (e.startsWith(".") ? host.endsWith(e) || host === e.slice(1) : host === e || host.endsWith("." + e)) return true;
  }
  return false;
}

function createOutbound({ env = process.env } = {}) {
  const proxies = { "https:": parseProxy(pick(env, "HTTPS_PROXY")), "http:": parseProxy(pick(env, "HTTP_PROXY")) };
  const skip = pick(env, "NO_PROXY");

  function proxyFor(url) {
    const u = typeof url === "string" ? new URL(url) : url;
    const p = proxies[u.protocol];
    return p && !noProxy(skip, u.hostname) ? p : null;
  }

  function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000, maxBytes = 1048576, ca } = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (_) { const e = new Error("invalid url"); e.code = "EURL"; reject(e); return; }
      if (u.protocol !== "https:" && u.protocol !== "http:") { const e = new Error("only http and https"); e.code = "EURL"; reject(e); return; }
      const secure = u.protocol === "https:";
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const port = Number(u.port) || (secure ? 443 : 80);
      const data = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      const hdrs = { ...headers, ...(data ? { "content-length": String(data.length) } : {}) };
      const proxy = proxyFor(u);
      let done = false, sockets = [];
      const fail = (err, code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const s of sockets) s.destroy();
        if (code && !err.code) err.code = code;
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("timed out"), "ETIMEDOUT"), timeoutMs);
      const onResponse = (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) { fail(new Error("answer too big"), "ETOOBIG"); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          for (const s of sockets) s.destroy();   // one call, one connection: nothing kept open
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (e) => fail(e));
      };
      const send = (req) => {
        req.on("socket", (s) => sockets.push(s));
        req.on("error", (e) => fail(e));
        if (data) req.write(data);
        req.end();
      };

      if (!proxy) {
        send((secure ? https : http).request({ host, port, method, path: u.pathname + u.search, headers: hdrs, servername: net.isIP(host) ? undefined : host, ca, agent: false }, onResponse));
        return;
      }
      const pauth = proxy.auth ? { "proxy-authorization": proxy.auth } : {};
      if (!secure) {
        send(http.request({ host: proxy.host, port: proxy.port, method, path: u.href, headers: { host: u.host, ...hdrs, ...pauth }, agent: false }, onResponse));
        return;
      }
      // https: a CONNECT tunnel, then TLS end to end with the destination
      const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
      const tunnel = http.request({ host: proxy.host, port: proxy.port, method: "CONNECT", path: target, headers: { host: target, ...pauth }, agent: false });
      tunnel.on("socket", (s) => sockets.push(s));
      tunnel.on("error", (e) => fail(e, "EPROXY"));
      tunnel.on("connect", (res, socket) => {
        sockets.push(socket);
        if (res.statusCode !== 200) { fail(new Error(`proxy answered ${res.statusCode} to CONNECT`), "EPROXY"); return; }
        const secured = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ca });
        sockets.push(secured);
        secured.on("error", (e) => fail(e));
        // an agent that hands over the tunnel's TLS socket (agent: false would dial again)
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => secured;
        send(https.request({ host, port, method, path: u.pathname + u.search, headers: hdrs, agent }, onResponse));
      });
      tunnel.end();
    });
  }

  // for the log: where calls go, never the credentials
  function describe() {
    const d = (p) => (p ? `${p.host}:${p.port}` : "direct");
    return { https: d(proxies["https:"]), http: d(proxies["http:"]) };
  }

  return { request, proxyFor, describe };
}

module.exports = { createOutbound, noProxy, parseProxy };
```

In `packaging/etc/hub.env`:

1. Replace

```
# config as code: *.json here win over the page (servitals-ctl config check)
# CONFD_DIR=/etc/servitals/conf.d
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

   with

```
# config as code: *.json here win over the page (servitals-ctl config check)
# CONFD_DIR=/etc/servitals/conf.d
# outbound proxy for the alert channels (only http:// proxy URLs); this host is never proxied
# HTTPS_PROXY=http://proxy.example:3128
# NO_PROXY=.internal.example
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

In `docs/networking.md`:

1. Replace

```markdown
| hub behind a reverse proxy | TLS at the proxy; set `TRUSTED_PROXIES` in `hub.env` to the proxy's address |
| server with no outbound internet except one allowed destination | allow outbound 443 to the hub hostname only |
| server that reaches the internet through an HTTP proxy | `HTTPS_PROXY` in `agent.env`; lower `WAIT_SECONDS` if the proxy drops idle connections |
| many private servers in a closed network | run a self-hosted hub inside it (relaying chosen nodes to the hosted service comes later) |
| phone notifications (Web Push, later) | the hub must be served over HTTPS (tunnel, Tailscale certificate, or reverse proxy) |
```

   with

```markdown
| hub behind a reverse proxy | TLS at the proxy; set `TRUSTED_PROXIES` in `hub.env` to the proxy's address |
| server with no outbound internet except one allowed destination | allow outbound 443 to the hub hostname only |
| server that reaches the internet through an HTTP proxy | `HTTPS_PROXY` in `agent.env` (and in `hub.env` for a hub that sends alerts); lower `WAIT_SECONDS` if the proxy drops idle connections |
| many private servers in a closed network | run a self-hosted hub inside it (relaying chosen nodes to the hosted service comes later) |
| phone notifications (Web Push, later) | the hub must be served over HTTPS (tunnel, Tailscale certificate, or reverse proxy) |
```

2. Replace

```markdown
`curl` tunnels HTTPS through the proxy with `CONNECT`. The agent always adds
`localhost,127.0.0.1,::1` to `NO_PROXY`, so the hub's own agent never uses
the proxy. Proxies and firewalls often cut idle connections before the
55-second long poll ends: set `WAIT_SECONDS=25` (5 to 55) if waits keep
failing.
```

   with

```markdown
`curl` tunnels HTTPS through the proxy with `CONNECT`. The agent always adds
`localhost,127.0.0.1,::1` to `NO_PROXY`, so the hub's own agent never uses
the proxy.

A hub that sends alerts (ntfy, webhooks) reads the same `HTTPS_PROXY`,
`HTTP_PROXY` and `NO_PROXY` from `/etc/servitals/hub.env`. Only `http://`
proxy URLs work; HTTPS goes through a `CONNECT` tunnel, so the proxy never
sees the message and the destination's certificate is checked as usual.
`NO_PROXY` takes host names, domain suffixes (`.example.com`), IPv4 CIDRs
(`10.0.0.0/8`), IPv6 addresses and `*`; `localhost` is always direct. The
hub's log names the proxy host at start, never its credentials. Proxies and firewalls often cut idle connections before the
55-second long poll ends: set `WAIT_SECONDS=25` (5 to 55) if waits keep
failing.
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 417 tests (6 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/proxy.js test/outbound.test.js packaging/etc/hub.env docs/networking.md
git commit -m "feat(hub): outbound calls through HTTPS_PROXY with NO_PROXY, a CONNECT tunnel for HTTPS"
```

---

### Task 2: The notifier, ntfy and webhooks

**Files:**
- Create: `hub/lib/notify.js`, `test/notify.test.js`
- Modify: `hub/lib/alerts.js`, `hub/lib/i18n.js`, `hub/server.js`, `test/alerts.test.js`, `test/agentapi.test.js`, `test/i18n.test.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `createOutbound` (Task 1); the engine's events (6b).
- Produces:
  - `createNotifier({dir, outbound, now, log, sleep, env})` → `{onEvent, tick, test, setConfig, view, flush}`; `checkChannels(input, old)`; `ADAPTERS`; `SECRET`;
  - `GET /__ctl/alerts/channels` → `{channels (secrets masked), quiet, digestAt, status, types}`; `POST /__ctl/alerts/channels` → 200 or 400 `{error}` naming the channel; `POST /__ctl/alerts/channels/test {id}` → `{ok, error?}`.

  6c-2's page and adapters build on these.

- [ ] **Step 1: Write the failing tests**

Create `test/notify.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Where alerts go (spec 8.3, 8.4): channels with a minimum severity, retries, quiet hours
 * with a summary at their end, the daily digest, secrets kept out of view and logs.
 * Local time is UTC here.
 */
process.env.TZ = "UTC";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNotifier, checkChannels, SECRET } = require("../hub/lib/notify");

const at = (hhmm, dayOffset = 0) => Date.UTC(2026, 9, 9 + dayOffset, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));
const ntfy = (extra = {}) => ({ id: "ch_n", type: "ntfy", name: "phone", min: "warning", on: true, config: { topic: "sv-home", token: "tk_secret" }, ...extra });
const hook = (extra = {}) => ({ id: "ch_w", type: "webhook", name: "pager", min: "critical", on: true, config: { url: "https://hooks.test/T0K3N", secret: "s3" }, ...extra });

function setup(config, { fail = () => 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notify-"));
  const sent = [], logs = [], slept = [];
  const clock = { t: at("12:00") };
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); const s = fail(url, sent.length); return { status: s || 200, headers: {}, body: "" }; } };
  const make = () => createNotifier({ dir, outbound, now: () => clock.t, env: { NTFY_TOKEN: "from_env", HOOK_URL: "https://hooks.test/env" },
    log: { info() {}, warn: (event, f) => logs.push([event, f]) }, sleep: async (ms) => { slept.push(ms); } });
  const n = make();
  if (config) n.setConfig(config);
  return { n, dir, sent, logs, slept, clock, make };
}
const ev = (kind, severity, extra = {}) => ({ kind, rule: "disk_full", metric: "disk.used", severity, node: "nodeaaaaaaaa", nodeName: "nas",
  sub: "/srv", value: 92, at: at("12:00"), since: at("11:55"), ...extra });

test("channels are checked: type, severity, topic, URL; a masked secret keeps its value; $NAME comes from the environment", () => {
  const ok = checkChannels({ channels: [ntfy(), hook({ config: { url: "$HOOK_URL" } })], quiet: { from: "23:00", to: "07:00" } });
  assert.deepStrictEqual(ok, { channels: [ntfy(), hook({ config: { url: "$HOOK_URL" } })], quiet: { from: "23:00", to: "07:00" }, digestAt: "07:00" });
  const bad = (chs, re, extra = {}) => assert.throws(() => checkChannels({ channels: chs, ...extra }, ok), re);
  bad([ntfy({ type: "fax" })], /phone: type/);
  bad([ntfy({ min: "page" })], /phone: min/);
  bad([ntfy({ config: { topic: "a b" } })], /phone: topic: not valid/);
  bad([ntfy({ config: {} })], /phone: topic: needed/);
  bad([hook({ config: { url: "ftp://x" } })], /pager: url: an http or https URL/);
  bad([hook({ config: { url: "https://x/\n" } })], /pager: url: text/);
  bad([ntfy(), ntfy()], /phone: listed twice/);
  bad([ntfy({ id: "x" })], /id: ch_/);
  bad([ntfy({ on: "yes" })], /on: true or false/);
  bad([], /quiet hours/, { quiet: { from: "23:00", to: "23:00" } });
  bad([], /digest: a time/, { digestAt: "7am" });
  bad(Array.from({ length: 21 }, (_, i) => ntfy({ id: "ch_" + i })), /at most 20/);
  const kept = checkChannels({ channels: [ntfy({ config: { topic: "sv-home", token: SECRET } })] }, { channels: [ntfy()] });
  assert.strictEqual(kept.channels[0].config.token, "tk_secret", "unchanged on the page: kept");
  assert.throws(() => checkChannels({ channels: [ntfy({ id: "ch_new", config: { topic: "t", token: SECRET } })] }, { channels: [ntfy()] }), /token: type it again/);
});

test("an alert goes to each channel whose minimum it meets: ntfy as JSON with a bearer token, a webhook signed", async () => {
  const s = setup({ channels: [ntfy({ config: { topic: "sv-home", token: "$NTFY_TOKEN" } }), hook()] });
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.deepStrictEqual(s.sent.map((r) => r.url), ["https://ntfy.sh/"], "warning: not to the critical-only pager");
  const body = JSON.parse(s.sent[0].body);
  assert.deepStrictEqual(body, { topic: "sv-home", title: "warning: disk full /srv on nas", message: "value 92%\nsince 11:55", priority: 4, tags: ["warning"] });
  assert.strictEqual(s.sent[0].headers.authorization, "Bearer from_env");
  s.n.onEvent(ev("firing", "critical", { rule: "c_x", name: "backup <disk>", metric: "temp", value: 71.26 }));
  s.n.onEvent(ev("resolved", "critical", { rule: "offline", metric: "offline", sub: undefined, value: 0 }));
  await s.n.flush();
  assert.deepStrictEqual(s.sent.map((r) => r.url).slice(1).sort(), ["https://hooks.test/T0K3N", "https://hooks.test/T0K3N", "https://ntfy.sh/", "https://ntfy.sh/"]);
  const hooks = s.sent.filter((r) => r.url.startsWith("https://hooks"));
  const first = JSON.parse(hooks[0].body);
  assert.deepStrictEqual([first.kind, first.severity, first.title, first.text.split("\n")[0], first.event.rule], ["alert", "critical", "critical: backup <disk> /srv on nas", "value 71.3 °C", "c_x"]);
  assert.strictEqual(hooks[0].headers["x-servitals-signature"], "sha256=" + crypto.createHmac("sha256", "s3").update(hooks[0].body).digest("hex"));
  assert.strictEqual(JSON.parse(hooks[1].body).title, "resolved: offline on nas", "an offline alert has no value to show");
  const off = setup({ channels: [ntfy({ on: false })] });
  off.n.onEvent(ev("firing", "critical"));
  await off.n.flush();
  assert.deepStrictEqual(off.sent, [], "a channel turned off sends nothing");
});

test("a failed send is tried again after 2, 10 and 30 s, then logged without the URL or the token; the page sees the last error", async () => {
  const s = setup({ channels: [hook({ min: "warning" })] }, { fail: (url, n) => (n < 3 ? 503 : 0) });
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.deepStrictEqual([s.sent.length, s.slept], [3, [2000, 10000]], "the third try worked");
  assert.strictEqual(typeof s.n.view().status.ch_w.lastOk, "number");
  const f = setup({ channels: [hook({ min: "warning" })] }, { fail: () => 500 });
  f.n.onEvent(ev("firing", "warning"));
  await f.n.flush();
  assert.deepStrictEqual([f.sent.length, f.slept], [4, [2000, 10000, 30000]]);
  assert.deepStrictEqual(f.logs, [["alert.notify_failed", { channel: "ch_w", type: "webhook", error: "HTTP_500" }]]);
  assert.doesNotMatch(JSON.stringify(f.logs), /T0K3N|s3/);
  assert.strictEqual(f.n.view().status.ch_w.lastError, "HTTP_500");
});

test("quiet hours hold warnings, not critical; at their end one summary of what still fires, and of ends told before", async () => {
  const s = setup({ channels: [ntfy()], quiet: { from: "23:00", to: "07:00" } });
  const told = { rule: "memory", metric: "mem", sub: undefined };
  s.clock.t = at("22:00"); s.n.onEvent(ev("firing", "warning", told)); s.n.tick();
  await s.n.flush();
  assert.strictEqual(s.sent.length, 1, "before the window: sent");
  s.clock.t = at("23:30"); s.n.tick();
  s.n.onEvent(ev("firing", "warning", { sub: "/a" }));
  s.n.onEvent(ev("firing", "critical", { rule: "offline", metric: "offline", sub: undefined }));
  await s.n.flush();
  assert.strictEqual(s.sent.length, 2, "critical goes through, the warning waits");
  s.clock.t = at("01:00", 1); s.n.onEvent(ev("resolved", "warning", { sub: "/a" }));   // fired and ended inside: log only
  s.n.onEvent(ev("firing", "warning", { sub: "/b" }));
  s.n.onEvent(ev("resolved", "warning", told));                                         // told before the window
  const again = s.make();                                                                // a restart in the night keeps what is held
  s.clock.t = at("06:59", 1); again.tick();
  await again.flush();
  assert.strictEqual(s.sent.length, 2);
  s.clock.t = at("07:00", 1); again.tick();
  await again.flush();
  assert.strictEqual(s.sent.length, 3);
  const sum = JSON.parse(s.sent[2].body);
  assert.strictEqual(sum.title, "2 alerts held during quiet hours");
  assert.deepStrictEqual(sum.message.split("\n").sort(), ["fired: disk full /b on nas · 92%", "resolved: memory on nas · 92%"]);
  s.clock.t = at("07:01", 1); again.tick();
  await again.flush();
  assert.strictEqual(s.sent.length, 3, "once");
});

test("info goes to one digest a day at 07:00, to every channel unless it opts out", async () => {
  const s = setup({ channels: [ntfy({ min: "critical" }), hook({ digest: false })] });
  s.clock.t = at("08:00"); s.n.tick();
  s.n.onEvent(ev("firing", "info", { rule: "security_updates", metric: "security_updates", sub: undefined, value: 3 }));
  s.n.onEvent(ev("firing", "info", { rule: "reboot_required", metric: "reboot_required", sub: undefined, value: 1 }));
  await s.n.flush();
  assert.strictEqual(s.sent.length, 0, "info is never sent on its own");
  s.clock.t = at("06:59", 1); s.n.tick();
  s.clock.t = at("07:00", 1); s.n.tick();
  await s.n.flush();
  assert.deepStrictEqual(s.sent.map((r) => r.url), ["https://ntfy.sh/"]);
  const d = JSON.parse(s.sent[0].body);
  assert.deepStrictEqual([d.title, d.message, d.priority], ["daily digest: 2 events", "fired: security updates on nas · 3\nfired: reboot required on nas", 3]);
  s.clock.t = at("09:00", 1); s.n.tick();
  s.clock.t = at("07:00", 2); s.n.tick();
  await s.n.flush();
  assert.strictEqual(s.sent.length, 1, "once a day, and nothing when there is nothing");
});

test("send test answers at once; the page sees secrets masked, names from the environment as they are; the file is 0600", async () => {
  const s = setup({ channels: [ntfy(), hook({ config: { url: "$HOOK_URL" } })] }, { fail: (url) => (url.includes("env") ? 404 : 0) });
  assert.deepStrictEqual(await s.n.test("ch_n"), { ok: true });
  assert.deepStrictEqual(await s.n.test("ch_w"), { ok: false, error: "HTTP_404" });
  assert.deepStrictEqual(await s.n.test("ch_zz"), { ok: false, error: "no such channel" });
  assert.strictEqual(JSON.parse(s.sent[0].body).title, "servitals test");
  assert.strictEqual(s.sent[1].url, "https://hooks.test/env");
  const v = s.n.view();
  assert.deepStrictEqual(v.channels.map((c) => c.config), [{ topic: "sv-home", token: SECRET }, { url: "$HOOK_URL" }]);
  assert.strictEqual(v.status.ch_w.lastError, "HTTP_404");
  assert.deepStrictEqual(v.types.ntfy.map((f) => f.key), ["server", "topic", "token"]);
  assert.strictEqual(fs.statSync(path.join(s.dir, "channels.json")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(s.dir, "channels.json"), "utf8"), /tk_secret/, "kept in the file, which only the hub reads");
});
```

In `test/alerts.test.js`:

1. Replace

```js
  c.at(5); a.evaluate(N, disk(92));
  assert.deepStrictEqual(kinds(events), ["firing:disk_full:/srv"]);
  assert.deepStrictEqual(events[0], { kind: "firing", rule: "disk_full", severity: "warning", node: N.id, nodeName: "nas",
    sub: "/srv", value: 92, at: c.t, since: 1790000000000 });
  c.at(6); a.evaluate(N, disk(89));                      // below 90, but not below 88: still firing (hysteresis)
```

   with

```js
  c.at(5); a.evaluate(N, disk(92));
  assert.deepStrictEqual(kinds(events), ["firing:disk_full:/srv"]);
  assert.deepStrictEqual(events[0], { kind: "firing", rule: "disk_full", metric: "disk.used", severity: "warning", node: N.id, nodeName: "nas",
    sub: "/srv", value: 92, at: c.t, since: 1790000000000 });
  c.at(6); a.evaluate(N, disk(89));                      // below 90, but not below 88: still firing (hysteresis)
```

In `test/agentapi.test.js`:

1. Replace

```js
  }, { CTL_LAN_ONLY: "0" });
});

```

   with

```js
  }, { CTL_LAN_ONLY: "0" });
});

test("alert channels: saved from the page with secrets masked; an alert reaches a webhook; send test answers", async () => {
  const got = [];
  const dest = require("node:http").createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { got.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) }); res.writeHead(req.url === "/gone" ? 410 : 200); res.end(); });
  });
  await new Promise((r) => dest.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${dest.address().port}/hook`;
  try {
    await withHub(async (hub, c) => {
      const cookie = cookieFrom(await login(hub.port));
      const get = async () => JSON.parse((await request(hub.port, { path: "/__ctl/alerts/channels", headers: { cookie } })).body);
      const save = (b) => ctlPost(hub.port, cookie, "/__ctl/alerts/channels", JSON.stringify(b));
      assert.deepStrictEqual((await get()).channels, []);
      const ch = { id: "ch_w", type: "webhook", name: "hook", min: "warning", on: true, config: { url } };
      assert.strictEqual((await save({ channels: [ch] })).status, 200);
      assert.match(hub.logs(), /event=alert\.channels_saved/);
      assert.deepStrictEqual((await get()).channels[0].config, { url: "********" }, "a webhook URL is a secret");
      assert.strictEqual(fs.statSync(path.join(hub.dataDir, "alerts", "channels.json")).mode & 0o777, 0o600);
      assert.strictEqual((await save({ channels: [{ ...ch, config: { url: "********" } }] })).status, 200, "masked: kept");
      const bad = await save({ channels: [{ ...ch, min: "page" }] });
      assert.deepStrictEqual([bad.status, JSON.parse(bad.body).error], [400, "hook: min: one of critical, warning, info"]);
      // reboot_required raised to warning, so it is sent at once
      assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/rules", JSON.stringify({ rules: [{ id: "reboot_required", severity: "warning" }] }))).status, 200);
      assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true } }) })).status, 200);
      for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual([got[0].url, got[0].body.kind], ["/hook", "alert"]);
      assert.match(got[0].body.title, /^warning: reboot required on \S/);
      const t = JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/alerts/channels/test", JSON.stringify({ id: "ch_w" }))).body);
      assert.deepStrictEqual(t, { ok: true });
      assert.strictEqual(got[1].body.kind, "test");
      assert.strictEqual((await save({ channels: [{ ...ch, config: { url: url.replace("/hook", "/gone") } }] })).status, 200);
      assert.deepStrictEqual(JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/alerts/channels/test", JSON.stringify({ id: "ch_w" }))).body), { ok: false, error: "HTTP_410" });
      assert.strictEqual((await get()).status.ch_w.lastError, "HTTP_410");
      assert.doesNotMatch(hub.logs(), /127\.0\.0\.1:\d+\/(hook|gone)/, "the hub's log never shows a channel's URL");
      assert.strictEqual((await request(hub.port, { path: "/__ctl/alerts/channels" })).status, 401);
    });
  } finally { dest.close(); }
});

```

In `test/i18n.test.js`:

1. Replace

```js
test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"), read("js/history.js"), read("js/alerts.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
```

   with

```js
test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"), read("js/history.js"), read("js/alerts.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "lib", "notify.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/notify.test.js test/alerts.test.js test/agentapi.test.js test/i18n.test.js`
Expected: FAIL:
- `test/notify.test.js` as a whole (`Cannot find module '../hub/lib/notify'`);
- "a rule fires only after its condition held for its time…" (the event has no `metric` yet);
- "alert channels: saved from the page…" (404 on the route);
- "every key the code asks for is in the dictionary…" (`hub/lib/notify.js` does not exist yet).

- [ ] **Step 3: The notifier and its routes**

Create `hub/lib/notify.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Where alerts go (spec 8.3, 8.4): the channels a person sets, each with a minimum
 * severity; quiet hours that hold warnings (critical always goes through) and send what
 * is still firing as one summary when they end; info events in one digest a day.
 *   <dir>/channels.json (mode 0600, it holds tokens):
 *     { channels: [{ id: "ch_…", type, name, min, on, digest?, config }],
 *       quiet: null | { from: "HH:MM", to: "HH:MM" }, digestAt: "HH:MM" }
 *   <dir>/notify-state.json: what quiet hours hold, the digest so far, the last digest day.
 * Times are the hub's local time. A config value "$NAME" is read from the environment
 * when sent (config as code keeps tokens out of the file). A send that fails is tried
 * again after 2, 10 and 30 s, then logged alert.notify_failed; a channel's last error is
 * kept for the page. Never logged: tokens, and URLs (a webhook URL is a secret).
 *   createNotifier({ dir, outbound, now, log, sleep, env }) → { onEvent(e), tick(), test(id),
 *     setConfig(input), view(), flush() }
 *   checkChannels(input, old) → the clean config, or throws an Error naming the channel
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./fsutil");
const { tr } = require("./i18n");

const SEV = ["critical", "warning", "info"];
const rank = (s) => (SEV.includes(s) ? SEV.indexOf(s) : 2);
const SECRET = "********";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENVREF = /^\$[A-Z_][A-Z0-9_]*$/;
const RETRIES = [2000, 10000, 30000];
const MAX_HELD = 500, MAX_DIGEST = 500;

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const httpUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch (_) { return false; } };

/* ------------------------------------------------------------------ channels
   fields: { name: { secret?, optional?, url?, re? } }; build(config, message) → the request */
const ADAPTERS = {
  // ntfy's JSON publishing: no header has to carry the title's characters
  ntfy: {
    fields: { server: { optional: true, url: true }, topic: { re: /^[A-Za-z0-9_-]{1,64}$/ }, token: { optional: true, secret: true } },
    build(c, m) {
      const server = (c.server || "https://ntfy.sh").replace(/\/+$/, "");
      const tags = m.kind === "test" ? ["white_check_mark"] : m.resolved ? ["white_check_mark"] : m.severity === "critical" ? ["rotating_light"] : ["warning"];
      return { url: server + "/", headers: { "content-type": "application/json", ...(c.token ? { authorization: "Bearer " + c.token } : {}) },
        body: JSON.stringify({ topic: c.topic, title: m.title, message: m.text, priority: m.severity === "critical" ? 5 : m.severity === "warning" ? 4 : 3, tags }) };
    },
  },
  // a JSON POST to any URL; with a secret, X-Servitals-Signature: sha256=<HMAC of the body>
  webhook: {
    fields: { url: { url: true, secret: true }, secret: { optional: true, secret: true } },
    build(c, m) {
      const body = JSON.stringify({ kind: m.kind, severity: m.severity, title: m.title, text: m.text, ...(m.event ? { event: m.event } : {}) });
      const sig = c.secret ? { "x-servitals-signature": "sha256=" + crypto.createHmac("sha256", c.secret).update(body).digest("hex") } : {};
      return { url: c.url, headers: { "content-type": "application/json", ...sig }, body };
    },
  },
};

function checkChannels(input, old = { channels: [] }) {
  if (!isObj(input) || !Array.isArray(input.channels)) throw new Error("channels: a list");
  if (input.channels.length > 20) throw new Error("channels: at most 20");
  const ids = new Set();
  const channels = input.channels.map((ch, i) => {
    let at = `channel ${i + 1}`;
    if (!isObj(ch)) throw new Error(`${at}: not a channel`);
    if (typeof ch.name === "string" && ch.name.trim()) at = ch.name.trim().slice(0, 60);
    if (typeof ch.id !== "string" || !/^ch_[a-z0-9]{1,16}$/.test(ch.id)) throw new Error(`${at}: id: ch_ and up to 16 letters or digits`);
    if (ids.has(ch.id)) throw new Error(`${at}: listed twice`);
    ids.add(ch.id);
    const ad = ADAPTERS[ch.type];
    if (!ad) throw new Error(`${at}: type: one of ${Object.keys(ADAPTERS).join(", ")}`);
    if (typeof ch.name !== "string" || !ch.name.trim() || ch.name.length > 60 || /[\u0000-\u001f\u007f]/.test(ch.name)) throw new Error(`${at}: name: 1 to 60 characters`);
    if (!SEV.includes(ch.min)) throw new Error(`${at}: min: one of ${SEV.join(", ")}`);
    if (typeof ch.on !== "boolean") throw new Error(`${at}: on: true or false`);
    if (ch.digest !== undefined && typeof ch.digest !== "boolean") throw new Error(`${at}: digest: true or false`);
    const cfg = isObj(ch.config) ? ch.config : {};
    const was = (old.channels || []).find((x) => x.id === ch.id && x.type === ch.type);
    const config = {};
    for (const [k, f] of Object.entries(ad.fields)) {
      let v = cfg[k];
      if (v === SECRET && f.secret) {
        if (!was || was.config[k] === undefined) throw new Error(`${at}: ${k}: type it again`);
        v = was.config[k];
      }
      if (v === undefined || v === "") {
        if (!f.optional) throw new Error(`${at}: ${k}: needed`);
        continue;
      }
      if (typeof v !== "string" || v.length > 2048 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${at}: ${k}: text up to 2048 characters`);
      if (!ENVREF.test(v)) {
        if (f.url && !httpUrl(v)) throw new Error(`${at}: ${k}: an http or https URL`);
        if (f.re && !f.re.test(v)) throw new Error(`${at}: ${k}: not valid`);
      }
      config[k] = v;
    }
    return { id: ch.id, type: ch.type, name: ch.name.trim(), min: ch.min, on: ch.on, ...(ch.digest === false ? { digest: false } : {}), config };
  });
  let quiet = null;
  if (input.quiet !== undefined && input.quiet !== null) {
    const q = input.quiet;
    if (!isObj(q) || !TIME.test(q.from) || !TIME.test(q.to) || q.from === q.to) throw new Error("quiet hours: from and to as HH:MM, not the same");
    quiet = { from: q.from, to: q.to };
  }
  const digestAt = input.digestAt === undefined ? "07:00" : input.digestAt;
  if (!TIME.test(digestAt)) throw new Error("digest: a time as HH:MM");
  return { channels, quiet, digestAt };
}

/* ------------------------------------------------------------------ messages */
const UNIT = { "disk.used": "%", mem: "%", cpu: "%", temp: " °C" };
function what(e) {
  const k = String(e.rule).replace(/_([a-z])/g, (m, c) => c.toUpperCase());
  const label = e.name || (tr("alert.rule." + k) !== "alert.rule." + k ? tr("alert.rule." + k) : e.rule);
  return label + (e.sub ? " " + e.sub : "");
}
const valueOf = (e) => (typeof e.value === "number" && Number.isFinite(e.value) && !/^(reboot_required|container\.down|offline)$/.test(e.metric || e.rule)
  ? Math.round(e.value * 10) / 10 + (UNIT[e.metric] || "") : "");
const clock = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
// one line for an event: "fired: disk full /srv on nas · 92%"
function line(e) {
  const kind = e.ended ? "ended" : e.kind === "resolved" || e.kind === "repeat" ? e.kind : "firing";
  const v = valueOf(e);
  return tr("notify.line", { kind: tr("alert.kind." + kind), what: what(e), node: e.nodeName || e.node }) + (v ? " · " + v : "");
}
function alertMessage(e) {
  const kind = e.ended ? "ended" : e.kind === "resolved" || e.kind === "repeat" ? e.kind : "firing";
  const title = tr("notify.title", { head: kind === "firing" ? tr("alert.sev." + (SEV.includes(e.severity) ? e.severity : "info")) : tr("alert.kind." + kind),
                                     what: what(e), node: e.nodeName || e.node });
  const v = valueOf(e);
  const text = (v ? tr("notify.value", { value: v }) + "\n" : "") + tr("notify.since", { time: clock(e.since || e.at) });
  return { kind: "alert", severity: e.severity, resolved: e.kind === "resolved", title, text, event: e };
}

/* ------------------------------------------------------------------ the notifier */
function createNotifier({ dir, outbound, now = Date.now, log = { info() {}, warn() {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)).then(() => {}), env = process.env } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "channels.json"), stFile = path.join(dir, "notify-state.json");
  let cfg = { channels: [], quiet: null, digestAt: "07:00" };
  try { cfg = checkChannels(JSON.parse(fs.readFileSync(cfgFile, "utf8"))); }
  catch (e) { if (e.code !== "ENOENT") log.warn("alerts.channels_ignored", { error: e.message }); }
  let st = { held: [], digest: [], digestDay: null, quietWas: false };
  try {
    const f = JSON.parse(fs.readFileSync(stFile, "utf8"));
    if (Array.isArray(f.held)) st.held = f.held;
    if (Array.isArray(f.digest)) st.digest = f.digest;
    if (typeof f.digestDay === "string") st.digestDay = f.digestDay;
    st.quietWas = f.quietWas === true;
  } catch (_) { /* first start */ }
  let saved = JSON.stringify(st);
  const save = () => {
    const s = JSON.stringify(st);
    if (s === saved) return;
    try { writeFileAtomic(stFile, s, 0o600); saved = s; } catch (e) { log.warn("alerts.notify_state_failed", { error: e.code || String(e) }); }
  };
  const status = {};   // id → { lastOk, lastError, at }
  const pending = new Set();

  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  function inQuiet(t) {
    if (!cfg.quiet) return false;
    const d = new Date(t), m = d.getHours() * 60 + d.getMinutes(), a = mins(cfg.quiet.from), b = mins(cfg.quiet.to);
    return a < b ? m >= a && m < b : m >= a || m < b;
  }
  const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

  // a channel's config with "$NAME" read from the environment
  const resolved = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, ENVREF.test(v) ? env[v.slice(1)] || "" : v]));
  async function sendOnce(ch, m) {
    const req = ADAPTERS[ch.type].build(resolved(ch.config), m);
    const r = await outbound.request(req.url, { method: "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
  }
  const errText = (e) => (e && e.code ? String(e.code) : "failed");
  async function send(ch, m) {
    for (let i = 0; ; i++) {
      try {
        await sendOnce(ch, m);
        status[ch.id] = { ...status[ch.id], lastOk: now() };
        return true;
      } catch (e) {
        status[ch.id] = { ...status[ch.id], lastError: errText(e), at: now() };
        if (i >= RETRIES.length) { log.warn("alert.notify_failed", { channel: ch.id, type: ch.type, error: errText(e) }); return false; }
        await sleep(RETRIES[i]);
      }
    }
  }
  function deliver(m, to) {
    for (const ch of cfg.channels.filter((c) => c.on && to(c))) {
      const p = send(ch, m);
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  }
  const slim = (e) => ({ kind: e.kind, rule: e.rule, ...(e.name ? { name: e.name } : {}), ...(e.metric ? { metric: e.metric } : {}), severity: e.severity,
    node: e.node, nodeName: e.nodeName, ...(e.sub ? { sub: e.sub } : {}), value: e.value, at: e.at, since: e.since, ...(e.ended ? { ended: e.ended } : {}) });

  return {
    // an alert event from the engine
    onEvent(e) {
      const t = now();
      if (rank(e.severity) >= 2) {
        st.digest.push(slim(e));
        if (st.digest.length > MAX_DIGEST) st.digest.splice(0, st.digest.length - MAX_DIGEST);
        save();
        return;
      }
      if (e.severity !== "critical" && inQuiet(t)) {
        st.held.push(slim(e));
        if (st.held.length > MAX_HELD) st.held.splice(0, st.held.length - MAX_HELD);
        save();
        return;
      }
      deliver(alertMessage(e), (c) => rank(e.severity) <= rank(c.min));
    },
    // once a minute: the summary when quiet hours end, the digest at its time
    tick() {
      const t = now(), quiet = inQuiet(t);
      if (st.quietWas && !quiet && st.held.length) {
        // per alert, its last event: still firing, or ended after it was told before the window
        const last = new Map(), firedInside = new Set();
        for (const e of st.held) {
          const k = `${e.rule}|${e.node}|${e.sub || ""}`;
          last.set(k, e);
          if (e.kind === "firing") firedInside.add(k);
        }
        const lines = [...last.entries()].filter(([k, e]) => e.kind !== "resolved" || !firedInside.has(k)).map(([, e]) => line(e));
        if (lines.length) {
          deliver({ kind: "summary", severity: "warning", title: tr("notify.summaryTitle", { n: lines.length }), text: lines.join("\n") },
            (c) => rank("warning") <= rank(c.min));
        }
        st.held = [];
      }
      st.quietWas = quiet;
      const d = new Date(t);
      if (d.getHours() * 60 + d.getMinutes() >= mins(cfg.digestAt) && st.digestDay !== day(t)) {
        st.digestDay = day(t);
        if (st.digest.length) {
          deliver({ kind: "digest", severity: "info", title: tr("notify.digestTitle", { n: st.digest.length }), text: st.digest.map(line).join("\n") },
            (c) => c.digest !== false);
        }
        st.digest = [];
      }
      save();
    },
    // the page's "send test": one try, the answer at once
    async test(id) {
      const ch = cfg.channels.find((c) => c.id === id);
      if (!ch) return { ok: false, error: "no such channel" };
      try {
        await sendOnce(ch, { kind: "test", severity: "info", title: tr("notify.testTitle"), text: tr("notify.testText") });
        status[id] = { ...status[id], lastOk: now() };
        return { ok: true };
      } catch (e) {
        status[id] = { ...status[id], lastError: errText(e), at: now() };
        return { ok: false, error: errText(e) };
      }
    },
    setConfig(input) {
      const clean = checkChannels(input, cfg);
      writeFileAtomic(cfgFile, JSON.stringify(clean, null, 2) + "\n", 0o600);
      cfg = clean;
      for (const id of Object.keys(status)) if (!cfg.channels.some((c) => c.id === id)) delete status[id];
    },
    // for the page: secrets shown as ******** (sent back unchanged, they keep their value)
    view() {
      const mask = (ch) => ({ ...ch, config: Object.fromEntries(Object.entries(ch.config).map(([k, v]) =>
        [k, ADAPTERS[ch.type].fields[k].secret && !ENVREF.test(v) ? SECRET : v])) });
      return { channels: cfg.channels.map(mask), quiet: cfg.quiet, digestAt: cfg.digestAt, status: { ...status },
               types: Object.fromEntries(Object.entries(ADAPTERS).map(([t, a]) => [t, Object.entries(a.fields).map(([k, f]) => ({ key: k, secret: !!f.secret, optional: !!f.optional }))])) };
    },
    // for tests: wait for the sends under way
    flush() { return Promise.all([...pending]); },
  };
}

module.exports = { createNotifier, checkChannels, ADAPTERS, SECRET, alertMessage };
```

In `hub/lib/alerts.js`:

1. Replace

```js
  // (extra: { ended: "rule" } when it ends because its rule no longer holds there, not because it is fixed)
  function tell(kind, inst, r, t, extra) {
    const e = { kind, rule: inst.rule, ...(r.name ? { name: r.name } : {}), severity: r.severity, node: inst.node, nodeName: inst.nodeName,
                ...(inst.sub ? { sub: inst.sub } : {}), value: inst.value, at: t, since: inst.since, ...extra };
    const why = kind === "resolved" ? (inst.notified ? "" : quiet(inst, r, t) || "untold") : quiet(inst, r, t);
```

   with

```js
  // (extra: { ended: "rule" } when it ends because its rule no longer holds there, not because it is fixed)
  function tell(kind, inst, r, t, extra) {
    const e = { kind, rule: inst.rule, ...(r.name ? { name: r.name } : {}), ...(r.metric ? { metric: r.metric } : {}), severity: r.severity, node: inst.node, nodeName: inst.nodeName,
                ...(inst.sub ? { sub: inst.sub } : {}), value: inst.value, at: t, since: inst.since, ...extra };
    const why = kind === "resolved" ? (inst.notified ? "" : quiet(inst, r, t) || "untold") : quiet(inst, r, t);
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "alert.rule.rebootRequired": "reboot required", "alert.rule.securityUpdates": "security updates",

  // dialogs
  "dlg.close": "[esc]",
```

   with

```js
  "alert.rule.rebootRequired": "reboot required", "alert.rule.securityUpdates": "security updates",

  // what the alert channels send (the hub's words: hub/lib/notify.js)
  "notify.title": "{head}: {what} on {node}",
  "notify.line": "{kind}: {what} on {node}",
  "notify.value": "value {value}",
  "notify.since": "since {time}",
  "notify.summaryTitle": "{n} alerts held during quiet hours",
  "notify.digestTitle": "daily digest: {n} events",
  "notify.testTitle": "servitals test",
  "notify.testText": "This channel works.",

  // dialogs
  "dlg.close": "[esc]",
```

In `hub/server.js`:

1. Replace

```js
const { createAlerts } = require("./lib/alerts");
const alertRules = require("./lib/alertrules");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

   with

```js
const { createAlerts } = require("./lib/alerts");
const alertRules = require("./lib/alertrules");
const { createOutbound } = require("./lib/proxy");
const { createNotifier } = require("./lib/notify");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

2. Replace

```js
setInterval(historySweep, 86400000).unref();
historySweep();
// alerts (spec 8.1): judged on each push and once a minute; events go to the log (channels: 6c)
const HUB_START = Date.now();
// the alert rules the person set (spec 8.1); a file that cannot be read leaves the defaults
const RULES_F = path.join(DATA, "alerts", "rules.json");
```

   with

```js
setInterval(historySweep, 86400000).unref();
historySweep();
// alerts (spec 8.1): judged on each push and once a minute; events go to the log and to
// the channels the person set (spec 8.3, 8.4), through HTTPS_PROXY when hub.env sets one
const HUB_START = Date.now();
const outbound = createOutbound();
if (outbound.describe().https !== "direct" || outbound.describe().http !== "direct") log.info("outbound.proxy", outbound.describe());
const notifier = createNotifier({ dir: path.join(DATA, "alerts"), outbound, log });
// the alert rules the person set (spec 8.1); a file that cannot be read leaves the defaults
const RULES_F = path.join(DATA, "alerts", "rules.json");
```

3. Replace

```js
  rules: alertRules.buildRules(savedRules),
  warn: (event, fields) => log.warn(event, fields),
  onEvent: (e) => log.info("alert." + e.kind, { rule: e.rule, severity: e.severity, node: e.node, ...(e.sub ? { sub: e.sub } : {}), value: e.value }),
});
const nodeName = (id) => { const n = nodes.get(id); return (n && n.name) || id; };
```

   with

```js
  rules: alertRules.buildRules(savedRules),
  warn: (event, fields) => log.warn(event, fields),
  onEvent: (e) => {
    log.info("alert." + e.kind, { rule: e.rule, severity: e.severity, node: e.node, ...(e.sub ? { sub: e.sub } : {}), value: e.value });
    try { notifier.onEvent(e); } catch (err) { log.warn("alerts.notify_error", { error: err.code || String(err) }); }
  },
});
const nodeName = (id) => { const n = nodes.get(id); return (n && n.name) || id; };
```

4. Replace

```js
    }));
  } catch (e) { log.warn("alerts.check_failed", { error: e.code || String(e) }); }
}, 60000).unref();
const agentApi = createAgentApi({
```

   with

```js
    }));
  } catch (e) { log.warn("alerts.check_failed", { error: e.code || String(e) }); }
  try { notifier.tick(); } catch (e) { log.warn("alerts.notify_error", { error: e.code || String(e) }); }
}, 60000).unref();
const agentApi = createAgentApi({
```

5. Replace

```js
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
```

   with

```js
    }

    // the alert channels (spec 8.4): secrets come back masked; a save keeps a masked one
    if (req.method === "GET" && pathname === "/__ctl/alerts/channels") return json(200, notifier.view());
    if (req.method === "POST" && pathname === "/__ctl/alerts/channels") {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 64 * 1024)); } catch (_) { return json(400, { error: "invalid json" }); }
      try { notifier.setConfig(body); } catch (e) { return json(e.code ? 500 : 400, { error: e.code ? String(e.code) : e.message }); }
      log.audit("alert.channels_saved", { ip, channels: notifier.view().channels.length });
      return json(200, { ok: true });
    }
    // "send test": one message, the answer at once
    if (req.method === "POST" && pathname === "/__ctl/alerts/channels/test") {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 1024)); } catch (_) { return json(400, { error: "invalid json" }); }
      const id = body && typeof body.id === "string" ? body.id : "";
      return json(200, await notifier.test(id));
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Alert rules (spec 8.1): the alerts view's "rules" tab changes a default
  rule's threshold, time, clear value and severity, or turns it off; adds
```

   with

```markdown

### Added
- Alert channels (spec 8.3, 8.4): ntfy and webhooks (JSON, signed with
  `X-Servitals-Signature` when a secret is set) get each alert at or above
  their minimum severity. Quiet hours hold warnings (critical always goes
  through) and send one summary of what still fires when they end; info
  events go to one digest a day at 07:00. A failed send is tried again after
  2, 10 and 30 s, then logged as `alert.notify_failed`. Channels live in the
  state directory's `alerts/channels.json` (mode 0600); a value `$NAME` is read
  from the environment. `GET` and `POST /__ctl/alerts/channels`, and
  `POST /__ctl/alerts/channels/test` to send a test. The page's channel
  settings follow.
- Outbound proxy (spec 8.4): every call the hub makes goes through
  `HTTPS_PROXY` / `HTTP_PROXY` from `hub.env` unless `NO_PROXY` says
  otherwise, with a `CONNECT` tunnel for HTTPS.
- Alert rules (spec 8.1): the alerts view's "rules" tab changes a default
  rule's threshold, time, clear value and severity, or turns it off; adds
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 424 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/notify.js hub/lib/alerts.js hub/lib/i18n.js hub/server.js test/notify.test.js test/alerts.test.js test/agentapi.test.js test/i18n.test.js CHANGELOG.md
git commit -m "feat(hub): alert channels: ntfy and webhooks by severity, quiet hours with a summary, a daily digest, retries"
```
