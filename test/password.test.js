// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { hashPassword, verifyPassword, describeHash } = require("../hub/lib/password");

test("hash has the documented format and verifies", async () => {
  const h = await hashPassword("s3cret-pass");
  assert.match(h, /^scrypt:32768:8:1:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]{44}$/);
  assert.strictEqual(describeHash(h), "scrypt");
  assert.strictEqual(await verifyPassword("s3cret-pass", h), true);
  assert.strictEqual(await verifyPassword("wrong", h), false);
});

test("two hashes of the same password differ (random salt)", async () => {
  assert.notStrictEqual(await hashPassword("x"), await hashPassword("x"));
});

test("legacy sha256 hex still verifies", async () => {
  const legacy = crypto.createHash("sha256").update("old-pass").digest("hex");
  assert.strictEqual(describeHash(legacy), "sha256");
  assert.strictEqual(await verifyPassword("old-pass", legacy), true);
  assert.strictEqual(await verifyPassword("nope", legacy), false);
});

test("malformed or dangerous parameters are rejected, never computed", async () => {
  const salt = Buffer.alloc(16).toString("base64");
  const hash = Buffer.alloc(32).toString("base64");
  for (const bad of [
    "", "scrypt", "plain-text", `scrypt:1024:8:1:${salt}:${hash}`,        // N too small
    `scrypt:1048576:16:1:${salt}:${hash}`,                                 // needs 2 GiB
    `scrypt:30000:8:1:${salt}:${hash}`,                                    // N not a power of two
    `scrypt:32768:8:1:${Buffer.alloc(4).toString("base64")}:${hash}`,      // salt too short
  ]) {
    assert.strictEqual(describeHash(bad), "invalid", bad);
    assert.strictEqual(await verifyPassword("x", bad), false, bad);
  }
});

test("at most two scrypt computations run at once", async () => {
  const { _activeHashes } = require("../hub/lib/password");
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, _activeHashes()); }, 1);
  await Promise.all([1, 2, 3, 4, 5].map((i) => hashPassword("p" + i)));
  clearInterval(timer);
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
});

test("CLI prints a hash for the password on stdin", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "hub", "lib", "password.js")], {
    input: "cli-pass",
  }).toString().trim();
  assert.strictEqual(describeHash(out), "scrypt");
});
