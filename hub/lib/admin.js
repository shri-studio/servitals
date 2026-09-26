// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The admin login in STATE_DIR/admin.json: { "user", "hash", "gen" }. When the
 * file exists it wins over AUTH_USER / AUTH_PASS_HASH / AUTH_PASS from the
 * environment. Sessions carry `gen`; every change raises it, which ends every
 * other session. Re-read when the mtime changes (servitals-ctl passwd writes
 * it as root). A file that does not parse keeps the last good copy.
 */
const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");
const { describeHash } = require("./password");

const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validAdmin(a) {
  return !!a && typeof a === "object" && typeof a.user === "string" && USER_RE.test(a.user) &&
    describeHash(a.hash) === "scrypt" && Number.isInteger(a.gen) && a.gen >= 0;
}

function createAdminStore(file) {
  let cached = null;
  let mtime = -1;
  let broken = false;

  function load() {
    let st;
    try { st = fs.statSync(file); } catch (_) { cached = null; mtime = -1; broken = false; return null; }
    if (st.mtimeMs === mtime) return cached;
    mtime = st.mtimeMs;
    try {
      const a = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validAdmin(a)) throw new Error("invalid");
      cached = { user: a.user, hash: a.hash, gen: a.gen };
      broken = false;
    } catch (_) { broken = true; }
    return cached;
  }

  function save(a) {
    if (!validAdmin(a)) throw new Error("invalid admin record");
    writeFileAtomic(file, JSON.stringify({ user: a.user, hash: a.hash, gen: a.gen }, null, 2) + "\n", 0o600);
    mtime = -1;
  }

  return { load, save, isBroken: () => { load(); return broken; } };
}

module.exports = { createAdminStore, validAdmin, USER_RE };
