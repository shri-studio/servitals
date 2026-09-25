// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The product version, from the VERSION file: next to server.js inside the
 * Docker image and the Ubuntu package, or at the repository root in a
 * checkout. Shown to logged-in users only (never on the login page).
 */
const fs = require("node:fs");
const path = require("node:path");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const DEFAULT_CANDIDATES = [
  path.join(__dirname, "..", "VERSION"),        // /app/VERSION in the image
  path.join(__dirname, "..", "..", "VERSION"),  // repository root
];

function readVersion(candidates = DEFAULT_CANDIDATES) {
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (SEMVER.test(v)) return v;
    } catch (_) { /* try the next location */ }
  }
  return "unknown";
}

module.exports = { VERSION: readVersion(), readVersion };
