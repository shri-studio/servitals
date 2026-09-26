// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VERSION, readVersion } = require("../hub/lib/version");
const { startHub, request, login, cookieFrom } = require("./helpers/hub");

const ROOT = path.join(__dirname, "..");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

test("VERSION file holds one semantic version", () => {
  const v = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8");
  assert.match(v, /^\S+\n$/, "one line, trailing newline");
  assert.match(v.trim(), SEMVER);
});

test("hub reads the same version", () => {
  assert.strictEqual(VERSION, fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim());
});

test("readVersion ignores missing or malformed files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ver-"));
  const bad = path.join(dir, "VERSION");
  fs.writeFileSync(bad, "not a version\n");
  assert.strictEqual(readVersion([path.join(dir, "missing"), bad]), "unknown");
  fs.writeFileSync(bad, "2.3.4\n");
  assert.strictEqual(readVersion([path.join(dir, "missing"), bad]), "2.3.4");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CHANGELOG has a section for this version", () => {
  const log = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const heading = VERSION.includes("-") ? "## [Unreleased]" : `## [${VERSION}]`;
  assert.ok(log.includes(heading), `CHANGELOG.md needs "${heading}"`);
});

test("version is shown after login only", async () => {
  const hub = await startHub();
  try {
    const page = await request(hub.port, { path: "/" });
    assert.ok(!page.body.includes(VERSION), "login page must not reveal the version");
    assert.match(page.body, /servitals/);
    const cookie = cookieFrom(await login(hub.port));
    const who = JSON.parse((await request(hub.port, { path: "/__ctl/whoami", headers: { cookie } })).body);
    assert.strictEqual(who.version, VERSION);
    assert.match(hub.logs(), new RegExp(`event=server\\.start .*version=${VERSION.replace(/\./g, "\\.")}`));
  } finally {
    await hub.stop();
  }
});

test("dashboard has the branding footer and the update notice", () => {
  const html = fs.readFileSync(path.join(ROOT, "www", "index.html"), "utf8");
  for (const id of ["brandfoot", "sv-version", "updnote", "updver", "upddismiss"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes("https://github.com/shri-studio/servitals"), "footer links the source");
  // .update-note sets display:flex, which would override the hidden attribute
  assert.match(html, /\.update-note\[hidden\]\s*\{\s*display:\s*none/, "hidden update note must stay hidden");
});

test("the Debian version follows VERSION", () => {
  const upstream = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim().replace(/-/g, "~");
  const first = fs.readFileSync(path.join(ROOT, "debian", "changelog"), "utf8").split("\n")[0];
  assert.match(first, new RegExp(`^servitals \\(${upstream.replace(/[.~]/g, "\\$&")}-\\d+\\) [a-z]+; urgency=`));
});
