// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bootstrap, readEnvFile } = require("../hub/lib/bootstrap");
const { verifyPassword } = require("../hub/lib/password");

function dirs(hubEnv = "PORT=20002\nAUTH_USER=admin\n# AUTH_PASS_HASH=scrypt:...\n") {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-boot-"));
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), "sv-etc-"));
  fs.writeFileSync(path.join(etc, "hub.env"), hubEnv);
  return { state, etc };
}
const read = (d, f) => fs.readFileSync(path.join(d, f), "utf8");

test("first run creates a login, the password file and the local node", async () => {
  const { state, etc } = dirs();
  assert.deepStrictEqual(await bootstrap(state, etc, { hostname: "box" }), ["admin", "node"]);
  const pw = read(state, "initial-password").trim();
  assert.match(pw, /^[a-hjkmnp-z2-9]{20}$/);
  const admin = JSON.parse(read(state, "admin.json"));
  assert.strictEqual(admin.user, "admin");
  assert.strictEqual(await verifyPassword(pw, admin.hash), true);
  for (const f of ["admin.json", "initial-password", "nodes.json", "local-agent.env"]) {
    assert.strictEqual(fs.statSync(path.join(state, f)).mode & 0o777, 0o600, f);
  }
  assert.match(read(state, "local-agent.env"), /^HUB_URL=http:\/\/127\.0\.0\.1:20002\nNODE_ID=[a-z2-7]{12}\n/);
});

test("a second run changes nothing", async () => {
  const { state, etc } = dirs();
  await bootstrap(state, etc);
  const before = ["admin.json", "initial-password", "nodes.json"].map((f) => read(state, f));
  assert.deepStrictEqual(await bootstrap(state, etc), []);
  assert.deepStrictEqual(["admin.json", "initial-password", "nodes.json"].map((f) => read(state, f)), before);
});

test("an existing login in hub.env is kept, and PORT sets the agent's hub URL", async () => {
  const { state, etc } = dirs("PORT=20012\nAUTH_USER=rishabha\nAUTH_PASS_HASH='scrypt:1:2:3:x:y'\n");
  assert.deepStrictEqual(await bootstrap(state, etc), ["node"]);
  assert.ok(!fs.existsSync(path.join(state, "admin.json")));
  assert.ok(!fs.existsSync(path.join(state, "initial-password")));
  assert.match(read(state, "local-agent.env"), /^HUB_URL=http:\/\/127\.0\.0\.1:20012$/m);
});

test("hub.env is parsed, never evaluated", () => {
  const { etc } = dirs('A="x y"\nB=\'$(touch /tmp/nope)\'\n# C=1\nD=plain\n');
  assert.deepStrictEqual(readEnvFile(path.join(etc, "hub.env")), { A: "x y", B: "$(touch /tmp/nope)", D: "plain" });
});
