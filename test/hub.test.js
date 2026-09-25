// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { startHub, runHubUntilExit, request, login, cookieFrom, DEFAULT_PASS } = require("./helpers/hub");
const { hashPassword } = require("../hub/lib/password");

async function withHub(env, fn) {
  const hub = await startHub(env);
  try { await fn(hub); } finally { await hub.stop(); }
}
const whoami = (hub, cookie, headers = {}) =>
  request(hub.port, { path: "/__ctl/whoami", headers: { cookie, ...headers } }).then((r) => JSON.parse(r.body));

test("refuses to start without a password", async () => {
  const r = await runHubUntilExit({ AUTH_PASS: "", AUTH_PASS_HASH: "" });
  assert.strictEqual(r.code, 1);
  assert.match(r.logs, /event=auth\.no_password/);
});

test("login: Origin required, cookie renamed, no Secure on plain HTTP", async () => {
  await withHub({}, async (hub) => {
    assert.strictEqual((await login(hub.port, { origin: null })).status, 403);
    assert.strictEqual((await login(hub.port, { origin: "http://evil.example" })).status, 403);
    const ok = await login(hub.port);
    assert.strictEqual(ok.status, 302);
    const set = ok.headers["set-cookie"].join(";");
    assert.match(set, /sv_session=[^;]+; HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(set, /Secure/);
  });
});

test("Secure cookie when a trusted proxy says HTTPS", async () => {
  await withHub({}, async (hub) => {
    const ok = await login(hub.port, { headers: { "x-forwarded-proto": "https", "x-forwarded-for": "192.168.1.5" } });
    assert.match(ok.headers["set-cookie"].join(";"), /; Secure/);
  });
});

test("client identity follows the trusted-proxy rules", async () => {
  await withHub({}, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    // loopback is a trusted proxy by default: without a header it is proxy-only
    const self = await whoami(hub, cookie); delete self.version;
    assert.deepStrictEqual(self, { ip: "127.0.0.1", lan: false, controls: false });
    assert.strictEqual((await whoami(hub, cookie, { "x-forwarded-for": "192.168.1.5" })).lan, true);
    const spoof = await whoami(hub, cookie, { "x-forwarded-for": "192.168.1.5, 203.0.113.7" });
    delete spoof.version;
    assert.deepStrictEqual(spoof, { ip: "203.0.113.7", lan: false, controls: false });
  });
});

test("headers from an untrusted peer are ignored", async () => {
  await withHub({ TRUSTED_PROXIES: "192.0.2.1" }, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    const w = await whoami(hub, cookie, { "x-forwarded-for": "203.0.113.7" });
    assert.strictEqual(w.ip, "127.0.0.1");
    assert.strictEqual(w.lan, true, "a direct loopback client is whitelisted");
  });
});

test("three failures ban that client only", async () => {
  await withHub({}, async (hub) => {
    const bad = { "x-forwarded-for": "203.0.113.9" };
    assert.strictEqual((await login(hub.port, { pass: "x", headers: bad })).status, 401);
    assert.strictEqual((await login(hub.port, { pass: "x", headers: bad })).status, 401);
    assert.strictEqual((await login(hub.port, { pass: "x", headers: bad })).status, 403);
    assert.strictEqual((await request(hub.port, { path: "/", headers: bad })).status, 403);
    const other = await request(hub.port, { path: "/", headers: { "x-forwarded-for": "203.0.113.10" } });
    assert.strictEqual(other.status, 200);
    const audit = fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8");
    assert.match(audit, /"event":"auth\.banned"/);
  });
});

test("state-changing /__ctl requests need Origin even with a session", async () => {
  await withHub({}, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    const noOrigin = await request(hub.port, { method: "POST", path: "/__ctl/refresh", headers: { cookie } });
    assert.strictEqual(noOrigin.status, 403);
    const withOrigin = await request(hub.port, {
      method: "POST", path: "/__ctl/refresh", headers: { cookie, origin: `http://127.0.0.1:${hub.port}` },
    });
    assert.strictEqual(withOrigin.status, 200);
  });
});

test("logout is POST-only and needs Origin", async () => {
  await withHub({}, async (hub) => {
    assert.strictEqual((await request(hub.port, { path: "/__auth/logout" })).status, 405);
    const r = await request(hub.port, {
      method: "POST", path: "/__auth/logout", headers: { origin: `http://127.0.0.1:${hub.port}` },
    });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers["set-cookie"].join(";"), /sv_session=; Path=\/; Max-Age=0/);
  });
});

test("scrypt AUTH_PASS_HASH works and the plain password is not required", async () => {
  const hash = await hashPassword("hashed-pass-1");
  await withHub({ AUTH_PASS: "", AUTH_PASS_HASH: hash }, async (hub) => {
    assert.strictEqual((await login(hub.port, { pass: "hashed-pass-1" })).status, 302);
    assert.strictEqual((await login(hub.port, { pass: "wrong", headers: { "x-forwarded-for": "192.168.1.5" } })).status, 401);
    assert.doesNotMatch(hub.logs(), /event=auth\.(plain_password|legacy_hash)/);
  });
});

test("legacy sha256 hash still works and logs a warning", async () => {
  const legacy = crypto.createHash("sha256").update("legacy-pass").digest("hex");
  await withHub({ AUTH_PASS: "", AUTH_PASS_HASH: legacy }, async (hub) => {
    assert.strictEqual((await login(hub.port, { pass: "legacy-pass" })).status, 302);
    assert.match(hub.logs(), /level=warn event=auth\.legacy_hash/);
  });
});

test("passwords and cookies never reach the logs", async () => {
  await withHub({}, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    await login(hub.port, { pass: "wrong-guess-123", headers: { "x-forwarded-for": "192.168.1.5" } });
    const all = hub.logs() + fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8");
    assert.ok(!all.includes(DEFAULT_PASS));
    assert.ok(!all.includes("wrong-guess-123"));
    assert.ok(!all.includes(cookie.split("=")[1]));
    assert.match(all, /event=auth\.login_ok/);
  });
});

test("without UPSTREAM the gateway serves www itself, after login only", async () => {
  await withHub({ UPSTREAM: "" }, async (hub) => {
    const anon = await request(hub.port, { path: "/" });
    assert.match(anon.body, /authentication required/);
    const cookie = cookieFrom(await login(hub.port));
    const page = await request(hub.port, { path: "/", headers: { cookie } });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<title>servitals<\/title>/);
    const dot = await request(hub.port, { path: "/.env", headers: { cookie } });
    assert.strictEqual(dot.status, 404);
    assert.match(hub.logs(), /upstream=static:/);
  });
});

test("a missing WWW_DIR stops the gateway at startup", async () => {
  const r = await runHubUntilExit({ UPSTREAM: "", WWW_DIR: "/nonexistent/www" });
  assert.strictEqual(r.code, 1);
  assert.match(r.logs, /config\.www_missing/);
});
