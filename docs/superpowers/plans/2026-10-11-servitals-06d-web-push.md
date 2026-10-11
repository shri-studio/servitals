# servitals Phone Notifications (Web Push, sub-project 6d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone or computer turns on notifications from settings, and alerts then arrive as system notifications (one per alert; a tap opens that server's view), through Web Push implemented with Node's crypto only.

**Why:** the installable app (spec 10.3) is where most people will look at servitals from a phone. Web Push is the one channel that needs no third-party account, and spec 8.3 makes it a default for warning and critical.

**Architecture:**
- **`hub/lib/webpush.js` (new):**
  - `loadVapid(file)`: a P-256 key pair made on first run, kept in `vapid.json` (0600); a broken file means new keys.
  - `vapidHeader({endpoint, subject, keys, now})`: RFC 8292, `vapid t=<ES256 JWT for the push service's origin, 12 h>, k=<public key>` (`crypto.sign` with `dsaEncoding: "ieee-p1363"`).
  - `encrypt({payload, p256dh, auth, salt?, serverKeys?})`: RFC 8291 aes128gcm, one record (delimiter 2), rs 4096; equal to RFC 8291 appendix A byte for byte.
  - `sendPush({subscription, payload, keys, subject, outbound, ttl, urgency})` through the outbound client (proxy).
  - `createPushStore(file)`: the browsers that subscribed (`push-subscriptions.json`, 0600, at most 50, https endpoints, checked keys); `devices()` for the page never shows an endpoint or a key.
