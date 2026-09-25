// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { writeFileAtomic } = require("../hub/lib/fsutil");

async function withHub(env, fn) {
  const hub = await startHub(env);
  try { await fn(hub); } finally { await hub.stop(); }
}
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));

test("writeFileAtomic replaces the file whole and sets the mode", () => {
  const d = tmpdir();
  const f = path.join(d, "x.json");
  writeFileAtomic(f, "one", 0o600);
  writeFileAtomic(f, "two", 0o600);
  assert.strictEqual(fs.readFileSync(f, "utf8"), "two");
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(d), ["x.json"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("STATE_DIR wins over DATA_DIR", async () => {
  const state = tmpdir();
  await withHub({ STATE_DIR: state }, async () => {
    assert.ok(fs.existsSync(path.join(state, "secret")));
  });
  fs.rmSync(state, { recursive: true, force: true });
});

test("config.json lives in the state dir and needs a session", async () => {
  await withHub({}, async (hub) => {
    const anon = await request(hub.port, { path: "/config.json" });
    assert.match(anon.body, /authentication required/);
    const cookie = cookieFrom(await login(hub.port));
    const empty = await request(hub.port, { path: "/config.json?t=1", headers: { cookie } });
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.headers["cache-control"], "no-store");
    assert.deepStrictEqual(JSON.parse(empty.body), {});
    const saved = await ctlPost(hub.port, cookie, "/__ctl/config", JSON.stringify({ title: "lab" }));
    assert.strictEqual(saved.status, 200);
    const back = await request(hub.port, { path: "/config.json", headers: { cookie } });
    assert.strictEqual(JSON.parse(back.body).title, "lab");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(hub.dataDir, "config.json"), "utf8")).title, "lab");
  });
});

test("an old www/config.json is copied to the state dir once", async () => {
  const www = tmpdir();
  fs.writeFileSync(path.join(www, "config.json"), JSON.stringify({ title: "old" }));
  await withHub({ WWW_DIR: www }, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    const r = await request(hub.port, { path: "/config.json", headers: { cookie } });
    assert.strictEqual(JSON.parse(r.body).title, "old");
    assert.ok(fs.existsSync(path.join(www, "config.json")), "the original stays");
    assert.match(hub.logs(), /config\.migrated/);
  });
  fs.rmSync(www, { recursive: true, force: true });
});

test("the gateway creates the local node and its agent credentials", async () => {
  const dir = tmpdir();
  const first = await startHub({}, { dataDir: dir });
  const envFile = path.join(dir, "local-agent.env");
  let text;
  try {
    text = fs.readFileSync(envFile, "utf8");
    assert.match(text, new RegExp(`^HUB_URL=http://127\\.0\\.0\\.1:${first.port}\\nNODE_ID=[a-z2-7]{12}\\nNODE_SECRET=[0-9a-f]{64}\\n$`));
    assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(dir, "nodes.json")).mode & 0o777, 0o600);
    const secret = /^NODE_SECRET=(.*)$/m.exec(text)[1];
    assert.ok(!first.logs().includes(secret), "the secret is never logged");
  } finally { await first.stop(); }
  const second = await startHub({ LOCAL_HUB_URL: "http://gateway:8080" }, { dataDir: dir });
  try {
    const again = fs.readFileSync(envFile, "utf8");
    assert.strictEqual(again.split("\n")[1], text.split("\n")[1], "same node id after a restart");
    assert.match(again, /^HUB_URL=http:\/\/gateway:8080$/m);
  } finally { await second.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
