// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * nodes.json: { "<node id>": { name, secret, local, created, tags?, revoked? } }, mode 0600.
 * Re-read when its mtime changes, so servitals-ctl can edit it without a
 * restart. A file that does not parse keeps the last good copy in memory.
 */
const crypto = require("crypto");
const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const newNodeId = () => [...crypto.randomBytes(12)].map((b) => B32[b & 31]).join("");

function createNodeStore(file) {
  let nodes = {};
  let mtime = -1;
  let unreadable = false;   // the file exists but never parsed: never overwrite it

  function load() {
    let st;
    try { st = fs.statSync(file); } catch (_) { nodes = {}; mtime = -1; unreadable = false; return nodes; }
    if (st.mtimeMs === mtime) return nodes;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      nodes = parsed;
      mtime = st.mtimeMs;
      unreadable = false;
    } catch (_) {
      // half-written or bad hand edit: keep the last good copy; with none, refuse to write
      if (mtime === -1) unreadable = true;
    }
    return nodes;
  }

  function save() {
    writeFileAtomic(file, JSON.stringify(nodes, null, 2) + "\n", 0o600);
    mtime = fs.statSync(file).mtimeMs;
  }

  function get(id) {
    const n = Object.prototype.hasOwnProperty.call(load(), id) ? nodes[id] : null;
    return n && !n.revoked ? n : null;
  }

  function localId() {
    const all = load();
    return Object.keys(all).find((id) => all[id].local && !all[id].revoked) || null;
  }

  function ensureLocal(name) {
    const existing = localId();
    if (existing) return { id: existing, created: false };
    if (unreadable) throw new Error(`${file} exists but does not parse; fix or remove it`);
    const id = newNodeId();
    nodes[id] = { name, secret: crypto.randomBytes(32).toString("hex"), local: true, created: Date.now() };
    save();
    return { id, created: true };
  }

  const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
  const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  function checkName(name) {
    const n = String(name || "").trim();
    if (!NAME.test(n)) throw new Error("name: 1-64 printable characters");
    return n;
  }

  // throws with a message for the person when a name or tag is not allowed
  function check(name, tags = []) {
    const clean = checkName(name);
    for (const t of tags) if (!TAG.test(t)) throw new Error(`tag "${t}": lowercase letters, digits, dot, dash, underscore`);
    return clean;
  }

  // a remote node: returns its id and secret (the secret is shown once, in the join string).
  // A linked agent brings its own secret (spec 6.1.1).
  function add(name, tags = [], secret = crypto.randomBytes(32).toString("hex")) {
    const clean = check(name, tags);
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("secret: 64 hex characters");
    load();
    if (unreadable) throw new Error(`${file} exists but does not parse; fix or remove it`);
    let id;
    do { id = newNodeId(); } while (nodes[id]);
    nodes[id] = { name: clean, secret, local: false, created: Date.now(), tags };
    save();
    return { id, secret };
  }

  function change(id, fn) {
    load();
    if (!Object.prototype.hasOwnProperty.call(nodes, id) || nodes[id].revoked) throw new Error(`no node ${id}`);
    fn(nodes[id]);
    save();
  }
  const rename = (id, name) => change(id, (n) => { n.name = checkName(name); });
  const setTags = (id, tags) => change(id, (n) => {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) throw new Error("tags: a list of words");
    check(n.name, tags);
    n.tags = [...new Set(tags)];
  });
  const revoke = (id) => change(id, (n) => {
    if (n.local) throw new Error("the local node cannot be revoked");
    n.revoked = true;
    n.secret = "";
  });

  // every node that is not revoked, without secrets
  function list() {
    const all = load();
    return Object.keys(all).filter((id) => !all[id].revoked).map((id) => ({
      id, name: all[id].name, local: !!all[id].local, created: all[id].created, tags: all[id].tags || [],
    }));
  }

  return { get, localId, ensureLocal, check, add, rename, setTags, revoke, list, all: load };
}

const localAgentEnv = (hubUrl, id, secret) => `HUB_URL=${hubUrl}\nNODE_ID=${id}\nNODE_SECRET=${secret}\n`;

module.exports = { createNodeStore, newNodeId, localAgentEnv };

// CLI for servitals-ctl: node nodes.js <nodes.json> add <name> [tag...] | list | rename <id> <name> | revoke <id>
if (require.main === module) {
  const [file, cmd, ...args] = process.argv.slice(2);
  try {
    const store = createNodeStore(file);
    let out;
    if (cmd === "add") out = store.add(args[0], args.slice(1));
    else if (cmd === "list") out = store.list();
    else if (cmd === "rename") { store.rename(args[0], args[1]); out = { ok: true }; }
    else if (cmd === "revoke") { store.revoke(args[0]); out = { ok: true }; }
    else throw new Error("usage: nodes.js <nodes.json> add|list|rename|revoke ...");
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
