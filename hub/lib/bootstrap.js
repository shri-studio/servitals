// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * First-run setup for the Ubuntu package, run as root by the servitals postinst:
 *   node bootstrap.js <state-dir> <etc-dir>
 * Idempotent. Creates admin.json with a random password (also written once to
 * initial-password, 0600) unless a login already exists (admin.json, or a
 * password in hub.env), and the local node with its local-agent.env. The
 * postinst hands file ownership to _servitals afterwards.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hashPassword } = require("./password");
const { createAdminStore } = require("./admin");
const { createNodeStore, localAgentEnv } = require("./nodes");
const { writeFileAtomic } = require("./fsutil");

// KEY=VALUE lines; quotes removed; never evaluated
function readEnvFile(file) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";   // no look-alikes (0/o, 1/l/i)
function randomPassword(len = 20) {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

async function bootstrap(stateDir, etcDir, { hostname = os.hostname() } = {}) {
  const env = readEnvFile(path.join(etcDir, "hub.env"));
  const done = [];
  fs.mkdirSync(stateDir, { recursive: true });

  const admin = createAdminStore(path.join(stateDir, "admin.json"));
  if (!fs.existsSync(path.join(stateDir, "admin.json")) && !env.AUTH_PASS_HASH && !env.AUTH_PASS) {
    const password = randomPassword();
    admin.save({ user: env.AUTH_USER || "admin", hash: await hashPassword(password), gen: 0 });
    writeFileAtomic(path.join(stateDir, "initial-password"), password + "\n", 0o600);
    done.push("admin");
  }

  const nodes = createNodeStore(path.join(stateDir, "nodes.json"));
  const local = nodes.ensureLocal(hostname.slice(0, 64));
  const port = /^\d{1,5}$/.test(env.PORT || "") ? env.PORT : "20002";
  writeFileAtomic(path.join(stateDir, "local-agent.env"),
    localAgentEnv(`http://127.0.0.1:${port}`, local.id, nodes.get(local.id).secret), 0o600);
  if (local.created) done.push("node");
  return done;
}

module.exports = { bootstrap, readEnvFile, randomPassword };

if (require.main === module) {
  const [stateDir, etcDir] = process.argv.slice(2);
  if (!stateDir || !etcDir) {
    process.stderr.write("usage: bootstrap.js <state-dir> <etc-dir>\n");
    process.exit(2);
  }
  bootstrap(stateDir, etcDir).then((done) => {
    if (done.includes("admin")) {
      process.stdout.write(`servitals: log in as ${readEnvFile(path.join(etcDir, "hub.env")).AUTH_USER || "admin"}; ` +
        `the first password is in ${path.join(stateDir, "initial-password")}\n`);
    }
  }).catch((e) => { process.stderr.write(`servitals bootstrap: ${e.message}\n`); process.exit(1); });
}
