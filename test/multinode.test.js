// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { signRequest } = require("../hub/lib/agentsig");

const NODES_JS = path.join(__dirname, "..", "hub", "lib", "nodes.js");
const PUSH = "/api/v1/agent/push";
const WAIT = "/api/v1/agent/wait";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addNode(hub, name) {
  return JSON.parse(execFileSync(process.execPath, [NODES_JS, path.join(hub.dataDir, "nodes.json"), "add", name, "lab"]).toString());
}
let lastTs = 0;
const nextTs = () => String(lastTs = Math.max(Date.now(), lastTs + 1));
function signed(hub, c, { method = "POST", path: p = PUSH, body = "", ts = nextTs(), headers = {}, secret = c.secret } = {}) {
  const buf = Buffer.from(body);
  return request(hub.port, {
    method, path: p, body: buf.length ? buf : undefined,
    headers: { "content-type": "application/json", "content-length": buf.length, "x-servitals-proto": "1",
      "x-servitals-agent": "test/0", "x-servitals-node": c.id, "x-servitals-ts": ts,
      "x-servitals-sig": signRequest(secret, method, p, ts, buf), ...headers },
  }).then((r) => ({ ...r, ts }));
}
const snap = (over = {}) => JSON.stringify({
  schema: 1, ts: Date.now(), interval: 60, host: { name: "nas", os: "linux", distro: "Ubuntu" },
  cpu: { usage: 5, cores: 2 }, mem: { total: 100, used: 30 },
  disks: [{ mount: "/srv", mounted: true, pct: 91 }],
  net: { iface: "eth0", rxBytes: 1000, txBytes: 0 }, docker: [{ name: "db", id: "d1", state: "running", cpuUsec: 0, mem: 1 }],
  ...over,
});
const getJSON = async (hub, cookie, p) => {
  const r = await request(hub.port, { path: p, headers: { cookie } });
  return { status: r.status, body: JSON.parse(r.body) };
};

test("a second node joins the fleet and gets its own view", { timeout: 60000 }, async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    const before = await getJSON(hub, cookie, "/__ctl/nodes");
    assert.deepStrictEqual(before.body.map((n) => [n.local, n.status]), [[true, "waiting"], [false, "waiting"]]);

    assert.strictEqual((await signed(hub, nas, { body: snap() })).status, 200);
    const list = (await getJSON(hub, cookie, "/__ctl/nodes")).body;
    const card = list.find((n) => n.id === nas.id);
    assert.strictEqual(card.status, "online");
    assert.deepStrictEqual(card.tags, ["lab"]);
    assert.deepStrictEqual([card.summary.cpu, card.summary.mem, card.summary.disk], [5, 30, { mount: "/srv", pct: 91 }]);
    assert.ok(!JSON.stringify(list).includes(nas.secret), "secrets never reach the page");

    await sleep(5100);   // the hub takes one push per 5 s per node
    assert.strictEqual((await signed(hub, nas, { body: snap({ net: { iface: "eth0", rxBytes: 6000, txBytes: 0 },
      docker: [{ name: "db", id: "d1", state: "running", cpuUsec: 2000000, mem: 1 }] }) })).status, 200);
    const v = await getJSON(hub, cookie, `/__ctl/node/${nas.id}`);
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.node.name, "nas");
    assert.ok(v.body.net.rateRx > 0 && v.body.net.rateRx <= 1000, String(v.body.net.rateRx));
    assert.ok(v.body.docker[0].cpu > 0);
    assert.strictEqual(v.body.trend.length, 2);
    assert.strictEqual((await getJSON(hub, cookie, "/__ctl/node/aaaaaaaaaaaa")).status, 404);
  } finally { await hub.stop(); }
});

