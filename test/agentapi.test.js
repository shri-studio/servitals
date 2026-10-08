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
const snap = (extra = {}) => JSON.stringify({ schema: 1, ts: Date.now(), interval: 60, host: { name: "t", os: "linux" }, ...extra });
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
    for (const [body, where] of [["[1]", "$"], ["nope", "$"],
                                 ['{"schema":2,"ts":1,"interval":60,"host":{"name":"x"}}', "$.schema"],
                                 ['{"schema":1,"interval":60,"host":{"name":"x"}}', "$.ts"],
                                 ['{"schema":1,"ts":1,"interval":60,"host":"x"}', "$.host"],
                                 ['{"schema":1,"ts":1,"interval":1,"host":{"name":"x"}}', "$.interval"]]) {
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

test("a second refresh within 5 s of a wake does not wake the agent again", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const first = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/refresh")).body).woke, true);
    assert.strictEqual((await first).status, 200);
    // the agent re-arms at once, before its push has landed
    const started = Date.now();
    const second = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "5" } });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/refresh")).body).woke, false);
    assert.strictEqual((await second).status, 204, "left waiting, not woken twice");
    assert.ok(Date.now() - started >= 4500);
  });
});

test("an address that keeps failing authentication is slowed down", async () => {
  await withHub(async (hub, c) => {
    for (let i = 0; i < 30; i++) {
      assert.strictEqual((await signed(hub, c, { body: snap(), secret: "ab".repeat(32) })).status, 401);
    }
    const blocked = await signed(hub, c, { body: snap() });
    assert.strictEqual(blocked.status, 429, "even a good request waits out the minute");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
  });
});

test("a captured push cannot be replayed after a hub restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  const a = await startHub({}, { dataDir: dir });
  const c = creds(a);
  const body = snap();
  let first;
  try {
    first = await signed(a, c, { body });
    assert.strictEqual(first.status, 200);
  } finally { await a.stop(); }
  const b = await startHub({}, { dataDir: dir });
  try {
    const again = await signed(b, c, { body, ts: first.ts });
    assert.deepStrictEqual([again.status, JSON.parse(again.body).error], [401, "replay"]);
    assert.strictEqual(fs.statSync(path.join(dir, "replay.json")).mode & 0o777, 0o600);
  } finally { await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failures of one node or of unknown ids never lock out another node at the same address", async () => {
  await withHub(async (hub, c) => {
    const other = JSON.parse(require("node:child_process").execFileSync(process.execPath,
      [path.join(__dirname, "..", "hub", "lib", "nodes.js"), path.join(hub.dataDir, "nodes.json"), "add", "other"]).toString());
    for (let i = 0; i < 30; i++) {
      assert.strictEqual((await signed(hub, c, { body: snap(), secret: "ab".repeat(32) })).status, 401);
      assert.strictEqual((await signed(hub, { ...c, id: "aaaaaaaaaaaa" }, { body: snap() })).status, 401);
    }
    assert.strictEqual((await signed(hub, { ...c, id: "aaaaaaaaaaaa" }, { body: snap() })).status, 429, "junk ids are slowed down");
    assert.strictEqual((await signed(hub, other, { body: snap() })).status, 200, "a healthy node behind the same address still pushes");
  });
});

test("replays are not counted as authentication failures", async () => {
  await withHub(async (hub, c) => {
    const ok = await signed(hub, c, { body: snap() });
    for (let i = 0; i < 35; i++) assert.strictEqual((await signed(hub, c, { body: snap(), ts: ok.ts })).status, 401);
    const wait = await signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "5" } });
    assert.strictEqual(wait.status, 204);
  });
});

test("a push with a bad optional group is stored without it, says what was dropped, and logs it once", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const bad = () => snap({ fans: [{ label: "f", rpm: 1350000 }], mem: { total: 100, used: 50 } });
    const count = () => (hub.logs().match(/api\.groups_dropped/g) || []).length;
    const pause = () => new Promise((ok) => setTimeout(ok, 5100));   // the hub stores one push per 5 s
    const r = await signed(hub, c, { body: bad() });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, dropped: ["$.fans[0].rpm"] });
    assert.ok(replyOk(r, c), "the reply is signed");
    const d = JSON.parse((await request(hub.port, { path: "/data.json?t=1", headers: { cookie } })).body);
    assert.strictEqual(d.fans, undefined, "the bad group is not stored");
    assert.deepStrictEqual(d.mem, { total: 100, used: 50 }, "the rest is");
    await new Promise((ok) => setTimeout(ok, 200));
    assert.strictEqual(count(), 1);
    assert.match(hub.logs(), /api\.groups_dropped.*\$\.fans\[0\]\.rpm/);
    await pause();
    assert.strictEqual((await signed(hub, c, { body: bad() })).status, 200);
    await new Promise((ok) => setTimeout(ok, 200));
    assert.strictEqual(count(), 1, "the same bad sensor again: not logged again");
    await pause();
    assert.deepStrictEqual(JSON.parse((await signed(hub, c, { body: snap() })).body), { ok: true });
    await pause();
    await signed(hub, c, { body: bad() });
    await new Promise((ok) => setTimeout(ok, 200));
    assert.strictEqual(count(), 2, "after a clean push, it is news again");
  });
});

