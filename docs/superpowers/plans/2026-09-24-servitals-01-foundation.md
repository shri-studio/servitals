# servitals Foundation (sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename systemdashboard to servitals, restructure the source tree, and harden the existing gateway: scrypt passwords, trusted-proxy client IPs, `Origin` checks, structured and audit logging. Add license files, the admin CLI, CI and the lightness-budget checks. The Docker install keeps working.

**Architecture:** The gateway (`hub/server.js`) stays a single zero-dependency Node process. New logic goes into small, separately tested modules under `hub/lib/`: `log.js`, `password.js`, `clientip.js`, `origin.js`. The agent (`agent/collect.sh`) only gets a single-tick mode and renamed strings. Tests use Node's built-in `node:test` and start the real gateway as a child process.

**Tech Stack:** Node.js ≥ 18 (built-ins only), bash, jq, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` (sections 2, 4.1, 5.1, 11, 16, 18, 20 row 1), `docs/threat-model.md`.

## Global Constraints

- Zero runtime dependencies: Node built-ins only in `hub/`; bash, coreutils, `jq`, `curl`, `vnstat` in `agent/`. No `package.json` with `dependencies`.
- Every source file must work on Node 18 (Ubuntu noble) and Node 22 (resolute). Do not use `fetch`, `node:sqlite` or any API newer than Node 18.
- License: AGPL-3.0-or-later. Every source file carries `SPDX-License-Identifier: AGPL-3.0-or-later`.
- Names: product `servitals`, session cookie `sv_session`, CLI `servitals-ctl`, compose services `gateway`, `web`, `agent`, containers `servitals-gateway`, `servitals-web`, `servitals-agent`.
- Password hash format: `scrypt:N:r:p:salt_b64:hash_b64` with N=32768, r=8, p=1, 16-byte salt, 32-byte key. At most 2 scrypt computations run at once.
- Proxy trust: forwarding headers are honoured only when the TCP peer is in `TRUSTED_PROXIES` (default `127.0.0.1,::1`). The client address is the **rightmost** `X-Forwarded-For` entry, or `Cf-Connecting-Ip` when `PROXY_HEADER=cf-connecting-ip`. A request from a trusted proxy without a forwarding header is never whitelisted.
- `POST /__auth/login`, `POST /__auth/logout` and every `POST /__ctl/*` need an `Origin` whose host matches `Host`, `X-Forwarded-Host` (only from a trusted proxy) or `PUBLIC_URL`. Otherwise the answer is 403.
- Logs: logfmt by default, `LOG_FORMAT=json` option, sd-daemon priority prefix only when `JOURNAL_STREAM` is set, never log passwords, cookies, secrets, signatures or tokens. Audit events go to `DATA_DIR/audit.log` (0600, rotated at 5 MB, one old file kept).
- Lightness budget, enforced by `test/budget.sh`: 0 runtime deps; first page load ≤ 61440 bytes gzipped (fonts excluded); gateway `RssAnon` ≤ 40960 kB idle; agent tick CPU ≤ 400 ms with Docker off; agent peak RSS ≤ 10240 kB.
- **Do the work in a git worktree** (superpowers:using-git-worktrees). The user's live dashboard runs from the main checkout (`./www` and `./data` are bind-mounted into the running `systemdashboard-*` containers). Never run `docker compose` in the main checkout, never stop or rebuild the `systemdashboard-*` containers, and never write to the main checkout's `data/`.
- OpenWolf rules (`.claude/rules/openwolf.md`): before fixing a bug run `openwolf bug search "<error>"`; after fixing one, log it in `.wolf/buglog.json`. Do not edit `.wolf/anatomy.md` or `.wolf/memory.md`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013gXLEwsNSggDnjkMm7yDDT
  ```

## File map

| path | status | responsibility |
| --- | --- | --- |
| `hub/server.js` | moved from `auth/server.js`, modified | gateway: routing, login, bans, proxying, container control |
| `hub/Dockerfile` | moved from `auth/Dockerfile`, modified | gateway image; copies `lib/` |
| `hub/lib/log.js` | new | leveled logger, logfmt/json, journald prefix, redaction, audit file |
| `hub/lib/password.js` | new | scrypt hash and verify, legacy sha256, hash-type detection, CLI entry |
| `hub/lib/clientip.js` | new | IP normalisation, CIDR lists, trusted-proxy client resolution, whitelist rule |
| `hub/lib/origin.js` | new | `Origin` check and HTTPS detection |
| `agent/collect.sh` | moved from `collector/collect.sh`, modified | agent; adds `ONCE=1` single-tick mode |
| `agent/Dockerfile` | moved from `collector/Dockerfile` | agent image |
| `bin/servitals-ctl` | new | bans, unban, whitelist, hash-password |
| `bin/bans`, `bin/unban`, `bin/whitelist` | modified | thin wrappers around `servitals-ctl` |
| `www/index.html` | modified | rename, localStorage key migration, logout as POST form |
| `docker-compose.example.yml` | modified | service renames, pinned subnet, new env |
| `.env.example` | modified | new env variables, hash instructions |
| `README.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `www/fonts/OFL-*.txt` | new or modified | docs and licenses |
| `test/helpers/hub.js` | new | start and stop a gateway for tests, HTTP helpers |
| `test/*.test.js` | new | unit and integration tests |
| `test/budget.sh`, `test/compose-smoke.sh` | new | budget checks, Docker smoke test |
| `.github/workflows/ci.yml` | new | CI |

---

### Task 1: Worktree, source layout move, test harness

**Files:**
- Move: `auth/` → `hub/`, `collector/` → `agent/`
- Modify: `hub/Dockerfile`, `docker-compose.example.yml:3-5,44-46` (build paths only in this task)
- Create: `test/helpers/hub.js`, `test/hub-smoke.test.js`

**Interfaces:**
- Produces: `test/helpers/hub.js` exporting `startHub(env) → Promise<Hub>`, where `Hub` is `{ port, dataDir, logs(): string, stop(): Promise<void> }`, plus `request(port, opts) → Promise<{status, headers, body}>`, `login(port, opts) → Promise<Response>`, `cookieFrom(res) → string|null`, `runHubUntilExit(env, timeoutMs) → Promise<{code, logs}>`. Later tasks use all of these.

- [ ] **Step 1: Create the worktree**

Use superpowers:using-git-worktrees to create a worktree for branch `feat/servitals-foundation` based on `design/servitals-platform`. Run every later command inside that worktree.

- [ ] **Step 2: Move the directories**

```bash
git mv auth hub
git mv collector agent
```

- [ ] **Step 3: Update build paths**

In `docker-compose.example.yml` change `build: ./auth` to `build: ./hub` and `build: ./collector` to `build: ./agent`. Leave the other lines for Task 9.

Replace `hub/Dockerfile` with:

```dockerfile
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY lib ./lib
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/__auth/health || exit 1
ENTRYPOINT ["node", "server.js"]
```

Create `hub/lib/.gitkeep` (empty) so `COPY lib` works before Task 3.

- [ ] **Step 4: Write the test helper**

Create `test/helpers/hub.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
// Start a real gateway (hub/server.js) as a child process for tests.
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER = path.join(__dirname, "..", "..", "hub", "server.js");
const DEFAULT_PASS = "correct horse battery";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok " + req.url);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(port, logs) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request(port, { path: "/__auth/health" });
      if (r.status === 200) return;
    } catch (_) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not become healthy:\n" + logs());
}

function baseEnv(port, dataDir, upstreamPort) {
  return {
    PATH: process.env.PATH,
    PORT: String(port),
    DATA_DIR: dataDir,
    UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    AUTH_USER: "admin",
    AUTH_PASS: DEFAULT_PASS,
    LOG_LEVEL: "debug",
  };
}

async function startHub(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));
  const upstream = await startUpstream();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...baseEnv(port, dataDir, upstream.address().port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const logs = () => output;
  try {
    await waitForHealth(port, logs);
  } catch (e) {
    child.kill("SIGKILL");
    upstream.close();
    throw e;
  }
  return {
    port,
    dataDir,
    logs,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      upstream.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Run a gateway that is expected to exit on its own (bad configuration).
async function runHubUntilExit(env = {}, timeoutMs = 5000) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...baseEnv(port, dataDir, 9), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
    child.once("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  return { code, logs: output };
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

async function login(port, { user = "admin", pass = DEFAULT_PASS, headers = {}, origin } = {}) {
  const body = formBody({ username: user, password: pass });
  const h = {
    "content-type": "application/x-www-form-urlencoded",
    "content-length": Buffer.byteLength(body),
    ...headers,
  };
  if (origin !== null) h.origin = origin || `http://127.0.0.1:${port}`;
  return request(port, { method: "POST", path: "/__auth/login", headers: h, body });
}

function cookieFrom(res) {
  const set = res.headers["set-cookie"] || [];
  for (const c of set) {
    const m = /^sv_session=([^;]*)/.exec(c);
    if (m && m[1]) return `sv_session=${m[1]}`;
  }
  return null;
}

module.exports = { startHub, runHubUntilExit, request, login, cookieFrom, formBody, DEFAULT_PASS };
```

- [ ] **Step 5: Write the smoke test**

Create `test/hub-smoke.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { startHub, request } = require("./helpers/hub");

test("gateway starts and answers the health check", async () => {
  const hub = await startHub();
  try {
    const r = await request(hub.port, { path: "/__auth/health" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, "ok");
  } finally {
    await hub.stop();
  }
});
```

- [ ] **Step 6: Run the test**

Run: `node --test test/*.test.js`
Expected: PASS (1 test). The moved gateway still starts with the old code.

- [ ] **Step 7: Commit**

```bash
git add -A hub agent docker-compose.example.yml test
git commit -m "refactor: move auth/ to hub/ and collector/ to agent/, add test harness"
```

---

### Task 2: Logger (`hub/lib/log.js`)

**Files:**
- Create: `hub/lib/log.js`, `test/log.test.js`
- Delete: `hub/lib/.gitkeep`

**Interfaces:**
- Produces: `createLogger({ level, format, journal, auditFile, auditMaxBytes, write, now }) → { error(event, fields), warn(event, fields), info(event, fields), debug(event, fields), audit(event, fields) }`. Also exports `redact(fields) → object` and `LEVELS`.

- [ ] **Step 1: Write the failing tests**

Create `test/log.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/log.test.js`
Expected: FAIL with `Cannot find module '../hub/lib/log'`.

- [ ] **Step 3: Implement `hub/lib/log.js`**

```js
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
```

Delete `hub/lib/.gitkeep`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/log.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add -A hub/lib test/log.test.js
git commit -m "feat(hub): structured logger with journald priorities, redaction and audit file"
```

---

### Task 3: Passwords (`hub/lib/password.js`)

**Files:**
- Create: `hub/lib/password.js`, `test/password.test.js`

**Interfaces:**
- Produces: `hashPassword(plain: string) → Promise<string>` (format `scrypt:32768:8:1:<salt_b64>:<hash_b64>`), `verifyPassword(plain: string, stored: string) → Promise<boolean>`, `describeHash(stored) → "scrypt" | "sha256" | "invalid"`. Run as a script (`node hub/lib/password.js`), it reads a password from stdin and prints its hash.

- [ ] **Step 1: Write the failing tests**

Create `test/password.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { hashPassword, verifyPassword, describeHash } = require("../hub/lib/password");

test("hash has the documented format and verifies", async () => {
  const h = await hashPassword("s3cret-pass");
  assert.match(h, /^scrypt:32768:8:1:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]{44}$/);
  assert.strictEqual(describeHash(h), "scrypt");
  assert.strictEqual(await verifyPassword("s3cret-pass", h), true);
  assert.strictEqual(await verifyPassword("wrong", h), false);
});

test("two hashes of the same password differ (random salt)", async () => {
  assert.notStrictEqual(await hashPassword("x"), await hashPassword("x"));
});

test("legacy sha256 hex still verifies", async () => {
  const legacy = crypto.createHash("sha256").update("old-pass").digest("hex");
  assert.strictEqual(describeHash(legacy), "sha256");
  assert.strictEqual(await verifyPassword("old-pass", legacy), true);
  assert.strictEqual(await verifyPassword("nope", legacy), false);
});

test("malformed or dangerous parameters are rejected, never computed", async () => {
  const salt = Buffer.alloc(16).toString("base64");
  const hash = Buffer.alloc(32).toString("base64");
  for (const bad of [
    "", "scrypt", "plain-text", `scrypt:1024:8:1:${salt}:${hash}`,        // N too small
    `scrypt:1048576:16:1:${salt}:${hash}`,                                 // needs 2 GiB
    `scrypt:30000:8:1:${salt}:${hash}`,                                    // N not a power of two
    `scrypt:32768:8:1:${Buffer.alloc(4).toString("base64")}:${hash}`,      // salt too short
  ]) {
    assert.strictEqual(describeHash(bad), "invalid", bad);
    assert.strictEqual(await verifyPassword("x", bad), false, bad);
  }
});

test("at most two scrypt computations run at once", async () => {
  const { _activeHashes } = require("../hub/lib/password");
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, _activeHashes()); }, 1);
  await Promise.all([1, 2, 3, 4, 5].map((i) => hashPassword("p" + i)));
  clearInterval(timer);
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
});

test("CLI prints a hash for the password on stdin", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "hub", "lib", "password.js")], {
    input: "cli-pass",
  }).toString().trim();
  assert.strictEqual(describeHash(out), "scrypt");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/password.test.js`
Expected: FAIL with `Cannot find module '../hub/lib/password'`.

- [ ] **Step 3: Implement `hub/lib/password.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Password hashing. Format: scrypt:N:r:p:salt_b64:hash_b64 (colons so the
 * value survives Docker Compose .env interpolation). Legacy sha256 hex from
 * AUTH_PASS_HASH still verifies. One scrypt hash at N=2^15, r=8 needs 32 MiB,
 * so at most two run at once.
 */
