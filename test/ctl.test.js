// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { verifyPassword } = require("../hub/lib/password");

const CTL = path.join(__dirname, "..", "bin", "servitals-ctl");
function ctl(dataDir, args, input) {
  return execFileSync("bash", [CTL, ...args], { env: { ...process.env, DATA_DIR: dataDir }, input }).toString();
}
function tmpData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ctl-"));
  fs.writeFileSync(path.join(d, "bans.json"), JSON.stringify({ "203.0.113.9": { at: 0, until: 0, fails: 3 } }));
  fs.writeFileSync(path.join(d, "whitelist.txt"), "# comment\n127.0.0.1\n");
  return d;
}

test("bans lists blocked IPs and the whitelist", () => {
  const d = tmpData();
  const out = ctl(d, ["bans"]);
  assert.match(out, /203\.0\.113\.9/);
  assert.match(out, /\(permanent\)/);
  assert.match(out, /127\.0\.0\.1/);
});

test("unban removes the entry", () => {
  const d = tmpData();
  ctl(d, ["unban", "203.0.113.9"]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "bans.json"), "utf8")), {});
});

test("whitelist appends once and unbans", () => {
  const d = tmpData();
  ctl(d, ["whitelist", "203.0.113.9"]);
  ctl(d, ["whitelist", "203.0.113.9"]);
  const wl = fs.readFileSync(path.join(d, "whitelist.txt"), "utf8");
  assert.strictEqual(wl.split("\n").filter((l) => l === "203.0.113.9").length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "bans.json"), "utf8")), {});
});

test("whitelist validates addresses without needing node", () => {
  const d = tmpData();
  for (const bad of ["not-an-ip", "300.1.1.1", "10.0.0.0/33", "fd00::/8", "1.2.3"]) {
    assert.throws(() => ctl(d, ["whitelist", bad]), bad);
  }
  for (const good of ["198.51.100.0/24", "10.1.2.3", "2001:db8::1", "::1"]) {
    ctl(d, ["whitelist", good]);
  }
});

test("hash-password reads stdin when not a terminal", async () => {
  const d = tmpData();
  const out = ctl(d, ["hash-password"], "long-enough-pass\n").trim();
  assert.strictEqual(await verifyPassword("long-enough-pass", out), true);
});

test("hash-password refuses short passwords", () => {
  const d = tmpData();
  assert.throws(() => ctl(d, ["hash-password"], "short\n"));
});

test("old bin/unban wrapper still works", () => {
  const d = tmpData();
  execFileSync("sh", [path.join(__dirname, "..", "bin", "unban"), "203.0.113.9"], { env: { ...process.env, DATA_DIR: d } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, "bans.json"), "utf8")), {});
});