test("refresh wakes one node or all of them", async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    const wait = signed(hub, nas, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    await sleep(300);
    const r = await ctlPost(hub.port, cookie, `/__ctl/refresh?node=${nas.id}`);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, woke: true, fresh: false });
    assert.strictEqual((await wait).status, 200);
    const all = await ctlPost(hub.port, cookie, "/__ctl/refresh?node=all");
    assert.deepStrictEqual(JSON.parse(all.body), { ok: true, woke: 0 }, "nobody is waiting now");
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/refresh?node=aaaaaaaaaaaa")).status, 404);
  } finally { await hub.stop(); }
});

test("container controls refuse every node but the hub's own", async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    const r = await ctlPost(hub.port, cookie, `/__ctl/container/web/restart?node=${nas.id}`);
    assert.strictEqual(r.status, 403);
    assert.match(JSON.parse(r.body).error, /only on the hub's own host/);
    const local = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "nodes.json"), "utf8"));
    const localId = Object.keys(local).find((id) => local[id].local);
    const mine = await ctlPost(hub.port, cookie, `/__ctl/container/web/restart?node=${localId}`);
    assert.doesNotMatch(mine.body, /only on the hub's own host/);
  } finally { await hub.stop(); }
});

test("a revoked node is refused and leaves the fleet", async () => {
  const hub = await startHub();
  try {
    const cookie = cookieFrom(await login(hub.port));
    const nas = addNode(hub, "nas");
    execFileSync(process.execPath, [NODES_JS, path.join(hub.dataDir, "nodes.json"), "revoke", nas.id]);
    const r = await signed(hub, nas, { body: snap() });
    assert.deepStrictEqual([r.status, JSON.parse(r.body).error], [401, "unknown_node"]);
    assert.ok(!(await getJSON(hub, cookie, "/__ctl/nodes")).body.some((n) => n.id === nas.id));
    assert.strictEqual((await getJSON(hub, cookie, `/__ctl/node/${nas.id}`)).status, 404);
  } finally { await hub.stop(); }
});

test("the page renames, tags and revokes a node; revoking is LAN-only and never the hub's own", async () => {
  const hub = await startHub();
  try {
    const c = addNode(hub, "nas");
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 200);
    const cookie = cookieFrom(await login(hub.port));
    const node = (id) => getJSON(hub, cookie, "/__ctl/nodes").then((r) => r.body.find((n) => n.id === id));

    let r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ name: "  big nas ", tags: ["home", "storage"] }));
    assert.strictEqual(r.status, 200, r.body);
    assert.deepStrictEqual(((n) => [n.name, n.tags])(await node(c.id)), ["big nas", ["home", "storage"]]);
    r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ tags: ["Bad Tag"] }));
    assert.deepStrictEqual([r.status, /tag/.test(JSON.parse(r.body).error)], [400, true]);
    r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ name: "" }));
    assert.strictEqual(r.status, 400);
    r = await ctlPost(hub.port, cookie, "/__ctl/node/aaaaaaaaaaaa", JSON.stringify({ name: "x" }));
    assert.strictEqual(r.status, 404);

    const revoke = (id, from) => request(hub.port, { method: "POST", path: `/__ctl/node/${id}/revoke`,
      headers: { cookie, origin: `http://127.0.0.1:${hub.port}`, "x-forwarded-for": from } });
    assert.strictEqual((await revoke(c.id, "203.0.113.5")).status, 403, "not from outside the LAN");
    const local = (await getJSON(hub, cookie, "/__ctl/nodes")).body.find((n) => n.local);
    assert.strictEqual((await revoke(local.id, "192.168.1.10")).status, 400, "never the hub's own node");

    assert.strictEqual((await revoke(c.id, "192.168.1.10")).status, 200);
    assert.strictEqual(await node(c.id), undefined, "gone from the fleet");
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 401, "its agent is refused");
    assert.ok(!fs.existsSync(path.join(hub.dataDir, "snapshots", c.id + ".json")), "its snapshot is gone");
    assert.match(fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8"), /node\.revoked/);
  } finally { await hub.stop(); }
});

