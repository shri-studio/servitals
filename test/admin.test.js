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

test("changing the login needs the current password and ends other sessions", async () => {
  const hub = await startHub();
  try {
    const mine = cookieFrom(await login(hub.port));
    const other = cookieFrom(await login(hub.port));
    const wrong = await account(hub.port, mine, { current: "nope", user: "owner", password: "brand-new-pass" });
    assert.strictEqual(wrong.status, 403);
    assert.ok(!fs.existsSync(path.join(hub.dataDir, "admin.json")));
    const fails = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "fails.json"), "utf8"));
    assert.strictEqual(fails["127.0.0.1"].n, 1, "a wrong current password counts toward the lockout");
    assert.strictEqual((await account(hub.port, mine, { current: "correct horse battery", user: "a b" })).status, 400);
    assert.strictEqual((await account(hub.port, mine, { current: "correct horse battery", password: "short" })).status, 400);
    const ok = await account(hub.port, mine, { current: "correct horse battery", user: "owner", password: "brand-new-pass" });
    assert.strictEqual(ok.status, 200, ok.body);
    assert.deepStrictEqual(JSON.parse(ok.body), { ok: true, user: "owner" });
    const fresh = cookieFrom(ok);
    assert.strictEqual((await whoami(hub.port, fresh)).status, 200, "this browser stays logged in");
    assert.strictEqual((await whoami(hub.port, other)).status, 401, "other sessions end");
    assert.strictEqual((await whoami(hub.port, mine)).status, 401, "the old cookie ends too");
    assert.strictEqual((await login(hub.port, { user: "owner", pass: "brand-new-pass" })).status, 302);
    const saved = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "admin.json"), "utf8"));
    assert.strictEqual(saved.gen, 1);
    assert.strictEqual(await verifyPassword("brand-new-pass", saved.hash), true);
    assert.ok(!hub.logs().includes("brand-new-pass") && !hub.logs().includes("correct horse battery"));
    assert.match(hub.logs(), /auth\.account_changed/);
    assert.match(hub.logs(), /auth\.account_denied/);
  } finally { await hub.stop(); }
});

test("renaming alone keeps the password", async () => {
  const hub = await startHub();
  try {
    const c = cookieFrom(await login(hub.port));
    assert.strictEqual((await account(hub.port, c, { current: "correct horse battery", user: "renamed" })).status, 200);
    assert.strictEqual((await login(hub.port, { user: "renamed", pass: "correct horse battery" })).status, 302);
  } finally { await hub.stop(); }
});

test("an old sha256 login must pick a new password to move to admin.json", async () => {
  const legacy = require("node:crypto").createHash("sha256").update("legacy-pass-1").digest("hex");
  const hub = await startHub({ AUTH_PASS: "", AUTH_PASS_HASH: legacy });
  try {
    const c = cookieFrom(await login(hub.port, { pass: "legacy-pass-1" }));
    const r = await account(hub.port, c, { current: "legacy-pass-1", user: "admin2" });
    assert.strictEqual(r.status, 400);
    assert.match(JSON.parse(r.body).error, /new password/);
  } finally { await hub.stop(); }
});
