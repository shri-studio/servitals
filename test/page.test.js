// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");

// pull one top-level function out of the page's script and run it here
function pageFunction(name) {
  const m = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(HTML);
  assert.ok(m, `function ${name} not found in www/index.html`);
  return new Function(`${m[0]}; return ${name};`)();
}

test("disks without a configured label get a readable default", () => {
  const diskLabel = pageFunction("diskLabel");
  assert.strictEqual(diskLabel("/"), "system");
  assert.strictEqual(diskLabel("/srv"), "srv");
  assert.strictEqual(diskLabel("/mnt/elements"), "elements");
  assert.strictEqual(diskLabel("/mnt/router-usb/"), "router-usb");
});

test("a configured label still wins", () => {
  assert.match(HTML, /meta\.label \|\| diskLabel\(dk\.mount\)/);
});

test("the settings panel has the login section wired up", () => {
  for (const id of ["acct-user", "acct-new", "acct-new2", "acct-current", "acct-save", "acct-msg"]) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /\$\("#acct-save"\)\.onclick = saveAccount;/);
  assert.match(HTML, /fetch\("\/__ctl\/account"/);
});

test("the fleet grid and node tabs are wired up", () => {
  for (const id of ["tabs", "fleet"]) assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /fetch\("\/__ctl\/nodes\?t="/);
  assert.match(HTML, /`\/__ctl\/node\/\$\{currentNode\}`/);
  assert.match(HTML, /"\/__ctl\/refresh\?node=all"/);
  assert.match(HTML, /window\.addEventListener\("hashchange"/);
  // container buttons only for the hub's own host
  assert.match(HTML, /if \(!ctlAllowed \|\| !isLocalView\(\)\) return "";/);
  assert.match(HTML, /\/logs\$\{nodeQuery\(\)\}/);
  // node names, statuses and mounts come from remote machines: always escaped
  for (const expr of ["esc(n.name)", "esc(n.status)", "esc(disk.mount)", "esc(n.id)"]) {
    assert.ok(HTML.includes("${" + expr + "}"), `renderFleet must use \${${expr}}`);
  }
});

test("snapshot times are milliseconds", () => {
  assert.match(HTML, /const age = \(Date\.now\(\) - \(ts \|\| 0\)\) \/ 1000;/);
  assert.match(HTML, /new Date\(ts \|\| 0\)\.toLocaleTimeString\(\)/);
});

test("fleet numbers show a dash when unknown", () => {
  const fmtVal = pageFunction("fmtVal");
  assert.strictEqual(fmtVal(null, "%"), "–");
  assert.strictEqual(fmtVal(12.6, "%"), "13%");
  assert.strictEqual(fmtVal(0, "°C"), "0°C");
});

test("vnStat bar titles from remote nodes are escaped, also in the tooltip", () => {
  assert.doesNotMatch(HTML, /data-t="\$\{x\.title\}"/);
  assert.match(HTML, /data-t="\$\{esc\(x\.title\)\}"/);
  assert.doesNotMatch(HTML, /\$\{d\.dataset\.t\}/);
  assert.match(HTML, /\$\{esc\(d\.dataset\.t\)\}/);
});

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| cfg\.panels\[panel\] === false\)/);
});

test("without vnStat the network panel shows the live rate and says how to get history", () => {
  assert.match(HTML, /install vnstat for today, month and 30-day history/);
});

test("the node tabs sit at the top, above the header", () => {
  const tabs = HTML.indexOf('<nav class="tabs hidden" id="tabs"');
  const head = HTML.indexOf('<div class="head">');
  assert.ok(tabs > 0 && head > 0 && tabs < head, "tabs before the header bar");
});