- **`hub/lib/notify.js`:** a `webpush` adapter (no fields) that sends `{title, body, severity, tag, url}` to every device through a `push` object given to the notifier; `ensureWebPush(name)` adds a "phone notifications" channel (warning and up) when the first device subscribes; `EPUSH_NONE` and `EPUSH_OFF` are final.
- **`hub/server.js`:** VAPID keys and the store at start; `push.sendAll` sends to each device once, removes a gone one (404, 410; logged `push.subscription_gone`), and fails only when no device took the message; the subject is `VAPID_SUBJECT`, else `PUBLIC_URL`, else the page's https origin at the last subscribe, else `mailto:servitals@localhost`. `GET /__ctl/push` → `{publicKey, devices, https}`; `POST /__ctl/push/subscribe` and `/unsubscribe` (audited).
- **The page:** a "notifications on this device" section in settings (`www/js/settings.js`): HTTPS needed (with a link to the new HTTPS section of `docs/networking.md`), the browser cannot (iOS hint), blocked, or on/off; "enable notifications" asks permission, subscribes with the hub's key (an old subscription is renewed) and tells the hub; "turn them off here" unsubscribes.
- **`www/sw.js`:** `push` shows the notification (tag per alert, renotify, the hub's icon); the URL is only ever `/` or `/#node=<id>`; `notificationclick` focuses an open window of the hub and navigates it, or opens one.
- `packaging/etc/hub.env` (`VAPID_SUBJECT`), `docs/networking.md` (HTTPS for phone notifications), `CHANGELOG.md`.

**Tech Stack:** Node.js ≥ 18 built-ins (`crypto`: ECDH, HMAC, AES-128-GCM, ECDSA); the browser's Push API and service worker.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` 8.5 (zero-dependency VAPID and aes128gcm, RFC test vectors, `vapid.json`, `VAPID_SUBJECT`, "Enable notifications" in settings, iOS, HTTPS with the guide, expired subscriptions removed), 8.3 (Web Push for warning and critical), 10.3 (the installable app).

**Scope:** 6d. Next: 1.0 hardening.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (f39a304) on 2026-10-11: node suite 456 tests; budget, screens, compose smoke, both packages and autopkgtest pass.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6c still holds.
- Keys and subscriptions 0600; an endpoint (a capability) never reaches the page or the log.
- The strict CSP; every word through `tr()`.
- Work in a worktree `.claude/worktrees/servitals-push` on branch `feat/push` from `main` (f39a304).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **The crypto:** RFC 8291's vector, a fresh message a browser decrypts, bad keys, the JWT's claims and signature. Tests: test/webpush.test.js.
2. **Subscriptions:** http endpoints, bad keys, 50 devices, a gone device, a device that fails, all gone. Tests: "Web Push: a browser subscribes…" (agentapi), "Web Push: one payload…" (notify).
3. **Where a tap goes:** a payload whose url points elsewhere, an open window, none. Test: "a push shows its alert…".
4. **The settings section across browsers:** plain HTTP, no Push API (iOS outside the home screen), denied permission, a renewed subscription. Test: "settings: notifications need HTTPS…".
5. **Secrets:** endpoints and keys never in the page or the log, file modes. Tests: the agentapi test.

---

### Task 1: Web Push with Node's crypto

**Files:**
- Create: `hub/lib/webpush.js`, `test/webpush.test.js`, `test/helpers/push.js`

**Interfaces:**
- Produces: `loadVapid`, `vapidHeader`, `encrypt`, `sendPush`, `newKeys`, `createPushStore`, `checkSubscription`; the test helper `decrypt(body, uaPrivate, auth)` and `UA` (RFC 8291's user agent keys). Task 2 wires them into the hub.

- [ ] **Step 1: Write the failing tests**

Create `test/helpers/push.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Web Push from the browser's side (RFC 8291, the user agent): decrypt an aes128gcm body
 * with the subscription's private key and auth secret. Keys from RFC 8291 appendix A.
 */
const assert = require("node:assert");
const crypto = require("node:crypto");

const UA = { private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };

function decrypt(body, uaPrivate = UA.private, auth = UA.auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivate, "base64url"));
  const h = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const ikm = h(h(Buffer.from(auth, "base64url"), ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const d = crypto.createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, "the last record's delimiter");
  return plain.subarray(0, -1).toString();
}

module.exports = { decrypt, UA };
```

Create `test/webpush.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Web Push (spec 8.5): aes128gcm against RFC 8291's test vector, a round trip a browser
 * would decrypt, the VAPID JWT (RFC 8292) checked with the public key, the key file.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadVapid, vapidHeader, encrypt, sendPush, newKeys } = require("../hub/lib/webpush");

// RFC 8291, appendix A
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const { decrypt } = require("./helpers/push");

test("aes128gcm: RFC 8291's test vector, byte for byte", () => {
  const out = encrypt({ payload: RFC.plaintext, p256dh: RFC.uaPublic, auth: RFC.auth, salt: Buffer.from(RFC.salt, "base64url"), serverKeys: { privateKey: RFC.asPrivate } });
  assert.strictEqual(out.toString("base64url"), RFC.body);
});

test("a fresh message decrypts on the browser's side; a bad key is refused", () => {
  const body = encrypt({ payload: JSON.stringify({ title: "critical: disk full /srv on nas — ünïcode" }), p256dh: RFC.uaPublic, auth: RFC.auth });
  assert.strictEqual(body.readUInt32BE(16), 4096, "record size");
  assert.deepStrictEqual(JSON.parse(decrypt(body, RFC.uaPrivate, RFC.auth)), { title: "critical: disk full /srv on nas — ünïcode" });
  const again = encrypt({ payload: "x", p256dh: RFC.uaPublic, auth: RFC.auth });
  assert.notDeepStrictEqual(again.subarray(0, 16), body.subarray(0, 16), "a new salt each time");
  assert.throws(() => encrypt({ payload: "x", p256dh: "AAAA", auth: RFC.auth }), (e) => e.code === "EPUSHKEY");
  assert.throws(() => encrypt({ payload: "x", p256dh: RFC.uaPublic, auth: "AAAA" }), (e) => e.code === "EPUSHKEY");
});

test("VAPID: an ES256 JWT for the push service's origin, 12 hours, checked with the public key", () => {
  const keys = newKeys();
  const now = 1790000000000;
  const h = vapidHeader({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", subject: "https://dash.example.org", keys, now });
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.strictEqual(k, keys.publicKey);
  const [head, body, sig] = jwt.split(".");
  assert.deepStrictEqual(JSON.parse(Buffer.from(head, "base64url")), { typ: "JWT", alg: "ES256" });
  assert.deepStrictEqual(JSON.parse(Buffer.from(body, "base64url")), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 43200, sub: "https://dash.example.org" });
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
  assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("the VAPID keys are made once and kept 0600; a push carries the encrypted body and the VAPID header", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-push-"));
  const f = path.join(dir, "vapid.json");
  const a = loadVapid(f), b = loadVapid(f);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, "{broken");
  assert.notDeepStrictEqual(loadVapid(f), a, "a broken file: new keys (every browser subscribes again)");
  const sent = [];
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); return { status: 201 }; } };
  const r = await sendPush({ subscription: { endpoint: "https://push.example.net/s/1", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } },
    payload: "{\"title\":\"t\"}", keys: a, subject: "mailto:admin@example.org", outbound, urgency: "high" });
  assert.deepStrictEqual(r, { status: 201 });
  assert.deepStrictEqual([sent[0].headers["content-encoding"], sent[0].headers.ttl, sent[0].headers.urgency], ["aes128gcm", "86400", "high"]);
  assert.match(sent[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.strictEqual(decrypt(sent[0].body, RFC.uaPrivate, RFC.auth), "{\"title\":\"t\"}");
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/webpush.test.js`
Expected: FAIL, the file as a whole (`Cannot find module '../hub/lib/webpush'`).

- [ ] **Step 3: The module**

Create `hub/lib/webpush.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Web Push (spec 8.5), with Node's crypto only:
 *   - VAPID (RFC 8292): a P-256 key pair made on first run and kept in vapid.json (0600);
 *     each push carries "Authorization: vapid t=<ES256 JWT>, k=<public key>".
 *   - the payload encrypted as aes128gcm (RFC 8188, RFC 8291): ECDH with the browser's
 *     key, HKDF with its auth secret, one AES-128-GCM record.
 *   loadVapid(file) → { publicKey, privateKey } (base64url: 65-byte point, 32-byte d)
 *   vapidHeader({ endpoint, subject, keys, now }) → the Authorization header's value
 *   encrypt({ payload, p256dh, auth, salt?, serverKeys? }) → Buffer (salt and keys only for tests)
 *   sendPush({ subscription, payload, keys, subject, outbound, ttl, urgency }) → { status }
 *   createPushStore(file) → { list(), add(subscription, label), remove(endpoint), devices() }:
 *     the browsers that subscribed (push-subscriptions.json, 0600), at most 50
 */
const crypto = require("crypto");
const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// a P-256 key pair as base64url: the public key as an uncompressed point, the private as d
function newKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
function loadVapid(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8"));
    if (unb64u(k.publicKey).length === 65 && unb64u(k.privateKey).length === 32) { try { fs.chmodSync(file, 0o600); } catch (_) { /* read-only */ } return k; }
  } catch (_) { /* first run */ }
  const k = newKeys();
  writeFileAtomic(file, JSON.stringify(k) + "\n", 0o600);
  return k;
}

// the private key as a KeyObject for signing
function signingKey(keys) {
  const pub = unb64u(keys.publicKey);
  return crypto.createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
}
// RFC 8292: a JWT for the push service's origin, valid 12 hours
function vapidHeader({ endpoint, subject, keys, now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: signingKey(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

// RFC 8291 section 3.4 and RFC 8188: one record, the last (delimiter 0x02), no padding
function encrypt({ payload, p256dh, auth, salt = crypto.randomBytes(16), serverKeys }) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw Object.assign(new Error("p256dh is not a P-256 point"), { code: "EPUSHKEY" });
  if (authSecret.length !== 16) throw Object.assign(new Error("auth is not 16 bytes"), { code: "EPUSHKEY" });
  const ecdh = crypto.createECDH("prime256v1");
  if (serverKeys) ecdh.setPrivateKey(unb64u(serverKeys.privateKey)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
}

// one push: resolves the push service's status (201 sent; 404 or 410: the subscription is gone)
async function sendPush({ subscription, payload, keys, subject, outbound, ttl = 86400, urgency = "normal" }) {
  const body = encrypt({ payload, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
  const r = await outbound.request(subscription.endpoint, { method: "POST", timeoutMs: 15000, body, headers: {
    "content-type": "application/octet-stream", "content-encoding": "aes128gcm", ttl: String(ttl), urgency,
    authorization: vapidHeader({ endpoint: subscription.endpoint, subject, keys }) } });
  return { status: r.status };
}

// a subscription as a browser sends it: { endpoint (https), keys: { p256dh, auth } }
function checkSubscription(s) {
  if (!s || typeof s !== "object" || typeof s.endpoint !== "string" || s.endpoint.length > 2048) throw new Error("subscription: an endpoint");
  let u;
  try { u = new URL(s.endpoint); } catch (_) { throw new Error("subscription: an endpoint"); }
  if (u.protocol !== "https:") throw new Error("subscription: an https endpoint");
  const k = s.keys || {};
  if (typeof k.p256dh !== "string" || unb64u(k.p256dh).length !== 65 || typeof k.auth !== "string" || unb64u(k.auth).length !== 16) throw new Error("subscription: its keys");
  return { endpoint: u.href, keys: { p256dh: k.p256dh, auth: k.auth } };
}
function createPushStore(file) {
  let subs = [];
  try { const f = JSON.parse(fs.readFileSync(file, "utf8")); if (Array.isArray(f.subscriptions)) subs = f.subscriptions; } catch (_) { /* none yet */ }
  const save = () => writeFileAtomic(file, JSON.stringify({ subscriptions: subs }, null, 2) + "\n", 0o600);
  const id = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
  return {
    list: () => subs.slice(),
    add(sub, label) {
      const clean = checkSubscription(sub);
      const name = typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60) : "";
      subs = subs.filter((s) => s.endpoint !== clean.endpoint);
      if (subs.length >= 50) throw new Error("at most 50 devices");
      subs.push({ ...clean, label: name, created: Date.now() });
      save();
      return id(clean.endpoint);
    },
    remove(endpoint) {
      const n = subs.length;
      subs = subs.filter((s) => s.endpoint !== endpoint && id(s.endpoint) !== endpoint);
      if (subs.length !== n) save();
      return subs.length !== n;
    },
    // for the page: never an endpoint (it is a capability) or a key
    devices: () => subs.map((s) => ({ id: id(s.endpoint), label: s.label, created: s.created, service: new URL(s.endpoint).host })),
  };
}

module.exports = { loadVapid, vapidHeader, encrypt, sendPush, newKeys, createPushStore, checkSubscription };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 451 tests (4 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/webpush.js test/webpush.test.js test/helpers/push.js
git commit -m "feat(hub): Web Push with Node's crypto: VAPID (ES256) and aes128gcm, checked against RFC 8291"
```

---

### Task 2: Subscribe from settings, the Web Push channel, the service worker

**Files:**
- Modify: `hub/lib/notify.js`, `hub/server.js`, `hub/lib/i18n.js`, `www/js/settings.js`, `www/sw.js`, `www/index.html`, `test/notify.test.js`, `test/agentapi.test.js`, `test/pwa.test.js`, `packaging/etc/hub.env`, `docs/networking.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1's module; the notifier and its channels (6c).
- Produces: `ADAPTERS.webpush`; `createNotifier({…, push})` and `ensureWebPush(name)`; `GET /__ctl/push`, `POST /__ctl/push/subscribe`, `POST /__ctl/push/unsubscribe`; settings.js `pushSupport`, `deviceLabel`, `pushSub`, `drawPush`, `enablePush`, `disablePush`, `b64uBytes`; sw.js `push` and `notificationclick` handlers.

- [ ] **Step 1: Write the failing tests**

In `test/notify.test.js`:

1. Replace

```js
const hook = (extra = {}) => ({ id: "ch_w", type: "webhook", name: "pager", min: "critical", on: true, config: { url: "https://hooks.test/T0K3N", secret: "s3" }, ...extra });

function setup(config, { fail = () => 0, sleep, sendMail, execFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notify-"));
  const sent = [], logs = [], slept = [];
```

   with

```js
const hook = (extra = {}) => ({ id: "ch_w", type: "webhook", name: "pager", min: "critical", on: true, config: { url: "https://hooks.test/T0K3N", secret: "s3" }, ...extra });

function setup(config, { fail = () => 0, sleep, sendMail, execFile, push } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notify-"));
  const sent = [], logs = [], slept = [];
```

2. Replace

```js
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); const s = fail(url, sent.length); return { status: s || 200, headers: {}, body: "" }; } };
  const make = () => createNotifier({ dir, outbound, now: () => clock.t, env: { SERVITALS_NOTIFY_NTFY: "from_env", SERVITALS_NOTIFY_HOOK: "https://hooks.test/env", SERVITALS_NOTIFY_BAD: "ftp://x", AUTH_PASS: "pw" },
    log: { info() {}, warn: (event, f) => logs.push([event, f]) }, sleep: sleep || (async (ms) => { slept.push(ms); }), sendMail, execFile });
  const n = make();
  if (config) n.setConfig(config);
```

   with

```js
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); const s = fail(url, sent.length); return { status: s || 200, headers: {}, body: "" }; } };
  const make = () => createNotifier({ dir, outbound, now: () => clock.t, env: { SERVITALS_NOTIFY_NTFY: "from_env", SERVITALS_NOTIFY_HOOK: "https://hooks.test/env", SERVITALS_NOTIFY_BAD: "ftp://x", AUTH_PASS: "pw" },
    log: { info() {}, warn: (event, f) => logs.push([event, f]) }, sleep: sleep || (async (ms) => { slept.push(ms); }), sendMail, execFile, push });
  const n = make();
  if (config) n.setConfig(config);
