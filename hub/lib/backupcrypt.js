// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Encrypted backups (servitals-ctl backup --encrypt): AES-256-GCM with a key from the
 * passphrase through scrypt, so a changed file is refused instead of restored.
 *   file: "SVBK1\n" | salt (16) | nonce (12) | tag (16) | ciphertext
 *   node backupcrypt.js encrypt|decrypt  < in > out, the passphrase in SV_BACKUP_PASS
 * decrypt writes nothing unless the whole file is authentic (exit 2 otherwise).
 */
const crypto = require("crypto");

const MAGIC = Buffer.from("SVBK1\n");
const MAX = 2 * 1024 * 1024 * 1024 - 1;   // what one Buffer holds
const key = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

function encrypt(plain, pass) {
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(pass, salt), nonce);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, nonce, c.getAuthTag(), data]);
}
function decrypt(file, pass) {
  if (file.length < MAGIC.length + 44 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an encrypted servitals backup");
  let o = MAGIC.length;
  const salt = file.subarray(o, o += 16), nonce = file.subarray(o, o += 12), tag = file.subarray(o, o += 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key(pass, salt), nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(file.subarray(o)), d.final()]);   // final() throws unless authentic
}

function main() {
  const mode = process.argv[2], pass = process.env.SV_BACKUP_PASS || "";
  if (!/^(encrypt|decrypt)$/.test(mode || "") || !pass) { process.stderr.write("usage: SV_BACKUP_PASS=… backupcrypt.js encrypt|decrypt < in > out\n"); process.exit(64); }
  const chunks = [];
  let size = 0;
  process.stdin.on("data", (c) => { size += c.length; if (size > MAX) { process.stderr.write("too big\n"); process.exit(2); } chunks.push(c); });
  process.stdin.on("end", () => {
    let out;
    try { out = mode === "encrypt" ? encrypt(Buffer.concat(chunks), pass) : decrypt(Buffer.concat(chunks), pass); }
    catch (_) { process.stderr.write("a wrong passphrase or a damaged file\n"); process.exit(2); }
    process.stdout.write(out, () => process.exit(0));
  });
}

if (require.main === module) main();
module.exports = { encrypt, decrypt, MAGIC };
