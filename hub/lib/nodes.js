// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * nodes.json: { "<node id>": { name, secret, local, created, revoked? } }, mode 0600.
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

  return { get, localId, ensureLocal, all: load };
}

const localAgentEnv = (hubUrl, id, secret) => `HUB_URL=${hubUrl}\nNODE_ID=${id}\nNODE_SECRET=${secret}\n`;

module.exports = { createNodeStore, newNodeId, localAgentEnv };
