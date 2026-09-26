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
