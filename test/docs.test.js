// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const README = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

test("README has the native install section with the docker warning", () => {
  const i = README.indexOf("## Native install (systemd, no Docker)");
  assert.ok(i >= 0, "section heading");
  const sec = README.slice(i, README.indexOf("\n## ", i + 3));
  assert.match(sec, /```bash\nsudo apt install nodejs jq curl vnstat\n/);
  assert.match(sec, /\/etc\/servitals\/hub\.env/);
  assert.match(sec, /\*\*The `docker` group can take\s+over the host as root\*\*/);
  assert.match(sec, /--uninstall/);
});

test("the Docker upgrade note carries the gateway's new settings", () => {
  const i = README.indexOf("**Upgrading an existing Docker install:**");
  assert.ok(i >= 0);
  const note = README.slice(i, README.indexOf("\n\n", i));
  for (const s of ["LOCAL_HUB_URL", "WWW_DIR", "./www:/www:ro"]) assert.ok(note.includes(s), s);
});
