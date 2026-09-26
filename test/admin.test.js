// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startHub, runHubUntilExit, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { createAdminStore } = require("../hub/lib/admin");
const { hashPassword, verifyPassword } = require("../hub/lib/password");

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-admin-"));
async function adminFile(dir, user, password, gen = 0) {
  fs.writeFileSync(path.join(dir, "admin.json"), JSON.stringify({ user, hash: await hashPassword(password), gen }), { mode: 0o600 });
}
const whoami = (port, cookie) => request(port, { path: "/__ctl/whoami", headers: { cookie } });
const account = (port, cookie, body) => ctlPost(port, cookie, "/__ctl/account", JSON.stringify(body));

test("the admin store refuses records without a scrypt hash or a sane name", async () => {
  const dir = tmpdir();
  const store = createAdminStore(path.join(dir, "admin.json"));
  assert.strictEqual(store.load(), null);
  const good = await hashPassword("x-long-enough");
  assert.throws(() => store.save({ user: "a b", hash: good, gen: 0 }));
  assert.throws(() => store.save({ user: "ok", hash: "0".repeat(64), gen: 0 }));
  store.save({ user: "ok", hash: await hashPassword("pw-123456"), gen: 2 });
  assert.strictEqual(store.load().gen, 2);
  assert.strictEqual(fs.statSync(path.join(dir, "admin.json")).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, "admin.json"), "{ not json");
  fs.utimesSync(path.join(dir, "admin.json"), new Date(), new Date(Date.now() + 5000));
  assert.strictEqual(store.load().user, "ok", "a bad edit keeps the last good copy");
  assert.strictEqual(store.isBroken(), true);
});

test("admin.json wins over the environment and needs no AUTH_PASS", async () => {
  const dir = tmpdir();
  await adminFile(dir, "owner", "file-pass-123");
  const hub = await startHub({ AUTH_PASS: "", STATE_DIR: dir });
  try {
    assert.strictEqual((await login(hub.port)).status, 401, "the environment's admin no longer works");
    const ok = await login(hub.port, { user: "owner", pass: "file-pass-123" });
    assert.strictEqual(ok.status, 302);
    const w = JSON.parse((await whoami(hub.port, cookieFrom(ok))).body);
    assert.strictEqual(w.user, "owner");
    assert.match(hub.logs(), /login=admin\.json/);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a broken admin.json stops the gateway", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "admin.json"), '{"user":"x"}');
  const r = await runHubUntilExit({ STATE_DIR: dir });
  assert.strictEqual(r.code, 1);
  assert.match(r.logs, /auth\.admin_unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
});