```

3. Replace

```js
  assert.deepStrictEqual([STRINGS["ch.field.user"], STRINGS["ch.field.login"]], ["user key", "login"], "Pushover keeps its label");
});
```

   with

```js
  assert.deepStrictEqual([STRINGS["ch.field.user"], STRINGS["ch.field.login"]], ["user key", "login"], "Pushover keeps its label");
});

test("Web Push: one payload for the service worker, per alert a tag and its node's view; no device is not retried", async () => {
  const pushed = [];
  let fail = null;
  const s = setup(null, { push: { sendAll: async (p) => { pushed.push(JSON.parse(p)); if (fail) throw Object.assign(new Error("x"), { code: fail }); } } });
  assert.strictEqual(s.n.ensureWebPush("phone notifications"), true);
  assert.strictEqual(s.n.ensureWebPush("phone notifications"), false, "once");
  assert.deepStrictEqual(s.n.view().channels, [{ id: "ch_webpush", type: "webpush", name: "phone notifications", min: "warning", on: true, config: {} }]);
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.deepStrictEqual(pushed[0], { title: "warning: disk full /srv on nas", body: "value 92%\nsince 11:55", severity: "warning",
    tag: "disk_full|nodeaaaaaaaa|/srv", url: "/#node=nodeaaaaaaaa" });
  fail = "EPUSH_NONE";
  s.n.onEvent(ev("firing", "critical"));
  await s.n.flush();
  assert.strictEqual(pushed.length, 2, "no device subscribed: nothing to try again");
  const off = setup({ channels: [{ id: "ch_webpush", type: "webpush", name: "p", min: "warning", on: true, config: {} }] });
  assert.deepStrictEqual(await off.n.test("ch_webpush"), { ok: false, error: "EPUSH_OFF" });
});
```

In `test/agentapi.test.js`:

1. Replace

```js
  } finally { dest.close(); }
});
```

   with

```js
  } finally { dest.close(); }
});

