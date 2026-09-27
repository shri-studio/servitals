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
