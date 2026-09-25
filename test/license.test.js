// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

test("LICENSE is the AGPL v3 and font licenses are present", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
  for (const f of ["OFL-JetBrainsMono.txt", "OFL-PressStart2P.txt"]) {
    assert.match(fs.readFileSync(path.join(ROOT, "www", "fonts", f), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/i);
  }
});

test("every tracked source file carries an SPDX identifier", () => {
  const files = execFileSync("git", ["ls-files", "hub", "agent", "bin", "test", "www/index.html",
    "docker-compose.example.yml", "nginx.conf"], { cwd: ROOT }).toString().split("\n").filter(Boolean);
  const missing = files.filter((f) => /\.(js|sh|html|yml|conf)$|Dockerfile$|^bin\//.test(f))
    .filter((f) => !fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").slice(0, 5)
      .some((l) => l.includes("SPDX-License-Identifier: AGPL-3.0-or-later")));
  assert.deepStrictEqual(missing, []);
});