test("Web Push: a browser subscribes, gets a channel, receives an alert it can decrypt; a gone subscription is removed", async () => {
  const { decrypt, UA } = require("./helpers/push");
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", path.join(dir, "k"), "-out", path.join(dir, "c"),
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const got = [];
  let answer = 201;
  const service = require("node:https").createServer({ key: fs.readFileSync(path.join(dir, "k")), cert: fs.readFileSync(path.join(dir, "c")) }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(answer); res.end(); });
  });
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  const endpoint = `https://127.0.0.1:${service.address().port}/push/abc`;
  try {
    await withHub(async (hub, c) => {
      const cookie = cookieFrom(await login(hub.port));
      const get = async (p) => JSON.parse((await request(hub.port, { path: p, headers: { cookie } })).body);
      const p0 = await get("/__ctl/push");
      assert.strictEqual(Buffer.from(p0.publicKey, "base64url").length, 65);
      assert.deepStrictEqual([p0.devices, p0.https], [[], false]);
      const sub = (b) => ctlPost(hub.port, cookie, "/__ctl/push/subscribe", JSON.stringify(b));
      assert.strictEqual((await sub({ subscription: { endpoint: endpoint.replace("https", "http"), keys: { p256dh: UA.public, auth: UA.auth } } })).status, 400, "https only");
      const r = JSON.parse((await sub({ subscription: { endpoint, keys: { p256dh: UA.public, auth: UA.auth } }, label: "Android Chrome" })).body);
      assert.deepStrictEqual([r.ok, r.channelAdded], [true, true]);
      const devs = (await get("/__ctl/push")).devices;
      assert.deepStrictEqual(devs.map((d) => [d.label, d.service]), [["Android Chrome", `127.0.0.1:${service.address().port}`]]);
      assert.doesNotMatch(JSON.stringify(devs), /push\/abc/, "the page never sees an endpoint");
      assert.strictEqual(fs.statSync(path.join(hub.dataDir, "push-subscriptions.json")).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.join(hub.dataDir, "vapid.json")).mode & 0o777, 0o600);
      assert.strictEqual((await get("/__ctl/alerts/channels")).channels[0].type, "webpush");
      assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/rules", JSON.stringify({ rules: [{ id: "reboot_required", severity: "warning" }] }))).status, 200);
      assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true } }) })).status, 200);
      for (let i = 0; i < 100 && !got.length; i++) await new Promise((res) => setTimeout(res, 20));
      assert.strictEqual(got[0].headers["content-encoding"], "aes128gcm");
      assert.match(got[0].headers.authorization, new RegExp(`^vapid t=.+, k=${p0.publicKey}$`));
      const msg = JSON.parse(decrypt(got[0].body));
      assert.match(msg.title, /^warning: reboot required on /);
      assert.deepStrictEqual([msg.url, msg.tag], [`/#node=${c.id}`, `reboot_required|${c.id}|`]);
      answer = 410;
      assert.deepStrictEqual(JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/alerts/channels/test", JSON.stringify({ id: "ch_webpush" }))).body),
        { ok: false, error: "EPUSH_NONE" }, "the only device was gone");
      assert.deepStrictEqual((await get("/__ctl/push")).devices, [], "410: the subscription is gone");
      assert.match(hub.logs(), /event=push\.subscription_gone/);
      assert.match(hub.logs(), /event=push\.subscribed/);
      assert.doesNotMatch(hub.logs(), /push\/abc/, "never an endpoint in the log");
    }, { NODE_EXTRA_CA_CERTS: path.join(dir, "c") });
  } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