test("conf.d: file settings win in config.json and are listed as managed; file tags and names win for nodes", async () => {
  const confd = fs.mkdtempSync(path.join(os.tmpdir(), "sv-confd-"));
  fs.writeFileSync(path.join(confd, "10-site.json"), JSON.stringify({
    settings: { title: "from file", units: { temp: "f" } },
    nodes: { nas: { tags: ["storage"] } },
  }));
  const hub = await startHub({ CONFD_DIR: confd });
  try {
    const c = addNode(hub, "nas");
    const cookie = cookieFrom(await login(hub.port));
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/config",
      JSON.stringify({ title: "from page", units: { temp: "c", clock: "12h" }, _managed: ["x"] }))).status, 200);
    const cfg = (await getJSON(hub, cookie, "/config.json")).body;
    assert.strictEqual(cfg.title, "from file");
    assert.deepStrictEqual(cfg.units, { temp: "f", clock: "12h" }, "key by key: the page's clock stays");
    assert.deepStrictEqual(cfg._managed, ["title", "units.temp"]);
    const saved = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "config.json"), "utf8"));
    assert.strictEqual(saved._managed, undefined, "the list is never saved");

    const n = (await getJSON(hub, cookie, "/__ctl/nodes")).body.find((x) => x.id === c.id);
    assert.deepStrictEqual([n.tags, n.managed], [["storage"], ["name", "tags"]], "found by its name: the name is pinned too");
    const r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ tags: ["other"] }));
    assert.deepStrictEqual([r.status, JSON.parse(r.body).error], [409, "tags are managed by a file in conf.d"]);
    assert.strictEqual((await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ name: "nas2" }))).status, 409,
      "a file that finds the node by its name pins that name: a rename would detach it");

    fs.writeFileSync(path.join(confd, "20-bad.json"), "{ nope");
    await sleep(2100);
    assert.strictEqual((await getJSON(hub, cookie, "/config.json")).body.title, "from file", "a bad file changes nothing");
    assert.match(hub.logs(), /config\.file_skipped.*20-bad\.json/);
  } finally { await hub.stop(); fs.rmSync(confd, { recursive: true, force: true }); }
});

test("conf.d review: entries by id and by name merge; saving settings never copies file values into config.json", async () => {
  const confd = fs.mkdtempSync(path.join(os.tmpdir(), "sv-confd-"));
  const hub = await startHub({ CONFD_DIR: confd });
  try {
    const c = addNode(hub, "nas");
    const cookie = cookieFrom(await login(hub.port));
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/config", JSON.stringify({ title: "my lab", units: { temp: "c" } }))).status, 200);
    fs.writeFileSync(path.join(confd, "10-a.json"), JSON.stringify({ settings: { title: "from file", units: { temp: "f" } }, nodes: { nas: { tags: ["home"] } } }));
    fs.writeFileSync(path.join(confd, "20-b.json"), JSON.stringify({ nodes: { [c.id]: { name: "big nas" } } }));
    await sleep(2100);
    const n = (await getJSON(hub, cookie, "/__ctl/nodes")).body.find((x) => x.id === c.id);
    assert.deepStrictEqual([n.name, n.tags, n.managed], ["big nas", ["home"], ["name", "tags"]]);

    // the page saves its whole config, file values included
    const shown = (await getJSON(hub, cookie, "/config.json")).body;
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/config", JSON.stringify({ ...shown, refreshSec: 30 }))).status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "config.json"), "utf8"));
    assert.deepStrictEqual([saved.title, saved.units.temp, saved.refreshSec], ["my lab", "c", 30], "the page's own values stay underneath");
    fs.rmSync(path.join(confd, "10-a.json"));
    await sleep(2100);
    assert.strictEqual((await getJSON(hub, cookie, "/config.json")).body.title, "my lab", "and come back when the file goes");
  } finally { await hub.stop(); fs.rmSync(confd, { recursive: true, force: true }); }
});

