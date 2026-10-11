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