const crypto = require("node:crypto");

const N = 32768, R = 8, P = 1, SALT_BYTES = 16, KEY_BYTES = 32;
const MAX_MEM = 64 * 1024 * 1024;
const MAX_ACTIVE = 2;

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_ACTIVE) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

function scrypt(plain, salt, keylen, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, keylen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
      (err ? reject(err) : resolve(key)));
  });
}

function parseScrypt(stored) {
  const parts = String(stored).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 16384 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16) return null;
  if (!Number.isInteger(p) || p < 1 || p > 4) return null;
  if (128 * n * r > MAX_MEM / 2) return null;   // refuse parameters that need more than 32 MiB
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 16 || hash.length < 16) return null;
  return { n, r, p, salt, hash };
}

function describeHash(stored) {
  if (typeof stored !== "string" || stored === "") return "invalid";
  if (/^[0-9a-f]{64}$/i.test(stored)) return "sha256";
  return parseScrypt(stored) ? "scrypt" : "invalid";
}

async function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await withSlot(() => scrypt(String(plain), salt, KEY_BYTES, N, R, P));
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

async function verifyPassword(plain, stored) {
  const kind = describeHash(stored);
  if (kind === "sha256") {
    const got = crypto.createHash("sha256").update(String(plain)).digest();
    return crypto.timingSafeEqual(got, Buffer.from(stored, "hex"));
  }
  if (kind !== "scrypt") return false;
  const s = parseScrypt(stored);
  const key = await withSlot(() => scrypt(String(plain), s.salt, s.hash.length, s.n, s.r, s.p));
  return crypto.timingSafeEqual(key, s.hash);
}

module.exports = { hashPassword, verifyPassword, describeHash, _activeHashes: () => active };

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { input += d; });
  process.stdin.on("end", async () => {
    const pw = input.replace(/\r?\n$/, "");
    if (!pw) {
      process.stderr.write("empty password\n");
      process.exit(1);
    }
    process.stdout.write((await hashPassword(pw)) + "\n");
  });
}
```

Note on the size check: `128 * N * r` is scrypt's memory need; with N=2^15 and r=8 it is 32 MiB, exactly `MAX_MEM / 2`, so the default parameters pass and anything larger is refused.

- [ ] **Step 4: Run the tests**

Run: `node --test test/password.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/password.js test/password.test.js
git commit -m "feat(hub): scrypt password hashing with bounded concurrency and legacy sha256"
```

---

### Task 4: Client IP and proxy trust (`hub/lib/clientip.js`)

**Files:**
- Create: `hub/lib/clientip.js`, `test/clientip.test.js`

**Interfaces:**
- Produces: `normalizeIp(raw) → string|null`; `parseCidrList(input: string|string[]) → Entry[]`; `matchesAny(ip, entries) → boolean`; `createClientResolver({ trustedProxies, proxyHeader }) → (req) → Client`, where `Client` is `{ ip: string|null, peer: string|null, peerTrusted: boolean, viaProxy: boolean, proxyOnly: boolean }`; `isWhitelisted(client, entries) → boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/clientip.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { normalizeIp, parseCidrList, matchesAny, createClientResolver, isWhitelisted } =
  require("../hub/lib/clientip");

const fakeReq = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const LAN = parseCidrList("127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16");

test("normalizeIp accepts IPv4, IPv6 and v4-mapped v6; rejects junk", () => {
  assert.strictEqual(normalizeIp(" 192.0.2.1 "), "192.0.2.1");
  assert.strictEqual(normalizeIp("::ffff:192.0.2.1"), "192.0.2.1");
  assert.strictEqual(normalizeIp("2001:DB8::1"), "2001:db8::1");
  for (const bad of ["", "localhost", "<script>", "300.1.1.1", null, undefined, 42]) {
    assert.strictEqual(normalizeIp(bad), null, String(bad));
  }
});

test("CIDR matching", () => {
  assert.ok(matchesAny("192.168.1.5", LAN));
  assert.ok(matchesAny("172.31.250.1", LAN));
  assert.ok(matchesAny("::1", LAN));
  assert.ok(!matchesAny("203.0.113.7", LAN));
  assert.ok(!matchesAny("172.32.0.1", LAN));
  assert.ok(!matchesAny(null, LAN));
  assert.ok(matchesAny("198.51.100.9", parseCidrList(["198.51.100.0/24"])));
  assert.ok(matchesAny("8.8.8.8", parseCidrList("0.0.0.0/0")));
  assert.deepStrictEqual(parseCidrList("# comment, 10.0.0.0/33, bogus"), []);
});

test("untrusted peer: headers ignored", () => {
  const resolve = createClientResolver({ trustedProxies: "127.0.0.1,::1" });
  const c = resolve(fakeReq("203.0.113.7", { "x-forwarded-for": "192.168.1.5" }));
  assert.deepStrictEqual(c, { ip: "203.0.113.7", peer: "203.0.113.7", peerTrusted: false, viaProxy: false, proxyOnly: false });
  assert.strictEqual(isWhitelisted(c, LAN), false);
});

test("trusted peer: rightmost X-Forwarded-For wins", () => {
  const resolve = createClientResolver({ trustedProxies: "127.0.0.1" });
  const c = resolve(fakeReq("::ffff:127.0.0.1", { "x-forwarded-for": "192.168.1.5, 203.0.113.9" }));
  assert.strictEqual(c.ip, "203.0.113.9");
  assert.strictEqual(c.viaProxy, true);
  assert.strictEqual(isWhitelisted(c, LAN), false);
  const lan = resolve(fakeReq("127.0.0.1", { "x-forwarded-for": "192.168.1.5" }));
  assert.strictEqual(lan.ip, "192.168.1.5");
  assert.strictEqual(isWhitelisted(lan, LAN), true);
});

test("trusted peer without a forwarding header is never whitelisted", () => {
  const resolve = createClientResolver({ trustedProxies: "172.31.250.1" });
  const c = resolve(fakeReq("172.31.250.1"));
  assert.deepStrictEqual(c, { ip: "172.31.250.1", peer: "172.31.250.1", peerTrusted: true, viaProxy: false, proxyOnly: true });
  assert.strictEqual(isWhitelisted(c, LAN), false);
});

test("trusted peer with an unparseable header falls back to proxyOnly", () => {
  const resolve = createClientResolver({ trustedProxies: "127.0.0.1" });
  const c = resolve(fakeReq("127.0.0.1", { "x-forwarded-for": "<script>" }));
  assert.strictEqual(c.proxyOnly, true);
  assert.strictEqual(isWhitelisted(c, LAN), false);
});

