// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLogger } = require("../hub/lib/log");

const fixedNow = () => new Date("2026-09-24T12:00:00.000Z");
function capture(opts = {}) {
  const lines = [];
  const log = createLogger({ now: fixedNow, write: (s) => lines.push(s), ...opts });
  return { log, lines };
}

test("logfmt line with level, event and fields", () => {
  const { log, lines } = capture();
  log.info("auth.login_ok", { ip: "192.0.2.1", user: "admin" });
  assert.deepStrictEqual(lines, [
    "ts=2026-09-24T12:00:00.000Z level=info event=auth.login_ok ip=192.0.2.1 user=admin\n",
  ]);
});

test("values with spaces or quotes are quoted", () => {
  const { log, lines } = capture();
  log.warn("x", { reason: 'clock skew "big"' });
  assert.match(lines[0], /reason="clock skew \\"big\\""/);
});

test("level threshold drops lower levels", () => {
  const { log, lines } = capture({ level: "warn" });
  log.info("hidden", {});
  log.debug("hidden", {});
  log.warn("shown", {});
  log.error("shown", {});
  assert.strictEqual(lines.length, 2);
});

test("json format", () => {
  const { log, lines } = capture({ format: "json" });
  log.error("http.error", { status: 500 });
  assert.deepStrictEqual(JSON.parse(lines[0]), {
    ts: "2026-09-24T12:00:00.000Z", level: "error", event: "http.error", status: 500,
  });
});

test("journald priority prefix only when journal is true", () => {
  const a = capture({ journal: true });
  a.log.warn("w", {});
  a.log.error("e", {});
  assert.ok(a.lines[0].startsWith("<4>ts="));
  assert.ok(a.lines[1].startsWith("<3>ts="));
  const b = capture({ journal: false });
  b.log.warn("w", {});
  assert.ok(b.lines[0].startsWith("ts="));
});

test("secret-looking field names are redacted", () => {
  const { log, lines } = capture();
  log.info("x", { password: "hunter2", token: "abc", cookie: "sv_session=1", secret: "s", sig: "f", apiKey: "k", ip: "192.0.2.1" });
  assert.ok(!/hunter2|abc|sv_session|=s |=f |=k /.test(lines[0]), lines[0]);
  assert.match(lines[0], /password=\[redacted\]/);
  assert.match(lines[0], /ip=192\.0\.2\.1/);
});

test("audit writes JSON lines to the audit file with mode 0600 and rotates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-log-"));
  const file = path.join(dir, "audit.log");
  try {
    const { log, lines } = capture({ auditFile: file, auditMaxBytes: 200 });
    log.audit("auth.login_ok", { ip: "192.0.2.1", password: "nope" });
    assert.strictEqual(lines.length, 1, "audit events also go to the normal log");
    const first = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.strictEqual(first.event, "auth.login_ok");
    assert.strictEqual(first.password, "[redacted]");
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    for (let i = 0; i < 5; i++) log.audit("auth.login_fail", { ip: "192.0.2.1", n: i });
    assert.ok(fs.existsSync(file + ".1"), "rotated file exists");
    assert.ok(fs.statSync(file).size <= 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
