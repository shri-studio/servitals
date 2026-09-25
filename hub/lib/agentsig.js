// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Agent protocol v1 signatures (docs/protocol.md section 4).
 *   request: HMAC-SHA256(secret, METHOD \n PATH \n TS \n sha256hex(body))
 *   reply:   HMAC-SHA256(secret, "reply" \n TS \n sha256hex(reply body))
 * The secret is 64 hex characters and is used as raw key bytes.
 */
const crypto = require("crypto");

const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmacHex = (secretHex, message) =>
  crypto.createHmac("sha256", Buffer.from(secretHex, "hex")).update(message).digest("hex");

function signRequest(secretHex, method, pathname, ts, body) {
  return hmacHex(secretHex, `${method.toUpperCase()}\n${pathname}\n${ts}\n${sha256hex(body)}`);
}

function verifyRequest(secretHex, method, pathname, ts, body, sig) {
  if (typeof sig !== "string" || !HEX64.test(sig)) return false;
  const want = Buffer.from(signRequest(secretHex, method, pathname, ts, body), "hex");
  return crypto.timingSafeEqual(want, Buffer.from(sig, "hex"));
}

function signReply(secretHex, ts, body) {
  return hmacHex(secretHex, `reply\n${ts}\n${sha256hex(body)}`);
}

module.exports = { sha256hex, signRequest, verifyRequest, signReply };
