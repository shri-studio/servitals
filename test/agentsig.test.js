// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { sha256hex, signRequest, verifyRequest, signReply } = require("../hub/lib/agentsig");

// docs/protocol.md section 8
const SECRET = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BODY = '{"schema":1,"ts":1790000000000,"host":{"name":"nas","os":"linux"}}';
const PUSH_SIG = "a2ca87da11ec97e2133ebdae553a888ae899fe9ea32fc4798a626b3eb3331f03";

test("request signatures match the protocol vectors", () => {
  assert.strictEqual(sha256hex(BODY), "0fa1448a21a0a6a62894effa6272130a82718c810984c5c7f8714b5d6e6e0ffb");
  assert.strictEqual(signRequest(SECRET, "POST", "/api/v1/agent/push", "1790000000123", Buffer.from(BODY)), PUSH_SIG);
  assert.strictEqual(signRequest(SECRET, "GET", "/api/v1/agent/wait", "1790000000456", Buffer.alloc(0)),
    "194b6dc9c936d5c7b8c8802d22836053af2cc8ef63e93d497f09506bd3ba9293");
});

test("reply signature matches the protocol vector", () => {
  assert.strictEqual(signReply(SECRET, "1790000000123", '{"ok":true}'),
    "11e9e5a365260ee327629ca9ada7e6afeeb357ad09b9f7810f1052ba9da0dc57");
});

test("verifyRequest accepts the right signature only", () => {
  const args = [SECRET, "POST", "/api/v1/agent/push", "1790000000123", BODY];
  assert.strictEqual(verifyRequest(...args, PUSH_SIG), true);
  assert.strictEqual(verifyRequest(...args, PUSH_SIG.replace(/^a/, "b")), false);
  assert.strictEqual(verifyRequest(...args, PUSH_SIG.toUpperCase()), false);
  assert.strictEqual(verifyRequest(...args, PUSH_SIG.slice(2)), false);
  assert.strictEqual(verifyRequest(...args, undefined), false);
  assert.strictEqual(verifyRequest(SECRET, "POST", "/api/v1/agent/wait", "1790000000123", BODY, PUSH_SIG), false);
  assert.strictEqual(verifyRequest(SECRET, "POST", "/api/v1/agent/push", "1790000000124", BODY, PUSH_SIG), false);
});