test("history: a push becomes series the page can ask for, and they outlive a restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));   // kept across the restart
  const hub = await startHub({}, { dataDir });
  const c = creds(hub);
  try {
    const cookie = cookieFrom(await login(hub.port));
    const get = async (q) => request(hub.port, { path: "/__ctl/history?" + q, headers: { cookie } });
    assert.strictEqual((await signed(hub, c, { body: snap({ cpu: { usage: 12, cores: 2 }, mem: { total: 200, used: 50 },
      disks: [{ mount: "/", pct: 40 }] }) })).status, 200);
    const list = JSON.parse((await get("series=list")).body);
    assert.deepStrictEqual(list.series.sort(), ["cpu", "disk./.used", "mem"]);
    const r = await get("series=cpu&range=1h");
    assert.strictEqual(r.status, 200);
    const h = JSON.parse(r.body);
    assert.strictEqual(h.step, 60);
    // the last point with data: the push's minute (a later minute may have begun meanwhile)
    const lastData = (points) => points.filter((p) => p[1] !== null).at(-1).slice(1);
    assert.deepStrictEqual(lastData(h.points), [12, 12, 12]);
    assert.deepStrictEqual(lastData(JSON.parse((await get(`node=${c.id}&series=mem&range=24h`)).body).points), [25, 25, 25]);
    assert.strictEqual((await get("series=load1&range=1h")).status, 404);
    assert.strictEqual((await get("series=cpu&range=2h")).status, 400);
    assert.strictEqual((await get("node=bbbbbbbbbbbb&series=cpu&range=1h")).status, 404);
    assert.strictEqual((await request(hub.port, { path: "/__ctl/history?series=cpu&range=1h" })).status, 401, "logged in only");
    await hub.stop();
    const again = await startHub({}, { dataDir });
    try {
      const cookie2 = cookieFrom(await login(again.port));
      const back = JSON.parse((await request(again.port, { path: "/__ctl/history?series=cpu&range=1h", headers: { cookie: cookie2 } })).body);
      assert.deepStrictEqual(back.points.filter((p) => p[1] !== null).at(-1).slice(1), [12, 12, 12], "flushed on SIGTERM");
    } finally { await again.stop(); }
  } finally { await hub.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("alerts: a push that meets a rule shows as firing; it can be muted; the log keeps it", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const get = async () => JSON.parse((await request(hub.port, { path: "/__ctl/alerts", headers: { cookie } })).body);
    assert.deepStrictEqual((await get()).firing, []);
    assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true } }) })).status, 200);
    const a = await get();
    assert.deepStrictEqual(a.firing.map((f) => [f.rule, f.severity, f.node, f.muted]), [["reboot_required", "info", c.id, false]]);
    assert.deepStrictEqual(a.recent.map((e) => [e.kind, e.rule]), [["firing", "reboot_required"]]);
    assert.match(hub.logs(), /event=alert\.firing.*rule=reboot_required/);
    const until = Date.now() + 3600000;
    const m = await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ rule: "reboot_required", until }));
    assert.strictEqual(m.status, 200);
    assert.strictEqual((await get()).firing[0].muted, true);
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ until }))).status, 400, "a rule or a node");
    assert.strictEqual((await request(hub.port, { path: "/__ctl/alerts" })).status, 401, "logged in only");
  });
});

test("alerts: after a hub restart, a node is offline only once its own limit passed since the hub started", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8");
  assert.match(src, /lastPush: rec \? Math\.max\(rec\.at, HUB_START\) : null/);
  assert.match(src, /^const HUB_START = Date\.now\(\);/m);
});

test("alerts: the page gets the running mutes, can unmute, and sees each node's count on the fleet", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const get = async (p) => JSON.parse((await request(hub.port, { path: p, headers: { cookie } })).body);
    assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true, security: 2 } }) })).status, 200);
    const card = async () => (await get("/__ctl/nodes")).find((n) => n.id === c.id).alerts;
    assert.deepStrictEqual(await card(), { count: 2, worst: "info" });
    const until = Date.now() + 3600000;
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ node: c.id, until }))).status, 200);
    assert.deepStrictEqual((await get("/__ctl/alerts")).mutes, { rules: {}, nodes: { [c.id]: until } });
    assert.strictEqual(await card(), null, "nothing told: no badge");
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ node: c.id, until: Date.now() }))).status, 200);
    assert.deepStrictEqual((await get("/__ctl/alerts")).mutes, { rules: {}, nodes: {} }, "unmuted");
    assert.deepStrictEqual(await card(), { count: 2, worst: "info" });
  });
});

