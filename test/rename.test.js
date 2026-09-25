// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// README.md joins this list in Task 10, when it is rewritten
const FILES = ["hub/server.js", "agent/collect.sh", "www/index.html", "docker-compose.example.yml", ".env.example"];

test("old names only remain on lines marked legacy-name", () => {
  for (const f of FILES) {
    fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (/systemdashboard|sysdash|sd_session/i.test(line) && !line.includes("legacy-name")) {
        assert.fail(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
});

test("compose file uses the new service names and pinned subnet", () => {
  const c = fs.readFileSync(path.join(ROOT, "docker-compose.example.yml"), "utf8");
  for (const s of ["gateway:", "container_name: servitals-gateway", "subnet: 172.31.250.0/24",
    "TRUSTED_PROXIES=${TRUSTED_PROXIES:-172.31.250.1}", "AUTH_PASS_HASH=${AUTH_PASS_HASH:-}"]) {
    assert.ok(c.includes(s), `missing: ${s}`);
  }
  assert.ok(!/TRUST_PROXY=/.test(c), "TRUST_PROXY must be gone");
});