In `test/pwa.test.js`:

1. Replace

```js
  assert.deepStrictEqual(await run(Date.now() - 5000), ["alerts"]);
});
```

   with

```js
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
  const env = (o) => pageScope(["pushSupport", "deviceLabel", "pushSub", "drawPush", "enablePush", "disablePush"], {
    $, toast: (m, err) => toasts.push([m, !!err]), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    b64uBytes: (s) => Uint8Array.from(Buffer.from(s, "base64url")),
    fetch: async (url, opt) => { if (opt) sent.push([url, JSON.parse(opt.body)]); return { ok: true, json: async () => ({ publicKey: key.getPublicKey().toString("base64url") }) }; },
    ...o });
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/notify.test.js test/agentapi.test.js test/pwa.test.js`
Expected: FAIL, 5 tests: "Web Push: one payload…", "Web Push: a browser subscribes…", "a push shows its alert…", "settings: notifications need HTTPS…", "the hub's key in base64url…".

- [ ] **Step 3: The hub**

In `hub/lib/notify.js`:

1. Replace

```js
    },
  },
  // a room message: PUT with a transaction id, so a retry is not a second message
  matrix: {
```

   with

```js
    },
  },
  // Web Push (spec 8.5): to every browser that subscribed (the hub's push store)
  webpush: {
    fields: {},
    send(c, m, ctx) {
      if (!ctx.push) throw Object.assign(new Error("web push is off"), { code: "EPUSH_OFF" });
      // what the service worker shows; one notification per alert (tag), its node's view on a tap
      const e = m.event;
      return ctx.push.sendAll(JSON.stringify({ title: cut(m.title, 200), body: fit(m.text, 1500), severity: m.severity,
        tag: e ? `${e.rule}|${e.node}|${e.sub || ""}` : m.kind, url: e && /^[a-z2-7]{12}$/.test(e.node) ? "/#node=" + e.node : "/" }));
    },
  },
  // a room message: PUT with a transaction id, so a retry is not a second message
  matrix: {
```

2. Replace

```js
/* ------------------------------------------------------------------ the notifier */
function createNotifier({ dir, outbound, now = Date.now, log = { info() {}, warn() {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)).then(() => {}), env = process.env,
                          execFile = childProcess.execFile, sendMail = smtp.sendMail } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "channels.json"), stFile = path.join(dir, "notify-state.json");
```

   with

```js
/* ------------------------------------------------------------------ the notifier */
function createNotifier({ dir, outbound, now = Date.now, log = { info() {}, warn() {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)).then(() => {}), env = process.env,
                          execFile = childProcess.execFile, sendMail = smtp.sendMail, push = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "channels.json"), stFile = path.join(dir, "notify-state.json");
```