test("Cf-Connecting-Ip is used only when PROXY_HEADER selects it", () => {
  const xff = createClientResolver({ trustedProxies: "127.0.0.1" });
  const cf = createClientResolver({ trustedProxies: "127.0.0.1", proxyHeader: "cf-connecting-ip" });
  const req = fakeReq("127.0.0.1", { "cf-connecting-ip": "192.168.1.9", "x-forwarded-for": "203.0.113.4" });
  assert.strictEqual(xff(req).ip, "203.0.113.4");
  assert.strictEqual(cf(req).ip, "192.168.1.9");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/clientip.test.js`
Expected: FAIL with `Cannot find module '../hub/lib/clientip'`.

- [ ] **Step 3: Implement `hub/lib/clientip.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Who is the client? Forwarding headers are forgeable, so they are honoured
 * only when the TCP peer is a trusted proxy (TRUSTED_PROXIES). The client is
 * the rightmost X-Forwarded-For entry, the one our proxy appended; anything
 * left of it came from the client. A trusted proxy's own address is never
 * whitelisted: a request from it without a usable header is "proxyOnly".
 */
const net = require("node:net");

function normalizeIp(raw) {
  if (typeof raw !== "string") return null;
  let ip = raw.trim();
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function v4ToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function parseCidrList(input) {
  const items = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
  const out = [];
  for (const raw of items) {
    const s = String(raw).trim();
    if (!s || s.startsWith("#")) continue;
    const [addr, bitsStr] = s.split("/");
    const ip = normalizeIp(addr);
    if (!ip) continue;
    if (net.isIPv4(ip)) {
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      out.push({ v: 4, net: (v4ToInt(ip) & mask) >>> 0, mask });
    } else if (bitsStr === undefined || bitsStr === "128") {
      out.push({ v: 6, ip });   // IPv6 entries match exact addresses only
    }
  }
  return out;
}

function matchesAny(ip, entries) {
  if (!ip) return false;
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return entries.some((e) => e.v === 4 && ((n & e.mask) >>> 0) === e.net);
  }
  return entries.some((e) => e.v === 6 && e.ip === ip);
}

function forwardedIp(req, header) {
  if (header === "cf-connecting-ip") return normalizeIp(req.headers["cf-connecting-ip"]);
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return null;
  const parts = String(xff).split(",");
  return normalizeIp(parts[parts.length - 1]);
}

function createClientResolver({ trustedProxies = "127.0.0.1,::1", proxyHeader = "x-forwarded-for" } = {}) {
  const trusted = parseCidrList(trustedProxies);
  const header = proxyHeader === "cf-connecting-ip" ? "cf-connecting-ip" : "x-forwarded-for";
  return function resolveClient(req) {
    const peer = normalizeIp(req.socket && req.socket.remoteAddress);
    if (peer && matchesAny(peer, trusted)) {
      const fwd = forwardedIp(req, header);
      if (fwd) return { ip: fwd, peer, peerTrusted: true, viaProxy: true, proxyOnly: false };
      return { ip: peer, peer, peerTrusted: true, viaProxy: false, proxyOnly: true };
    }
    return { ip: peer, peer, peerTrusted: false, viaProxy: false, proxyOnly: false };
  };
}

function isWhitelisted(client, entries) {
  return !!client && !client.proxyOnly && matchesAny(client.ip, entries);
}

module.exports = { normalizeIp, parseCidrList, matchesAny, createClientResolver, isWhitelisted };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/clientip.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/clientip.js test/clientip.test.js
git commit -m "feat(hub): trusted-proxy client IP resolution and CIDR whitelist matching"
```

---

### Task 5: Origin check and HTTPS detection (`hub/lib/origin.js`)

**Files:**
- Create: `hub/lib/origin.js`, `test/origin.test.js`

**Interfaces:**
- Consumes: `Client` from Task 4 (only its `peerTrusted` flag).
- Produces: `originAllowed(req, { publicUrl, peerTrusted }) → boolean`; `requestIsHttps(req, { publicUrl, peerTrusted }) → boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/origin.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { originAllowed, requestIsHttps } = require("../hub/lib/origin");

const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });

