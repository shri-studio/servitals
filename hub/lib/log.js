// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Leveled logger. One event per line: logfmt by default, JSON on request.
 * Under systemd (journal: true) each line starts with an sd-daemon priority
 * prefix so `journalctl -p warning` filters by level. Field names that look
 * like secrets are redacted. audit() also appends a JSON line to auditFile.
 */
const fs = require("node:fs");

const LEVELS = { error: 3, warn: 4, info: 6, debug: 7 };
const SECRET_FIELD = /pass|secret|token|cookie|sig|key/i;

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = SECRET_FIELD.test(k) ? "[redacted]" : v;
  }
  return out;
}

function fmtValue(v) {
  if (v === null || v === undefined) return '""';
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === "" || /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

function logfmt(rec) {
  return Object.entries(rec).map(([k, v]) => `${k}=${fmtValue(v)}`).join(" ");
}

function createLogger({
  level = "info",
  format = "logfmt",
  journal = false,
  auditFile = null,
  auditMaxBytes = 5 * 1024 * 1024,
  write = (s) => process.stdout.write(s),
  now = () => new Date(),
} = {}) {
  const threshold = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;

  function emit(lvl, event, fields) {
    if (LEVELS[lvl] > threshold) return;
    const rec = { ts: now().toISOString(), level: lvl, event, ...redact(fields) };
    const line = format === "json" ? JSON.stringify(rec) : logfmt(rec);
    write((journal ? `<${LEVELS[lvl]}>` : "") + line + "\n");
  }

  function audit(event, fields) {
    emit("info", event, fields);
    if (!auditFile) return;
    const line = JSON.stringify({ ts: now().toISOString(), event, ...redact(fields) }) + "\n";
    try {
      let size = 0;
      try { size = fs.statSync(auditFile).size; } catch (_) { /* no file yet */ }
      if (size > 0 && size + Buffer.byteLength(line) > auditMaxBytes) {
        fs.renameSync(auditFile, auditFile + ".1");
      }
      fs.appendFileSync(auditFile, line, { mode: 0o600 });
    } catch (e) {
      emit("error", "log.audit_failed", { error: e.message });
    }
  }

  return {
    error: (e, f) => emit("error", e, f),
    warn: (e, f) => emit("warn", e, f),
    info: (e, f) => emit("info", e, f),
    debug: (e, f) => emit("debug", e, f),
    audit,
  };
}

module.exports = { createLogger, redact, LEVELS };