3. Replace

```js
  async function sendOnce(ch, m) {
    const ad = ADAPTERS[ch.type];
    if (ad.send) { await ad.send(resolved(ch), m, { outbound, execFile, sendMail }); return; }
    const req = ad.build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: req.method || "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
```

   with

```js
  async function sendOnce(ch, m) {
    const ad = ADAPTERS[ch.type];
    if (ad.send) { await ad.send(resolved(ch), m, { outbound, execFile, sendMail, push }); return; }
    const req = ad.build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: req.method || "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
```

4. Replace

```js
  // (SMTP: a 5xx is final, a 4xx is "try later"; no TLS, a bad address, no apprise: final)
  const final = (e) => /^HTTP_4\d\d$/.test(e.code) && !/^HTTP_(408|429)$/.test(e.code) || /^SMTP_5/.test(e.code)
    || /^(ENV_UNSET|EBADVALUE|EURL|ETLSREQUIRED|EADDRESS|APPRISE_MISSING|ERR_TLS_CERT|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|CERT_)/.test(String(e.code));
  async function send(ch, m) {
    for (let i = 0; ; i++) {
```

   with

```js
  // (SMTP: a 5xx is final, a 4xx is "try later"; no TLS, a bad address, no apprise: final)
  const final = (e) => /^HTTP_4\d\d$/.test(e.code) && !/^HTTP_(408|429)$/.test(e.code) || /^SMTP_5/.test(e.code)
    || /^(ENV_UNSET|EBADVALUE|EURL|ETLSREQUIRED|EADDRESS|APPRISE_MISSING|EPUSH_NONE|EPUSH_OFF|ERR_TLS_CERT|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|CERT_)/.test(String(e.code));
  async function send(ch, m) {
    for (let i = 0; ; i++) {
```

5. Replace

```js
      }
    },
    setConfig(input) {
      const clean = checkChannels(input, cfg);
```

   with

```js
      }
    },
    // the first browser that subscribes gets a Web Push channel (warning and up), if none
    ensureWebPush(name) {
      if (cfg.channels.some((c) => c.type === "webpush")) return false;
      this.setConfig({ ...cfg, channels: [...cfg.channels, { id: "ch_webpush", type: "webpush", name, min: "warning", on: true, config: {} }] });
      return true;
    },
    setConfig(input) {
      const clean = checkChannels(input, cfg);
```

In `hub/server.js`:

1. Replace

```js
const { createOutbound } = require("./lib/proxy");
const { createNotifier } = require("./lib/notify");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

   with

```js
const { createOutbound } = require("./lib/proxy");
const { createNotifier } = require("./lib/notify");
const webpush = require("./lib/webpush");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
```

2. Replace

```js
const outbound = createOutbound();
if (outbound.describe().https !== "direct" || outbound.describe().http !== "direct") log.info("outbound.proxy", outbound.describe());
const notifier = createNotifier({ dir: path.join(DATA, "alerts"), outbound, log });
// the alert rules the person set (spec 8.1); a file that cannot be read leaves the defaults
const RULES_F = path.join(DATA, "alerts", "rules.json");
```

   with

```js
const outbound = createOutbound();
if (outbound.describe().https !== "direct" || outbound.describe().http !== "direct") log.info("outbound.proxy", outbound.describe());
// Web Push (spec 8.5): the VAPID keys made on first run, the browsers that subscribed
const vapid = webpush.loadVapid(path.join(DATA, "vapid.json"));
const pushStore = webpush.createPushStore(path.join(DATA, "push-subscriptions.json"));
let pushOrigin = "";   // the page's origin at the last subscribe: the VAPID subject when nothing else says
const pushSubject = () => {
  const s = process.env.VAPID_SUBJECT || PUBLIC_URL || pushOrigin;
  return /^(mailto:|https:\/\/)/.test(s) ? s.replace(/\/+$/, "") : "mailto:servitals@localhost";
};
const push = {
  // every device once; a gone one (404, 410) is removed; an error when none took it
  async sendAll(payload) {
    const subs = pushStore.list();
    if (!subs.length) throw Object.assign(new Error("no device subscribed"), { code: "EPUSH_NONE" });
    let ok = 0, last = null;
    for (const s of subs) {
      try {
        const r = await webpush.sendPush({ subscription: s, payload, keys: vapid, subject: pushSubject(), outbound, urgency: "high" });
        if (r.status === 404 || r.status === 410) { pushStore.remove(s.endpoint); log.info("push.subscription_gone", { service: new URL(s.endpoint).host }); }
        else if (r.status >= 200 && r.status < 300) ok++;
        else last = Object.assign(new Error(`HTTP ${r.status}`), { code: "HTTP_" + r.status });
      } catch (e) { last = e; }
    }
    if (!ok) throw last || Object.assign(new Error("no device left"), { code: "EPUSH_NONE" });
  },
};
const notifier = createNotifier({ dir: path.join(DATA, "alerts"), outbound, log, push });
// the alert rules the person set (spec 8.1); a file that cannot be read leaves the defaults
const RULES_F = path.join(DATA, "alerts", "rules.json");
```

3. Replace

```js
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
```

   with

```js
    }

    // Web Push (spec 8.5): the public key, this hub's devices; subscribe and unsubscribe
    if (req.method === "GET" && pathname === "/__ctl/push") {
      return json(200, { publicKey: vapid.publicKey, devices: pushStore.devices(),
                         https: requestIsHttps(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted }) });
    }
    if (req.method === "POST" && (pathname === "/__ctl/push/subscribe" || pathname === "/__ctl/push/unsubscribe")) {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 8192)); } catch (_) { return json(400, { error: "invalid json" }); }
      if (!body || typeof body !== "object") return json(400, { error: "invalid json" });
      if (pathname.endsWith("/unsubscribe")) {
        const gone = typeof body.endpoint === "string" && pushStore.remove(body.endpoint);
        log.audit("push.unsubscribed", { ip });
        return json(200, { ok: true, removed: gone });
      }
      let id;
      try { id = pushStore.add(body.subscription, body.label); } catch (e) { return json(400, { error: e.message }); }
      const o = req.headers.origin;
      if (typeof o === "string" && /^https:\/\/[^\s/]+$/.test(o)) pushOrigin = o;
      const added = notifier.ensureWebPush(tr("notify.webpushName"));
      log.audit("push.subscribed", { ip, device: id });
      return json(200, { ok: true, id, channelAdded: added });
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "notify.testText": "This channel works.",
  "notify.more": "+{n} more in the alert log",

  // dialogs
