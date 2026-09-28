// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Config as code (spec 12): /etc/servitals/conf.d/*.json, read in name order.
 * A file holds "settings" (dashboard defaults) and/or "nodes" (tags or a name
 * per node id or name). Later files win, key by key; values from files win over
 * values edited in the page, which shows them as "managed by file". A file with
 * any mistake is skipped whole and logged, never half-applied.
 *
 *   node confd.js check <dir>     what servitals-ctl config check runs
 */
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 256 * 1024;
const CHECK_EVERY_MS = 2000;
const PANELS = ["mem", "cpu", "temp", "storage", "network", "docker", "clocks", "weather"];
const NODE_ID = /^[a-z2-7]{12}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;

class Invalid extends Error {}
const fail = (where, what) => { throw new Invalid(`${where}: ${what}`); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function onlyKeys(obj, where, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(where, `unknown key "${k}"`);
}
const oneOf = (choices) => (v, where) => { if (!choices.includes(v)) fail(where, `one of ${choices.join(", ")}`); return v; };
const bool = (v, where) => { if (typeof v !== "boolean") fail(where, "true or false"); return v; };
const range = (lo, hi) => (v, where) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fail(where, `a number from ${lo} to ${hi}`);
  return v;
};
const listOf = (choices, what) => (v, where) => {
  if (!Array.isArray(v) || !v.every((x) => choices.includes(x))) fail(where, `a list of ${what || choices.join(", ")}`);
  return [...v];
};
const strings = (v, where) => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(where, "a list of words");
  return [...v];
};
// an object whose keys come from `keys` and whose values pass `check`
const table = (keys, check) => (v, where) => {
  if (!isObject(v)) fail(where, "an object");
  onlyKeys(v, where, keys);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = typeof check === "function" ? check(x, `${where}.${k}`) : check[k](x, `${where}.${k}`);
  return out;
};

const SETTINGS = {
  title: (v, where) => { if (typeof v !== "string" || !NAME.test(v)) fail(where, "1-64 characters"); return v; },
  refreshSec: range(5, 900),
  kioskSec: range(5, 600),
  kiosk: bool,
  style: (v, where) => { if (typeof v !== "string" || !/^[a-z0-9-]{1,32}$/.test(v)) fail(where, "a style name"); return v; },
  mode: oneOf(["system", "light", "dark"]),
  density: oneOf(["compact", "comfortable", "large"]),
  units: table(["temp", "size", "rate", "clock"], {
    temp: oneOf(["c", "f"]), size: oneOf(["binary", "decimal"]), rate: oneOf(["bytes", "bits"]), clock: oneOf(["auto", "24h", "12h"]),
  }),
  fleet: table(["sort", "group", "card", "pinned", "hidden"], {
    sort: oneOf(["name", "status", "cpu", "mem", "temp", "disk"]), group: bool,
    card: listOf(["cpu", "mem", "temp", "disk", "containers"]), pinned: strings, hidden: strings,
  }),
  panels: table(PANELS, bool),
  panelSize: table(PANELS, oneOf(["normal", "wide", "full"])),
  panelOrder: listOf(PANELS, "panel names"),
};
const NESTED = ["units", "fleet", "panels", "panelSize"];   // merged key by key

function checkNode(key, v) {
  const where = `nodes.${key}`;
  if (!NODE_ID.test(key) && !NAME.test(key)) fail("nodes", "a node id or name for each entry");
  if (!isObject(v)) fail(where, "an object");
  onlyKeys(v, where, ["tags", "name"]);
  const out = {};
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags)) fail(`${where}.tags`, "a list");
    for (const t of v.tags) {
      if (typeof t !== "string" || !TAG.test(t)) fail(`${where}.tags`, `tag "${t}": lowercase letters, digits, dot, dash, underscore`);
    }
    out.tags = [...new Set(v.tags)];
  }
  if (v.name !== undefined) {
    if (typeof v.name !== "string" || !NAME.test(v.name.trim())) fail(`${where}.name`, "1-64 characters");
    out.name = v.name.trim();
  }
  return out;
}

// one file's text: { settings, nodes } or an Invalid error
function parseFile(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Invalid(`not valid JSON: ${e.message}`); }
  if (!isObject(obj)) throw new Invalid('an object with "settings" and/or "nodes"');
  onlyKeys(obj, "file", ["settings", "nodes"]);
  const settings = {}, nodes = {};
  if (obj.settings !== undefined) {
    if (!isObject(obj.settings)) fail("settings", "an object");
    onlyKeys(obj.settings, "settings", Object.keys(SETTINGS));
    for (const [k, v] of Object.entries(obj.settings)) settings[k] = SETTINGS[k](v, `settings.${k}`);
  }
  if (obj.nodes !== undefined) {
    if (!isObject(obj.nodes)) fail("nodes", "an object");
    for (const [k, v] of Object.entries(obj.nodes)) nodes[k] = checkNode(k, v);
  }
  return { settings, nodes };
}

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
      .map((name) => ({ name, file: path.join(dir, name), st: fs.statSync(path.join(dir, name)) }))
      .filter((f) => f.st.isFile());
  } catch (_) { return []; }
}

function readConfd(dir) {
  const out = { settings: {}, nodes: {}, managed: [], files: [] };
  for (const { name, file, st } of jsonFiles(dir)) {
    try {
      if (st.size > MAX_BYTES) throw new Invalid("larger than 256 KB");
      const { settings, nodes } = parseFile(fs.readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(settings)) {
        out.settings[k] = NESTED.includes(k) ? { ...(out.settings[k] || {}), ...v } : v;
      }
      for (const [k, v] of Object.entries(nodes)) out.nodes[k] = { ...(out.nodes[k] || {}), ...v };
      out.files.push({ name, ok: true });
    } catch (e) {
      if (!(e instanceof Invalid)) e.message = `could not read: ${e.code || e.message}`;
      out.files.push({ name, ok: false, error: e.message });
    }
  }
  for (const [k, v] of Object.entries(out.settings)) {
    if (NESTED.includes(k)) for (const n of Object.keys(v)) out.managed.push(`${k}.${n}`);
    else out.managed.push(k);
  }
  out.managed.sort();
  return out;
}

// the hub's copy: looks at the directory again at most every 2 s, logs each bad file once
function createConfd(dir, { log, now = Date.now } = {}) {
  let current = null, lastCheck = -Infinity, signature = "";
  const logged = new Set();
  function get() {
    const t = now();
    if (current && t - lastCheck < CHECK_EVERY_MS) return current;
    lastCheck = t;
    const sig = jsonFiles(dir).map((f) => `${f.name}:${f.st.mtimeMs}:${f.st.size}`).join("|");
    if (current && sig === signature) return current;
    signature = sig;
    current = readConfd(dir);
    for (const f of current.files) {
      const key = `${f.name}:${f.error}`;
      if (!f.ok && !logged.has(key)) { logged.add(key); if (log) log.warn("config.file_skipped", { file: f.name, error: f.error }); }
    }
    return current;
  }
  return { get };
}

module.exports = { readConfd, createConfd, parseFile };

if (require.main === module) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== "check" || !dir) { process.stderr.write("usage: confd.js check <dir>\n"); process.exit(2); }
  const c = readConfd(dir);
  if (!c.files.length) process.stdout.write(`no files in ${dir}\n`);
  for (const f of c.files) process.stdout.write(f.ok ? `ok     ${f.name}\n` : `error  ${f.name}: ${f.error}\n`);
  process.exit(c.files.every((f) => f.ok) ? 0 : 1);
}
