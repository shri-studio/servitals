// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readConfd, createConfd } = require("../hub/lib/confd");

const CONFD_JS = path.join(__dirname, "..", "hub", "lib", "confd.js");
function dir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sv-confd-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), typeof body === "string" ? body : JSON.stringify(body));
  return d;
}

test("files are read in name order; later values win, key by key", () => {
  const d = dir({
    "10-base.json": { settings: { title: "home", units: { temp: "f", clock: "24h" }, fleet: { sort: "cpu" } } },
    "20-over.json": { settings: { units: { temp: "c" }, kiosk: true }, nodes: { nas: { tags: ["home"] } } },
    "README": "not json, not read",
    "30-off.json.example": "{ nope",
  });
  const c = readConfd(d);
  assert.deepStrictEqual(c.settings, { title: "home", units: { temp: "c", clock: "24h" }, fleet: { sort: "cpu" }, kiosk: true });
  assert.deepStrictEqual(c.nodes, { nas: { tags: ["home"] } });
  assert.deepStrictEqual(c.managed, ["fleet.sort", "kiosk", "title", "units.clock", "units.temp"]);
  assert.deepStrictEqual(c.files.map((f) => [f.name, f.ok]), [["10-base.json", true], ["20-over.json", true]]);
});

test("a file with any mistake is skipped whole and says where", () => {
  const cases = [
    ["{ not json", /not valid JSON/],
    ["[1]", /an object with "settings" and\/or "nodes"/],
    [{ setting: {} }, /unknown key "setting"/],
    [{ settings: { units: { temp: "k" } } }, /settings\.units\.temp: one of c, f/],
    [{ settings: { fleet: { card: ["cpu", "gpu"] } } }, /settings\.fleet\.card: a list of cpu, mem, temp, disk, containers/],
    [{ settings: { refreshSec: 2 } }, /settings\.refreshSec: a number from 5 to 900/],
    [{ settings: { title: "x".repeat(65) } }, /settings\.title: 1-64 characters/],
    [{ settings: { style: "Bad Style" } }, /settings\.style: a style name/],
    [{ settings: { panels: { mem: "yes" } } }, /settings\.panels\.mem: true or false/],
    [{ settings: { panelSize: { mem: "huge" } } }, /settings\.panelSize\.mem: one of normal, wide, full/],
    [{ settings: { favicon: "x" } }, /unknown key "favicon"/],
    [{ nodes: { nas: { tags: ["Bad Tag"] } } }, /nodes\.nas\.tags: tag "Bad Tag"/],
    [{ nodes: { nas: { colour: "red" } } }, /nodes\.nas: unknown key "colour"/],
    [{ nodes: { "": { tags: [] } } }, /nodes: a node id or name/],
    [JSON.stringify({ settings: { title: "ok" } }).replace("{", '{"__proto__":{"x":1},'), /unknown key "__proto__"/],
  ];
  for (const [body, want] of cases) {
    const d = dir({ "10-good.json": { settings: { title: "kept" } }, "20-bad.json": body });
    const c = readConfd(d);
    assert.deepStrictEqual(c.settings, { title: "kept" }, JSON.stringify(body));
    const bad = c.files.find((f) => f.name === "20-bad.json");
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, want, JSON.stringify(body));
  }
  assert.strictEqual(({}).x, undefined);
});

test("no directory, an empty one, or a huge file", () => {
  assert.deepStrictEqual(readConfd("/nonexistent/servitals/conf.d"), { settings: {}, nodes: {}, managed: [], files: [] });
  const d = dir({ "10-big.json": JSON.stringify({ settings: { title: "x" } }) + " ".repeat(300 * 1024) });
  assert.match(readConfd(d).files[0].error, /larger than 256 KB/);
});

test("the hub's copy follows edits, at most every 2 seconds, and logs each bad file once", () => {
  const d = dir({ "10-a.json": { settings: { title: "one" } } });
  let t = 1e12;
  const logged = [];
  const log = { warn: (event, f) => logged.push([event, f.file]) };
  const c = createConfd(d, { log, now: () => t });
  assert.strictEqual(c.get().settings.title, "one");
  fs.writeFileSync(path.join(d, "10-a.json"), JSON.stringify({ settings: { title: "two" } }));
  fs.writeFileSync(path.join(d, "20-b.json"), "{ bad");
  assert.strictEqual(c.get().settings.title, "one", "not looked at again within 2 s");
  t += 2001;
  assert.strictEqual(c.get().settings.title, "two");
  t += 2001; c.get();
  assert.deepStrictEqual(logged, [["config.file_skipped", "20-b.json"]]);
});

test("servitals-ctl config check: one line per file, exit 1 when any file is wrong", () => {
  const good = dir({ "10-a.json": { settings: { title: "one" } } });
  let r = spawnSync(process.execPath, [CONFD_JS, "check", good], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok +10-a\.json$/m);
  const bad = dir({ "10-a.json": { settings: { title: "one" } }, "20-b.json": { settings: { units: { temp: "k" } } } });
  r = spawnSync(process.execPath, [CONFD_JS, "check", bad], { encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error +20-b\.json: settings\.units\.temp: one of c, f$/m);
  r = spawnSync(process.execPath, [CONFD_JS, "check", "/nonexistent/dir"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no files in \/nonexistent\/dir/);
});