```

   with

```js
  "notify.testText": "This channel works.",
  "notify.more": "+{n} more in the alert log",
  "notify.webpushName": "phone notifications",
  "push.title": "notifications on this device",
  "push.enable": "enable notifications",
  "push.disable": "turn them off here",
  "push.guide": "how to serve servitals over HTTPS",
  "push.needHttps": "Notifications need servitals over HTTPS (a tunnel, a Tailscale certificate or a reverse proxy).",
  "push.unsupported": "This browser cannot get notifications. On iPhone and iPad, add servitals to the home screen first (iOS 16.4 or later).",
  "push.denied": "Notifications are blocked for this site; allow them in the browser's settings.",
  "push.onHere": "On for this device. The channels tab sets which alerts it gets.",
  "push.offHere": "Off for this device.",
  "push.enabled": "notifications on",
  "push.failed": "could not change notifications",

  // dialogs
```

- [ ] **Step 4: The page and the service worker**

In `www/js/settings.js`:

1. Replace

```js
  markManaged();
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
}
```

   with

```js
  markManaged();
  $("#acct-msg").textContent = "";
  drawPush();
  $("#overlay").classList.add("open");
}

/* ------------------------------------------------------------------ notifications on this device (spec 8.5)
   Web Push needs HTTPS and a service worker; on iPhone and iPad also the app on the home
   screen (iOS 16.4 or later). The hub's public key comes from GET /__ctl/push. */