test("same host is allowed, others refused", () => {
  assert.ok(originAllowed(req({ host: "hub.lan:20002", origin: "http://hub.lan:20002" }), {}));
  assert.ok(originAllowed(req({ host: "HUB.lan:20002", origin: "http://hub.LAN:20002" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan:20002", origin: "http://evil.example" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan:20002", origin: "http://hub.lan:20003" }), {}));
});

test("missing, null or garbage Origin is refused", () => {
  assert.ok(!originAllowed(req({ host: "hub.lan" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan", origin: "null" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan", origin: "::::" }), {}));
});

test("X-Forwarded-Host counts only from a trusted proxy", () => {
  const r = req({ host: "127.0.0.1:20002", origin: "https://dash.example.com", "x-forwarded-host": "dash.example.com" });
  assert.ok(originAllowed(r, { peerTrusted: true }));
  assert.ok(!originAllowed(r, { peerTrusted: false }));
});

test("PUBLIC_URL host is accepted", () => {
  const r = req({ host: "127.0.0.1:20002", origin: "https://dash.example.com" });
  assert.ok(originAllowed(r, { publicUrl: "https://dash.example.com/" }));
});

test("HTTPS detection", () => {
  assert.ok(requestIsHttps(req({}, true), {}));
  assert.ok(requestIsHttps(req({}), { publicUrl: "https://dash.example.com" }));
  assert.ok(requestIsHttps(req({ "x-forwarded-proto": "http, https" }), { peerTrusted: true }));
  assert.ok(!requestIsHttps(req({ "x-forwarded-proto": "https" }), { peerTrusted: false }));
  assert.ok(!requestIsHttps(req({}), {}));
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/origin.test.js`
Expected: FAIL with `Cannot find module '../hub/lib/origin'`.

- [ ] **Step 3: Implement `hub/lib/origin.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * CSRF defence for state-changing browser requests: the Origin header's host
 * must be one of ours (Host, X-Forwarded-Host from a trusted proxy, or
 * PUBLIC_URL). Also answers "did the browser use HTTPS?" for Secure cookies.
 */
function lastHeaderValue(v) {
  if (!v) return "";
  const parts = String(v).split(",");
  return parts[parts.length - 1].trim().toLowerCase();
}

function expectedHosts(req, { publicUrl, peerTrusted }) {
  const hosts = new Set();
  if (req.headers.host) hosts.add(String(req.headers.host).toLowerCase());
  if (peerTrusted && req.headers["x-forwarded-host"]) hosts.add(lastHeaderValue(req.headers["x-forwarded-host"]));
  if (publicUrl) {
    try { hosts.add(new URL(publicUrl).host.toLowerCase()); } catch (_) { /* ignore bad PUBLIC_URL */ }
  }
  return hosts;
}

function originAllowed(req, opts = {}) {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return false;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch (_) { return false; }
  return host !== "" && expectedHosts(req, opts).has(host);
}

function requestIsHttps(req, { publicUrl, peerTrusted } = {}) {
  if (req.socket && req.socket.encrypted) return true;
  if (publicUrl && /^https:/i.test(publicUrl)) return true;
  return !!peerTrusted && lastHeaderValue(req.headers["x-forwarded-proto"]) === "https";
}

module.exports = { originAllowed, requestIsHttps };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/origin.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/origin.js test/origin.test.js
git commit -m "feat(hub): Origin check and HTTPS detection helpers"
```

---

### Task 6: Wire the modules into the gateway

**Files:**
- Modify: `hub/server.js` (sections named below)
- Create: `test/hub.test.js`

**Interfaces:**
- Consumes: `createLogger` (Task 2), `verifyPassword`, `describeHash` (Task 3), `createClientResolver`, `parseCidrList`, `isWhitelisted` (Task 4), `originAllowed`, `requestIsHttps` (Task 5), test helpers (Task 1).
- Produces: gateway env variables `TRUSTED_PROXIES`, `PROXY_HEADER`, `PUBLIC_URL`, `LOG_LEVEL`, `LOG_FORMAT`; session cookie `sv_session`; `POST`-only `/__auth/logout`; `/__ctl/whoami` returns `{ ip, lan, controls }` as before.

- [ ] **Step 1: Search the bug log**

Run: `openwolf bug search "X-Forwarded-For"` and `openwolf bug search "AUTH_PASS"`.
Expected: no matches (checked 2026-09-24). If there are matches, read them before editing.

- [ ] **Step 2: Write the failing integration tests**

Create `test/hub.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { startHub, runHubUntilExit, request, login, cookieFrom, DEFAULT_PASS } = require("./helpers/hub");
const { hashPassword } = require("../hub/lib/password");

async function withHub(env, fn) {
  const hub = await startHub(env);
  try { await fn(hub); } finally { await hub.stop(); }
}
const whoami = (hub, cookie, headers = {}) =>
  request(hub.port, { path: "/__ctl/whoami", headers: { cookie, ...headers } }).then((r) => JSON.parse(r.body));

test("refuses to start without a password", async () => {
  const r = await runHubUntilExit({ AUTH_PASS: "", AUTH_PASS_HASH: "" });
  assert.strictEqual(r.code, 1);
  assert.match(r.logs, /event=auth\.no_password/);
});

test("login: Origin required, cookie renamed, no Secure on plain HTTP", async () => {
  await withHub({}, async (hub) => {
    assert.strictEqual((await login(hub.port, { origin: null })).status, 403);
    assert.strictEqual((await login(hub.port, { origin: "http://evil.example" })).status, 403);
    const ok = await login(hub.port);
    assert.strictEqual(ok.status, 302);
    const set = ok.headers["set-cookie"].join(";");
    assert.match(set, /sv_session=[^;]+; HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(set, /Secure/);
  });
});

test("Secure cookie when a trusted proxy says HTTPS", async () => {
  await withHub({}, async (hub) => {
    const ok = await login(hub.port, { headers: { "x-forwarded-proto": "https", "x-forwarded-for": "192.168.1.5" } });
    assert.match(ok.headers["set-cookie"].join(";"), /; Secure/);
  });
});

test("client identity follows the trusted-proxy rules", async () => {
  await withHub({}, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    // loopback is a trusted proxy by default: without a header it is proxy-only
    assert.deepStrictEqual(await whoami(hub, cookie), { ip: "127.0.0.1", lan: false, controls: false });
    assert.strictEqual((await whoami(hub, cookie, { "x-forwarded-for": "192.168.1.5" })).lan, true);
    const spoof = await whoami(hub, cookie, { "x-forwarded-for": "192.168.1.5, 203.0.113.7" });
    assert.deepStrictEqual(spoof, { ip: "203.0.113.7", lan: false, controls: false });
  });
});

test("headers from an untrusted peer are ignored", async () => {
  await withHub({ TRUSTED_PROXIES: "192.0.2.1" }, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    const w = await whoami(hub, cookie, { "x-forwarded-for": "203.0.113.7" });
    assert.strictEqual(w.ip, "127.0.0.1");
    assert.strictEqual(w.lan, true, "a direct loopback client is whitelisted");
  });
});

test("three failures ban that client only", async () => {
  await withHub({}, async (hub) => {
    const bad = { "x-forwarded-for": "203.0.113.9" };
    assert.strictEqual((await login(hub.port, { pass: "x", headers: bad })).status, 401);
    assert.strictEqual((await login(hub.port, { pass: "x", headers: bad })).status, 401);
    assert.strictEqual((await login(hub.port, { pass: "x", headers: bad })).status, 403);
    assert.strictEqual((await request(hub.port, { path: "/", headers: bad })).status, 403);
    const other = await request(hub.port, { path: "/", headers: { "x-forwarded-for": "203.0.113.10" } });
    assert.strictEqual(other.status, 200);
    const audit = fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8");
    assert.match(audit, /"event":"auth\.banned"/);
  });
});

test("state-changing /__ctl requests need Origin even with a session", async () => {
  await withHub({}, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    const noOrigin = await request(hub.port, { method: "POST", path: "/__ctl/refresh", headers: { cookie } });
    assert.strictEqual(noOrigin.status, 403);
    const withOrigin = await request(hub.port, {
      method: "POST", path: "/__ctl/refresh", headers: { cookie, origin: `http://127.0.0.1:${hub.port}` },
    });
    assert.strictEqual(withOrigin.status, 200);
  });
});

test("logout is POST-only and needs Origin", async () => {
  await withHub({}, async (hub) => {
    assert.strictEqual((await request(hub.port, { path: "/__auth/logout" })).status, 405);
    const r = await request(hub.port, {
      method: "POST", path: "/__auth/logout", headers: { origin: `http://127.0.0.1:${hub.port}` },
    });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers["set-cookie"].join(";"), /sv_session=; Path=\/; Max-Age=0/);
  });
});

test("scrypt AUTH_PASS_HASH works and the plain password is not required", async () => {
  const hash = await hashPassword("hashed-pass-1");
  await withHub({ AUTH_PASS: "", AUTH_PASS_HASH: hash }, async (hub) => {
    assert.strictEqual((await login(hub.port, { pass: "hashed-pass-1" })).status, 302);
    assert.strictEqual((await login(hub.port, { pass: "wrong", headers: { "x-forwarded-for": "192.168.1.5" } })).status, 401);
    assert.doesNotMatch(hub.logs(), /event=auth\.(plain_password|legacy_hash)/);
  });
});

test("legacy sha256 hash still works and logs a warning", async () => {
  const legacy = crypto.createHash("sha256").update("legacy-pass").digest("hex");
  await withHub({ AUTH_PASS: "", AUTH_PASS_HASH: legacy }, async (hub) => {
    assert.strictEqual((await login(hub.port, { pass: "legacy-pass" })).status, 302);
    assert.match(hub.logs(), /level=warn event=auth\.legacy_hash/);
  });
});

test("passwords and cookies never reach the logs", async () => {
  await withHub({}, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    await login(hub.port, { pass: "wrong-guess-123", headers: { "x-forwarded-for": "192.168.1.5" } });
    const all = hub.logs() + fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8");
    assert.ok(!all.includes(DEFAULT_PASS));
    assert.ok(!all.includes("wrong-guess-123"));
    assert.ok(!all.includes(cookie.split("=")[1]));
    assert.match(all, /event=auth\.login_ok/);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/hub.test.js`
Expected: FAIL. The first failures are "refuses to start without a password" (the old gateway starts) and the login tests (old cookie name `sd_session`, no Origin check).

- [ ] **Step 4: Change the gateway header and configuration block**

In `hub/server.js`, replace the file header comment and everything from `const http = require("http");` through the line `const SEED_WHITELIST = …;` (the configuration block) with:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * servitals gateway — zero dependencies.
 *
 * - login form + HMAC-signed session cookie (sv_session)
 * - after MAX_FAILS failed logins an IP is banned (BAN_HOURS=0 => until unbanned)
 * - whitelisted IPs / CIDRs can never be banned and skip login-count tracking
 * - client IPs from proxy headers only when the peer is in TRUSTED_PROXIES
 * - state-changing requests need a same-origin Origin header
 * - ban list and whitelist are plain files under DATA_DIR, re-read every request
 *
 * unban:      servitals-ctl unban <ip>
 * whitelist:  servitals-ctl whitelist <ip|cidr>
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createLogger } = require("./lib/log");
const { verifyPassword, describeHash } = require("./lib/password");
const { createClientResolver, parseCidrList, isWhitelisted } = require("./lib/clientip");
const { originAllowed, requestIsHttps } = require("./lib/origin");

const UP        = process.env.UPSTREAM     || "http://web:80";
const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const CTL_LAN_ONLY = process.env.CTL_LAN_ONLY !== "0";   // control actions: whitelisted IPs only
const REFRESH_FILE = process.env.REFRESH_FILE || "/www/.refresh";
const USER      = process.env.AUTH_USER    || "admin";
const PASS      = process.env.AUTH_PASS    || "";
const PASS_HASH = process.env.AUTH_PASS_HASH || "";           // scrypt:… (or legacy sha256 hex)
const MAX_FAILS = parseInt(process.env.MAX_FAILS || "3", 10);
const BAN_HOURS = parseFloat(process.env.BAN_HOURS || "0");   // 0 => permanent
const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS || "720");
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PROXY_HEADER = (process.env.PROXY_HEADER || "x-forwarded-for").toLowerCase();
const SITE   = process.env.SITE_NAME || "servitals";
const PORT   = parseInt(process.env.PORT || "8080", 10);
const DATA   = process.env.DATA_DIR || "/data";
const SEED_WHITELIST = (process.env.WHITELIST ||
  "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16").split(",").map(s => s.trim());

fs.mkdirSync(DATA, { recursive: true });
const log = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: process.env.LOG_FORMAT === "json" ? "json" : "logfmt",
  journal: !!process.env.JOURNAL_STREAM,
  auditFile: path.join(DATA, "audit.log"),
});

// TRUST_PROXY from an old .env: "0" means trust nobody, anything else maps to
// the loopback default. TRUSTED_PROXIES wins when both are set.
let trustedProxies = process.env.TRUSTED_PROXIES;
if (trustedProxies === undefined && process.env.TRUST_PROXY !== undefined) {
  trustedProxies = process.env.TRUST_PROXY === "0" ? "" : "127.0.0.1,::1";
  log.warn("config.trust_proxy_deprecated", { hint: "set TRUSTED_PROXIES instead", trusted_proxies: trustedProxies });
}
if (trustedProxies === undefined) trustedProxies = "127.0.0.1,::1";
const resolveClient = createClientResolver({ trustedProxies, proxyHeader: PROXY_HEADER });

if (!PASS && !PASS_HASH) {
  log.error("auth.no_password", { hint: "set AUTH_PASS_HASH (servitals-ctl hash-password) or AUTH_PASS" });
  process.exit(1);
}
if (PASS_HASH && describeHash(PASS_HASH) === "invalid") {
  log.error("auth.bad_hash", { hint: "AUTH_PASS_HASH is neither scrypt:… nor 64 hex characters" });
  process.exit(1);
}
if (PASS_HASH && describeHash(PASS_HASH) === "sha256") {
  log.warn("auth.legacy_hash", { hint: "replace with servitals-ctl hash-password" });
}
if (!PASS_HASH) {
  log.warn("auth.plain_password", { hint: "store a hash instead: servitals-ctl hash-password" });
}
```

Then delete the now-duplicated line `fs.mkdirSync(DATA, { recursive: true });` under `/* ---------- state files ---------- */`.

- [ ] **Step 5: Replace the IP helpers**

Replace everything from the comment `/* ---------- ip helpers ---------- */` through the end of `function whitelisted(ip) { … }` with:

```js
/* ---------- client identity ---------- */
function whitelisted(client) { return isWhitelisted(client, parseCidrList(readWL())); }
```

Leave `banInfo`, `recordFail` and `clearFails` unchanged; they take the IP string.

- [ ] **Step 6: Make the password check async**

Replace the `/* ---------- password check ---------- */` section with:

```js
/* ---------- password check ---------- */
async function checkPass(u, p) {
  const userOk = eq(u, USER);
  const passOk = PASS_HASH ? await verifyPassword(p || "", PASS_HASH) : eq(p, PASS);
  return userOk && passOk;
}
```

- [ ] **Step 7: Update the blocked page's admin hint**

In `bannedPage`, change ``<div class="foot">admin: <code>bin/unban ${escHtml(ip)}</code></div>`` to ``<div class="foot">admin: <code>servitals-ctl unban ${escHtml(ip)}</code></div>``.

- [ ] **Step 8: Replace the request handler's start, login and logout**

Replace the body of `async function handle(req, res) {` from its first line down to (not including) `const authed = validCookie(getCookie(req, "sd_session"));` with:

```js
  const client = resolveClient(req);
  const ip = client.ip;
  const wl = whitelisted(client);

  if (!wl) {
    const b = banInfo(ip);
    if (b) { res.writeHead(403, { "content-type": "text/html" }); return res.end(bannedPage(ip, b)); }
  }

  // health check, no auth
  if (req.url === "/__auth/health") { res.writeHead(200); return res.end("ok"); }

  // CSRF: state-changing browser requests must come from our own origin
  const stateChange = req.method === "POST" && req.url && (
    req.url === "/__auth/login" || req.url === "/__auth/logout" || req.url.startsWith("/__ctl/"));
  if (stateChange && !originAllowed(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted })) {
    log.warn("auth.origin_refused", { ip, url: req.url, origin: req.headers.origin || "" });
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("cross-origin request refused");
  }
  const secure = requestIsHttps(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted }) ? "; Secure" : "";

  if (req.method === "POST" && req.url === "/__auth/login") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get("username") || "";
    const ok = await checkPass(user, params.get("password") || "");
    if (ok) {
      clearFails(ip);
      log.audit("auth.login_ok", { ip, user });
      res.writeHead(302, {
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
        location: "/",
      });
      return res.end();
    }
    await new Promise(r => setTimeout(r, 800)); // slow brute force
    let msg = { cls: "err", text: "invalid credentials" };
    if (!wl) {
      const r = recordFail(ip);
      log.audit("auth.login_fail", { ip, user, remaining: r.remaining });
      if (r.banned) {
        log.audit("auth.banned", { ip, hours: BAN_HOURS });
        res.writeHead(403, { "content-type": "text/html" });
        return res.end(bannedPage(ip, banInfo(ip) || {}));
      }
      msg = { cls: "warn", text: `invalid credentials — ${r.remaining} attempt${r.remaining === 1 ? "" : "s"} left before this IP is blocked` };
    } else {
      log.audit("auth.login_fail", { ip, user, whitelisted: true });
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg));
  }

  if (req.url === "/__auth/logout") {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end("POST only"); }
    log.audit("auth.logout", { ip });
    res.writeHead(302, { "set-cookie": `sv_session=; Path=/; Max-Age=0${secure}`, location: "/" });
    return res.end();
  }

```

Then change `const authed = validCookie(getCookie(req, "sd_session"));` to `const authed = validCookie(getCookie(req, "sv_session"));`.

- [ ] **Step 9: Audit config saves and container actions**

In the `/__ctl/config` branch, directly before `return json(200, { ok: true });`, add:

```js
        log.audit("config.saved", { ip });
```

In the container branch, replace the final POST action lines:

```js
      const r = await dockerApi("POST", `/containers/${name}/${action}?t=10`);
      return json(r.status < 300 ? 200 : r.status,
```

with:

```js
      const r = await dockerApi("POST", `/containers/${name}/${action}?t=10`);
      log.audit("ctl.container", { ip, action, name, status: r.status });
      return json(r.status < 300 ? 200 : r.status,
```

- [ ] **Step 10: Replace console logging**

Replace `console.error("request handler error:", err && err.stack || err);` with `log.error("http.error", { error: String(err && err.stack || err) });`.

Replace the two `process.on(...)` lines and the `server.listen(...)` block at the end of the file with:

```js
// a gateway should stay up: log and keep serving rather than exit on a stray throw
process.on("unhandledRejection", (e) => log.error("process.unhandled_rejection", { error: String(e && e.stack || e) }));
process.on("uncaughtException",  (e) => log.error("process.uncaught_exception", { error: String(e && e.stack || e) }));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

server.listen(PORT, () => {
  log.info("server.start", {
    port: PORT, upstream: UP, user: USER, max_fails: MAX_FAILS,
    ban: BAN_HOURS > 0 ? BAN_HOURS + "h" : "permanent",
    trusted_proxies: trustedProxies, proxy_header: PROXY_HEADER,
    container_controls: CTL_LAN_ONLY ? "LAN only" : "any authed",
  });
});
```

- [ ] **Step 11: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS (all tests in all files, including the 11 in `test/hub.test.js`).

- [ ] **Step 12: Log the fixed bugs**

Read `.wolf/buglog.json` first and match its structure (field names and where entries live); the current file holds bug-001 and bug-002. Append three entries with the next free ids, in this content:

```json
{ "id": "bug-003", "error_message": "Forged X-Forwarded-For/Cf-Connecting-Ip gave LAN whitelist privileges (lockout bypass, container control) when the port was reachable directly with TRUST_PROXY=1",
  "root_cause": "Proxy headers were trusted from any peer, and the leftmost X-Forwarded-For entry (client-controlled) was used",
  "fix": "hub/lib/clientip.js: headers honoured only from TRUSTED_PROXIES peers, rightmost XFF entry, proxy-only requests never whitelisted",
  "tags": ["security", "auth", "proxy"] },
{ "id": "bug-004", "error_message": "Empty AUTH_PASS allowed login with an empty password",
  "root_cause": "checkPass compared against PASS even when it was empty",
  "fix": "gateway exits with auth.no_password unless AUTH_PASS or AUTH_PASS_HASH is set",
  "tags": ["security", "auth"] },
{ "id": "bug-005", "error_message": "Logout and /__ctl POSTs were open to cross-site requests",
  "root_cause": "No Origin check; logout accepted GET",
  "fix": "hub/lib/origin.js Origin check on login, logout and /__ctl POSTs; logout is POST-only",
  "tags": ["security", "csrf"] }
```

Run: `node -e 'JSON.parse(require("fs").readFileSync(".wolf/buglog.json","utf8"))' && echo valid`
Expected: `valid`. (`.wolf/` is git-ignored; nothing to commit for this step.)

- [ ] **Step 13: Commit**

```bash
git add hub/server.js test/hub.test.js
git commit -m "feat(hub): trusted proxies, Origin checks, scrypt login, audit logging, sv_session cookie"
```

---

### Task 7: Admin CLI (`bin/servitals-ctl`)

**Files:**
- Create: `bin/servitals-ctl`, `test/ctl.test.js`
- Modify: `bin/bans`, `bin/unban`, `bin/whitelist` (become wrappers)

**Interfaces:**
- Consumes: `hub/lib/password.js` CLI mode (Task 3).
- Produces: `servitals-ctl bans | unban <ip> | whitelist <ip|cidr> | hash-password`, state directory from `DATA_DIR` (default `<repo>/data`).

- [ ] **Step 1: Write the failing tests**

Create `test/ctl.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/ctl.test.js`
Expected: FAIL (`bin/servitals-ctl` does not exist).

- [ ] **Step 3: Write `bin/servitals-ctl`**

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals-ctl: admin commands for the gateway's state files.
#   servitals-ctl bans                 list blocked IPs and the whitelist
#   servitals-ctl unban <ip>           remove a block (takes effect immediately)
#   servitals-ctl whitelist <ip|cidr>  never block this address again (also unbans)
#   servitals-ctl hash-password        print an AUTH_PASS_HASH value
# DATA_DIR defaults to ./data next to this script's parent (Docker install).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
BANS="$DATA_DIR/bans.json"
WL="$DATA_DIR/whitelist.txt"

die() { echo "servitals-ctl: $*" >&2; exit 1; }

# write stdin to $1 atomically, keeping the original file's mode
atomic_write() {
  local dst=$1 tmp
  tmp=$(mktemp "$dst.XXXXXX")
  cat > "$tmp"
  chmod --reference="$dst" "$tmp" 2>/dev/null || chmod 644 "$tmp"
  mv "$tmp" "$dst"
}

valid_addr() {  # IPv4, IPv4/0-32, or an exact IPv6 address (optionally /128); pure bash
  local a=${1%%/*} bits="" o
  [[ $1 == */* ]] && bits=${1#*/}
  if [[ $a =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
    [ -z "$bits" ] || [[ $bits =~ ^([0-9]|[12][0-9]|3[0-2])$ ]]
  elif [[ $a =~ ^[0-9A-Fa-f:]+$ && $a == *:*:* ]]; then
    [ -z "$bits" ] || [ "$bits" = 128 ]
  else
    return 1
  fi
}

cmd_bans() {
  echo "== blocked =="
  if [ -s "$BANS" ] && jq -e 'length > 0' "$BANS" >/dev/null 2>&1; then
    jq -r 'to_entries[] | "\(.key)  since \(.value.at / 1000 | strftime("%Y-%m-%d %H:%M UTC"))  \(if .value.until == 0 then "(permanent)" else "until " + (.value.until / 1000 | strftime("%Y-%m-%d %H:%M UTC")) end)"' "$BANS"
  else
    echo "(none)"
  fi
  echo
  echo "== whitelist =="
  grep -v '^#' "$WL" 2>/dev/null | grep -v '^[[:space:]]*$' || echo "(none)"
}

cmd_unban() {
  [ $# -eq 1 ] || die "usage: servitals-ctl unban <ip>"
  [ -f "$BANS" ] || { echo "no bans file"; return 0; }
  jq --arg ip "$1" 'del(.[$ip])' "$BANS" | atomic_write "$BANS"
  echo "unbanned $1"
}

cmd_whitelist() {
  [ $# -eq 1 ] || die "usage: servitals-ctl whitelist <ip|cidr>"
  valid_addr "$1" || die "not an IP address or CIDR: $1"
  touch "$WL"
  if grep -qxF "$1" "$WL"; then
    echo "$1 already whitelisted"
  else
    { cat "$WL"; echo "$1"; } | atomic_write "$WL"
    echo "whitelisted $1"
  fi
  cmd_unban "$1" >/dev/null 2>&1 || true
}

cmd_hash_password() {
  local pw pw2
  if [ -t 0 ]; then
    read -rsp "new password: " pw; echo >&2
    read -rsp "again: " pw2; echo >&2
    [ "$pw" = "$pw2" ] || die "passwords differ"
  else
    IFS= read -r pw || true
  fi
  [ "${#pw}" -ge 8 ] || die "use at least 8 characters"
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$pw" | node "$ROOT/hub/lib/password.js"
  else
    printf '%s' "$pw" | docker compose -f "$ROOT/docker-compose.yml" run --rm -T --no-deps gateway node lib/password.js
  fi
  [ -t 1 ] && echo "put this in .env as AUTH_PASS_HASH='…' (single quotes) and remove AUTH_PASS" >&2
  return 0
}

case "${1:-}" in
  bans)          shift; cmd_bans "$@" ;;
  unban)         shift; cmd_unban "$@" ;;
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
```

Run: `chmod +x bin/servitals-ctl`

- [ ] **Step 4: Turn the old scripts into wrappers**

`bin/bans`:

```sh
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Kept for existing Docker installs; use bin/servitals-ctl.
exec "$(dirname "$0")/servitals-ctl" bans "$@"
```

`bin/unban`:

```sh
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Kept for existing Docker installs; use bin/servitals-ctl.
exec "$(dirname "$0")/servitals-ctl" unban "$@"
```

`bin/whitelist`:

```sh
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Kept for existing Docker installs; use bin/servitals-ctl.
exec "$(dirname "$0")/servitals-ctl" whitelist "$@"
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/ctl.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add bin test/ctl.test.js
git commit -m "feat: servitals-ctl admin CLI (bans, unban, whitelist, hash-password)"
```

---

### Task 8: Agent single-tick mode and rename

**Files:**
- Modify: `agent/collect.sh:1-6` (header), `agent/collect.sh:346` (start message), main loop at the end
- Create: `test/agent.test.js`

**Interfaces:**
- Produces: `ONCE=1` runs one tick, writes `OUT_FILE`, exits with the tick's status. `test/budget.sh` (Task 11) uses it.

- [ ] **Step 1: Write the failing test**

Create `test/agent.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("ONCE=1 writes one snapshot of this host and exits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  const out = path.join(dir, "data.json");
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, ONCE: "1", DISKS: "/", DOCKER_HOST: "unix:///nonexistent" },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /^servitals agent: /m);
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(d.host.name.length > 0);
  assert.ok(d.mem.total > 0);
  assert.ok(d.cpu.cores >= 1);
  assert.strictEqual(d.disks[0].mount, "/");
  assert.deepStrictEqual(d.docker, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `node --test test/agent.test.js`
Expected: FAIL with a timeout (the agent loops forever) or a missing `servitals agent:` line.

- [ ] **Step 3: Edit `agent/collect.sh`**

Replace the first two lines

```bash
#!/usr/bin/env bash
# systemdashboard metrics collector
```

with

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent: metrics collector
```

Change `echo "systemdashboard agent: HOST=$HOST OUT=$OUT INTERVAL=${INTERVAL}s DISKS=$DISKS"` to `echo "servitals agent: HOST=$HOST OUT=$OUT INTERVAL=${INTERVAL}s DISKS=$DISKS"`.

Directly after the line `IFACE=$(pick_iface)` near the end, insert:

```bash
# single tick for tests and budget checks: sample once, write, exit
if [ "${ONCE:-0}" = "1" ]; then
  collect
  exit $?
fi
```

- [ ] **Step 4: Run the test**

Run: `node --test test/agent.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/collect.sh test/agent.test.js
git commit -m "feat(agent): ONCE=1 single-tick mode; rename to servitals"
```

---

### Task 9: Page, compose and env: rename and new settings

**Files:**
- Modify: `www/index.html` (lines 6, 533, 539, 790-843, 854-875, 1399, 1418, 1562; exact anchors below)
- Modify: `docker-compose.example.yml`, `.env.example`
- Create: `test/rename.test.js`, `test/compose-smoke.sh`

**Interfaces:**
- Consumes: gateway env from Task 6; `POST /__auth/logout` from Task 6.
- Produces: localStorage keys `servitals.cfg`, `servitals.theme`, `servitals.style` (old `sysdash.*` values migrate once); compose services `gateway`, `web`, `agent` on subnet `172.31.250.0/24`.

- [ ] **Step 1: Write the failing rename test**

Create `test/rename.test.js`:

```js
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/rename.test.js`
Expected: FAIL listing `www/index.html:6: <title>systemdashboard</title>` and other lines.

- [ ] **Step 3: Edit `www/index.html`**

Directly after `<!DOCTYPE html>` add `<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->`.

Change `<title>systemdashboard</title>` to `<title>servitals</title>`.

Change `<span id="hostname">systemdashboard</span>` to `<span id="hostname">servitals</span>`.

Replace ``<a href="/__auth/logout" style="color:var(--dim)">[logout]</a>`` with:

```html
<form method="post" action="/__auth/logout" class="logout-form"><button type="submit" class="linkbtn">[logout]</button></form>
```

In the main `<style>` block, directly before the line `* { margin: 0; padding: 0; box-sizing: border-box; }`, add:

```css
  .logout-form { display: inline; }
  .linkbtn { background: none; border: 0; padding: 0; font: inherit; color: var(--dim); cursor: pointer; }
  .linkbtn:hover, .linkbtn:focus-visible { color: var(--fg-bright); }
```

Replace the line `const LS_KEY = "sysdash.cfg";` with:

```js
// per-browser settings; values stored under the pre-rename prefix move over once
function lsGet(key) {
  try {
    const v = localStorage.getItem("servitals." + key);
    if (v !== null) return v;
    const old = localStorage.getItem("sysdash." + key); // legacy-name
    if (old !== null) {
      localStorage.setItem("servitals." + key, old);
      localStorage.removeItem("sysdash." + key); // legacy-name
    }
    return old;
  } catch (e) { return null; }
}
function lsSet(key, value) { try { localStorage.setItem("servitals." + key, value); } catch (e) {} }
function lsDel(key) { try { localStorage.removeItem("servitals." + key); } catch (e) {} }
```

In `loadConfig`, change `title: "systemdashboard", favicon: "", refreshSec: 60,` to `title: "servitals", favicon: "", refreshSec: 60,` and change `try { saved = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) {}` to `try { saved = JSON.parse(lsGet("cfg") || "null"); } catch (e) {}`.

In `applyBranding`, change `const name = cfg.title || "systemdashboard";` to `const name = cfg.title || "servitals";`.

Change `function saveConfig() { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }` to `function saveConfig() { lsSet("cfg", JSON.stringify(cfg)); }`.

Change `try { localStorage.setItem("sysdash.theme", next); } catch (e) {}` to `lsSet("theme", next);`.
Change `try { t = localStorage.getItem("sysdash.theme"); } catch (e) {}` to `t = lsGet("theme");`.
Change `try { localStorage.setItem("sysdash.style", next); } catch (e) {}` to `lsSet("style", next);`.
Change `try { s = localStorage.getItem("sysdash.style"); } catch (e) {}` to `s = lsGet("style");`.

In `saveSettings`, change `cfg.title = $("#cfg-name").value.trim() || "systemdashboard";` to `cfg.title = $("#cfg-name").value.trim() || "servitals";`.

Change `if (r.ok) { try { localStorage.removeItem(LS_KEY); } catch (e) {} toast("settings saved"); return; }` to `if (r.ok) { lsDel("cfg"); toast("settings saved"); return; }`.

In the `#cfg-reset` handler change `localStorage.removeItem(LS_KEY);` to `lsDel("cfg");`.

The config POST in `saveSettings` already uses `fetch("/__ctl/config", { method: "POST", … })`; browsers add the `Origin` header to it, so no change is needed there. `refreshNow()`'s `fetch("/__ctl/refresh", { method: "POST" })` and the container control POSTs likewise.

- [ ] **Step 4: Replace `docker-compose.example.yml`**

```yaml
# SPDX-License-Identifier: AGPL-3.0-or-later
name: servitals

services:
  gateway:
    build: ./hub
    image: servitals-gateway:local
    container_name: servitals-gateway
    restart: unless-stopped
    ports:
      # BIND_ADDR=127.0.0.1 in .env when only a local reverse proxy / tunnel
      # should reach the gateway.
      - "${BIND_ADDR:-0.0.0.0}:${PORT:-20002}:8080"
    environment:
      - UPSTREAM=http://web:80
      - AUTH_USER=${AUTH_USER:-admin}
      - AUTH_PASS=${AUTH_PASS:-}
      - AUTH_PASS_HASH=${AUTH_PASS_HASH:-}
      - MAX_FAILS=${MAX_FAILS:-3}
      - BAN_HOURS=${BAN_HOURS:-0}
      - SESSION_HOURS=${SESSION_HOURS:-720}
      # Proxy headers are trusted only from these peers. 172.31.250.1 is this
      # network's gateway: a tunnel or proxy on the host connects from it.
      - TRUSTED_PROXIES=${TRUSTED_PROXIES:-172.31.250.1}
      - PROXY_HEADER=${PROXY_HEADER:-x-forwarded-for}
      - PUBLIC_URL=${PUBLIC_URL:-}
      - SITE_NAME=${SITE_NAME:-homeserver}
      - WHITELIST=${WHITELIST:-127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}
      # container start/stop/restart/logs from the UI: "1" = whitelisted IPs
      # (LAN) only, "0" = any logged-in user. refresh trigger is always allowed.
      - CTL_LAN_ONLY=${CTL_LAN_ONLY:-1}
      - REFRESH_FILE=/www/.refresh
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - LOG_FORMAT=${LOG_FORMAT:-logfmt}
    volumes:
      - ./data:/data
      - ./www:/www                                 # write the .refresh trigger
      - /var/run/docker.sock:/var/run/docker.sock   # container start/stop/restart/logs
    depends_on:
      - web

  web:
    image: nginx:alpine
    container_name: servitals-web
    restart: unless-stopped
    expose:
      - "80"
    volumes:
      - ./www:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro

  agent:
    build: ./agent
    image: servitals-agent:local
    container_name: servitals-agent
    restart: unless-stopped
    environment:
      - HOST_ROOT=/host
      - OUT_FILE=/www/data.json
      - INTERVAL=${INTERVAL:-300}
      - NET_IFACE=${NET_IFACE:-}
      - DISKS=${DISKS:-/}
      - TZ=${TZ:-UTC}
    volumes:
      - ./www:/www
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # Whole host FS, read-only, with rslave so nested mounts (e.g. /srv,
      # /mnt/*) are visible to the agent for per-drive usage.
      - type: bind
        source: /
        target: /host
        read_only: true
        bind:
          propagation: rslave

networks:
  default:
    ipam:
      config:
        # fixed so TRUSTED_PROXIES can name the gateway address; change both
        # if this range clashes with another network on the host
        - subnet: 172.31.250.0/24
          gateway: 172.31.250.1
```

- [ ] **Step 5: Edit `.env.example`**

Replace the lines from `# Host address to bind that port to.` through `BIND_ADDR=0.0.0.0` with:

```
# Host address to bind that port to. Leave 0.0.0.0 for direct LAN access.
# Set 127.0.0.1 if a reverse proxy / Cloudflare tunnel on this host is the
# only thing that should reach it.
BIND_ADDR=0.0.0.0
```

Replace the `# ---- login ----` block down to (not including) `# Failed logins from one IP before it is blocked` with:

```
# ---- login ----
AUTH_USER=admin
# Preferred: a scrypt hash. Create it with `bin/servitals-ctl hash-password`
# and keep the single quotes:
# AUTH_PASS_HASH='scrypt:32768:8:1:…'
# Or a plain password (the gateway logs a warning at startup):
AUTH_PASS=change-me
```

Replace

```
# Trust X-Forwarded-For (behind a Cloudflare tunnel / reverse proxy)
TRUST_PROXY=1
```

with

```
# Peers whose X-Forwarded-For header is trusted (a tunnel or reverse proxy).
# The compose default 172.31.250.1 is the Docker network gateway, which is
# where a tunnel running on the host connects from. Anyone else's forwarding
# headers are ignored.
# TRUSTED_PROXIES=172.31.250.1
# Use Cloudflare's Cf-Connecting-Ip instead of X-Forwarded-For. Only when
# nothing but Cloudflare can reach your proxy.
# PROXY_HEADER=cf-connecting-ip
# Public address of the dashboard, if a proxy rewrites the Host header.
# PUBLIC_URL=https://dash.example.com
# Logging: LOG_LEVEL=error|warn|info|debug, LOG_FORMAT=logfmt|json
# LOG_LEVEL=info
```

Change the comment `# Block duration in hours. 0 = permanent, until `bin/unban <ip>`` to `# Block duration in hours. 0 = permanent, until `bin/servitals-ctl unban <ip>``.

- [ ] **Step 6: Write the compose smoke test**

Create `test/compose-smoke.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build and start the Docker install from a throwaway copy of the working tree
# (never the checkout itself: a live instance may use its data/ and www/),
# then check login, Origin enforcement and proxy trust. Cleans up after itself.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-20099}"
PASS="smoke-password-123"
BASE="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
PROJECT="servitals-smoke"

cleanup() {
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    echo "SMOKE_KEEP=1: stack left running on $BASE (user admin, password $PASS)"
    echo "tear down with: (cd $WORK && docker compose -p $PROJECT down -v) &&" \
         "docker run --rm -v $WORK:/w alpine:3.20 rm -rf /w/data /w/www && rm -rf $WORK"
    return
  fi
  (cd "$WORK" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1) || true
  # the containers write data/ and www/ as root; delete those through a container
  docker run --rm -v "$WORK:/w" alpine:3.20 rm -rf /w/data /w/www >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# copy the working tree: tracked and untracked files, minus git-ignored ones
# (so a checkout's data/, .env and docker-compose.yml never leak in)
(cd "$SRC" && git ls-files -z --cached --others --exclude-standard) |
  while IFS= read -r -d '' f; do
    [ -e "$SRC/$f" ] && (cd "$SRC" && cp --parents -- "$f" "$WORK/")
  done
cd "$WORK"
cp docker-compose.example.yml docker-compose.yml
cp www/config.example.json www/config.json
cat > .env <<EOF
PORT=$PORT
BIND_ADDR=127.0.0.1
AUTH_USER=admin
AUTH_PASS=$PASS
DISKS=/
EOF
# unique container names so a running install is never touched
sed -i 's/container_name: servitals-/container_name: servitals-smoke-/' docker-compose.yml

docker compose -p "$PROJECT" up -d --build

for _ in $(seq 1 60); do
  curl -fsS "$BASE/__auth/health" >/dev/null 2>&1 && break
  sleep 1
done
[ "$(curl -fsS "$BASE/__auth/health")" = "ok" ] || { echo "gateway not healthy"; exit 1; }

fail() { echo "FAIL: $*"; docker compose -p "$PROJECT" logs gateway | tail -40; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data "username=admin&password=$PASS" "$BASE/__auth/login")
[ "$code" = 403 ] || fail "login without Origin: expected 403, got $code"

jar="$WORK/cookies"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H "Origin: $BASE" -X POST \
  --data "username=admin&password=$PASS" "$BASE/__auth/login")
[ "$code" = 302 ] || fail "login: expected 302, got $code"
grep -q sv_session "$jar" || fail "no sv_session cookie"

# capture first: `curl | grep -q` fails under pipefail when grep exits early
page=$(curl -fsS -b "$jar" "$BASE/")
grep -q '<title>servitals</title>' <<<"$page" || fail "page not served through nginx"

# host connections arrive from the network gateway 172.31.250.1, a trusted proxy:
# without a header the client is proxy-only (not LAN), with one it is the header's address
who=$(curl -fsS -b "$jar" "$BASE/__ctl/whoami")
[ "$(echo "$who" | jq -r .lan)" = false ] || fail "proxy-only request treated as LAN: $who"
who=$(curl -fsS -b "$jar" -H 'X-Forwarded-For: 203.0.113.50' "$BASE/__ctl/whoami")
[ "$(echo "$who" | jq -r .ip)" = 203.0.113.50 ] || fail "forwarded address not used: $who"

# the agent produced a snapshot
for _ in $(seq 1 30); do
  curl -fsS -b "$jar" "$BASE/data.json" 2>/dev/null | jq -e '.host.name' >/dev/null && break
  sleep 1
done
curl -fsS -b "$jar" "$BASE/data.json" | jq -e '.host.name' >/dev/null || fail "no data.json from the agent"

echo "compose smoke test passed"
```

Run: `chmod +x test/compose-smoke.sh`

- [ ] **Step 7: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (including `test/rename.test.js`).

Run: `bash test/compose-smoke.sh`
Expected: last line `compose smoke test passed`. It runs in a temporary copy with project name `servitals-smoke` on port 20099 and does not touch the live `systemdashboard-*` containers.

- [ ] **Step 8: Check the page in a browser**

Run: `SMOKE_KEEP=1 bash test/compose-smoke.sh`. The stack stays up and the script prints its URL, credentials and teardown command. Use the `run` skill (or Playwright) to open `http://127.0.0.1:20099`, log in, and confirm:
- the tab title is `servitals`;
- `[logout]` looks like before and logs out;
- the theme and style keys `t` and `y` still work, and `localStorage` holds `servitals.theme` and `servitals.style`.

Then run the teardown command the script printed.

- [ ] **Step 9: Commit**

```bash
git add www/index.html docker-compose.example.yml .env.example test/rename.test.js test/compose-smoke.sh
git commit -m "feat: rename to servitals in page, compose and env; pinned compose subnet and trusted proxy"
```

---

### Task 10: Licenses and project documents

**Files:**
- Create: `LICENSE`, `www/fonts/OFL-JetBrainsMono.txt`, `www/fonts/OFL-PressStart2P.txt`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `test/license.test.js`
- Modify: `README.md`, `agent/Dockerfile`, `nginx.conf` (SPDX headers)

**Interfaces:**
- Produces: license files that the packaging plan (sub-project 3) references in `debian/copyright`.

- [ ] **Step 1: Write the failing license test**

Create `test/license.test.js`:

```js
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/license.test.js`
Expected: FAIL (no `LICENSE`; `agent/Dockerfile` and `nginx.conf` lack headers).

- [ ] **Step 3: Add the license texts**

```bash
curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE
curl -fsSL https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt -o www/fonts/OFL-JetBrainsMono.txt
curl -fsSL https://raw.githubusercontent.com/google/fonts/main/ofl/pressstart2p/OFL.txt -o www/fonts/OFL-PressStart2P.txt
```

Add `# SPDX-License-Identifier: AGPL-3.0-or-later` as the first line of `agent/Dockerfile` and of `nginx.conf`.

- [ ] **Step 4: Update `README.md`**

First add README to the rename check: in `test/rename.test.js` change the `FILES` line to

```js
const FILES = ["hub/server.js", "agent/collect.sh", "www/index.html", "docker-compose.example.yml", ".env.example", "README.md"];
```

and delete the comment line above it. Then make these edits:

1. Replace `# systemdashboard` with:

   ```markdown
   # servitals

   Formerly **systemdashboard**. Licensed under AGPL-3.0-or-later. <!-- legacy-name -->
   ```

2. In the Design table, change the `auth` row's service name to `gateway`. Under "Authentication & lockout", change "The `auth` gateway is the only thing listening on `PORT`" to "The `gateway` service is the only thing listening on `PORT`".

3. Replace the whole "Authentication & lockout" env table with:

   ```markdown
   | env | default | meaning |
   | --- | --- | --- |
   | `AUTH_USER` | `admin` | login name |
   | `AUTH_PASS_HASH` | — | scrypt hash from `bin/servitals-ctl hash-password` (keep it in single quotes in `.env`); legacy sha256 hex still works |
   | `AUTH_PASS` | — | plain password, if no hash is set (logs a warning) |
   | `MAX_FAILS` | `3` | failed logins from one IP before it is blocked |
   | `BAN_HOURS` | `0` | block duration; `0` = permanent until unbanned |
   | `SESSION_HOURS` | `720` | login session lifetime (30 days) |
   | `WHITELIST` | private ranges | IPv4 addresses and CIDRs, or exact IPv6 addresses, that are never blocked and skip fail tracking |
   | `TRUSTED_PROXIES` | `172.31.250.1` in Docker | peers whose `X-Forwarded-For` is trusted; everyone else's forwarding headers are ignored |
   | `PROXY_HEADER` | `x-forwarded-for` | set `cf-connecting-ip` only when nothing but Cloudflare can reach your proxy |
   | `PUBLIC_URL` | — | public address, if a proxy rewrites `Host` |
   | `LOG_LEVEL` / `LOG_FORMAT` | `info` / `logfmt` | `error`…`debug`; `json` for log shippers |
   | `BIND_ADDR` | `0.0.0.0` | host address the port binds to; `127.0.0.1` to keep it off the LAN |
   ```

4. Replace the paragraph starting "To expose it through an existing reverse proxy" with:

   ```markdown
   To expose it through an existing reverse proxy or Cloudflare tunnel, point a
   hostname at `http://localhost:<PORT>`. A tunnel or proxy on the same host
   connects from the Docker network's gateway, `172.31.250.1`, which is the
   default `TRUSTED_PROXIES`; its `X-Forwarded-For` header then gives the real
   client address, so lockout works for public visitors. Forwarding headers
   from any other address are ignored, so nobody can fake a LAN address. If the
   proxy runs in another container, set `TRUSTED_PROXIES` to that container's
   address.
   ```

5. Replace the `bin/bans` / `bin/unban` / `bin/whitelist` code block with:

   ```sh
   bin/servitals-ctl bans                   # list blocked IPs + the whitelist
   bin/servitals-ctl unban 203.0.113.7      # remove a block (takes effect immediately)
   bin/servitals-ctl whitelist 203.0.113.7  # never block this IP/CIDR again (also unbans)
   bin/servitals-ctl hash-password          # print an AUTH_PASS_HASH value
   ```

6. In "Setup", replace the `AUTH_USER` and `AUTH_PASS` bullet with:

   ```markdown
   - `AUTH_USER`, and either `AUTH_PASS_HASH` (recommended: run
     `bin/servitals-ctl hash-password` and paste the result in single quotes)
     or `AUTH_PASS`. The gateway refuses to start without one of them.
   ```

7. Replace the "Layout" tree with:

   ```
   servitals/
   ├── docker-compose.example.yml   # → docker-compose.yml (gitignored)
   ├── .env.example                 # → .env (gitignored)
   ├── nginx.conf
   ├── hub/
   │   ├── Dockerfile
   │   ├── server.js           # the login gateway (zero deps)
   │   └── lib/                # log, password, clientip, origin
   ├── agent/
   │   ├── Dockerfile
   │   └── collect.sh          # the whole agent
   ├── bin/
   │   └── servitals-ctl       # bans · unban · whitelist · hash-password
   ├── data/                   # bans.json, whitelist.txt, secret, audit.log (gitignored)
   ├── test/                   # node --test suites, budget and smoke scripts
   └── www/
       ├── index.html          # the whole UI
       ├── config.example.json # copy to config.json (gitignored) and edit
       ├── fonts/              # self-hosted JetBrains Mono and Press Start 2P (OFL)
       └── data.json           # generated by the agent (gitignored)
   ```

8. In "Keys", change "`[logout]` in the header ends the session." to "`[logout]` in the header ends the session (a POST, so other sites cannot log you out)."

The clone URL stays `https://github.com/shri-studio/systemdashboard.git` until the repository is renamed; add `<!-- legacy-name: update after the GitHub rename -->` at the end of that line so `test/rename.test.js` accepts it, and do the same for the `cd systemdashboard` line.

- [ ] **Step 5: Write `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Renamed from systemdashboard to **servitals**. The session cookie is now
  `sv_session`, so everyone logs in once after upgrading.
- Source tree: `auth/` is now `hub/`, `collector/` is now `agent/`. Compose
  services are `gateway`, `web` and `agent`.
- Proxy headers are trusted only from `TRUSTED_PROXIES` peers, using the
  rightmost `X-Forwarded-For` entry. `TRUST_PROXY` is deprecated.
- Logs are structured (logfmt or JSON) with levels; security events also go
  to `data/audit.log`.

### Added
- scrypt password hashes (`bin/servitals-ctl hash-password`).
- `bin/servitals-ctl` for bans, unban, whitelist and password hashing.
- License: AGPL-3.0-or-later.

### Security
- Fixed: a client that could reach the port directly could fake a LAN address
  with a forwarding header, skipping lockout and getting container controls.
- Fixed: an empty `AUTH_PASS` allowed logging in with an empty password. The
  gateway now refuses to start without a password.
- Fixed: logout and control requests could be triggered by other sites. They
  now require a same-origin `Origin` header, and logout is POST-only.

### Upgrading a Docker install
1. `docker compose down` in your install directory.
2. Pull the new version, then copy `docker-compose.example.yml` over your
   `docker-compose.yml` again and re-apply your own edits.
3. In `.env`, remove `TRUST_PROXY`. If a proxy in another container reaches
   the gateway, set `TRUSTED_PROXIES` to its address.
4. Optionally replace `AUTH_PASS` with `AUTH_PASS_HASH` from
   `bin/servitals-ctl hash-password`.
5. `docker compose up -d --build`. `data/` is kept.
```

- [ ] **Step 6: Write `SECURITY.md`**

```markdown
# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
"Report a vulnerability" button on the repository's Security tab (private
security advisories). Do not open a public issue.

Include what you found, how to reproduce it, and which version or commit you
tested. You will get an answer within 7 days.

## Supported versions

Only the latest release receives security fixes. Critical issues are fixed
in a release within 7 days of confirmation.

## Scope

The gateway (`hub/`), the agent (`agent/`), the admin CLI (`bin/`) and the
web page (`www/`). The threat model is in `docs/threat-model.md`.
```

- [ ] **Step 7: Write `CONTRIBUTING.md`**

```markdown
# Contributing

Thanks for helping. A few rules keep servitals small:

- **No runtime dependencies.** The gateway uses Node.js built-ins only; the
  agent uses bash, coreutils, `jq`, `curl` and `vnstat`. Pull requests that
  add a package dependency will not be merged.
- **Node 18 compatible.** Ubuntu 24.04 ships Node 18. Do not use `fetch` or
  newer APIs in `hub/`.
- **Tests first.** Run `node --test test/*.test.js`, `bash test/budget.sh`
  and, if you touched Docker files, `bash test/compose-smoke.sh`.
- **Budget.** `test/budget.sh` must pass: page size, gateway memory and agent
  CPU limits are enforced in CI.
- **License.** Contributions are accepted under AGPL-3.0-or-later. New source
  files start with `SPDX-License-Identifier: AGPL-3.0-or-later`.
- **Security issues** go through `SECURITY.md`, not public issues.
```

- [ ] **Step 8: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (including `test/license.test.js`, and `test/rename.test.js` now covering `README.md`).

- [ ] **Step 9: Commit**

```bash
git add LICENSE www/fonts/OFL-*.txt README.md CHANGELOG.md SECURITY.md CONTRIBUTING.md agent/Dockerfile nginx.conf test/license.test.js test/rename.test.js
git commit -m "docs: AGPL-3.0 license, font licenses, README for servitals, changelog, security and contributing guides"
```

---

### Task 11: Lightness budget checks

**Files:**
- Create: `test/budget.sh`

**Interfaces:**
- Consumes: `ONCE=1` agent mode (Task 8), gateway env (Task 6).
- Produces: `bash test/budget.sh` exits 0 when every budget holds, 1 otherwise; prints one line per check. CI runs it (Task 12). The `.deb` size and per-style CSS checks are added by the plans that create those artifacts (sub-projects 3 and 4).

- [ ] **Step 1: Write the script**

Create `test/budget.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Lightness budget (spec section 18). One line per check; exits 1 on any breach.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
check() {  # name value limit unit
  if [ "$2" -le "$3" ]; then
    printf 'ok    %-40s %8s <= %s %s\n' "$1" "$2" "$3" "$4"
  else
    printf 'FAIL  %-40s %8s >  %s %s\n' "$1" "$2" "$3" "$4"
    fail=1
  fi
}

# 1. runtime dependencies: no package.json may declare dependencies
deps=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  n=$(jq '(.dependencies // {}) | length' "$f")
  deps=$((deps + n))
done < <(git ls-files '*package.json')
check "runtime dependencies" "$deps" 0 "packages"

# 2. first page load, gzipped, fonts excluded
page=$(gzip -9 -c www/index.html | wc -c)
check "first page load (gzip, no fonts)" "$page" 61440 "bytes"

# 3. gateway steady-state anonymous memory
data=$(mktemp -d)
port=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
PORT=$port DATA_DIR=$data AUTH_PASS=budget-check-pass UPSTREAM=http://127.0.0.1:9 LOG_LEVEL=error \
  node hub/server.js >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/__auth/health" >/dev/null 2>&1 && break
  sleep 0.1
done
sleep 2
anon=$(awk '/^RssAnon:/ {print $2}' "/proc/$pid/status")
kill "$pid"; wait "$pid" 2>/dev/null || true
rm -rf "$data"
check "gateway RssAnon (idle)" "$anon" 40960 "kB"

# 4. agent tick CPU and peak memory, Docker off. A stub `docker` first in PATH
# makes the agent behave as on a host without Docker access. (With Docker on,
# the Docker CLI briefly adds ~29 MB; sub-project 2 replaces it with
# `curl --unix-socket`.)
out=$(mktemp)
stub=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' > "$stub/docker"; chmod +x "$stub/docker"
export PATH="$stub:$PATH"
TIMEFORMAT='%U %S'
cpu=$( { time HOST_ROOT=/ OUT_FILE="$out" ONCE=1 DISKS=/ DOCKER_HOST=unix:///nonexistent \
          bash agent/collect.sh >/dev/null 2>&1; } 2>&1 | awk '{printf "%d", ($1 + $2) * 1000}')
check "agent tick CPU (user+sys)" "$cpu" 400 "ms"
if [ -x /usr/bin/time ]; then
  tfile=$(mktemp)
  /usr/bin/time -f '%M' -o "$tfile" env HOST_ROOT=/ OUT_FILE="$out" ONCE=1 DISKS=/ \
    DOCKER_HOST=unix:///nonexistent bash agent/collect.sh >/dev/null 2>&1
  peak=$(tail -n 1 "$tfile"); rm -f "$tfile"
  check "agent peak RSS (whole process tree)" "$peak" 10240 "kB"
else
  echo "FAIL  agent peak RSS: /usr/bin/time not installed (apt install time)"
  fail=1
fi
rm -rf "$out" "$stub"

exit "$fail"
```

Run: `chmod +x test/budget.sh`

Note: `/usr/bin/time -f %M` reports the largest resident set among the process tree it waited for; that is stricter than anonymous memory, which is fine for a ceiling. `-o` writes it to a file because the command's own stderr is discarded.

- [ ] **Step 2: Run it**

Run: `bash test/budget.sh`
Expected: every line starts with `ok`, exit code 0. Measured on the dev host (2026-09-24, this exact script run against the plan's code): page 19888 bytes, gateway `RssAnon` 12100 kB, agent tick 238–278 ms, agent peak 7800–9016 kB with the Docker stub.

The agent peak sits close to its 10240 kB limit. If CI reports it over the
limit, do not raise the limit (it is a spec rule): find the child process
responsible with `/usr/bin/time -f '%C %M' <tool> …` on each tool the tick runs
(`jq`, `vnstat`, `awk`), then record the finding in `.wolf/buglog.json` and
ask the user how to proceed. If `/usr/bin/time` is missing locally, install it (`sudo apt install time`, which the user must run with `! sudo apt install time`) or accept that line failing locally; CI installs it.

- [ ] **Step 3: Commit**

```bash
git add test/budget.sh
git commit -m "test: lightness budget checks (deps, page size, gateway memory, agent CPU and RSS)"
```

---

### Task 12: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `test/*.test.js`, `test/budget.sh`, `test/compose-smoke.sh`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
# SPDX-License-Identifier: AGPL-3.0-or-later
name: ci

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - name: Install shellcheck
        run: sudo apt-get update && sudo apt-get install -y shellcheck
      - name: shellcheck (errors only; warnings are tightened when the agent is split in sub-project 2)
        run: shellcheck -S error agent/collect.sh bin/servitals-ctl bin/bans bin/unban bin/whitelist test/budget.sh test/compose-smoke.sh
      - name: node --check
        run: for f in hub/server.js hub/lib/*.js test/*.js test/helpers/*.js; do node --check "$f"; done

  test:
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        node: [18, 22]
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: ${{ matrix.node }}
      - name: Install agent tools
        run: sudo apt-get update && sudo apt-get install -y jq
      - name: Unit and integration tests
        run: node --test test/*.test.js

  budget:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 18
      - name: Install tools
        run: sudo apt-get update && sudo apt-get install -y jq time
      - name: Lightness budget
        run: bash test/budget.sh

  compose:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - name: Docker install smoke test
        run: bash test/compose-smoke.sh
```

- [ ] **Step 2: Run the lint job's commands locally**

Run: `shellcheck -S error agent/collect.sh bin/servitals-ctl bin/bans bin/unban bin/whitelist test/budget.sh test/compose-smoke.sh` (if shellcheck is missing, ask the user to run `! sudo apt install shellcheck`).
Expected: no output. If it reports an error in existing code, run `openwolf bug search` with the message, fix the line, log it in `.wolf/buglog.json`, and include the fix in this task's commit.

- [ ] **Step 3: Validate the YAML locally**

Run: `node -e 'const y=require("fs").readFileSync(".github/workflows/ci.yml","utf8"); if(/\t/.test(y)) throw new Error("tabs in YAML"); console.log("ok")'`
Expected: `ok`. (GitHub validates the workflow on push; the repository is only pushed when the user asks.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint, tests on Node 18 and 22, lightness budget, Docker smoke test"
```

---

### Task 13: Final verification and handoff

**Files:**
- Modify: `.wolf/cerebrum.md` (git-ignored), `.wolf/STATUS.md` via `/handoff`

- [ ] **Step 1: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/compose-smoke.sh`
Expected: all tests pass, every budget line `ok`, `compose smoke test passed`.

- [ ] **Step 2: Check the live instance was not touched**

Run: `docker ps --format '{{.Names}} {{.Status}}' | grep systemdashboard`
Expected: the three `systemdashboard-*` containers still running with their original uptime.

- [ ] **Step 3: Check the acceptance criteria (spec section 20, row 1)**

- CI green: all four jobs pass locally as run above; GitHub runs them after the user pushes.
- Docker install works renamed: `test/compose-smoke.sh` passed.
- Forged proxy headers no longer grant LAN privileges: `test/hub.test.js` "client identity follows the trusted-proxy rules" and the smoke test's whoami checks passed.

- [ ] **Step 4: Record learnings and hand off**

Add to the Decision Log in `.wolf/cerebrum.md`:

```
- [2026-09-24] Foundation: client IP = rightmost X-Forwarded-For from TRUSTED_PROXIES peers only; Cf-Connecting-Ip only with PROXY_HEADER=cf-connecting-ip (any other proxy would pass a client-sent value through). Password hashes use colons (scrypt:N:r:p:salt:hash) so Docker Compose .env interpolation cannot corrupt them.
```

Run the `/handoff` skill to regenerate `.wolf/STATUS.md` with sub-project 1 done and sub-project 2 (native mode) next.

- [ ] **Step 5: Offer the next step**

Tell the user sub-project 1 is complete on branch `feat/servitals-foundation` in the worktree. List the manual steps only they can do:
- push and open a PR;
- rename the GitHub repository to `servitals`, then remove the two `legacy-name` markers from `README.md`;
- upgrade the live install using `CHANGELOG.md`'s "Upgrading a Docker install" steps.

Then offer to write the sub-project 2 plan (native mode).
