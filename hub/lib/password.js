// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Password hashing. Format: scrypt:N:r:p:salt_b64:hash_b64 (colons so the
 * value survives Docker Compose .env interpolation). Legacy sha256 hex from
 * AUTH_PASS_HASH still verifies. One scrypt hash at N=2^15, r=8 needs 32 MiB,
 * so at most two run at once.
 */
const crypto = require("node:crypto");

const N = 32768, R = 8, P = 1, SALT_BYTES = 16, KEY_BYTES = 32;
const MAX_MEM = 64 * 1024 * 1024;
const MAX_ACTIVE = 2;

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_ACTIVE) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

function scrypt(plain, salt, keylen, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, keylen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
      (err ? reject(err) : resolve(key)));
  });
}

function parseScrypt(stored) {
  const parts = String(stored).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 16384 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16) return null;
  if (!Number.isInteger(p) || p < 1 || p > 4) return null;
  if (128 * n * r > MAX_MEM / 2) return null;   // refuse parameters that need more than 32 MiB
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 16 || hash.length < 16) return null;
  return { n, r, p, salt, hash };
}

function describeHash(stored) {
  if (typeof stored !== "string" || stored === "") return "invalid";
  if (/^[0-9a-f]{64}$/i.test(stored)) return "sha256";
  return parseScrypt(stored) ? "scrypt" : "invalid";
}

async function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await withSlot(() => scrypt(String(plain), salt, KEY_BYTES, N, R, P));
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

async function verifyPassword(plain, stored) {
  const kind = describeHash(stored);
  if (kind === "sha256") {
    const got = crypto.createHash("sha256").update(String(plain)).digest();
    return crypto.timingSafeEqual(got, Buffer.from(stored, "hex"));
  }
  if (kind !== "scrypt") return false;
  const s = parseScrypt(stored);
  const key = await withSlot(() => scrypt(String(plain), s.salt, s.hash.length, s.n, s.r, s.p));
  return crypto.timingSafeEqual(key, s.hash);
}

module.exports = { hashPassword, verifyPassword, describeHash, _activeHashes: () => active };

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { input += d; });
  process.stdin.on("end", async () => {
    const pw = input.replace(/\r?\n$/, "");
    if (!pw) {
      process.stderr.write("empty password\n");
      process.exit(1);
    }
    process.stdout.write((await hashPassword(pw)) + "\n");
  });
}
