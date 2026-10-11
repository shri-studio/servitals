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
// new keys only on the first run: other keys would silently end every subscription, so a
// file that cannot be read is an error (EVAPID) for the hub to log
function loadVapid(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code !== "ENOENT") throw Object.assign(new Error(`vapid.json: ${e.code}`), { code: "EVAPID" });
  }
  if (text !== undefined) {
    let k = null;
    try { k = JSON.parse(text); } catch (_) { /* below */ }
    if (!k || typeof k.publicKey !== "string" || typeof k.privateKey !== "string" || unb64u(k.publicKey).length !== 65 || unb64u(k.privateKey).length !== 32) {
      throw Object.assign(new Error("vapid.json: not a key pair"), { code: "EVAPID" });
    }
    try { fs.chmodSync(file, 0o600); } catch (_) { /* read-only */ }
    return k;
  }
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
// one record of 4096 bytes: 86 for the header, 16 for the tag, 1 for the delimiter
const MAX_PLAIN = 4096 - 86 - 16 - 1;
function encrypt({ payload, p256dh, auth, salt = crypto.randomBytes(16), serverKeys }) {
  if (Buffer.byteLength(payload) > MAX_PLAIN) throw Object.assign(new Error("payload too big for one push"), { code: "EPUSHSIZE" });
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
  const b64 = (x) => typeof x === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(x);
  if (!b64(k.p256dh) || unb64u(k.p256dh).length !== 65 || !b64(k.auth) || unb64u(k.auth).length !== 16) throw new Error("subscription: its keys");
  try { const e = crypto.createECDH("prime256v1"); e.generateKeys(); e.computeSecret(unb64u(k.p256dh)); }   // a point on the curve
  catch (_) { throw new Error("subscription: its keys"); }
  return { endpoint: u.href, keys: { p256dh: k.p256dh, auth: k.auth } };
}
function createPushStore(file) {
  let subs = [];
  try { const f = JSON.parse(fs.readFileSync(file, "utf8")); if (Array.isArray(f.subscriptions)) subs = f.subscriptions; } catch (_) { /* none yet */ }
  const save = () => writeFileAtomic(file, JSON.stringify({ subscriptions: subs }, null, 2) + "\n", 0o600);
  const id = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
  return {
    list: () => subs.slice(),
    // the newest subscribe's https origin: the VAPID subject when nothing else says, kept
    origin: () => { const o = subs.map((s) => s.origin).filter(Boolean); return o.length ? o[o.length - 1] : ""; },
    add(sub, label, origin) {
      const clean = checkSubscription(sub);
      const name = typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60) : "";
      subs = subs.filter((s) => s.endpoint !== clean.endpoint);
      if (subs.length >= 50) throw new Error("at most 50 devices");
      subs.push({ ...clean, label: name, created: Date.now(), ...(typeof origin === "string" && /^https:\/\/[^\s/]+\/?$/.test(origin) ? { origin: origin.replace(/\/$/, "") } : {}) });
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

// RFC 8292's subject: the first candidate that is a mailto: or https: address
function vapidSubject(candidates) {
  const s = candidates.find((c) => typeof c === "string" && /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(c));
  return s ? s.replace(/\/+$/, "") : "mailto:servitals@localhost";
}

module.exports = { loadVapid, vapidHeader, encrypt, sendPush, newKeys, createPushStore, checkSubscription, vapidSubject };