const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
// "https" (plain HTTP), "unsupported", or "ok"
function pushSupport() {
  if (!window.isSecureContext) return "https";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return "unsupported";
  return "ok";
}
// a name for this device in the hub's list: the system and the browser (product names)
function deviceLabel() {
  const ua = navigator.userAgent || "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" ") || "browser";
}
async function pushSub() {
  const reg = await navigator.serviceWorker.ready;
  return { reg, sub: await reg.pushManager.getSubscription() };
}
async function drawPush() {
  const s = pushSupport();
  $("#push-guide").classList.toggle("hidden", s !== "https");
  $("#push-on").classList.add("hidden");
  $("#push-off").classList.add("hidden");
  if (s === "https") { $("#push-msg").textContent = tr("push.needHttps"); return; }
  if (s !== "ok") { $("#push-msg").textContent = tr("push.unsupported"); return; }
  if (Notification.permission === "denied") { $("#push-msg").textContent = tr("push.denied"); return; }
  let sub = null;
  try { sub = (await pushSub()).sub; } catch (e) { sub = null; }
  $("#push-msg").textContent = sub ? tr("push.onHere") : tr("push.offHere");
  $("#push-on").classList.toggle("hidden", !!sub);
  $("#push-off").classList.toggle("hidden", !sub);
}
async function enablePush() {
  try {
    if (await Notification.requestPermission() !== "granted") { $("#push-msg").textContent = tr("push.denied"); return; }
    const info = await (await fetch("/__ctl/push")).json();
    const { reg, sub: old } = await pushSub();
    if (old) await old.unsubscribe();   // made with keys the hub may no longer have: renew
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(info.publicKey) });
    const r = await fetch("/__ctl/push/subscribe", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel() }) });
    if (!r.ok) throw new Error(String(r.status));
    toast(tr("push.enabled"));
  } catch (e) { toast(tr("push.failed"), true); }
  await drawPush();
}
async function disablePush() {
  try {
    const { sub } = await pushSub();
    if (sub) {
      await fetch("/__ctl/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  } catch (e) { toast(tr("push.failed"), true); }
  await drawPush();
}
```

2. Replace

```js
function initSettings() {
  $("#acct-save").onclick = saveAccount;
  $("#cfg-p-for").onchange = e => { panelFor = e.target.value; drawPanelCfg(); };
  $("#cfg-p-reset").onclick = () => { delete cfg.nodePanels[panelFor]; drawPanelCfg(); };
```

   with

```js
function initSettings() {
  $("#acct-save").onclick = saveAccount;
  $("#push-on").onclick = enablePush;
  $("#push-off").onclick = disablePush;
  $("#cfg-p-for").onchange = e => { panelFor = e.target.value; drawPanelCfg(); };
  $("#cfg-p-reset").onclick = () => { delete cfg.nodePanels[panelFor]; drawPanelCfg(); };
```

In `www/sw.js`:

1. Replace

```js
}

self.addEventListener("fetch", (e) => {
  if (route(e.request) !== "shell") return;
```

   with

```js
}

// Web Push (spec 8.5): show the alert, one per alert (tag); a tap opens its node's view
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: e.data ? e.data.text() : "" }; }
  const url = typeof d.url === "string" && /^\/(#node=[a-z2-7]{12})?$/.test(d.url) ? d.url : "/";
  e.waitUntil(self.registration.showNotification(String(d.title || "servitals").slice(0, 200), {
    body: String(d.body || "").slice(0, 2000), tag: String(d.tag || "servitals").slice(0, 200), renotify: true, data: { url }, icon: "/icons/icon-192.png" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (!w) return self.clients.openWindow(url);
    return (w.navigate ? w.navigate(url) : Promise.resolve()).then(() => w.focus());
  }));
});

self.addEventListener("fetch", (e) => {
  if (route(e.request) !== "shell") return;
```

In `www/index.html`:

1. Replace

```html

      <section>
        <label data-i18n="set.login">login</label>
        <div class="fields">
```

   with

```html

      <section>
        <label data-i18n="push.title">notifications on this device</label>
        <p class="hint" id="push-msg"></p>
        <p class="hint hidden" id="push-guide"><a href="https://github.com/shri-studio/servitals/blob/main/docs/networking.md#https-for-phone-notifications" target="_blank" rel="noopener" data-i18n="push.guide">how to serve servitals over HTTPS</a></p>
        <div class="addrow">
          <button id="push-on" class="hidden" data-i18n="push.enable">enable notifications</button>
          <button id="push-off" class="hidden" data-i18n="push.disable">turn them off here</button>
        </div>
      </section>

      <section>
        <label data-i18n="set.login">login</label>
        <div class="fields">
```

In `packaging/etc/hub.env`:

1. Replace

```
# HTTPS_PROXY=http://proxy.example:3128
# NO_PROXY=.internal.example
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

   with

```
# HTTPS_PROXY=http://proxy.example:3128
# NO_PROXY=.internal.example
# who runs this hub, for phone notifications (Web Push): a mailto: or https: address
# VAPID_SUBJECT=mailto:you@example.org
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

In `docs/networking.md`:

1. Replace

```markdown
failing.

## Troubleshooting
```

   with

```markdown
failing.

### HTTPS (for phone notifications)

Browsers give notifications (Web Push) and the installable app only to a site
served over HTTPS. Any of these works:

- **Tailscale:** `tailscale cert <name>.<tailnet>.ts.net`, then a reverse
  proxy (Caddy, nginx) on the hub with that certificate, or `tailscale serve
  https / http://127.0.0.1:20002`.
- **Cloudflare tunnel:** the tunnel's hostname is HTTPS already (see above).
- **Reverse proxy:** Caddy gets a certificate on its own; set `PUBLIC_URL` and
  `TRUSTED_PROXIES` in `hub.env` (see above).

Then open the dashboard at its `https://` address, open settings, and press
"enable notifications" on each phone or computer. On iPhone and iPad, add
servitals to the home screen first (iOS 16.4 or later) and enable them from
there. `VAPID_SUBJECT` in `hub.env` (a `mailto:` or `https:` address) tells
push services who runs the hub; it defaults to `PUBLIC_URL`.

## Troubleshooting
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Email and Apprise channels (spec 8.4): email over SMTP with STARTTLS or
  TLS (the server's certificate checked, a login only over TLS; plain SMTP
```

   with

```markdown

### Added
- Phone notifications (Web Push, spec 8.5): settings has "enable
  notifications" for each phone or computer; alerts then arrive as system
  notifications, one per alert, and a tap opens that server's view. The first
  device adds a "phone notifications" channel (warning and up) to the channels
  tab. VAPID keys (`vapid.json`) and subscriptions (`push-subscriptions.json`)
  live in the state directory (0600); expired subscriptions are removed. The
  encryption (aes128gcm) and the VAPID signature use Node's crypto only and are
  tested against RFC 8291's test vector. Needs HTTPS: `docs/networking.md`
  explains how; `VAPID_SUBJECT` can be set in `hub.env`.
- Email and Apprise channels (spec 8.4): email over SMTP with STARTTLS or
  TLS (the server's certificate checked, a login only over TLS; plain SMTP
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 456 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 6: Commit**

```bash
git add hub www test packaging/etc/hub.env docs/networking.md CHANGELOG.md
git commit -m "feat: phone notifications: subscribe from settings, a Web Push channel, the service worker shows alerts"
```
