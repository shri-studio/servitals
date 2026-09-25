// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const fs = require("fs");

// Write through a temp file and rename, so readers never see half a file.
function writeFileAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.unlinkSync(tmp); } catch (_) { /* nothing left over */ }
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
