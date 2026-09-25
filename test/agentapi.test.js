// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { signRequest, signReply } = require("../hub/lib/agentsig");

const PUSH = "/api/v1/agent/push";
const WAIT = "/api/v1/agent/wait";

function creds(hub) {
  const env = fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8");
  const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(env)[1];
  return { id: get("NODE_ID"), secret: get("NODE_SECRET") };
}
let lastTs = 0;
const nextTs = () => String(lastTs = Math.max(Date.now(), lastTs + 1));

function signed(hub, c, { method = "POST", path: p = PUSH, body = "", ts = nextTs(), headers = {}, secret = c.secret } = {}) {
  const buf = Buffer.from(body);
  return request(hub.port, {
    method, path: p, body: buf.length ? buf : undefined,
    headers: {
      "content-type": "application/json", "content-length": buf.length,
      "x-servitals-proto": "1", "x-servitals-agent": "test/0", "x-servitals-node": c.id,
      "x-servitals-ts": ts, "x-servitals-sig": signRequest(secret, method, p.split("?")[0], ts, buf),
      ...headers,
    },
  }).then((r) => ({ ...r, ts }));
}
const snap = (extra = {}) => JSON.stringify({ ts: Math.floor(Date.now() / 1000), interval: 60, host: { name: "t" }, ...extra });
const err = (r) => JSON.parse(r.body).error;
const replyOk = (r, c) => r.headers["x-servitals-sig"] === signReply(c.secret, r.ts, r.body);

async function withHub(fn, env = {}) {
  const hub = await startHub(env);
  try { await fn(hub, creds(hub)); } finally { await hub.stop(); }
}

test("a signed push is stored, answered with a signed reply and served as /data.json", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const before = await request(hub.port, { path: "/data.json", headers: { cookie } });
    assert.strictEqual(before.status, 503);
    const r = await signed(hub, c, { body: snap() });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
    assert.ok(replyOk(r, c), "reply signature");
    const d = await request(hub.port, { path: "/data.json?t=1", headers: { cookie } });
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.headers["cache-control"], "no-store");
    assert.strictEqual(JSON.parse(d.body).host.name, "t");
    const anon = await request(hub.port, { path: "/data.json" });
    assert.match(anon.body, /authentication required/);
    assert.doesNotMatch(hub.logs(), new RegExp(c.secret));
  });
});

test("refusals follow the protocol", async () => {
  await withHub(async (hub, c) => {
    assert.strictEqual((await signed(hub, c, { body: snap(), headers: { "x-servitals-proto": "2" } })).status, 426);
    const unknown = await signed(hub, { ...c, id: "aaaaaaaaaaaa" }, { body: snap() });
    assert.deepStrictEqual([unknown.status, err(unknown)], [401, "unknown_node"]);
    const skew = await signed(hub, c, { body: snap(), ts: String(Date.now() - 200000) });
    assert.deepStrictEqual([skew.status, err(skew)], [401, "clock_skew"]);
    assert.strictEqual(typeof JSON.parse(skew.body).hub_ms, "number");
    const badSig = await signed(hub, c, { body: snap(), secret: "ff".repeat(32) });
    assert.deepStrictEqual([badSig.status, err(badSig)], [401, "bad_signature"]);
    assert.strictEqual((await signed(hub, c, { body: snap(), path: PUSH + "?x=1" })).status, 400);
    assert.strictEqual((await signed(hub, c, { method: "GET", body: "" })).status, 405);
    for (const [body, where] of [["[1]", "$"], ["nope", "$"], ['{"host":{}}', "$.ts"],
                                 ['{"ts":1,"host":"x"}', "$.host"], ['{"ts":1,"host":{},"interval":1}', "$.interval"]]) {
      const bad = await signed(hub, c, { body });
      assert.deepStrictEqual([bad.status, err(bad), JSON.parse(bad.body).path], [422, "invalid_snapshot", where], body);
    }
    const big = await signed(hub, c, { body: snap({ pad: "x".repeat(300 * 1024) }) });
    assert.deepStrictEqual([big.status, err(big)], [413, "too_large"]);
    const ok = await signed(hub, c, { body: snap() });
    assert.strictEqual(ok.status, 200);
    const replay = await signed(hub, c, { body: snap(), ts: ok.ts });
    assert.deepStrictEqual([replay.status, err(replay)], [401, "replay"]);
    const soon = await signed(hub, c, { body: snap() });
    assert.deepStrictEqual([soon.status, err(soon)], [429, "rate_limited"]);
    assert.ok(Number(soon.headers["retry-after"]) >= 1);
  });
});

test("a browser ban never blocks the agent API", async () => {
  await withHub(async (hub, c) => {
    fs.writeFileSync(path.join(hub.dataDir, "bans.json"),
      JSON.stringify({ "127.0.0.1": { at: Date.now(), until: 0, fails: 3 } }));
    assert.strictEqual((await request(hub.port, { path: "/" })).status, 403);
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 200);
  });
});

test("wait: held, replaced by a newer wait, woken by refresh", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const first = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    await new Promise((r) => setTimeout(r, 300));
    const second = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    const replaced = await first;
    assert.strictEqual(replaced.status, 204);
    assert.ok(replyOk(replaced, c), "204 is signed too");
    await new Promise((r) => setTimeout(r, 300));
    const refresh = await ctlPost(hub.port, cookie, "/__ctl/refresh");
    assert.deepStrictEqual(JSON.parse(refresh.body), { ok: true, woke: true, fresh: false });
    const woken = await second;
    assert.strictEqual(woken.status, 200);
    assert.deepStrictEqual(JSON.parse(woken.body), { sample: true });
    assert.ok(replyOk(woken, c));
    const idle = await ctlPost(hub.port, cookie, "/__ctl/refresh");
    assert.strictEqual(JSON.parse(idle.body).woke, false, "nobody waiting");
  });
});

test("refresh right after a push does not wake the agent; the wait times out with 204", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 200);
    const started = Date.now();
    const wait = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "1" } });
    await new Promise((r) => setTimeout(r, 300));
    const refresh = await ctlPost(hub.port, cookie, "/__ctl/refresh");
    assert.deepStrictEqual(JSON.parse(refresh.body), { ok: true, woke: false, fresh: true });
    const r = await wait;
    assert.strictEqual(r.status, 204);
    assert.ok(Date.now() - started >= 4500, "X-Servitals-Wait is clamped to at least 5 s");
  });
});

test("the latest snapshot and the local node survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  const a = await startHub({}, { dataDir: dir });
  const c = creds(a);
  try { assert.strictEqual((await signed(a, c, { body: snap({ host: { name: "kept" } }) })).status, 200); }
  finally { await a.stop(); }
  const b = await startHub({}, { dataDir: dir });
  try {
    assert.deepStrictEqual(creds(b), c);
    const cookie = cookieFrom(await login(b.port));
    const d = await request(b.port, { path: "/data.json", headers: { cookie } });
    assert.strictEqual(JSON.parse(d.body).host.name, "kept");
  } finally { await b.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