test("alerts: a mute runs for a time the hub counts from its own clock; until 0 unmutes; a bad time is refused", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const mutes = async () => JSON.parse((await request(hub.port, { path: "/__ctl/alerts", headers: { cookie } })).body).mutes;
    const post = (b) => ctlPost(hub.port, cookie, "/__ctl/alerts/mute", JSON.stringify(b));
    const before = Date.now();
    assert.strictEqual((await post({ node: c.id, for: 3600000 })).status, 200);
    const until = (await mutes()).nodes[c.id];
    assert.ok(until >= before + 3600000 && until <= Date.now() + 3600000, "the hub's now plus the time");
    assert.strictEqual((await post({ node: c.id, until: 0 })).status, 200);
    assert.deepStrictEqual((await mutes()).nodes, {}, "until 0: unmuted, whatever the browser's clock says");
    for (const bad of [-1, 0, 367 * 86400000, "1h", null]) {
      assert.strictEqual((await post({ node: c.id, for: bad })).status, 400, `for: ${bad}`);
    }
    assert.strictEqual((await post({ node: c.id, for: 3600000, until: 0 })).status, 400, "one of the two");
  });
});

test("alert rules: the page reads and saves them; they apply at once, survive a restart, and a bad set is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  const a = await startHub({}, { dataDir: dir });
  const c = creds(a);
  const own = { id: "c_upd", name: "any update", metric: "security_updates", op: ">=", threshold: 1, for: 0, severity: "warning",
                scope: { node: c.id } };
  try {
    const cookie = cookieFrom(await login(a.port));
    const get = async (p) => JSON.parse((await request(a.port, { path: p, headers: { cookie } })).body);
    const r0 = await get("/__ctl/alerts/rules");
    assert.deepStrictEqual(r0.saved, { rules: [] });
    assert.strictEqual(r0.defaults.find((r) => r.id === "disk_full").for, 5, "minutes");
    assert.ok(r0.metrics.includes("disk.used") && !r0.metrics.includes("offline"));
    const save = (body) => ctlPost(a.port, cookie, "/__ctl/alerts/rules", JSON.stringify(body));
    const refused = await save({ rules: [{ id: "cpu", severity: "page" }] });
    assert.strictEqual(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, /severity/);
    assert.strictEqual((await save({ rules: [own, { id: "reboot_required", off: true }] })).status, 200);
    assert.match(a.logs(), /event=alert\.rules_saved/);
    assert.strictEqual((await signed(a, c, { body: snap({ ubuntu: { rebootRequired: true, security: 2 } }) })).status, 200);
    assert.deepStrictEqual((await get("/__ctl/alerts")).firing.map((f) => f.rule).sort(), ["c_upd", "security_updates"], "applied at once");
    assert.strictEqual((await ctlPost(a.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ rule: "c_upd", for: 60000 }))).status, 200,
      "a rule of one's own can be muted");
    const al = JSON.parse((await request(a.port, { path: "/__ctl/alerts", headers: { cookie } })).body);
    assert.deepStrictEqual(al.rules.c_upd, { name: "any update", metric: "security_updates" }, "the page can name a rule of one's own");
    assert.strictEqual(al.firing.find((f) => f.rule === "c_upd").name, "any update");
    // a mute that outlives its rule can still be undone
    assert.strictEqual((await save({ rules: [{ id: "reboot_required", off: true }] })).status, 200);
    assert.strictEqual((await ctlPost(a.port, cookie, "/__ctl/alerts/mute", JSON.stringify({ rule: "c_upd", until: 0 }))).status, 200);
    assert.strictEqual((await request(a.port, { path: "/__ctl/alerts/rules" })).status, 401);
  } finally { await a.stop(); }
  const b = await startHub({}, { dataDir: dir });
  try {
    const cookie = cookieFrom(await login(b.port));
    const r1 = JSON.parse((await request(b.port, { path: "/__ctl/alerts/rules", headers: { cookie } })).body);
    assert.deepStrictEqual(r1.saved.rules.map((r) => r.id), ["reboot_required"], "kept");
    assert.strictEqual((await signed(b, c, { body: snap({ ubuntu: { rebootRequired: true, security: 2 } }) })).status, 200);
    const f = JSON.parse((await request(b.port, { path: "/__ctl/alerts", headers: { cookie } })).body).firing;
    assert.ok(!f.some((x) => x.rule === "reboot_required"), "still off after the restart");
  } finally { await b.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("alert rules: a rules file that cannot be read leaves the defaults, and says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  fs.mkdirSync(path.join(dir, "alerts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "alerts", "rules.json"), '{"rules":[{"id":"cpu","severity":"page"}]}');
  const h = await startHub({}, { dataDir: dir });
  try {
    assert.match(h.logs(), /event=alerts\.rules_ignored/);
    const cookie = cookieFrom(await login(h.port));
    const r = JSON.parse((await request(h.port, { path: "/__ctl/alerts/rules", headers: { cookie } })).body);
    assert.deepStrictEqual(r.saved, { rules: [] });
  } finally { await h.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("alert rules: a server revoked after it was named stays savable; a new name must be a server there is", async () => {
  await withHub(async (hub) => {
    const other = JSON.parse(require("node:child_process").execFileSync(process.execPath,
      [path.join(__dirname, "..", "hub", "lib", "nodes.js"), path.join(hub.dataDir, "nodes.json"), "add", "other"]).toString());
    const cookie = cookieFrom(await login(hub.port));
    const save = (body) => ctlPost(hub.port, cookie, "/__ctl/alerts/rules", JSON.stringify(body));
    const rules = { rules: [{ id: "cpu", overrides: [{ node: other.id, off: true }] }] };
    assert.strictEqual((await save(rules)).status, 200);
    assert.strictEqual((await ctlPost(hub.port, cookie, `/__ctl/node/${other.id}/revoke`)).status, 200);
    assert.strictEqual((await save({ rules: [...rules.rules, { id: "memory", threshold: 80 }] })).status, 200, "the revoked server's override is kept");
    const fresh = await save({ rules: [{ id: "cpu", overrides: [{ node: "nodecccccccc", off: true }] }] });
    assert.deepStrictEqual([fresh.status, JSON.parse(fresh.body).error], [400, "cpu: override 1: no such server"]);
  }, { CTL_LAN_ONLY: "0" });
});

test("alert channels: saved from the page with secrets masked; an alert reaches a webhook; send test answers", async () => {
  const got = [];
  const dest = require("node:http").createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { got.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) }); res.writeHead(req.url === "/gone" ? 410 : 200); res.end(); });
  });
  await new Promise((r) => dest.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${dest.address().port}/hook`;
  try {
    await withHub(async (hub, c) => {
      const cookie = cookieFrom(await login(hub.port));
      const get = async () => JSON.parse((await request(hub.port, { path: "/__ctl/alerts/channels", headers: { cookie } })).body);
      const save = (b) => ctlPost(hub.port, cookie, "/__ctl/alerts/channels", JSON.stringify(b));
      assert.deepStrictEqual((await get()).channels, []);
      const ch = { id: "ch_w", type: "webhook", name: "hook", min: "warning", on: true, config: { url } };
      assert.strictEqual((await save({ channels: [ch] })).status, 200);
      assert.match(hub.logs(), /event=alert\.channels_saved/);
      assert.deepStrictEqual((await get()).channels[0].config, { url: "********" }, "a webhook URL is a secret");
      assert.strictEqual(fs.statSync(path.join(hub.dataDir, "alerts", "channels.json")).mode & 0o777, 0o600);
      assert.strictEqual((await save({ channels: [{ ...ch, config: { url: "********" } }] })).status, 200, "masked: kept");
      const bad = await save({ channels: [{ ...ch, min: "page" }] });
      assert.deepStrictEqual([bad.status, JSON.parse(bad.body).error], [400, "hook: min: one of critical, warning, info"]);
      // reboot_required raised to warning, so it is sent at once
      assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/alerts/rules", JSON.stringify({ rules: [{ id: "reboot_required", severity: "warning" }] }))).status, 200);
      assert.strictEqual((await signed(hub, c, { body: snap({ ubuntu: { rebootRequired: true } }) })).status, 200);
      for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual([got[0].url, got[0].body.kind], ["/hook", "alert"]);
      assert.match(got[0].body.title, /^warning: reboot required on \S/);
      const t = JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/alerts/channels/test", JSON.stringify({ id: "ch_w" }))).body);
      assert.deepStrictEqual(t, { ok: true });
      assert.match(hub.logs(), /event=alert\.channel_test.*channel=ch_w/, "a test is a call out of the hub: audited");
      assert.strictEqual(got[1].body.kind, "test");
      assert.strictEqual((await save({ channels: [{ ...ch, config: { url: url.replace("/hook", "/gone") } }] })).status, 200);
      assert.deepStrictEqual(JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/alerts/channels/test", JSON.stringify({ id: "ch_w" }))).body), { ok: false, error: "HTTP_410" });
      assert.strictEqual((await get()).status.ch_w.lastError, "HTTP_410");
      assert.doesNotMatch(hub.logs(), /127\.0\.0\.1:\d+\/(hook|gone)/, "the hub's log never shows a channel's URL");
      assert.strictEqual((await request(hub.port, { path: "/__ctl/alerts/channels" })).status, 401);
    });
  } finally { dest.close(); }
});
