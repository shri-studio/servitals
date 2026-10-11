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
