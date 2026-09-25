// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNodeStore, newNodeId, localAgentEnv } = require("../hub/lib/nodes");

const tmpfile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-nodes-")), "nodes.json");
const bumpMtime = (f) => fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));

test("node ids are 12 base32 characters", () => {
  for (let i = 0; i < 50; i++) assert.match(newNodeId(), /^[a-z2-7]{12}$/);
});

test("ensureLocal creates one local node, once, in a private file", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  assert.strictEqual(store.localId(), null);
  const a = store.ensureLocal("host-a");
  assert.strictEqual(a.created, true);
  assert.match(a.id, /^[a-z2-7]{12}$/);
  const n = store.get(a.id);
  assert.match(n.secret, /^[0-9a-f]{64}$/);
  assert.strictEqual(n.local, true);
  assert.strictEqual(n.name, "host-a");
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(store.ensureLocal("host-b"), { id: a.id, created: false });
  assert.strictEqual(createNodeStore(f).localId(), a.id, "a second store reads the same file");
});

test("unknown and revoked nodes are not returned", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  const { id } = store.ensureLocal("h");
  assert.strictEqual(store.get("aaaaaaaaaaaa"), null);
  const all = JSON.parse(fs.readFileSync(f, "utf8"));
  all[id].revoked = true;
  fs.writeFileSync(f, JSON.stringify(all));
  bumpMtime(f);
  assert.strictEqual(store.get(id), null, "an edit on disk is picked up by mtime");
  assert.strictEqual(store.localId(), null);
});

test("a corrupt file keeps the last good copy", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  const { id } = store.ensureLocal("h");
  fs.writeFileSync(f, "{ not json");
  bumpMtime(f);
  assert.ok(store.get(id));
});

test("local-agent.env text", () => {
  assert.strictEqual(localAgentEnv("http://127.0.0.1:20002", "abcdefghijkl", "ab".repeat(32)),
    `HUB_URL=http://127.0.0.1:20002\nNODE_ID=abcdefghijkl\nNODE_SECRET=${"ab".repeat(32)}\n`);
});

test("a nodes.json that does not parse is never overwritten", () => {
  const f = tmpfile();
  fs.writeFileSync(f, '{ "abcdefghijkl": { "secret": "x", "local": true }, }');
  const before = fs.readFileSync(f, "utf8");
  assert.throws(() => createNodeStore(f).ensureLocal("h"), /does not parse/);
  assert.strictEqual(fs.readFileSync(f, "utf8"), before);
});
