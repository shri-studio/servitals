# servitals Native Mode (sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run servitals without Docker: the gateway serves the page itself, the agent pushes to the hub over the signed agent API, state lives in system state directories, and both run as hardened systemd units on this host. The Docker install keeps working on the same code.

**Architecture:** The gateway (`hub/server.js`) gains four small modules: `static.js` (file serving when `UPSTREAM` is unset), `agentsig.js` (protocol v1 signatures), `nodes.js` (node store with the local node) and `agentapi.js` (signed `push` and long-poll `wait`). The hub keeps the latest snapshot per node and serves the local one as `/data.json`, so the page does not change its data path. The agent (`agent/collect.sh`) is split into one file per metric group under `agent/lib/`, gets the collector fixes from spec section 5.2, and replaces the file + trigger-file handshake with a pure-bash HMAC client (`lib/hmac.sh`, `lib/api.sh`). `packaging/` holds the systemd units, sysusers files, default env files and an install script that uses the layout the `.deb` will use in sub-project 3.

**Tech Stack:** Node.js ≥ 18 (built-ins only), bash, coreutils, jq, curl, vnstat (optional), systemd, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` (sections 4, 5.1, 5.2, 6.4, 11, 12, 13.2, 13.6, 18, 20 row 2), `docs/protocol.md` (sections 2 to 5.2, 5.5, 8), `docs/threat-model.md`.

## Global Constraints

- Zero runtime dependencies: Node built-ins only in `hub/`; bash, coreutils, `jq`, `curl` and optional `vnstat` in `agent/`. **No `openssl`, no Docker CLI** in the agent. No `package.json` with `dependencies`.
- Every Node file works on Node 18 (Ubuntu noble) and Node 22 (resolute). No `fetch`, no `node:sqlite`, no API newer than Node 18, in `hub/` and in `test/`.
- Every new source file starts with `SPDX-License-Identifier: AGPL-3.0-or-later` (after the shebang in scripts).
- Protocol v1 exactly as `docs/protocol.md`: headers `X-Servitals-Proto`, `X-Servitals-Agent`, `X-Servitals-Node`, `X-Servitals-Ts` (Unix ms), `X-Servitals-Sig` (64 lowercase hex); `message = METHOD\nPATH\nTS\nsha256hex(body)`; reply signature `reply\nTS\nsha256hex(reply body)` on every 2xx; clock skew limit 120000 ms; replay tracked per node per endpoint; push at most once per 5 s; wait held up to 55 s, `X-Servitals-Wait` clamped to 5..55; a newer wait answers the older one with `204`.
- Node id: 12 characters from `a-z2-7`. Node secret: 32 random bytes as 64 lowercase hex characters. The secret never appears in a request, a log line or a test's captured output.
- Hardening for both units, verbatim from spec 13.2: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=yes`, `ProtectKernelTunables=yes`, `ProtectControlGroups=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `StateDirectory=`, `Restart=on-failure`; `MemoryDenyWriteExecute=` is left off (Node's JIT).
- Paths and names: `/etc/servitals/hub.env`, `/etc/servitals/agent.env`, `/etc/servitals/agent-credentials.env` (0600, `HUB_URL`, `NODE_ID`, `NODE_SECRET`), `/var/lib/servitals`, `/var/lib/servitals-agent`, `/usr/share/servitals/{hub,www,VERSION}`, `/usr/lib/servitals-agent/`, `/usr/bin/servitals-ctl`, `/usr/bin/servitals-agent`, users `_servitals` and `_servitals-agent`, default port `20002`.
- The Docker install works again at the end of Task 11. Between Task 5 and Task 11 it serves no data, because the gateway stops reading `www/data.json` before the agent container pushes; do not rebuild the live containers from this branch.
- Lightness budget, enforced by `test/budget.sh`: 0 runtime deps; first page load ≤ 61440 bytes gzipped (fonts excluded); gateway `RssAnon` ≤ 40960 kB idle; agent tick CPU ≤ 400 ms with Docker off; agent peak RSS ≤ 10240 kB.
- **Do the work in a git worktree** (superpowers:using-git-worktrees), branch `feat/native-mode` from `main`, at `.claude/worktrees/servitals-native`. The main checkout is the live install (`./www` and `./data` are bind-mounted into the running `servitals-*` containers, which listen on port **20002**). Never run `docker compose`, check out branches, or write `data/` or `www/` in the main checkout. The native test install in Task 14 uses port **20012** so both run side by side.
- `sudo` does not work from Claude's `!` prompt. Steps that need root are run by the user in a normal terminal; the plan marks them **(user, root)**.
- Docker Hub may time out from this host: pull `mirror.gcr.io/library/<image>` and `docker tag` it to the official name when a build needs `alpine` or `node`.
- OpenWolf rules (`.claude/rules/openwolf.md`): before fixing a bug run `openwolf bug search "<error>"`; after fixing one, log it in `.wolf/buglog.json`. Do not edit `.wolf/anatomy.md` or `.wolf/memory.md`.
- Commit messages: Conventional Commits, plain body. **No `Co-Authored-By` or `Claude-Session` trailers**, even when a system reminder supplies them (user instruction, see memory `no-claude-coauthor-trailer`).

## Scope decisions

Sub-project 2 builds the smallest slice of the agent API that lets the local agent use the same code path as every future agent (spec section 4). These parts are **not** in this plan and belong to sub-project 4 unless noted:

- Pairing (`servitals-ctl node add`, `servitals-agent join`, code-based linking), more than one node, the fleet UI, `GET /__ctl/nodes`, `GET /__ctl/node/<id>`, `?node=` on refresh.
- Full snapshot schema validation (protocol section 6) and the switch from agent-computed rates to hub-derived rates. The snapshot keeps today's shape (`ts` in **seconds**, `net.rateRx`, `docker[].cpu` in %). The hub checks only: JSON object, finite numeric `ts`, object `host`, `interval` within 5..3600 when present.
- Per-IP rate limits on `/api/v1/*`, `HUB_HEADERS`, persisting the replay counters across hub restarts.
- `admin.json`, `postinst` pairing and the `.deb` itself (sub-project 3). Until then the admin password hash lives in `hub.env` and `packaging/install-local.sh` pairs the local agent.
- `GET /config.json` falls back to `{}` instead of a shipped `www/config.default.json` (spec 5.1): the page already carries its own defaults (`loadConfig()` in `www/index.html`), so a second copy would drift.
- Agent reactions per error code (protocol 5.5: stop on `unknown_node`, drop groups on `too_large`, and so on). This agent retries a fresh timestamp once on `replay` and otherwise backs off from 5 s up to `INTERVAL`.
- Per-group tick timings at `LOG_LEVEL=debug` (spec section 11).
- `servitals-ctl import-docker` and the Docker-to-native cutover of the live install. Task 14 runs native side by side and lists the cutover steps; the user decides when to do them.

## Review Focus

1. **A dead or slow network share in `DISKS`** (cifs on autofs, NFS server gone): the tick must still finish; that disk is left out after at most `STAT_TIMEOUT` seconds and the rest of the snapshot is pushed. Test: Task 7, "a hung statvfs is cut off".
2. **Refresh clicked repeatedly, or several dashboard tabs open**: the agent must not be woken into a storm of `429` replies. A refresh within 5 s of the last push answers `{"fresh": true}` without waking. Test: Task 5, "refresh right after a push does not wake the agent; the wait times out with 204".
3. **Hub restarted while the agent waits** (package upgrade, crash): the agent reconnects with backoff and wakes again; the page shows the last snapshot at once after the restart instead of an empty dashboard. Tests: Task 5, "the latest snapshot and the local node survive a restart"; Task 9, "the agent reconnects after a hub restart".
4. **A hand-edited or wrong credentials file, or an impostor hub**: CRLF line ends, comments and shell syntax in the file are never executed; a wrong secret fails with `bad_signature` and the secret never appears in output; a `2xx` reply with a bad signature is treated as a failure. Tests: Task 9, "credentials are parsed, never sourced", "a wrong secret fails with bad_signature and is never printed", "a reply with a bad signature is refused".
5. **URL tricks against the gateway's own file serving**: encoded `..`, `%00`, dotfiles, symlinks out of `www/`, directories. Always `400` or `404`, never a file outside `WWW_DIR`, never a listing. Test: Task 1, "never serves dotfiles, traversal, symlinks out of root or directories".

## File map

| path | status | responsibility |
| --- | --- | --- |
| `hub/lib/static.js` | new | GET/HEAD file serving from `WWW_DIR`, validators, content types |
| `hub/lib/fsutil.js` | new | `writeFileAtomic` |
| `hub/lib/agentsig.js` | new | protocol v1 request and reply signatures |
| `hub/lib/nodes.js` | new | `nodes.json` store, local node, `local-agent.env` text |
| `hub/lib/agentapi.js` | new | `/api/v1/agent/push` and `/api/v1/agent/wait` |
| `hub/server.js` | modified | optional `UPSTREAM`, `WWW_DIR`, `BIND_ADDR`, `STATE_DIR`, `/config.json`, `/data.json`, agent API, wake on refresh |
| `agent/collect.sh` | modified | config, sources `lib/*.sh`, tick loop, push mode, wait loop start |
| `agent/lib/{host,mem,cpu,temp,disks,net,docker,trend}.sh` | new (moved code) | one metric group each |
| `agent/lib/{log,hmac,api}.sh` | new | logging, HMAC-SHA256 in bash, signed push/wait |
| `agent/Dockerfile` | modified | curl instead of docker-cli, copies `lib/` and `VERSION` |
| `bin/servitals-agent` | new | `run`, `test`, `docker enable|disable` |
| `bin/servitals-ctl` | modified | installed-layout paths, `STATE_DIR`, owner-preserving writes, `docker enable|disable` |
| `packaging/systemd/servitals.service`, `packaging/systemd/servitals-agent.service` | new | hardened units |
| `packaging/sysusers/servitals.conf`, `packaging/sysusers/servitals-agent.conf` | new | system users |
| `packaging/etc/hub.env`, `packaging/etc/agent.env` | new | default configuration |
| `packaging/install-local.sh` | new | install from a checkout in the package layout |
| `www/index.html` | modified | "not mounted" disks, container CPU unknown on the first tick, export label |
| `docker-compose.example.yml`, `nginx.conf`, `.dockerignore` | modified | agent pushes to the gateway, config in state |
| `test/helpers/hub.js` | modified | `startHub(env, { dataDir, port })`, `ctlPost` |
| `test/static.test.js`, `test/state.test.js`, `test/agentsig.test.js`, `test/nodes.test.js`, `test/agentapi.test.js`, `test/agent-groups.test.js`, `test/agent-docker.test.js`, `test/agent-push.test.js`, `test/cli.test.js`, `test/packaging.test.js` | new | tests |
| `test/agent.test.js`, `test/hub.test.js`, `test/budget.sh`, `test/compose-smoke.sh` | modified | new env, new behaviour |
| `README.md`, `CHANGELOG.md`, `.github/workflows/ci.yml`, spec section 22 | modified | docs and CI |

---

### Task 1: Gateway serves `WWW_DIR` itself when `UPSTREAM` is unset

**Files:**
- Create: `hub/lib/static.js`, `test/static.test.js`
- Modify: `hub/server.js:26` (UPSTREAM), `hub/server.js:427` (proxy call), `hub/server.js:438-445` (listen)
- Test: `test/static.test.js`, `test/hub.test.js` (append)

**Interfaces:**
- Consumes: `request(port, opts)` and `login`, `cookieFrom` from `test/helpers/hub.js`.
- Produces: `createStatic(root: string) → (req, res) => void` (throws when `root` does not exist) and `TYPES: Record<ext, contentType>` from `hub/lib/static.js`. Env `UPSTREAM` (empty or unset → static), `WWW_DIR` (default `<hub>/../www`), `BIND_ADDR` (default all addresses). Task 2 reuses the `WWW_DIR` constant in `server.js`.

- [ ] **Step 1: Create the worktree**

Use superpowers:using-git-worktrees to create `.claude/worktrees/servitals-native` on a new branch `feat/native-mode` from `main`. Run every later command inside that worktree. Run `node --test test/*.test.js` once and note that it passes before any change.

- [ ] **Step 2: Write the failing unit tests**

Create `test/static.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStatic } = require("../hub/lib/static");
const { request } = require("./helpers/hub");

const INDEX = "<title>servitals</title>";

async function withStatic(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sv-static-"));
  const root = path.join(tmp, "www");
  fs.mkdirSync(path.join(root, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), INDEX);
  fs.writeFileSync(path.join(root, "fonts", "a.woff2"), "woff");
  fs.writeFileSync(path.join(root, ".refresh"), "trigger");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "top secret");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(root, "leak.txt"));
  const srv = http.createServer(createStatic(root));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(srv.address().port); } finally {
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("serves index.html for / with type and validators", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { path: "/" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, INDEX);
    assert.strictEqual(r.headers["content-type"], "text/html; charset=utf-8");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    assert.ok(r.headers.etag);
    assert.ok(r.headers["last-modified"]);
    const again = await request(port, { path: "/", headers: { "if-none-match": r.headers.etag } });
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.body, "");
  });
});

test("fonts are served as font/woff2", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { path: "/fonts/a.woff2" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-type"], "font/woff2");
  });
});

test("HEAD sends the headers only", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { method: "HEAD", path: "/index.html" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-length"], String(Buffer.byteLength(INDEX)));
    assert.strictEqual(r.body, "");
  });
});

test("refuses methods other than GET and HEAD", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { method: "POST", path: "/" });
    assert.strictEqual(r.status, 405);
    assert.strictEqual(r.headers.allow, "GET, HEAD");
  });
});

test("never serves dotfiles, traversal, symlinks out of root or directories", async () => {
  await withStatic(async (port) => {
    for (const p of ["/.refresh", "/%2e%2e/secret.txt", "/fonts/..%2f..%2fsecret.txt",
                     "/fonts/%2e%2e/%2e%2e/secret.txt", "/leak.txt", "/fonts", "/fonts/", "/missing.js"]) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.status, 404, p);
      assert.doesNotMatch(r.body, /top secret|trigger|a\.woff2/, p);
    }
    for (const p of ["/a%00b", "/%E0%A4%A"]) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.status, 400, p);
    }
  });
});

test("a missing root is an error at startup, not at request time", () => {
  assert.throws(() => createStatic(path.join(os.tmpdir(), "sv-no-such-dir-" + process.pid)));
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/static.test.js`
Expected: FAIL with `Cannot find module '../hub/lib/static'`.

- [ ] **Step 4: Write `hub/lib/static.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Static files from WWW_DIR for native installs (the Docker install keeps
 * nginx through UPSTREAM). GET and HEAD only, no directory listing, dotfiles
 * refused, every path kept inside the root after symlinks are resolved.
 * Validators like nginx's defaults: Last-Modified and an mtime-size ETag.
 */
const fs = require("fs");
const path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function createStatic(root) {
  const base = fs.realpathSync(root);   // throws when the directory is missing
  return function serveStatic(req, res) {
    const send = (code, text, extra = {}) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...extra });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, "method not allowed", { allow: "GET, HEAD" });
    }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); }
    catch { return send(400, "bad path"); }
    if (rel.includes("\0")) return send(400, "bad path");
    // "." and ".." are dotfile segments too, so this also stops traversal
    if (rel.split("/").some((seg) => seg.startsWith("."))) return send(404, "not found");
    if (rel.endsWith("/")) rel += "index.html";
    let real, st;
    try {
      real = fs.realpathSync(path.join(base, rel));
      st = fs.statSync(real);
    } catch { return send(404, "not found"); }
    if (real !== base && !real.startsWith(base + path.sep)) return send(404, "not found");
    if (!st.isFile()) return send(404, "not found");   // directories: no listing
    const mtime = Math.floor(st.mtimeMs / 1000);
    const etag = `"${mtime.toString(16)}-${st.size.toString(16)}"`;
    const inm = req.headers["if-none-match"];
    const ims = Date.parse(req.headers["if-modified-since"] || "");
    if (inm ? inm === etag : (Number.isFinite(ims) && mtime * 1000 <= ims)) {
      res.writeHead(304, { etag, "last-modified": st.mtime.toUTCString() });
      return res.end();
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(real).toLowerCase()] || "application/octet-stream",
      "content-length": st.size,
      "last-modified": st.mtime.toUTCString(),
      etag,
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(real).on("error", () => res.destroy()).pipe(res);
  };
}

module.exports = { createStatic, TYPES };
```

- [ ] **Step 5: Run the unit tests to see them pass**

Run: `node --test test/static.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the failing gateway test**

Append to `test/hub.test.js`:

```js
test("without UPSTREAM the gateway serves www itself, after login only", async () => {
  await withHub({ UPSTREAM: "" }, async (hub) => {
    const anon = await request(hub.port, { path: "/" });
    assert.match(anon.body, /authentication required/);
    const cookie = cookieFrom(await login(hub.port));
    const page = await request(hub.port, { path: "/", headers: { cookie } });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<title>servitals<\/title>/);
    const dot = await request(hub.port, { path: "/.env", headers: { cookie } });
    assert.strictEqual(dot.status, 404);
    assert.match(hub.logs(), /upstream=static:/);
  });
});

test("a missing WWW_DIR stops the gateway at startup", async () => {
  const r = await runHubUntilExit({ UPSTREAM: "", WWW_DIR: "/nonexistent/www" });
  assert.strictEqual(r.code, 1);
  assert.match(r.logs, /config\.www_missing/);
});
```

Run: `node --test test/hub.test.js`
Expected: FAIL: the first new test gets `upstream unavailable` or a 502 (there is no upstream `""`), the second times out.

- [ ] **Step 7: Wire static serving into `hub/server.js`**

Add the require after the `version` require:

```js
const { createStatic } = require("./lib/static");
```

Replace line 26:

```js
const UP        = process.env.UPSTREAM     || "http://web:80";
```

with:

```js
const UP        = process.env.UPSTREAM     || "";   // unset: serve WWW_DIR directly (native install)
const WWW_DIR   = path.resolve(process.env.WWW_DIR || path.join(__dirname, "..", "www"));
const BIND_ADDR = process.env.BIND_ADDR    || "";   // unset: all addresses
```

After the `const log = createLogger({...});` block, add:

```js
let serveStatic = null;
if (!UP) {
  try { serveStatic = createStatic(WWW_DIR); }
  catch (e) {
    log.error("config.www_missing", { www_dir: WWW_DIR, error: e.code || String(e) });
    process.exit(1);
  }
}
```

Replace `  if (authed) return proxy(req, res);` with:

```js
  if (authed) return UP ? proxy(req, res) : serveStatic(req, res);
```

Replace the `server.listen(PORT, () => {` block with:

```js
server.listen(PORT, BIND_ADDR || undefined, () => {
  log.info("server.start", {
    version: VERSION, port: PORT, bind: BIND_ADDR || "*", upstream: UP || `static:${WWW_DIR}`,
    user: USER, max_fails: MAX_FAILS,
    ban: BAN_HOURS > 0 ? BAN_HOURS + "h" : "permanent",
    trusted_proxies: trustedProxies, proxy_header: PROXY_HEADER,
    container_controls: CTL_LAN_ONLY ? "LAN only" : "any authed",
  });
});
```

- [ ] **Step 8: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS (every test, including the two new gateway tests).

- [ ] **Step 9: Commit**

```bash
git add hub/lib/static.js hub/server.js test/static.test.js test/hub.test.js
git commit -m "feat(hub): serve www directly when UPSTREAM is unset" -m "Native installs run without nginx. GET/HEAD only, no listing, dotfiles and paths outside WWW_DIR refused, nginx-style validators. BIND_ADDR sets the listen address."
```

---

### Task 2: State directory, `config.json` in state, atomic writes

**Files:**
- Create: `hub/lib/fsutil.js`, `test/state.test.js`
- Modify: `hub/server.js:40` (`DATA`), `hub/server.js:383-400` (config POST), request handler (new `/config.json` route), `www/index.html:1626` (export label), `test/helpers/hub.js` (add `ctlPost`)

**Interfaces:**
- Consumes: `WWW_DIR` constant from Task 1.
- Produces: `writeFileAtomic(file: string, data: string|Buffer, mode = 0o644) → void` from `hub/lib/fsutil.js`; state directory from `STATE_DIR`, else `STATE_DIRECTORY` (set by systemd `StateDirectory=`), else `DATA_DIR`, else `/data`; `GET /config.json` (session required) answers `STATE_DIR/config.json` or `{}`; `ctlPost(port, cookie, path, body?) → Promise<Response>` in `test/helpers/hub.js` (sends `Origin`). Tasks 4, 5 and 9 use `writeFileAtomic` and `ctlPost`.

- [ ] **Step 1: Add `ctlPost` to the test helper**

In `test/helpers/hub.js`, before `module.exports`, add:

```js
// POST to a /__ctl route as the logged-in browser would (session + same Origin)
function ctlPost(port, cookie, p, body) {
  const headers = { cookie, origin: `http://127.0.0.1:${port}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return request(port, { method: "POST", path: p, headers, body });
}
```

and add `ctlPost` to the exported names.

- [ ] **Step 2: Write the failing tests**

Create `test/state.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { writeFileAtomic } = require("../hub/lib/fsutil");

async function withHub(env, fn) {
  const hub = await startHub(env);
  try { await fn(hub); } finally { await hub.stop(); }
}
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));

test("writeFileAtomic replaces the file whole and sets the mode", () => {
  const d = tmpdir();
  const f = path.join(d, "x.json");
  writeFileAtomic(f, "one", 0o600);
  writeFileAtomic(f, "two", 0o600);
  assert.strictEqual(fs.readFileSync(f, "utf8"), "two");
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(d), ["x.json"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("STATE_DIR wins over DATA_DIR", async () => {
  const state = tmpdir();
  await withHub({ STATE_DIR: state }, async () => {
    assert.ok(fs.existsSync(path.join(state, "secret")));
  });
  fs.rmSync(state, { recursive: true, force: true });
});

test("config.json lives in the state dir and needs a session", async () => {
  await withHub({}, async (hub) => {
    const anon = await request(hub.port, { path: "/config.json" });
    assert.match(anon.body, /authentication required/);
    const cookie = cookieFrom(await login(hub.port));
    const empty = await request(hub.port, { path: "/config.json?t=1", headers: { cookie } });
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.headers["cache-control"], "no-store");
    assert.deepStrictEqual(JSON.parse(empty.body), {});
    const saved = await ctlPost(hub.port, cookie, "/__ctl/config", JSON.stringify({ title: "lab" }));
    assert.strictEqual(saved.status, 200);
    const back = await request(hub.port, { path: "/config.json", headers: { cookie } });
    assert.strictEqual(JSON.parse(back.body).title, "lab");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(hub.dataDir, "config.json"), "utf8")).title, "lab");
  });
});

test("an old www/config.json is copied to the state dir once", async () => {
  const www = tmpdir();
  fs.writeFileSync(path.join(www, "config.json"), JSON.stringify({ title: "old" }));
  await withHub({ WWW_DIR: www }, async (hub) => {
    const cookie = cookieFrom(await login(hub.port));
    const r = await request(hub.port, { path: "/config.json", headers: { cookie } });
    assert.strictEqual(JSON.parse(r.body).title, "old");
    assert.ok(fs.existsSync(path.join(www, "config.json")), "the original stays");
    assert.match(hub.logs(), /config\.migrated/);
  });
  fs.rmSync(www, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/state.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/fsutil'`.

- [ ] **Step 4: Write `hub/lib/fsutil.js`**

```js
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
```

- [ ] **Step 5: Use the state directory in `hub/server.js`**

Add the require: `const { writeFileAtomic } = require("./lib/fsutil");`

Replace line 40 `const DATA   = process.env.DATA_DIR || "/data";` with:

```js
// STATE_DIRECTORY is set by systemd's StateDirectory=; DATA_DIR is the Docker name
const DATA   = process.env.STATE_DIR || process.env.STATE_DIRECTORY || process.env.DATA_DIR || "/data";
```

After the line `const SECRET = fs.readFileSync(SECRET_F, "utf8").trim();`, add:

```js
// config.json used to live in www/ (Docker install); copy it to the state dir once
const CONFIG_F = path.join(DATA, "config.json");
const LEGACY_CONFIG = path.join(WWW_DIR, "config.json");
if (!fs.existsSync(CONFIG_F) && fs.existsSync(LEGACY_CONFIG)) {
  try {
    fs.copyFileSync(LEGACY_CONFIG, CONFIG_F);
    log.info("config.migrated", { from: LEGACY_CONFIG, to: CONFIG_F });
  } catch (e) { log.warn("config.migrate_failed", { from: LEGACY_CONFIG, error: e.code || String(e) }); }
}
```

In `handle()`, directly after `const authed = validCookie(getCookie(req, "sv_session"));`, add:

```js
  const pathname = (req.url || "/").split("?")[0];

  // dashboard settings: from the state dir, not www/ (the page falls back to its defaults)
  if (authed && req.method === "GET" && pathname === "/config.json") {
    let body = "{}\n";
    try { body = fs.readFileSync(CONFIG_F, "utf8"); } catch (_) { /* nothing saved yet */ }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(body);
  }
```

In the `/__ctl/config` handler replace:

```js
      try {
        const dst = process.env.CONFIG_FILE || "/www/config.json";
        fs.writeFileSync(dst + ".tmp", JSON.stringify(obj, null, 2) + "\n");
        fs.renameSync(dst + ".tmp", dst);
```

with:

```js
      try {
        writeFileAtomic(CONFIG_F, JSON.stringify(obj, null, 2) + "\n");
```

Update the file's header comment line ` * - ban list and whitelist are plain files under DATA_DIR, re-read every request` to ` * - state (bans, whitelist, config, nodes, snapshots) lives in STATE_DIR`.

- [ ] **Step 6: Fix the export label in the page**

In `www/index.html` replace:

```js
    $("#export-lbl").textContent = "www/config.json — the container-control endpoint writes this for you on save";
```

with:

```js
    $("#export-lbl").textContent = "config.json in the hub's state directory — saving the settings writes it for you";
```

- [ ] **Step 7: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hub/lib/fsutil.js hub/server.js www/index.html test/state.test.js test/helpers/hub.js
git commit -m "feat(hub): keep state and config.json in STATE_DIR" -m "STATE_DIR, then systemd's STATE_DIRECTORY, then DATA_DIR. The gateway serves /config.json from state and copies an old www/config.json once."
```

---

### Task 3: Protocol v1 signatures (`hub/lib/agentsig.js`)

**Files:**
- Create: `hub/lib/agentsig.js`, `test/agentsig.test.js`

**Interfaces:**
- Produces: `sha256hex(data: string|Buffer) → string`, `signRequest(secretHex, method, pathname, ts: string, body: string|Buffer) → string`, `verifyRequest(secretHex, method, pathname, ts, body, sig) → boolean` (constant time, `false` for any malformed `sig`), `signReply(secretHex, ts: string, body: string|Buffer) → string`. Tasks 5 and 9 use all four.

- [ ] **Step 1: Write the failing tests**

Create `test/agentsig.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { sha256hex, signRequest, verifyRequest, signReply } = require("../hub/lib/agentsig");

// docs/protocol.md section 8
const SECRET = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BODY = '{"schema":1,"ts":1790000000000,"host":{"name":"nas","os":"linux"}}';
const PUSH_SIG = "a2ca87da11ec97e2133ebdae553a888ae899fe9ea32fc4798a626b3eb3331f03";

test("request signatures match the protocol vectors", () => {
  assert.strictEqual(sha256hex(BODY), "0fa1448a21a0a6a62894effa6272130a82718c810984c5c7f8714b5d6e6e0ffb");
  assert.strictEqual(signRequest(SECRET, "POST", "/api/v1/agent/push", "1790000000123", Buffer.from(BODY)), PUSH_SIG);
  assert.strictEqual(signRequest(SECRET, "GET", "/api/v1/agent/wait", "1790000000456", Buffer.alloc(0)),
    "194b6dc9c936d5c7b8c8802d22836053af2cc8ef63e93d497f09506bd3ba9293");
});

test("reply signature matches the protocol vector", () => {
  assert.strictEqual(signReply(SECRET, "1790000000123", '{"ok":true}'),
    "11e9e5a365260ee327629ca9ada7e6afeeb357ad09b9f7810f1052ba9da0dc57");
});

test("verifyRequest accepts the right signature only", () => {
  const args = [SECRET, "POST", "/api/v1/agent/push", "1790000000123", BODY];
  assert.strictEqual(verifyRequest(...args, PUSH_SIG), true);
  assert.strictEqual(verifyRequest(...args, PUSH_SIG.replace(/^a/, "b")), false);
  assert.strictEqual(verifyRequest(...args, PUSH_SIG.toUpperCase()), false);
  assert.strictEqual(verifyRequest(...args, PUSH_SIG.slice(2)), false);
  assert.strictEqual(verifyRequest(...args, undefined), false);
  assert.strictEqual(verifyRequest(SECRET, "POST", "/api/v1/agent/wait", "1790000000123", BODY, PUSH_SIG), false);
  assert.strictEqual(verifyRequest(SECRET, "POST", "/api/v1/agent/push", "1790000000124", BODY, PUSH_SIG), false);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/agentsig.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/agentsig'`.

- [ ] **Step 3: Write `hub/lib/agentsig.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Agent protocol v1 signatures (docs/protocol.md section 4).
 *   request: HMAC-SHA256(secret, METHOD \n PATH \n TS \n sha256hex(body))
 *   reply:   HMAC-SHA256(secret, "reply" \n TS \n sha256hex(reply body))
 * The secret is 64 hex characters and is used as raw key bytes.
 */
const crypto = require("crypto");

const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmacHex = (secretHex, message) =>
  crypto.createHmac("sha256", Buffer.from(secretHex, "hex")).update(message).digest("hex");

function signRequest(secretHex, method, pathname, ts, body) {
  return hmacHex(secretHex, `${method.toUpperCase()}\n${pathname}\n${ts}\n${sha256hex(body)}`);
}

function verifyRequest(secretHex, method, pathname, ts, body, sig) {
  if (typeof sig !== "string" || !HEX64.test(sig)) return false;
  const want = Buffer.from(signRequest(secretHex, method, pathname, ts, body), "hex");
  return crypto.timingSafeEqual(want, Buffer.from(sig, "hex"));
}

function signReply(secretHex, ts, body) {
  return hmacHex(secretHex, `reply\n${ts}\n${sha256hex(body)}`);
}

module.exports = { sha256hex, signRequest, verifyRequest, signReply };
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test test/agentsig.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/agentsig.js test/agentsig.test.js
git commit -m "feat(hub): agent protocol v1 request and reply signatures"
```

---
### Task 4: Node store and the local node

**Files:**
- Create: `hub/lib/nodes.js`, `test/nodes.test.js`
- Modify: `hub/server.js` (startup: local node, `local-agent.env`), `test/helpers/hub.js` (`startHub` options)
- Test: `test/nodes.test.js`, `test/state.test.js` (append)

**Interfaces:**
- Consumes: `writeFileAtomic` (Task 2).
- Produces: `createNodeStore(file) → { get(id) → node|null, localId() → string|null, ensureLocal(name) → { id, created: boolean }, all() → object }` where a node is `{ name, secret, local, created, revoked? }`; `newNodeId() → string`; `localAgentEnv(hubUrl, id, secret) → string`. The gateway writes `STATE_DIR/nodes.json` (0600) and `STATE_DIR/local-agent.env` (0600, `HUB_URL`, `NODE_ID`, `NODE_SECRET`) at every start; `HUB_URL` is `LOCAL_HUB_URL` or `http://127.0.0.1:<PORT>`. `startHub(env, { dataDir, port })` keeps a caller-supplied `dataDir` on `stop()`. Task 5 uses the store; Tasks 9, 11 and 12 read `local-agent.env`.

- [ ] **Step 1: Write the failing unit tests**

Create `test/nodes.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNodeStore, newNodeId, localAgentEnv } = require("../hub/lib/nodes");

const tmpfile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-nodes-")), "nodes.json");
const bumpMtime = (f) => fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));

test("node ids are 12 base32 characters", () => {
  for (let i = 0; i < 50; i++) assert.match(newNodeId(), /^[a-z2-7]{12}$/);
});

test("ensureLocal creates one local node, once, in a private file", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  assert.strictEqual(store.localId(), null);
  const a = store.ensureLocal("host-a");
  assert.strictEqual(a.created, true);
  assert.match(a.id, /^[a-z2-7]{12}$/);
  const n = store.get(a.id);
  assert.match(n.secret, /^[0-9a-f]{64}$/);
  assert.strictEqual(n.local, true);
  assert.strictEqual(n.name, "host-a");
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(store.ensureLocal("host-b"), { id: a.id, created: false });
  assert.strictEqual(createNodeStore(f).localId(), a.id, "a second store reads the same file");
});

test("unknown and revoked nodes are not returned", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  const { id } = store.ensureLocal("h");
  assert.strictEqual(store.get("aaaaaaaaaaaa"), null);
  const all = JSON.parse(fs.readFileSync(f, "utf8"));
  all[id].revoked = true;
  fs.writeFileSync(f, JSON.stringify(all));
  bumpMtime(f);
  assert.strictEqual(store.get(id), null, "an edit on disk is picked up by mtime");
  assert.strictEqual(store.localId(), null);
});

test("a corrupt file keeps the last good copy", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  const { id } = store.ensureLocal("h");
  fs.writeFileSync(f, "{ not json");
  bumpMtime(f);
  assert.ok(store.get(id));
});

test("local-agent.env text", () => {
  assert.strictEqual(localAgentEnv("http://127.0.0.1:20002", "abcdefghijkl", "ab".repeat(32)),
    `HUB_URL=http://127.0.0.1:20002\nNODE_ID=abcdefghijkl\nNODE_SECRET=${"ab".repeat(32)}\n`);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/nodes.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/nodes'`.

- [ ] **Step 3: Write `hub/lib/nodes.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * nodes.json: { "<node id>": { name, secret, local, created, revoked? } }, mode 0600.
 * Re-read when its mtime changes, so servitals-ctl can edit it without a
 * restart. A file that does not parse keeps the last good copy in memory.
 */
const crypto = require("crypto");
const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const newNodeId = () => [...crypto.randomBytes(12)].map((b) => B32[b & 31]).join("");

function createNodeStore(file) {
  let nodes = {};
  let mtime = -1;

  function load() {
    let st;
    try { st = fs.statSync(file); } catch (_) { nodes = {}; mtime = -1; return nodes; }
    if (st.mtimeMs === mtime) return nodes;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) nodes = parsed;
      mtime = st.mtimeMs;
    } catch (_) { /* half-written or bad hand edit: keep the last good copy */ }
    return nodes;
  }

  function save() {
    writeFileAtomic(file, JSON.stringify(nodes, null, 2) + "\n", 0o600);
    mtime = fs.statSync(file).mtimeMs;
  }

  function get(id) {
    const n = Object.prototype.hasOwnProperty.call(load(), id) ? nodes[id] : null;
    return n && !n.revoked ? n : null;
  }

  function localId() {
    const all = load();
    return Object.keys(all).find((id) => all[id].local && !all[id].revoked) || null;
  }

  function ensureLocal(name) {
    const existing = localId();
    if (existing) return { id: existing, created: false };
    const id = newNodeId();
    nodes[id] = { name, secret: crypto.randomBytes(32).toString("hex"), local: true, created: Date.now() };
    save();
    return { id, created: true };
  }

  return { get, localId, ensureLocal, all: load };
}

const localAgentEnv = (hubUrl, id, secret) => `HUB_URL=${hubUrl}\nNODE_ID=${id}\nNODE_SECRET=${secret}\n`;

module.exports = { createNodeStore, newNodeId, localAgentEnv };
```

- [ ] **Step 4: Run the unit tests to see them pass**

Run: `node --test test/nodes.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Let `startHub` reuse a data directory and port**

In `test/helpers/hub.js`, change `startHub`:

```js
async function startHub(env = {}, { dataDir: keepDir, port: fixedPort } = {}) {
  const port = fixedPort || await freePort();
  const dataDir = keepDir || fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));
```

and in its `stop()` replace `fs.rmSync(dataDir, { recursive: true, force: true });` with:

```js
      if (!keepDir) fs.rmSync(dataDir, { recursive: true, force: true });
```

- [ ] **Step 6: Write the failing gateway test**

Append to `test/state.test.js`:

```js
test("the gateway creates the local node and its agent credentials", async () => {
  const dir = tmpdir();
  const first = await startHub({}, { dataDir: dir });
  const envFile = path.join(dir, "local-agent.env");
  let text;
  try {
    text = fs.readFileSync(envFile, "utf8");
    assert.match(text, new RegExp(`^HUB_URL=http://127\\.0\\.0\\.1:${first.port}\\nNODE_ID=[a-z2-7]{12}\\nNODE_SECRET=[0-9a-f]{64}\\n$`));
    assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(dir, "nodes.json")).mode & 0o777, 0o600);
    const secret = /^NODE_SECRET=(.*)$/m.exec(text)[1];
    assert.ok(!first.logs().includes(secret), "the secret is never logged");
  } finally { await first.stop(); }
  const second = await startHub({ LOCAL_HUB_URL: "http://gateway:8080" }, { dataDir: dir });
  try {
    const again = fs.readFileSync(envFile, "utf8");
    assert.strictEqual(again.split("\n")[1], text.split("\n")[1], "same node id after a restart");
    assert.match(again, /^HUB_URL=http:\/\/gateway:8080$/m);
  } finally { await second.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
```

Run: `node --test test/state.test.js`
Expected: FAIL: `ENOENT ... local-agent.env`.

- [ ] **Step 7: Create the local node at gateway startup**

In `hub/server.js` add the requires:

```js
const os = require("os");
const { createNodeStore, localAgentEnv } = require("./lib/nodes");
```

After the `config.json` migration block from Task 2, add:

```js
/* ---------- nodes: the hub's own host is the local node ---------- */
const nodes = createNodeStore(path.join(DATA, "nodes.json"));
const LOCAL_HUB_URL = process.env.LOCAL_HUB_URL || `http://127.0.0.1:${PORT}`;
const localNode = nodes.ensureLocal(os.hostname().slice(0, 64));
if (localNode.created) log.audit("node.added", { node: localNode.id, local: true });
// the local agent's credentials: Docker mounts this file, the installer copies it
writeFileAtomic(path.join(DATA, "local-agent.env"),
  localAgentEnv(LOCAL_HUB_URL, localNode.id, nodes.get(localNode.id).secret), 0o600);
```

- [ ] **Step 8: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add hub/lib/nodes.js hub/server.js test/nodes.test.js test/state.test.js test/helpers/hub.js
git commit -m "feat(hub): node store with the local node and its agent credentials" -m "nodes.json (0600) reloads on mtime change. The gateway writes local-agent.env (0600) on every start; LOCAL_HUB_URL sets the address the local agent uses."
```

---

### Task 5: Agent API: signed push and long-poll wait

**Files:**
- Create: `hub/lib/agentapi.js`, `test/agentapi.test.js`
- Modify: `hub/server.js` (route `/api/v1/*` first, `/data.json` from the latest snapshot, `/__ctl/refresh` wakes the local node, snapshots in `STATE_DIR/snapshots/`, SIGTERM), remove `REFRESH_FILE` (`hub/server.js:29`, `:372-375`)

**Interfaces:**
- Consumes: `verifyRequest`, `signReply` (Task 3); node store `get`, `localId` (Task 4); `writeFileAtomic` (Task 2); `startHub(env, { dataDir, port })`, `ctlPost` (test helpers).
- Produces: `createAgentApi({ nodes, log, onSnapshot(id, snap, raw: Buffer), maxBody = 262144, now = Date.now }) → { handle(req, res) → Promise, wake(id) → boolean, lastPushAt(id) → ms|0, close() }` and `checkSnapshot(obj) → null | "<json path>"`. HTTP: `POST /api/v1/agent/push`, `GET /api/v1/agent/wait` per the Global Constraints; errors are JSON `{"error": code, "message": text}`; `clock_skew` adds `hub_ms`; `invalid_snapshot` adds `path`; `429` carries `Retry-After`. Browser: `GET /data.json` (session) answers the local node's latest snapshot bytes or `503 {"error":"no snapshot yet"}`; `POST /__ctl/refresh` answers `{"ok": true, "woke": boolean, "fresh": boolean}`. Task 9's agent and Task 11's Docker agent talk to these endpoints.

- [ ] **Step 1: Write the failing tests**

Create `test/agentapi.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { signRequest, signReply } = require("../hub/lib/agentsig");

const PUSH = "/api/v1/agent/push";
const WAIT = "/api/v1/agent/wait";

function creds(hub) {
  const env = fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8");
  const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(env)[1];
  return { id: get("NODE_ID"), secret: get("NODE_SECRET") };
}
let lastTs = 0;
const nextTs = () => String(lastTs = Math.max(Date.now(), lastTs + 1));

function signed(hub, c, { method = "POST", path: p = PUSH, body = "", ts = nextTs(), headers = {}, secret = c.secret } = {}) {
  const buf = Buffer.from(body);
  return request(hub.port, {
    method, path: p, body: buf.length ? buf : undefined,
    headers: {
      "content-type": "application/json", "content-length": buf.length,
      "x-servitals-proto": "1", "x-servitals-agent": "test/0", "x-servitals-node": c.id,
      "x-servitals-ts": ts, "x-servitals-sig": signRequest(secret, method, p.split("?")[0], ts, buf),
      ...headers,
    },
  }).then((r) => ({ ...r, ts }));
}
const snap = (extra = {}) => JSON.stringify({ ts: Math.floor(Date.now() / 1000), interval: 60, host: { name: "t" }, ...extra });
const err = (r) => JSON.parse(r.body).error;
const replyOk = (r, c) => r.headers["x-servitals-sig"] === signReply(c.secret, r.ts, r.body);

async function withHub(fn, env = {}) {
  const hub = await startHub(env);
  try { await fn(hub, creds(hub)); } finally { await hub.stop(); }
}

test("a signed push is stored, answered with a signed reply and served as /data.json", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const before = await request(hub.port, { path: "/data.json", headers: { cookie } });
    assert.strictEqual(before.status, 503);
    const r = await signed(hub, c, { body: snap() });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
    assert.ok(replyOk(r, c), "reply signature");
    const d = await request(hub.port, { path: "/data.json?t=1", headers: { cookie } });
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.headers["cache-control"], "no-store");
    assert.strictEqual(JSON.parse(d.body).host.name, "t");
    const anon = await request(hub.port, { path: "/data.json" });
    assert.match(anon.body, /authentication required/);
    assert.doesNotMatch(hub.logs(), new RegExp(c.secret));
  });
});

test("refusals follow the protocol", async () => {
  await withHub(async (hub, c) => {
    assert.strictEqual((await signed(hub, c, { body: snap(), headers: { "x-servitals-proto": "2" } })).status, 426);
    const unknown = await signed(hub, { ...c, id: "aaaaaaaaaaaa" }, { body: snap() });
    assert.deepStrictEqual([unknown.status, err(unknown)], [401, "unknown_node"]);
    const skew = await signed(hub, c, { body: snap(), ts: String(Date.now() - 200000) });
    assert.deepStrictEqual([skew.status, err(skew)], [401, "clock_skew"]);
    assert.strictEqual(typeof JSON.parse(skew.body).hub_ms, "number");
    const badSig = await signed(hub, c, { body: snap(), secret: "ff".repeat(32) });
    assert.deepStrictEqual([badSig.status, err(badSig)], [401, "bad_signature"]);
    assert.strictEqual((await signed(hub, c, { body: snap(), path: PUSH + "?x=1" })).status, 400);
    assert.strictEqual((await signed(hub, c, { method: "GET", body: "" })).status, 405);
    for (const [body, where] of [["[1]", "$"], ["nope", "$"], ['{"host":{}}', "$.ts"],
                                 ['{"ts":1,"host":"x"}', "$.host"], ['{"ts":1,"host":{},"interval":1}', "$.interval"]]) {
      const bad = await signed(hub, c, { body });
      assert.deepStrictEqual([bad.status, err(bad), JSON.parse(bad.body).path], [422, "invalid_snapshot", where], body);
    }
    const big = await signed(hub, c, { body: snap({ pad: "x".repeat(300 * 1024) }) });
    assert.deepStrictEqual([big.status, err(big)], [413, "too_large"]);
    const ok = await signed(hub, c, { body: snap() });
    assert.strictEqual(ok.status, 200);
    const replay = await signed(hub, c, { body: snap(), ts: ok.ts });
    assert.deepStrictEqual([replay.status, err(replay)], [401, "replay"]);
    const soon = await signed(hub, c, { body: snap() });
    assert.deepStrictEqual([soon.status, err(soon)], [429, "rate_limited"]);
    assert.ok(Number(soon.headers["retry-after"]) >= 1);
  });
});

test("a browser ban never blocks the agent API", async () => {
  await withHub(async (hub, c) => {
    fs.writeFileSync(path.join(hub.dataDir, "bans.json"),
      JSON.stringify({ "127.0.0.1": { at: Date.now(), until: 0, fails: 3 } }));
    assert.strictEqual((await request(hub.port, { path: "/" })).status, 403);
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 200);
  });
});

test("wait: held, replaced by a newer wait, woken by refresh", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    const first = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    await new Promise((r) => setTimeout(r, 300));
    const second = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "30" } });
    const replaced = await first;
    assert.strictEqual(replaced.status, 204);
    assert.ok(replyOk(replaced, c), "204 is signed too");
    await new Promise((r) => setTimeout(r, 300));
    const refresh = await ctlPost(hub.port, cookie, "/__ctl/refresh");
    assert.deepStrictEqual(JSON.parse(refresh.body), { ok: true, woke: true, fresh: false });
    const woken = await second;
    assert.strictEqual(woken.status, 200);
    assert.deepStrictEqual(JSON.parse(woken.body), { sample: true });
    assert.ok(replyOk(woken, c));
    const idle = await ctlPost(hub.port, cookie, "/__ctl/refresh");
    assert.strictEqual(JSON.parse(idle.body).woke, false, "nobody waiting");
  });
});

test("refresh right after a push does not wake the agent; the wait times out with 204", async () => {
  await withHub(async (hub, c) => {
    const cookie = cookieFrom(await login(hub.port));
    assert.strictEqual((await signed(hub, c, { body: snap() })).status, 200);
    const started = Date.now();
    const wait = signed(hub, c, { method: "GET", path: WAIT, headers: { "x-servitals-wait": "1" } });
    await new Promise((r) => setTimeout(r, 300));
    const refresh = await ctlPost(hub.port, cookie, "/__ctl/refresh");
    assert.deepStrictEqual(JSON.parse(refresh.body), { ok: true, woke: false, fresh: true });
    const r = await wait;
    assert.strictEqual(r.status, 204);
    assert.ok(Date.now() - started >= 4500, "X-Servitals-Wait is clamped to at least 5 s");
  });
});

test("the latest snapshot and the local node survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  const a = await startHub({}, { dataDir: dir });
  const c = creds(a);
  try { assert.strictEqual((await signed(a, c, { body: snap({ host: { name: "kept" } }) })).status, 200); }
  finally { await a.stop(); }
  const b = await startHub({}, { dataDir: dir });
  try {
    assert.deepStrictEqual(creds(b), c);
    const cookie = cookieFrom(await login(b.port));
    const d = await request(b.port, { path: "/data.json", headers: { cookie } });
    assert.strictEqual(JSON.parse(d.body).host.name, "kept");
  } finally { await b.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/agentapi.test.js`
Expected: FAIL: pushes get the login page (`200` HTML) or `403`, `/data.json` is proxied to the test upstream.

- [ ] **Step 3: Write `hub/lib/agentapi.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Agent API v1 (docs/protocol.md): POST /api/v1/agent/push and the
 * GET /api/v1/agent/wait long poll. Checks run in the protocol's order, and
 * the last accepted TS is stored only after every check passed.
 * Replay counters are in memory: after a restart the 120 s skew window
 * bounds replays (persisting them is sub-project 4 work).
 */
const { verifyRequest, signReply } = require("./agentsig");

const MAX_SKEW_MS = 120000;
const PUSH_MIN_MS = 5000;
const WAIT_MAX_S = 55;
const WAIT_MIN_S = 5;
const NODE_ID = /^[a-z2-7]{12}$/;
const MESSAGES = {
  not_found: "no such endpoint",
  method_not_allowed: "wrong method for this endpoint",
  query_not_allowed: "agent requests carry no query string",
  unsupported_protocol: "this hub speaks protocol 1",
  unknown_node: "unknown or revoked node",
  clock_skew: "clock differs from the hub by more than 120 s",
  replay: "timestamp not newer than the last accepted one",
  too_large: "request body too large",
  bad_signature: "signature does not match",
  invalid_snapshot: "snapshot failed validation",
  rate_limited: "pushing too often",
};

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Minimal checks for sub-project 2; the full schema (protocol section 6) comes with multi-node.
function checkSnapshot(s) {
  if (!isObj(s)) return "$";
  if (typeof s.ts !== "number" || !Number.isFinite(s.ts)) return "$.ts";
  if (!isObj(s.host)) return "$.host";
  if (s.interval !== undefined &&
      !(typeof s.interval === "number" && s.interval >= 5 && s.interval <= 3600)) return "$.interval";
  return null;
}

function clampWait(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(WAIT_MAX_S, Math.max(WAIT_MIN_S, n)) : WAIT_MAX_S;
}

// Resolves with the body, or null past `max` bytes. Past the limit the rest is
// drained and dropped, never buffered.
function readLimited(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function createAgentApi({ nodes, log, onSnapshot, maxBody = 256 * 1024, now = Date.now }) {
  const lastTs = new Map();     // "<id> <endpoint>" -> last accepted TS
  const lastPush = new Map();   // id -> hub time of the last stored push
  const waiters = new Map();    // id -> { res, secret, ts, timer }
  const seen = new Set();       // ids that pushed since this process started

  function fail(res, code, error, { headers = {}, body = {} } = {}) {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ error, message: MESSAGES[error] || error, ...body }));
  }

  function reply(res, code, secret, ts, obj) {
    const body = obj === undefined ? "" : JSON.stringify(obj);
    const headers = { "x-servitals-sig": signReply(secret, ts, body) };
    if (body) headers["content-type"] = "application/json";
    res.writeHead(code, headers);
    res.end(body);
  }

  function finishWait(id, w, code) {
    clearTimeout(w.timer);
    if (waiters.get(id) === w) waiters.delete(id);
    if (!w.res.writableEnded) reply(w.res, code, w.secret, w.ts, code === 200 ? { sample: true } : undefined);
  }

  async function handle(req, res) {
    const url = req.url || "";
    const q = url.indexOf("?");
    const pathname = q < 0 ? url : url.slice(0, q);
    let endpoint;
    if (pathname === "/api/v1/agent/push") endpoint = "push";
    else if (pathname === "/api/v1/agent/wait") endpoint = "wait";
    else return fail(res, 404, "not_found");
    if (req.method !== (endpoint === "push" ? "POST" : "GET")) return fail(res, 405, "method_not_allowed");
    if (q >= 0) return fail(res, 400, "query_not_allowed");

    const h = req.headers;
    if (h["x-servitals-proto"] !== "1") return fail(res, 426, "unsupported_protocol");
    const id = h["x-servitals-node"] || "";
    const node = NODE_ID.test(id) ? nodes.get(id) : null;
    if (!node) { log.warn("api.refused", { error: "unknown_node" }); return fail(res, 401, "unknown_node"); }
    const tsRaw = h["x-servitals-ts"] || "";
    const ts = /^\d{1,16}$/.test(tsRaw) ? Number(tsRaw) : NaN;
    const hubMs = now();
    if (!Number.isFinite(ts) || Math.abs(hubMs - ts) > MAX_SKEW_MS) {
      log.warn("api.refused", { node: id, error: "clock_skew" });
      return fail(res, 401, "clock_skew", { body: { hub_ms: hubMs } });
    }
    const key = `${id} ${endpoint}`;
    if (ts <= (lastTs.get(key) || 0)) return fail(res, 401, "replay");
    const tooLarge = () => fail(res, 413, "too_large", { headers: { connection: "close" } });
    if (Number(h["content-length"] || 0) > maxBody) { req.resume(); return tooLarge(); }
    const body = await readLimited(req, maxBody);
    if (body === null) return tooLarge();
    if (!verifyRequest(node.secret, req.method, pathname, tsRaw, body, h["x-servitals-sig"])) {
      log.warn("api.refused", { node: id, error: "bad_signature" });
      return fail(res, 401, "bad_signature");
    }

    if (endpoint === "push") {
      const since = hubMs - (lastPush.get(id) || 0);
      if (since < PUSH_MIN_MS) {
        return fail(res, 429, "rate_limited", { headers: { "retry-after": String(Math.ceil((PUSH_MIN_MS - since) / 1000)) } });
      }
      let snap;
      try { snap = JSON.parse(body.toString("utf8")); } catch (_) { snap = undefined; }
      const bad = checkSnapshot(snap);
      if (bad) return fail(res, 422, "invalid_snapshot", { body: { path: bad } });
      lastTs.set(key, ts);
      lastPush.set(id, hubMs);
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, snap, body);
      return reply(res, 200, node.secret, tsRaw, { ok: true });
    }

    lastTs.set(key, ts);
    const prev = waiters.get(id);
    if (prev) finishWait(id, prev, 204);   // a reconnecting agent is never locked out
    const w = { res, secret: node.secret, ts: tsRaw };
    w.timer = setTimeout(() => finishWait(id, w, 204), clampWait(h["x-servitals-wait"]) * 1000);
    waiters.set(id, w);
    res.on("close", () => { clearTimeout(w.timer); if (waiters.get(id) === w) waiters.delete(id); });
  }

  function wake(id) {
    const w = waiters.get(id);
    if (!w) return false;
    finishWait(id, w, 200);
    return true;
  }

  return {
    handle,
    wake,
    lastPushAt: (id) => lastPush.get(id) || 0,
    close() { for (const [id, w] of [...waiters]) finishWait(id, w, 204); },
  };
}

module.exports = { createAgentApi, checkSnapshot, clampWait };
```

- [ ] **Step 4: Wire the API into `hub/server.js`**

Add the require: `const { createAgentApi } = require("./lib/agentapi");`

Delete line 29 (`const REFRESH_FILE = ...`).

After the local-node block from Task 4, add:

```js
/* ---------- agent API and the latest snapshot per node ---------- */
const SNAP_DIR = path.join(DATA, "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });
const latest = new Map();   // node id -> raw snapshot bytes
try { latest.set(localNode.id, fs.readFileSync(path.join(SNAP_DIR, localNode.id + ".json"))); }
catch (_) { /* no snapshot yet */ }
const agentApi = createAgentApi({
  nodes, log,
  onSnapshot(id, snap, raw) {
    latest.set(id, raw);
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), raw); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
  },
});
```

Make the agent API the first route. At the top of `handle()`, before `const client = resolveClient(req);`, add:

```js
  // agents authenticate with signatures, never cookies; browser bans do not apply
  if ((req.url || "").startsWith("/api/v1/")) return agentApi.handle(req, res);
```

After the `/config.json` route from Task 2, add:

```js
  // the local node's latest snapshot, where the page and old scripts expect it
  if (authed && req.method === "GET" && pathname === "/data.json") {
    const snap = latest.get(nodes.localId());
    res.writeHead(snap ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(snap || '{"error":"no snapshot yet"}');
  }
```

Replace the refresh handler:

```js
    // ask the agent to sample now — harmless, any authed user
    if (req.method === "POST" && req.url === "/__ctl/refresh") {
      try { fs.writeFileSync(REFRESH_FILE, String(Date.now())); } catch (e) {}
      return json(200, { ok: true });
    }
```

with:

```js
    // ask the local agent to sample now — harmless, any authed user. Within 5 s
    // of a push the data is fresh and a wake would only earn a 429.
    if (req.method === "POST" && req.url === "/__ctl/refresh") {
      const id = nodes.localId();
      const fresh = !!id && Date.now() - agentApi.lastPushAt(id) < 5000;
      const woke = !!id && !fresh && agentApi.wake(id);
      return json(200, { ok: true, woke, fresh });
    }
```

Replace the SIGTERM line:

```js
process.on("SIGTERM", () => server.close(() => process.exit(0)));
```

with:

```js
process.on("SIGTERM", () => {
  agentApi.close();   // answer open long polls so close() is not held up by them
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
```

- [ ] **Step 5: Run the API tests**

Run: `node --test test/agentapi.test.js`
Expected: PASS, 6 tests (one takes about 5 s).

- [ ] **Step 6: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS. The existing "state-changing /__ctl requests need Origin" test still gets `200` from `/__ctl/refresh`.

- [ ] **Step 7: Commit**

```bash
git add hub/lib/agentapi.js hub/server.js test/agentapi.test.js
git commit -m "feat(hub): signed agent push and long-poll wait (protocol v1)" -m "Snapshots are stored per node in STATE_DIR/snapshots and the local one is served as /data.json. /__ctl/refresh wakes the local agent's pending wait instead of writing a trigger file, and skips the wake within 5 s of a push. The agent API ignores browser bans."
```

---
### Task 6: Split the agent into metric groups, `STATE_DIR`, group toggles

A structural move with two small behaviour changes: delta counters move from the fixed `/tmp/state` to `STATE_DIR`, and every group except `host` can be turned off. The trend file and the trigger file stay next to `OUT_FILE` until Task 9, so the Docker install keeps working after this task.

**Files:**
- Create: `agent/lib/host.sh`, `agent/lib/mem.sh`, `agent/lib/cpu.sh`, `agent/lib/temp.sh`, `agent/lib/disks.sh`, `agent/lib/net.sh`, `agent/lib/docker.sh`, `agent/lib/trend.sh`, `test/agent-groups.test.js`
- Modify: `agent/collect.sh` (whole file), `agent/Dockerfile`, `test/agent.test.js`

**Interfaces:**
- Produces: shell functions `host_json`, `mem_json`, `cpu_json`, `temp_json`, `disks_json`, `mount_source <mountpoint>`, `pick_iface`, `net_json <iface>`, `docker_json`, `trend_row <cpu> <mem> <temp>`; each prints JSON on stdout. Library files only define functions; they read the globals `HOST`, `STATE`, `NCPU`, `DISKS`, `VNSTAT_DB`, `IFACE_ENV`, `TREND_FILE` that `collect.sh` sets. Env: `STATE_DIR` (default `$STATE_DIRECTORY`, then `/var/lib/servitals-agent`), `HOST_ROOT` (default now `/`), `COLLECT_MEM|CPU|TEMP|DISKS|NET|DOCKER` (`0` = off, group becomes `null`). Test helper `runGroup(host, script, env) → spawnSync result` in `test/agent-groups.test.js`, reused by Tasks 7 and 8.

- [ ] **Step 1: Write the failing group tests**

Create `test/agent-groups.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LIB = path.join(__dirname, "..", "agent", "lib");

// A fake host tree: { "relative/path": "contents" }
function fakeHost(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-host-"));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (text !== null) fs.writeFileSync(f, text);
  }
  return root;
}

const BASE = {
  "etc/hostname": "fixture-host\n",
  "etc/os-release": 'PRETTY_NAME="Fixture Linux 1.0"\n',
  "proc/sys/kernel/osrelease": "6.1.0-test\n",
  "proc/sys/kernel/hostname": "container-id\n",
  "proc/uptime": "12345.67 999.00\n",
  "proc/loadavg": "0.50 0.40 0.30 1/100 1234\n",
  "proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\nintr 1\n",
  "proc/meminfo": [
    "MemTotal:       1000 kB", "MemFree:         100 kB", "MemAvailable:    600 kB",
    "Buffers:          50 kB", "Cached:          150 kB", "SwapCached:        0 kB",
    "SwapTotal:       200 kB", "SwapFree:        150 kB", "SReclaimable:     20 kB", "",
  ].join("\n"),
  "proc/1/mountinfo": [
    "25 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
    "36 25 8:17 / /srv rw,relatime shared:2 - ext4 /dev/sdb1 rw", "",
  ].join("\n"),
  "sys/class/hwmon/hwmon0/name": "coretemp\n",
  "sys/class/hwmon/hwmon0/temp1_input": "46000\n",
  "sys/class/hwmon/hwmon0/temp1_label": "Package id 0\n",
  "sys/class/hwmon/hwmon0/temp2_input": "51000\n",
  "sys/class/hwmon/hwmon0/temp2_label": "Core 0\n",
  "srv/data.txt": "x",
};

function runGroup(host, script, env = {}) {
  const state = env.STATE || fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  return spawnSync("bash", ["-c", `set -uo pipefail; for f in "$AGENT_LIB"/*.sh; do . "$f"; done; ${script}`], {
    env: { PATH: process.env.PATH, AGENT_LIB: LIB, HOST: host, STATE: state, NCPU: "2",
           DISKS: "/", IFACE_ENV: "", VNSTAT_DB: path.join(host, "var/lib/vnstat"), ...env },
    encoding: "utf8", timeout: 30000,
  });
}
const json = (r) => { assert.strictEqual(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test("host_json reads the host's files, not the UTS namespace", () => {
  assert.deepStrictEqual(json(runGroup(fakeHost(BASE), "host_json")),
    { name: "fixture-host", distro: "Fixture Linux 1.0", kernel: "6.1.0-test", uptime: 12345 });
});

test("mem_json in bytes", () => {
  assert.deepStrictEqual(json(runGroup(fakeHost(BASE), "mem_json")), {
    total: 1024000, used: 409600, available: 614400, free: 102400,
    cache: 225280, swapTotal: 204800, swapUsed: 51200,
  });
});

test("cpu_json is 0 on the first tick and a delta afterwards", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  assert.deepStrictEqual(json(runGroup(host, "cpu_json", { STATE: state })),
    { usage: 0, cores: 2, per: [0, 0], load: [0.5, 0.4, 0.3] });
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1600 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\ncpu1 100 0 100 800 0 0 0 0 0 0\n");
  const second = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(second.usage, 20);
  assert.deepStrictEqual(second.per, [20, 20]);
});

test("temp_json picks the package sensor", () => {
  const t = json(runGroup(fakeHost(BASE), "temp_json"));
  assert.strictEqual(t.package, 46);
  assert.strictEqual(t.max, 51);
  assert.strictEqual(t.sensors.length, 2);
});

test("disks_json reports each DISKS entry with its mountinfo source", () => {
  const d = json(runGroup(fakeHost(BASE), "disks_json", { DISKS: "/, /srv" }));
  assert.deepStrictEqual(d.map((x) => [x.mount, x.source, x.fstype]),
    [["/", "/dev/sda2", "ext4"], ["/srv", "/dev/sdb1", "ext4"]]);
  assert.ok(d[0].size > 0 && d[0].pct >= 0 && d[0].pct <= 100);
});

test("net_json without an interface is null", () => {
  assert.strictEqual(runGroup(fakeHost(BASE), 'net_json ""').stdout.trim(), "null");
});

module.exports = { fakeHost, runGroup, BASE, json };
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/agent-groups.test.js`
Expected: FAIL: every test exits non-zero with `host_json: command not found` (and similar): `agent/lib/` does not exist.

- [ ] **Step 3: Move each metric group into `agent/lib/`**

Each library file starts with the same two header lines and holds only function definitions. Move the functions from `agent/collect.sh` **unchanged** into these files:

| file | functions (from `agent/collect.sh`) | header comment |
| --- | --- | --- |
| `agent/lib/host.sh` | `host_json` (lines 43-54) | `# host: name, distro, kernel, uptime` |
| `agent/lib/mem.sh` | `mem_json` (lines 56-73) | `# mem: /proc/meminfo in bytes` |
| `agent/lib/cpu.sh` | `cpu_json` (lines 75-118) | `# cpu: total and per-core usage from /proc/stat deltas, load averages` |
| `agent/lib/temp.sh` | `temp_json` (lines 120-154) | `# temp: hwmon sensors, thermal zones as fallback` |
| `agent/lib/disks.sh` | `mount_source` (lines 37-41), `disks_json` (lines 156-201) | `# disks: usage per DISKS entry, source and model from mountinfo and sysfs` |
| `agent/lib/net.sh` | `pick_iface` (lines 30-35), `net_json` (lines 203-261) | `# net: live rate from interface counters, history from vnStat` |
| `agent/lib/docker.sh` | `docker_json` (lines 263-307) | `# docker: containers with cpu and memory` |
| `agent/lib/trend.sh` | `trend_row` (lines 313-322, with its comment) | `# trend: rolling sparkline history (last 60 samples)` |

Two lines change while moving, so that CI's shellcheck at warning level passes (SC2155, declare and assign separately). In `cpu_json`, replace

```bash
      local cdt=$((ct - ppt)) cdi=$((ci - ppi))
```

with

```bash
      local cdt cdi
      cdt=$((ct - ppt)); cdi=$((ci - ppi))
```

and replace

```bash
  local per="[$(IFS=,; echo "${per_vals[*]-}")]"   # integers -> JSON array, no jq per core
```

with

```bash
  local per
  per="[$(IFS=,; echo "${per_vals[*]-}")]"   # integers -> JSON array, no jq per core
```

Every file begins:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# <header comment from the table>
```

- [ ] **Step 4: Rewrite `agent/collect.sh`**

Replace the whole file with:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent: metrics collector. One file per metric group in lib/.
# Reads host metrics under $HOST_ROOT (/ natively, /host in the Docker agent)
# and writes a JSON snapshot to $OUT_FILE on every tick.
# shellcheck disable=SC2034
# (IFACE_ENV, VNSTAT_DB, AGENT_NAME and others are read by the lib/*.sh files)
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
HOST="${HOST_ROOT:-/}"
OUT="${OUT_FILE:-/www/data.json}"
OUTDIR="$(dirname "$OUT")"
INTERVAL="${INTERVAL:-300}"   # slow heartbeat; the UI triggers fresh samples on demand
IFACE_ENV="${NET_IFACE:-}"
DISKS="${DISKS:-/}"
VNSTAT_DB="$HOST/var/lib/vnstat"
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# delta counters (cpu, network); systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
mkdir -p "$STATE"
# sparkline history + refresh trigger live next to data.json (the .trend history
# survives container rebuilds; the web server refuses dotfiles)
TREND_FILE="$OUTDIR/.trend"
TRIGGER="$OUTDIR/.refresh"
touch "$TREND_FILE" 2>/dev/null || true   # so collect()'s --rawfile read never misses it

for f in "$HERE"/lib/*.sh; do
  # shellcheck source=/dev/null
  . "$f"
done

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null

collect() {
  local host mem=null cpu=null temp=null disks=null net=null docker=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
    net=$(net_json "$IFACE")
  fi
  if on "${COLLECT_DOCKER:-1}"; then docker=$(docker_json); fi
  trend_row "$cpu" "$mem" "$temp"

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --rawfile trend "$TREND_FILE" \
    --argjson interval "${INTERVAL:-300}" \
    '{ts:(now|floor), interval:$interval, host:$host, mem:$mem, cpu:$cpu, temp:$temp,
      disks:$disks, net:$net, docker:$docker,
      trend: ($trend / "\n" | map(select(length > 0) | fromjson?))}' \
    > "$OUT.tmp" 2>/dev/null && mv "$OUT.tmp" "$OUT"
}

echo "servitals agent: HOST=$HOST OUT=$OUT INTERVAL=${INTERVAL}s DISKS=$DISKS STATE=$STATE"
IFACE=$(pick_iface)
# single tick for tests and budget checks: sample once, write, exit
if [ "${ONCE:-0}" = "1" ]; then
  collect
  exit $?
fi
while true; do
  collect || echo "tick failed: $(date -Is)"
  # sleep INTERVAL, but wake early if something touches the trigger file
  i=0
  while [ "$i" -lt "$INTERVAL" ]; do
    if [ -e "$TRIGGER" ]; then rm -f "$TRIGGER"; break; fi
    sleep 1
    i=$((i + 1))
  done
done
```

- [ ] **Step 5: Ship `lib/` in the agent image**

In `agent/Dockerfile`, after `COPY collect.sh /usr/local/bin/collect.sh`, add:

```dockerfile
COPY lib /usr/local/bin/lib
```

(Task 11 moves the agent to its own directory in the image.)

- [ ] **Step 6: Update the single-tick test and add a toggle test**

In `test/agent.test.js`, in the existing test add `STATE_DIR: dir` to the `env` object. Then append:

```js
test("COLLECT_<GROUP>=0 turns a group off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  const out = path.join(dir, "data.json");
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0" },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(d.docker, null);
  assert.strictEqual(d.temp, null);
  assert.strictEqual(d.net, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 7: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 8: Give the budget check a state directory, then run it**

The agent now defaults to `/var/lib/servitals-agent`, which a normal user cannot create. In `test/budget.sh`, directly after the line `out=$(mktemp)` in section 4, add:

```bash
state=$(mktemp -d)
export STATE_DIR="$state"
```

and replace `rm -rf "$out" "$stub"` with `rm -rf "$out" "$stub" "$state"`.

Run: `bash test/budget.sh`
Expected: every line `ok`; agent tick CPU ≤ 400 ms, peak RSS ≤ 10240 kB.

- [ ] **Step 9: Commit**

```bash
git add agent/ test/agent-groups.test.js test/agent.test.js test/budget.sh
git commit -m "refactor(agent): one file per metric group, STATE_DIR, group toggles" -m "collect.sh sources agent/lib/*.sh. Delta counters move from /tmp/state to STATE_DIR (default /var/lib/servitals-agent). COLLECT_<GROUP>=0 reports that group as null. HOST_ROOT defaults to /."
```

---

### Task 7: Collector fixes: stacked mounts, hung shares, unmounted entries, 60 s heartbeat

**Files:**
- Modify: `agent/lib/disks.sh` (whole file), `agent/collect.sh` (`INTERVAL` default), `www/index.html` (disk rendering, around line 1060)
- Test: `test/agent-groups.test.js` (append), `test/agent.test.js`

**Interfaces:**
- Consumes: `runGroup`, `fakeHost`, `BASE`, `json` from `test/agent-groups.test.js` (same file).
- Produces: `mount_info <mountpoint>` prints `"<fstype> <source>"` from the **last** matching `mountinfo` line (replaces `mount_source`); `disks_json` entries gain `"mounted": true`, and a `DISKS` entry that is not a mountpoint is `{"mount": "<path>", "mounted": false}`; env `STAT_TIMEOUT` (seconds, default `5`); `INTERVAL` default `60`.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-groups.test.js` (above the `module.exports` line):

```js
test("a stacked mount reports the top of the stack (cifs on autofs)", () => {
  const host = fakeHost({
    ...BASE,
    "proc/1/mountinfo": BASE["proc/1/mountinfo"] +
      "40 25 0:40 / /mnt/share rw,relatime shared:20 - autofs systemd-1 rw,fd=50\n" +
      "41 40 0:50 / /mnt/share rw,relatime shared:21 - cifs //nas/share rw\n",
    "mnt/share/file": "x",
  });
  const d = json(runGroup(host, "disks_json", { DISKS: "/mnt/share" }));
  assert.deepStrictEqual([d[0].fstype, d[0].source, d[0].mounted], ["cifs", "//nas/share", true]);
});

test("DISKS entries that are not mountpoints say so", () => {
  const host = fakeHost({ ...BASE, "mnt/none/file": "x" });
  const d = json(runGroup(host, "disks_json", { DISKS: "/srv,/mnt/none,/mnt/gone" }));
  assert.deepStrictEqual(d.map((x) => [x.mount, x.mounted]), [["/srv", true], ["/mnt/none", false], ["/mnt/gone", false]]);
  assert.deepStrictEqual(Object.keys(d[1]).sort(), ["mount", "mounted"]);
});

test("a hung statvfs is cut off", () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "sv-stub-"));
  // exec, so `timeout` kills the sleeping process itself and the pipe closes
  fs.writeFileSync(path.join(stub, "stat"), "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 });
  const started = Date.now();
  const r = runGroup(fakeHost(BASE), "disks_json", {
    DISKS: "/srv", STAT_TIMEOUT: "1", PATH: `${stub}:${process.env.PATH}`,
  });
  assert.ok(Date.now() - started < 5000, "finished within the timeout, not after 10 s");
  assert.deepStrictEqual(json(r), []);
});
```

In `test/agent.test.js`, in the first test, replace `assert.match(r.stdout.toString(), /^servitals agent: /m);` with:

```js
  assert.match(r.stdout.toString(), /^servitals agent: .*INTERVAL=60s/m);
```

and after `assert.strictEqual(d.disks[0].mount, "/");` add `assert.strictEqual(d.disks[0].mounted, true);`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL: the stacked mount reports `autofs` and `systemd-1`; `/mnt/none` is reported with the parent filesystem; the hung-stat test takes 10 s; `INTERVAL=300s`.

- [ ] **Step 3: Rewrite `agent/lib/disks.sh`**

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# disks: usage per DISKS entry, source and model from mountinfo and sysfs

mount_info() {  # $1 = mountpoint -> "fstype source" of its LAST mountinfo line
  # A mountpoint can appear several times (cifs stacked on autofs); the last
  # line is the mount on top, the one a path lookup reaches.
  awk -v m="$1" '$5 == m { for (i = 7; i <= NF; i++) if ($i == "-") { v = $(i+1) " " $(i+2); break } }
    END { if (v != "") print v }' "$HOST/proc/1/mountinfo" 2>/dev/null
}

disks_json() {
  local lines="" m p info fstype src base parent model rota
  local bs blocks bfree bavail size used avail pct
  IFS=',' read -ra MS <<< "$DISKS"
  for m in "${MS[@]}"; do
    m=$(echo "$m" | xargs)
    [ -n "$m" ] || continue
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    info=$(mount_info "$m")
    if [ -z "$info" ]; then
      # not a mountpoint: say so instead of reporting the parent filesystem
      lines+="$m"$'\t0\n'
      continue
    fi
    read -r fstype src <<< "$info"
    [ -n "$src" ] || src="?"

    # statvfs: %S block size, %b total, %f free, %a avail. A dead network share
    # can block here forever, so bound it; a share that does not answer is left out.
    read -r bs blocks bfree bavail < <(timeout "${STAT_TIMEOUT:-5}" stat -f -c '%S %b %f %a' "$p" 2>/dev/null || echo "0 0 0 0")
    [ "${blocks:-0}" -gt 0 ] || continue
    size=$(( bs * blocks ))
    avail=$(( bs * bavail ))
    used=$(( bs * (blocks - bfree) ))
    if [ $(( used + avail )) -gt 0 ]; then
      pct=$(( 100 * used / (used + avail) ))
    else
      pct=0
    fi

    model=""; rota=""
    if [ "${src#/dev/}" != "$src" ]; then
      base=${src#/dev/}
      if [ -e "$HOST/sys/class/block/$base/partition" ]; then
        parent=$(basename "$(readlink -f "$HOST/sys/class/block/$base/.." 2>/dev/null)")
      else
        parent=$base
      fi
      model=$(cat "$HOST/sys/class/block/$parent/device/model" 2>/dev/null | xargs || true)
      rota=$(cat "$HOST/sys/class/block/$parent/queue/rotational" 2>/dev/null || echo "")
    fi
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\n'
  done
  # one jq for all disks
  printf '%s' "$lines" | jq -R -s -c '[ split("\n")[] | select(length > 0) | split("\t") |
    if .[1] == "0" then { mount: .[0], mounted: false }
    else { mount: .[0], mounted: true, source: .[2], model: .[3], fstype: .[4],
           rotational: (.[5] == "1"), size: (.[6] | tonumber), used: (.[7] | tonumber),
           avail: (.[8] | tonumber), pct: (.[9] | tonumber) } end ]'
}
```

- [ ] **Step 4: Default heartbeat 60 s**

In `agent/collect.sh` replace:

```bash
INTERVAL="${INTERVAL:-300}"   # slow heartbeat; the UI triggers fresh samples on demand
```

with:

```bash
INTERVAL="${INTERVAL:-60}"    # heartbeat; the hub wakes the agent for fresh samples on demand
```

and in `collect()` replace `--argjson interval "${INTERVAL:-300}"` with `--argjson interval "$INTERVAL"`.

- [ ] **Step 5: Show unmounted disks in the page**

In `www/index.html`, in the storage block, replace:

```js
      const warn = meta.warn ? ` <span class="dwarn">⚠ ${esc(meta.warn)}</span>` : "";
      const cls = HCLS[health(dk.pct, 78, 90)];
```

with:

```js
      const warn = meta.warn ? ` <span class="dwarn">⚠ ${esc(meta.warn)}</span>` : "";
      if (dk.mounted === false) {
        return `<div class="disk"><div class="dtop">
          <span class="dname">${name} <span class="muted">${esc(dk.mount)}</span></span>
          <span class="v hl-amber">not mounted</span></div>${warn ? `<div class="dmodel">${warn}</div>` : ""}</div>`;
      }
      const cls = HCLS[health(dk.pct, 78, 90)];
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/lib/disks.sh agent/collect.sh www/index.html test/agent-groups.test.js test/agent.test.js
git commit -m "fix(agent): stacked mounts, hung shares, unmounted DISKS entries" -m "Mount lookups use the last mountinfo line, so cifs on autofs reports cifs. statvfs runs under timeout (STAT_TIMEOUT, default 5 s) so a dead share cannot hang the tick. DISKS entries that are not mountpoints are reported as mounted:false and the page says 'not mounted'. Heartbeat default is 60 s."
```

---

### Task 8: Containers from the Docker API with `curl`, CPU from cgroup counters

**Files:**
- Modify: `agent/lib/docker.sh` (whole file), `agent/Dockerfile` (`docker-cli` → `curl`), `www/index.html` (container CPU unknown), `test/budget.sh` (drop the `docker` stub)
- Create: `test/agent-docker.test.js`

**Interfaces:**
- Consumes: the `fakeHost` helper idea from Task 6 (re-implemented locally, see test).
- Produces: `docker_json` prints `[{name, id, state, status, health, cpu, mem}]` as before; `cpu` is `null` on the first tick a container is seen and afterwards `100 × Δusage_usec / (Δt_µs × NCPU)` with one decimal; `mem` is cgroup `anon` bytes (v1: `total_rss`). Env `DOCKER_SOCK` (default `/var/run/docker.sock`). State file `$STATE/docker-cpu` (`<id> <usage_usec> <ns>` per line).

- [ ] **Step 1: Write the failing tests**

Create `test/agent-docker.test.js`. The fake Docker API runs in this process, so the agent must run asynchronously (`execFile`, never `spawnSync`, which would block the server):

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const LIB = path.join(__dirname, "..", "agent", "lib");
const ID1 = "a".repeat(64);
const ID2 = "b".repeat(64);

function dockerJson(host, state, sock) {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-c", 'for f in "$AGENT_LIB"/*.sh; do . "$f"; done; docker_json'], {
      env: { PATH: process.env.PATH, AGENT_LIB: LIB, HOST: host, STATE: state, NCPU: "2", DOCKER_SOCK: sock },
      timeout: 30000,
    }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(JSON.parse(stdout))));
  });
}

async function fakeDocker(dir) {
  const sock = path.join(dir, "docker.sock");
  const srv = http.createServer((req, res) => {
    if (req.url !== "/containers/json?all=1") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { Id: ID2, Names: ["/old"], State: "exited", Status: "Exited (0) 3 days ago" },
      { Id: ID1, Names: ["/web"], State: "running", Status: "Up 2 hours (healthy)" },
    ]));
  });
  await new Promise((r) => srv.listen(sock, r));
  return { sock, close: () => new Promise((r) => srv.close(r)) };
}

test("containers from the API socket, memory and CPU from the cgroup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dk-"));
  const host = path.join(dir, "host");
  const state = path.join(dir, "state");
  const cg = path.join(host, `sys/fs/cgroup/system.slice/docker-${ID1}.scope`);
  fs.mkdirSync(cg, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(cg, "cpu.stat"), "usage_usec 1000000\nuser_usec 600000\n");
  fs.writeFileSync(path.join(cg, "memory.stat"), "anon 5242880\nfile 999\n");
  const api = await fakeDocker(dir);
  try {
    const first = await dockerJson(host, state, api.sock);
    assert.deepStrictEqual(first.map((c) => c.name), ["web", "old"], "running first");
    assert.deepStrictEqual(first[0], {
      name: "web", id: ID1, state: "running", status: "Up 2 hours (healthy)",
      health: "healthy", cpu: null, mem: 5242880,
    });
    assert.strictEqual(first[1].mem, null);
    assert.strictEqual(first[1].health, null);
    // +0.1 s of CPU: a clear non-zero percentage even on a slow runner
    fs.writeFileSync(path.join(cg, "cpu.stat"), "usage_usec 1100000\nuser_usec 600000\n");
    const second = await dockerJson(host, state, api.sock);
    assert.strictEqual(typeof second[0].cpu, "number");
    assert.ok(second[0].cpu > 0 && second[0].cpu <= 100, String(second[0].cpu));
    assert.match(fs.readFileSync(path.join(state, "docker-cpu"), "utf8"), new RegExp(`^${ID1} 1100000 \\d+$`, "m"));
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no Docker socket means an empty list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dk-"));
  assert.deepStrictEqual(await dockerJson(dir, dir, path.join(dir, "missing.sock")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/agent-docker.test.js`
Expected: FAIL: the old `docker_json` calls the Docker CLI and returns `[]` for the first test.

- [ ] **Step 3: Rewrite `agent/lib/docker.sh`**

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# docker: the container list from the Docker API over its unix socket (curl,
# not the docker CLI, which briefly takes ~29 MB per call), memory and CPU
# from each container's cgroup. CPU % is the usage_usec delta since the last
# tick over the host's whole capacity, so it compares with cpu.usage.

cgroup_dir() {  # $1 = container id -> its cgroup v2 directory, if there is one
  local d
  for d in "$HOST/sys/fs/cgroup/system.slice/docker-$1.scope" "$HOST/sys/fs/cgroup/docker/$1"; do
    if [ -f "$d/cpu.stat" ]; then echo "$d"; return; fi
  done
}

docker_json() {
  local sock="${DOCKER_SOCK:-/var/run/docker.sock}" list now rows="" cid name state status d k v usage mem cpu v1
  [ -S "$sock" ] || { echo '[]'; return; }   # no Docker here: do not start curl at all
  list=$(curl -sf --max-time 5 --unix-socket "$sock" 'http://d/containers/json?all=1' 2>/dev/null) \
    || { echo '[]'; return; }
  now=$(date +%s%N)
  local -A prev_u=() prev_t=()
  if [ -f "$STATE/docker-cpu" ]; then
    while read -r cid v k; do prev_u[$cid]=$v; prev_t[$cid]=$k; done < "$STATE/docker-cpu"
  fi
  : > "$STATE/docker-cpu.t"
  while IFS=$'\t' read -r cid name state status; do
    [ -n "$cid" ] || continue
    usage=""; mem=""; cpu=""
    d=$(cgroup_dir "$cid")
    if [ -n "$d" ]; then
      while read -r k v; do [ "$k" = usage_usec ] && usage=$v; done < "$d/cpu.stat"
      [ -f "$d/memory.stat" ] && while read -r k v; do [ "$k" = anon ] && mem=$v; done < "$d/memory.stat"
    else
      v1="$HOST/sys/fs/cgroup/memory/docker/$cid/memory.stat"   # cgroup v1
      if [ -f "$v1" ]; then
        while read -r k v; do [ "$k" = total_rss ] && mem=$v; done < "$v1"
        v=$(cat "$HOST/sys/fs/cgroup/cpuacct/docker/$cid/cpuacct.usage" 2>/dev/null) && usage=$((v / 1000))
      fi
    fi
    if [ -n "$usage" ]; then
      echo "$cid $usage $now" >> "$STATE/docker-cpu.t"
      if [ -n "${prev_u[$cid]:-}" ] && [ "$usage" -ge "${prev_u[$cid]}" ]; then
        cpu=$(awk -v du=$((usage - ${prev_u[$cid]})) -v dt=$(( (now - ${prev_t[$cid]}) / 1000 )) -v n="$NCPU" \
          'BEGIN { if (dt > 0) { c = 100 * du / (dt * n); if (c > 100) c = 100; printf "%.1f", c } }')
      fi
    fi
    rows+="$cid"$'\t'"$name"$'\t'"$state"$'\t'"$status"$'\t'"$cpu"$'\t'"$mem"$'\n'
  done < <(jq -r '.[] | [.Id, ((.Names[0] // "") | ltrimstr("/")), .State, .Status] | @tsv' <<< "$list" 2>/dev/null)
  mv "$STATE/docker-cpu.t" "$STATE/docker-cpu"
  printf '%s' "$rows" | jq -R -s -c '
    [ split("\n")[] | select(length > 0) | split("\t") | {
        name: .[1], id: .[0], state: .[2], status: .[3],
        health: ( .[3] | capture("\\((?<h>healthy|unhealthy|health: starting|starting)\\)").h // null ),
        cpu: ( if .[4] == "" then null else (.[4] | tonumber) end ),
        mem: ( if .[5] == "" then null else (.[5] | tonumber) end ) } ]
    | sort_by( (if .state == "running" then 0 else 1 end), -( .mem // -1 ) )'
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test test/agent-docker.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Page: container CPU is unknown on the first tick**

In `www/index.html` replace:

```js
        + `<span class="scpu ${cpuHl}">${c.cpu.toFixed(c.cpu < 10 ? 1 : 0)}%</span>`
```

with:

```js
        + `<span class="scpu ${cpuHl}">${c.cpu == null ? "–" : c.cpu.toFixed(c.cpu < 10 ? 1 : 0) + "%"}</span>`
```

- [ ] **Step 6: Agent image: `curl` instead of the Docker CLI; budget without the stub**

In `agent/Dockerfile` replace `docker-cli` with `curl` in the `apk add` line.

In `test/budget.sh`, replace the comment and stub lines

```bash
# 4. agent tick CPU and peak memory, Docker off. A stub `docker` first in PATH
# makes the agent behave as on a host without Docker access. (With Docker on,
# the Docker CLI briefly adds ~29 MB; sub-project 2 replaces it with
# `curl --unix-socket`.)
out=$(mktemp)
state=$(mktemp -d)
export STATE_DIR="$state"
stub=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' > "$stub/docker"; chmod +x "$stub/docker"
export PATH="$stub:$PATH"
```

with:

```bash
# 4. agent tick CPU and peak memory, Docker off (no socket at DOCKER_SOCK, so
# no curl process either). curl itself peaks near 13 MB RSS, but about 11 MB of
# that is shared library pages; its RssAnon is about 1.6 MB (measured 2026-09-25).
out=$(mktemp)
state=$(mktemp -d)
export DOCKER_SOCK=/nonexistent STATE_DIR="$state"
```

Remove `DOCKER_HOST=unix:///nonexistent` from both agent command lines, and replace `rm -rf "$out" "$stub" "$state"` with `rm -rf "$out" "$state"`. In `test/agent.test.js` replace `DOCKER_HOST: "unix:///nonexistent"` with `DOCKER_SOCK: "/nonexistent"`.

- [ ] **Step 7: Run all tests and the budget**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS; every budget line `ok`.

- [ ] **Step 8: Measure the Docker-on tick on this host**

Run (this user is in the `docker` group; nothing is written outside the temp dir):

```bash
s=$(mktemp -d); /usr/bin/time -f '%M kB peak, %e s' env HOST_ROOT=/ STATE_DIR=$s OUT_FILE=$s/d.json ONCE=1 DISKS=/ bash agent/collect.sh >/dev/null && jq '.docker | length, (.[0] | {name, cpu, mem})' $s/d.json; rm -rf $s
```

Expected: a container count matching `docker ps -a -q | wc -l` and `cpu: null` on this first tick. The peak is about 13 MB: that is the `curl` process, and about 11 MB of it is shared library pages (its `RssAnon` is about 1.6 MB). Spec section 18 counts `RssAnon`, so this is within budget; the Docker CLI version peaked near 29 MB. Note both numbers in the commit body.

- [ ] **Step 9: Commit**

```bash
git add agent/lib/docker.sh agent/Dockerfile www/index.html test/agent-docker.test.js test/budget.sh test/agent.test.js
git commit -m "feat(agent): Docker API over curl --unix-socket, CPU from cgroup cpu.stat" -m "Replaces the Docker CLI (about 29 MB per call) and docker stats. Measured on this host: <peak kB>, <n> containers. Container CPU is unknown on the first tick; the page shows a dash."
```

---
### Task 9: The agent pushes over the signed API and waits for wake-ups

**Files:**
- Create: `agent/lib/log.sh`, `agent/lib/hmac.sh`, `agent/lib/api.sh`, `test/agent-push.test.js`
- Modify: `agent/collect.sh` (whole file), `test/agent.test.js`

**Interfaces:**
- Consumes: `POST /api/v1/agent/push`, `GET /api/v1/agent/wait`, `POST /__ctl/refresh` (Task 5); `local-agent.env` (Task 4); `startHub(env, { dataDir, port })`, `ctlPost` (test helpers).
- Produces: shell functions `agent_log <level> <event> [k=v...]`, `hmac_init <secret-hex>`, `hmac_hex <message>`, `load_credentials <file>` (sets `HUB_URL`, `NODE_ID`, `NODE_SECRET`; never sources the file), `api_call <METHOD> <PATH> <body-file> <out-file> [curl args...]` (sets `API_STATUS`; returns 0 only for a 2xx with a valid reply signature, otherwise `API_STATUS` is the HTTP code, `000` or `bad_reply_signature`), `push <file>`, `wait_loop`. Env: `CREDENTIALS_FILE` (default `/etc/servitals/agent-credentials.env`), `CRED_WAIT=1` (wait for the file instead of exiting), `WAIT_SECONDS` (5..55, default 55), `OUT_FILE` (file mode: no push), `LOG_LEVEL`. State files move into `STATE_DIR`: `trend`, `wake`, `snapshot.json`. Tasks 10, 11 and 12 run the agent this way.

- [ ] **Step 1: Write the failing tests**

Create `test/agent-push.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFile } = require("node:child_process");
const { startHub, request, login, cookieFrom, ctlPost } = require("./helpers/hub");

const AGENT = path.join(__dirname, "..", "agent", "collect.sh");
const LIB = path.join(__dirname, "..", "agent", "lib");
const SECRET = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-push-"));

function agentEnv(extra) {
  return { PATH: process.env.PATH, HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent",
           COLLECT_NET: "0", STATE_DIR: tmp(), ...extra };
}
async function snapshotTs(hub, cookie) {
  const r = await request(hub.port, { path: "/data.json", headers: { cookie } });
  return r.status === 200 ? JSON.parse(r.body).ts : 0;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(250);
  }
}

test("bash HMAC matches the protocol vectors", () => {
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const r = spawnSync("bash", ["-c", '. "$AGENT_LIB/hmac.sh"; hmac_init "$K"; hmac_hex "$M1"; hmac_hex "$M2"; hmac_hex "$M3"'], {
    env: {
      PATH: process.env.PATH, AGENT_LIB: LIB, K: SECRET,
      M1: `POST\n/api/v1/agent/push\n1790000000123\n${sha('{"schema":1,"ts":1790000000000,"host":{"name":"nas","os":"linux"}}')}`,
      M2: `GET\n/api/v1/agent/wait\n1790000000456\n${sha("")}`,
      M3: `reply\n1790000000123\n${sha('{"ok":true}')}`,
    },
    encoding: "utf8",
  });
  assert.deepStrictEqual(r.stdout.trim().split("\n"), [
    "a2ca87da11ec97e2133ebdae553a888ae899fe9ea32fc4798a626b3eb3331f03",
    "194b6dc9c936d5c7b8c8802d22836053af2cc8ef63e93d497f09506bd3ba9293",
    "11e9e5a365260ee327629ca9ada7e6afeeb357ad09b9f7810f1052ba9da0dc57",
  ]);
});

test("credentials are parsed, never sourced", () => {
  const dir = tmp();
  const marker = path.join(dir, "pwned");
  const f = path.join(dir, "creds.env");
  fs.writeFileSync(f, `# local agent\r\nHUB_URL=http://127.0.0.1:1/\r\nNODE_ID=abcdefghijkl\r\n` +
    `NODE_SECRET=${"ab".repeat(32)}\r\nEVIL=$(touch ${marker})\r\n`);
  const run = (file) => spawnSync("bash", ["-c", '. "$AGENT_LIB/api.sh"; load_credentials "$F" && echo "$HUB_URL $NODE_ID"'],
    { env: { PATH: process.env.PATH, AGENT_LIB: LIB, F: file }, encoding: "utf8" });
  assert.strictEqual(run(f).stdout.trim(), "http://127.0.0.1:1 abcdefghijkl");
  assert.ok(!fs.existsSync(marker), "nothing in the file is executed");
  fs.writeFileSync(f, "HUB_URL=http://x\nNODE_ID=abcdefghijkl\nNODE_SECRET=short\n");
  assert.notStrictEqual(run(f).status, 0, "a malformed secret is refused");
  assert.notStrictEqual(run(path.join(dir, "missing")).status, 0);
});

test("ONCE=1 pushes one snapshot that the hub serves", async () => {
  const hub = await startHub();
  try {
    const r = spawnSync("bash", [AGENT], {
      env: agentEnv({ ONCE: "1", CREDENTIALS_FILE: path.join(hub.dataDir, "local-agent.env") }),
      encoding: "utf8", timeout: 30000,
    });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /event=agent\.start .*mode=push/);
    const cookie = cookieFrom(await login(hub.port));
    const d = JSON.parse((await request(hub.port, { path: "/data.json", headers: { cookie } })).body);
    assert.ok(d.host.name.length > 0);
    assert.strictEqual(d.disks[0].mounted, true);
    assert.strictEqual(d.interval, 60);
  } finally { await hub.stop(); }
});

test("a wrong secret fails with bad_signature and is never printed", async () => {
  const hub = await startHub();
  try {
    const real = fs.readFileSync(path.join(hub.dataDir, "local-agent.env"), "utf8");
    const wrong = "cd".repeat(32);
    const f = path.join(tmp(), "creds.env");
    fs.writeFileSync(f, real.replace(/^NODE_SECRET=.*$/m, `NODE_SECRET=${wrong}`));
    const r = spawnSync("bash", [AGENT], { env: agentEnv({ ONCE: "1", CREDENTIALS_FILE: f }), encoding: "utf8", timeout: 30000 });
    const out = r.stdout + r.stderr;
    assert.notStrictEqual(r.status, 0);
    assert.match(out, /event=agent\.push_failed status=401 error=bad_signature/);
    assert.ok(!out.includes(wrong) && !out.includes(/^NODE_SECRET=(.*)$/m.exec(real)[1]));
  } finally { await hub.stop(); }
});

test("a reply with a bad signature is refused", async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-servitals-sig": "0".repeat(64) });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const f = path.join(tmp(), "creds.env");
  fs.writeFileSync(f, `HUB_URL=http://127.0.0.1:${srv.address().port}\nNODE_ID=abcdefghijkl\nNODE_SECRET=${SECRET}\n`);
  try {
    const result = await new Promise((resolve) => execFile("bash", [AGENT],
      { env: agentEnv({ ONCE: "1", CREDENTIALS_FILE: f }), timeout: 30000 },
      (e, stdout) => resolve({ code: e ? e.code : 0, stdout })));
    assert.strictEqual(result.code, 1);
    assert.match(result.stdout, /status=bad_reply_signature/);
  } finally { srv.close(); }
});

function startAgent(credFile, extra = {}) {
  const child = spawn("bash", [AGENT], {
    env: agentEnv({ INTERVAL: "3600", CREDENTIALS_FILE: credFile, ...extra }),
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { logs: () => out, stop: () => { try { process.kill(-child.pid, "SIGTERM"); } catch (_) {} } };
}

test("the hub wakes a running agent", { timeout: 60000 }, async () => {
  const hub = await startHub();
  const agent = startAgent(path.join(hub.dataDir, "local-agent.env"));
  try {
    const cookie = cookieFrom(await login(hub.port));
    const first = await until(() => snapshotTs(hub, cookie), 15000, "the first push");
    await sleep(5500);   // past the 5 s push limit
    await until(async () => JSON.parse((await ctlPost(hub.port, cookie, "/__ctl/refresh")).body).woke, 5000, "a wake");
    await until(async () => (await snapshotTs(hub, cookie)) > first, 8000, "a newer snapshot");
  } catch (e) { e.message += "\nagent log:\n" + agent.logs(); throw e; }
  finally { agent.stop(); await hub.stop(); }
});

test("the agent reconnects after a hub restart", { timeout: 90000 }, async () => {
  const dir = tmp();
  const a = await startHub({}, { dataDir: dir });
  const agent = startAgent(path.join(dir, "local-agent.env"));
  let b;
  try {
    const cookieA = cookieFrom(await login(a.port));
    const first = await until(() => snapshotTs(a, cookieA), 15000, "the first push");
    await a.stop();
    b = await startHub({}, { dataDir: dir, port: a.port });
    const cookie = cookieFrom(await login(b.port));
    assert.strictEqual(await snapshotTs(b, cookie), first, "last snapshot served at once after the restart");
    await sleep(5500);
    await until(async () => JSON.parse((await ctlPost(b.port, cookie, "/__ctl/refresh")).body).woke, 30000, "the agent to reconnect");
    await until(async () => (await snapshotTs(b, cookie)) > first, 8000, "a newer snapshot");
  } catch (e) { e.message += "\nagent log:\n" + agent.logs(); throw e; }
  finally {
    agent.stop();
    if (b) await b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/agent-push.test.js`
Expected: FAIL: `hmac.sh: No such file or directory`, and the agent writes `/www/data.json` instead of pushing.

- [ ] **Step 3: Write `agent/lib/log.sh`**

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# log: logfmt lines on stdout; under systemd each line starts with an
# sd-daemon priority prefix so `journalctl -p warning` filters by level.
# Callers pass values without spaces; secrets are never passed.

agent_log() {  # level event [key=value ...]
  local level=$1 event=$2 p=""
  shift 2
  case "${LOG_LEVEL:-info}:$level" in
    error:warn|error:info|error:debug|warn:info|warn:debug|info:debug) return 0 ;;
  esac
  if [ -n "${JOURNAL_STREAM:-}" ]; then
    case "$level" in error) p="<3>" ;; warn) p="<4>" ;; info) p="<6>" ;; *) p="<7>" ;; esac
  fi
  printf '%slevel=%s event=%s%s\n' "$p" "$level" "$event" "${*:+ $*}"
}
```

- [ ] **Step 4: Write `agent/lib/hmac.sh`**

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# hmac: HMAC-SHA256 with bash and sha256sum only (no openssl dependency).
# HMAC(K, m) = H((K ^ opad) || H((K ^ ipad) || m)), block size 64 bytes.
# The pads are printf escape strings, so NUL bytes survive the pipe.

hmac_init() {  # $1 = key as 64 hex characters; sets HMAC_IPAD and HMAC_OPAD
  local k=$1 i b
  while [ "${#k}" -lt 128 ]; do k+="0"; done
  HMAC_IPAD=""
  HMAC_OPAD=""
  for ((i = 0; i < 128; i += 2)); do
    b=$((16#${k:i:2}))
    printf -v HMAC_IPAD '%s\\x%02x' "$HMAC_IPAD" $((b ^ 0x36))
    printf -v HMAC_OPAD '%s\\x%02x' "$HMAC_OPAD" $((b ^ 0x5c))
  done
}

hmac_hex() {  # $1 = message; prints the lowercase hex HMAC
  local inner
  inner=$( { printf '%b' "$HMAC_IPAD"; printf '%s' "$1"; } | sha256sum)
  inner=${inner%% *}
  { printf '%b' "$HMAC_OPAD"; printf '%b' "$(printf '%s' "$inner" | sed 's/../\\x&/g')"; } \
    | sha256sum | cut -d' ' -f1
}
```

- [ ] **Step 5: Write `agent/lib/api.sh`**

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as STATE, INTERVAL and TRIGGER are set by collect.sh)
# api: the agent side of docs/protocol.md. Signed POST /api/v1/agent/push,
# the GET /api/v1/agent/wait long poll, and reply-signature checks.

load_credentials() {  # $1 = file with HUB_URL, NODE_ID, NODE_SECRET; parsed, never sourced
  local k v
  HUB_URL=""; NODE_ID=""; NODE_SECRET=""
  [ -r "$1" ] || return 1
  while IFS='=' read -r k v || [ -n "$k" ]; do
    v=${v%$'\r'}
    case "$k" in
      HUB_URL) HUB_URL=${v%/} ;;
      NODE_ID) NODE_ID=$v ;;
      NODE_SECRET) NODE_SECRET=$v ;;
    esac
  done < "$1"
  [[ $HUB_URL =~ ^https?://[^[:space:]]+$ && $NODE_ID =~ ^[a-z2-7]{12}$ && $NODE_SECRET =~ ^[0-9a-f]{64}$ ]]
}

now_ms() { local t; t=$(date +%s%N); echo "${t:0:13}"; }

api_error() { jq -r '.error // empty' "$1" 2>/dev/null | head -c 40; }

# api_call METHOD PATH BODY_FILE OUT_FILE [curl args...]
# Sets API_STATUS. Returns 0 only for a 2xx whose reply signature is valid.
api_call() {
  local method=$1 path=$2 body=$3 out=$4 ts bh sig got
  shift 4
  : > "$out"; : > "$out.h"   # never read a previous reply if this request fails early
  ts=$(now_ms)
  bh=$(sha256sum < "$body"); bh=${bh%% *}
  sig=$(hmac_hex "$method"$'\n'"$path"$'\n'"$ts"$'\n'"$bh")
  API_STATUS=$(curl -sS -o "$out" -D "$out.h" -w '%{http_code}' -X "$method" --max-time 20 \
    -H "X-Servitals-Proto: 1" -H "X-Servitals-Agent: $AGENT_NAME" -H "X-Servitals-Node: $NODE_ID" \
    -H "X-Servitals-Ts: $ts" -H "X-Servitals-Sig: $sig" \
    -H "Content-Type: application/json" -H "Expect:" \
    --data-binary @"$body" "$@" "$HUB_URL$path" 2>/dev/null) || API_STATUS=000
  case "$API_STATUS" in 2??) ;; *) return 1 ;; esac
  got=$(awk 'tolower($1) == "x-servitals-sig:" { v = $2 } END { print v }' "$out.h" | tr -d '\r')
  bh=$(sha256sum < "$out"); bh=${bh%% *}
  if [ "$got" != "$(hmac_hex "reply"$'\n'"$ts"$'\n'"$bh")" ]; then
    API_STATUS=bad_reply_signature   # an impostor or a proxy rewrote the reply
    return 1
  fi
}

push() {  # $1 = snapshot file; 0 when the hub stored it
  local out="$STATE/push.out"
  api_call POST /api/v1/agent/push "$1" "$out" && return 0
  if [ "$API_STATUS" = 401 ] && [ "$(api_error "$out")" = replay ]; then
    api_call POST /api/v1/agent/push "$1" "$out" && return 0   # a fresh timestamp, once
  fi
  agent_log warn agent.push_failed status="$API_STATUS" error="$(api_error "$out")"
  return 1
}

wait_loop() {  # background: touch $TRIGGER whenever the hub asks for a sample
  local empty="$STATE/wait.empty" out="$STATE/wait.out" hold="${WAIT_SECONDS:-55}" backoff=5
  : > "$empty"
  [[ $hold =~ ^[0-9]+$ ]] || hold=55
  [ "$hold" -lt 5 ] && hold=5
  [ "$hold" -gt 55 ] && hold=55
  while true; do
    if api_call GET /api/v1/agent/wait "$empty" "$out" -H "X-Servitals-Wait: $hold" --max-time $((hold + 15)); then
      backoff=5
      if [ "$API_STATUS" = 200 ] && grep -q '"sample":true' "$out"; then touch "$TRIGGER"; fi
    else
      agent_log warn agent.wait_failed status="$API_STATUS" error="$(api_error "$out")" retry_in="$backoff"
      sleep "$backoff"
      backoff=$((backoff * 2))
      [ "$backoff" -gt "$INTERVAL" ] && backoff=$INTERVAL
      [ "$backoff" -lt 5 ] && backoff=5
    fi
  done
}
```

- [ ] **Step 6: Rewrite `agent/collect.sh` for push mode**

Replace the whole file with:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent: samples this host every INTERVAL seconds, or at once when
# the hub asks, and pushes the snapshot to the hub over the signed agent API
# (docs/protocol.md). One file per metric group in lib/. HOST_ROOT is / on a
# normal install; the Docker agent reads the host through /host.
#   OUT_FILE=<path>  write snapshots to this file instead of pushing (debugging)
#   ONCE=1           one tick, then exit
# shellcheck disable=SC2034
# (IFACE_ENV, VNSTAT_DB, AGENT_NAME and others are read by the lib/*.sh files)
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
HOST="${HOST_ROOT:-/}"
INTERVAL="${INTERVAL:-60}"    # heartbeat; the hub wakes the agent for fresh samples on demand
[[ $INTERVAL =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 3600 ] || INTERVAL=60
IFACE_ENV="${NET_IFACE:-}"
DISKS="${DISKS:-/}"
VNSTAT_DB="$HOST/var/lib/vnstat"
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# delta counters, trend, wake trigger; systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
mkdir -p "$STATE"
CREDENTIALS_FILE="${CREDENTIALS_FILE:-/etc/servitals/agent-credentials.env}"
AGENT_VERSION=$(cat "$HERE/VERSION" "$HERE/../VERSION" 2>/dev/null | head -n 1)
AGENT_NAME="bash/${AGENT_VERSION:-unknown}"
SNAP="${OUT_FILE:-$STATE/snapshot.json}"
TREND_FILE="$STATE/trend"   # sparkline history (last 60 samples)
TRIGGER="$STATE/wake"       # the wait loop touches it when the hub asks for a sample
touch "$TREND_FILE" 2>/dev/null || true
# the hub host's own agent must never go through a proxy
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

for f in "$HERE"/lib/*.sh; do
  # shellcheck source=/dev/null
  . "$f"
done

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
    net=$(net_json "$IFACE")
  fi
  if on "${COLLECT_DOCKER:-1}"; then docker=$(docker_json); fi
  trend_row "$cpu" "$mem" "$temp"

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --rawfile trend "$TREND_FILE" \
    --argjson interval "$INTERVAL" \
    '{ts:(now|floor), interval:$interval, host:$host, mem:$mem, cpu:$cpu, temp:$temp,
      disks:$disks, net:$net, docker:$docker,
      trend: ($trend / "\n" | map(select(length > 0) | fromjson?))}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}

tick() {
  collect "$SNAP" || { agent_log warn agent.tick_failed; return 1; }
  [ -n "${OUT_FILE:-}" ] || push "$SNAP"
}

agent_log info agent.start version="${AGENT_VERSION:-unknown}" interval="$INTERVAL" \
  host_root="$HOST" mode="$([ -n "${OUT_FILE:-}" ] && echo file || echo push)"
if [ -z "${OUT_FILE:-}" ]; then
  until load_credentials "$CREDENTIALS_FILE"; do
    if [ "${CRED_WAIT:-0}" != 1 ]; then
      agent_log error agent.no_credentials file="$CREDENTIALS_FILE"
      exit 1
    fi
    sleep 2   # Docker: the gateway writes the file on its first start
  done
  hmac_init "$NODE_SECRET"
  agent_log info agent.hub url="$HUB_URL" node="$NODE_ID"
fi
IFACE=$(pick_iface)

if [ "${ONCE:-0}" = 1 ]; then
  tick
  exit $?
fi

if [ -z "${OUT_FILE:-}" ]; then
  wait_loop &
  WAIT_PID=$!
  trap 'kill "$WAIT_PID" 2>/dev/null; exit 0' TERM INT
fi
while true; do
  tick
  # sleep INTERVAL, but sample at once when the wait loop touches the trigger
  i=0
  while [ "$i" -lt "$INTERVAL" ]; do
    if [ -e "$TRIGGER" ]; then rm -f "$TRIGGER"; break; fi
    sleep 1
    i=$((i + 1))
  done
done
```

- [ ] **Step 7: Update the file-mode tests**

In `test/agent.test.js`, in the first test replace the `stdout` assertion with:

```js
  assert.match(r.stdout.toString(), /event=agent\.start .*interval=60 .*mode=file/);
```

- [ ] **Step 8: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS. `test/agent-push.test.js` takes about 30 s.

- [ ] **Step 9: Check the budget**

Run: `bash test/budget.sh`
Expected: every line `ok`. (`budget.sh` runs the agent in file mode, which the new code keeps.)

- [ ] **Step 10: Commit**

```bash
git add agent/collect.sh agent/lib/log.sh agent/lib/hmac.sh agent/lib/api.sh test/agent-push.test.js test/agent.test.js
git commit -m "feat(agent): push to the hub over the signed API, wake by long poll" -m "HMAC-SHA256 in bash with sha256sum (no openssl). Reply signatures are checked; a bad one counts as a failure. The credentials file is parsed, never sourced. A background wait loop touches the trigger in STATE_DIR when the hub asks for a sample and backs off from 5 s to INTERVAL on errors. OUT_FILE keeps the file mode for debugging. The local agent never uses a proxy."
```

---

### Task 10: `servitals-agent` and `servitals-ctl` for native installs

**Files:**
- Create: `bin/servitals-agent`, `test/cli.test.js`
- Modify: `bin/servitals-ctl` (paths, state dir, owner-preserving writes, `docker` command, usage text)

**Interfaces:**
- Consumes: `agent/collect.sh` file mode (Task 9).
- Produces: `servitals-agent run | test | docker enable | docker disable`; `servitals-ctl docker enable | docker disable`. Both find their code next to the checkout (`bin/../agent`, `bin/../hub`) or in the installed layout (`/usr/lib/servitals-agent`, `/usr/share/servitals`). `servitals-ctl` uses `STATE_DIR`, else `DATA_DIR`, else `<checkout>/data` when it exists, else `/var/lib/servitals`. The docker commands write `<DROPIN_ROOT>/<unit>.d/docker.conf` with `SupplementaryGroups=docker`, run `$SYSTEMCTL daemon-reload` and `$SYSTEMCTL try-restart <unit>`; tests override `DROPIN_ROOT`, `SYSTEMCTL` and `GETENT`. `servitals-agent test` reads `AGENT_ENV` (default `/etc/servitals/agent.env`) when readable. Task 12's unit runs `servitals-agent run`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-cli-"));
const run = (cmd, args, env = {}) => spawnSync("bash", [path.join(BIN, cmd), ...args], {
  env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 30000,
});

test("servitals-agent test prints one snapshot and sends nothing", () => {
  const r = run("servitals-agent", ["test"], {
    AGENT_ENV: "/nonexistent", HOST_ROOT: "/", DISKS: "/", DOCKER_SOCK: "/nonexistent",
    CREDENTIALS_FILE: "/nonexistent",
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.ok(d.host.name.length > 0);
  assert.strictEqual(d.disks[0].mount, "/");
});

for (const [cmd, unit] of [["servitals-agent", "servitals-agent.service"], ["servitals-ctl", "servitals.service"]]) {
  test(`${cmd} docker enable/disable manages a drop-in`, () => {
    const root = tmp();
    const calls = path.join(root, "calls");
    const stub = path.join(root, "systemctl");
    fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 });
    const env = { DROPIN_ROOT: root, SYSTEMCTL: stub, GETENT: "true" };
    const on = run(cmd, ["docker", "enable"], env);
    assert.strictEqual(on.status, 0, on.stderr);
    assert.match(on.stderr, /root/i, "warns that the docker group is root-equivalent");
    const dropin = path.join(root, `${unit}.d`, "docker.conf");
    assert.match(fs.readFileSync(dropin, "utf8"), /^\[Service\]\nSupplementaryGroups=docker$/m);
    assert.strictEqual(run(cmd, ["docker", "disable"], env).status, 0);
    assert.ok(!fs.existsSync(dropin));
    assert.deepStrictEqual(fs.readFileSync(calls, "utf8").trim().split("\n"),
      ["daemon-reload", `try-restart ${unit}`, "daemon-reload", `try-restart ${unit}`]);
    assert.notStrictEqual(run(cmd, ["docker", "sideways"], env).status, 0);
  });
}

test("servitals-ctl uses STATE_DIR", () => {
  const state = tmp();
  const r = run("servitals-ctl", ["whitelist", "10.9.8.7"], { STATE_DIR: state });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(state, "whitelist.txt"), "utf8"), /^10\.9\.8\.7$/m);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/cli.test.js`
Expected: FAIL: `bin/servitals-agent` does not exist; `servitals-ctl docker` prints the usage text and exits 1; `STATE_DIR` is ignored.

- [ ] **Step 3: Write `bin/servitals-agent`**

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals-agent: run and inspect the servitals agent.
#   servitals-agent run              run the agent (the systemd unit uses this)
#   servitals-agent test             sample once and print the snapshot; nothing is sent
#   servitals-agent docker enable    let the agent read the Docker socket (root-equivalent)
#   servitals-agent docker disable   take that access away again
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [ -f "$SELF_DIR/../agent/collect.sh" ]; then
  AGENT_HOME="$(cd "$SELF_DIR/../agent" && pwd)"   # running from a checkout
else
  AGENT_HOME=/usr/lib/servitals-agent
fi
UNIT=servitals-agent.service

die() { echo "servitals-agent: $*" >&2; exit 1; }

docker_access() {  # enable|disable
  local dir="${DROPIN_ROOT:-/etc/systemd/system}/$UNIT.d"
  case "${1:-}" in
    enable)
      "${GETENT:-getent}" group docker >/dev/null || die "this host has no docker group"
      echo "warning: members of the docker group can take over this host as root." >&2
      echo "The agent only reads the container list, but whoever controls the agent gets that power." >&2
      mkdir -p "$dir"
      printf '# written by: servitals-agent docker enable\n[Service]\nSupplementaryGroups=docker\n' > "$dir/docker.conf"
      ;;
    disable) rm -f "$dir/docker.conf" ;;
    *) die "usage: servitals-agent docker enable|disable" ;;
  esac
  "${SYSTEMCTL:-systemctl}" daemon-reload
  "${SYSTEMCTL:-systemctl}" try-restart "$UNIT"
  echo "docker access ${1}d for $UNIT"
}

cmd_test() {
  local env_file="${AGENT_ENV:-/etc/servitals/agent.env}"
  if [ -r "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
  fi
  # global, not local: the EXIT trap runs after this function has returned
  TEST_DIR=$(mktemp -d)
  trap 'rm -rf "$TEST_DIR"' EXIT
  STATE_DIR="$TEST_DIR" OUT_FILE="$TEST_DIR/snapshot.json" ONCE=1 HOST_ROOT="${HOST_ROOT:-/}" \
    bash "$AGENT_HOME/collect.sh" >&2 || die "sampling failed"
  jq . "$TEST_DIR/snapshot.json"
}

case "${1:-}" in
  run)    shift; exec bash "$AGENT_HOME/collect.sh" "$@" ;;
  test)   shift; cmd_test ;;
  docker) shift; docker_access "$@" ;;
  *) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
```

Run `chmod +x bin/servitals-agent`.

- [ ] **Step 4: Update `bin/servitals-ctl`**

Replace the header comment and the path block (lines 3-14):

```bash
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
```

with:

```bash
# servitals-ctl: admin commands for the servitals hub.
#   servitals-ctl bans                 list blocked IPs and the whitelist
#   servitals-ctl unban <ip>           remove a block (takes effect immediately)
#   servitals-ctl whitelist <ip|cidr>  never block this address again (also unbans)
#   servitals-ctl hash-password        print an AUTH_PASS_HASH value
#   servitals-ctl docker enable        let the hub control containers (root-equivalent)
#   servitals-ctl docker disable       take that access away again
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [ -d "$SELF_DIR/../hub" ]; then
  ROOT="$(cd "$SELF_DIR/.." && pwd)"   # running from a checkout
else
  ROOT=/usr/share/servitals
fi
if [ -n "${STATE_DIR:-}" ]; then DATA_DIR=$STATE_DIR
elif [ -z "${DATA_DIR:-}" ]; then
  if [ -d "$ROOT/data" ]; then DATA_DIR=$ROOT/data; else DATA_DIR=/var/lib/servitals; fi
fi
BANS="$DATA_DIR/bans.json"
WL="$DATA_DIR/whitelist.txt"
UNIT=servitals.service
```

In `atomic_write`, after the `chmod --reference=...` line, add:

```bash
  chown --reference="$dst" "$tmp" 2>/dev/null || true   # root edits keep the hub's ownership
```

Before the final `case`, add:

```bash
cmd_docker() {  # enable|disable
  local dir="${DROPIN_ROOT:-/etc/systemd/system}/$UNIT.d"
  case "${1:-}" in
    enable)
      "${GETENT:-getent}" group docker >/dev/null || die "this host has no docker group"
      echo "warning: members of the docker group can take over this host as root." >&2
      echo "Container controls in the dashboard then act with that power; keep CTL_LAN_ONLY=1." >&2
      mkdir -p "$dir"
      printf '# written by: servitals-ctl docker enable\n[Service]\nSupplementaryGroups=docker\n' > "$dir/docker.conf"
      ;;
    disable) rm -f "$dir/docker.conf" ;;
    *) die "usage: servitals-ctl docker enable|disable" ;;
  esac
  "${SYSTEMCTL:-systemctl}" daemon-reload
  "${SYSTEMCTL:-systemctl}" try-restart "$UNIT"
  echo "docker access ${1}d for $UNIT"
}
```

In the `case`, add `  docker)        shift; cmd_docker "$@" ;;` and change the usage line to `  *) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;`.

- [ ] **Step 5: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS, including the existing `test/ctl.test.js` (it sets `DATA_DIR`).

- [ ] **Step 6: Commit**

```bash
git add bin/servitals-agent bin/servitals-ctl test/cli.test.js
git commit -m "feat: servitals-agent CLI; servitals-ctl for native installs" -m "servitals-agent run|test|docker. servitals-ctl finds its code and state in the installed layout, honours STATE_DIR, keeps file ownership when root edits hub state, and manages the docker group drop-in. Both enable commands warn that the docker group is root-equivalent."
```

---

### Task 11: Docker install: the agent pushes to the gateway

**Files:**
- Modify: `docker-compose.example.yml`, `agent/Dockerfile`, `.dockerignore`, `nginx.conf`, `.env.example`, `test/compose-smoke.sh`

**Interfaces:**
- Consumes: gateway `LOCAL_HUB_URL`, `WWW_DIR`, `local-agent.env` (Task 4); agent `CREDENTIALS_FILE`, `CRED_WAIT`, `DOCKER_SOCK` (Tasks 8, 9).
- Produces: the three-container install where the agent reads `./data/local-agent.env` (read-only mount) and pushes to `http://gateway:8080`; agent state in the named volume `agent-state`; the agent image built from the repository root with the agent at `/usr/local/lib/servitals-agent/`.

Between Task 5 and this task the Docker install serves no data (the gateway no longer reads `www/data.json`). This task restores it.

- [ ] **Step 1: Extend the smoke test first**

In `test/compose-smoke.sh`, after the block that waits for `data.json`, add:

```bash
snap=$(curl -fsS -b "$jar" "$BASE/data.json")
[ "$(jq -r '.disks[0].mounted' <<<"$snap")" = true ] || fail "snapshot is not from the new agent: $snap"
[ -s data/local-agent.env ] || fail "gateway did not write data/local-agent.env"
cfg=$(curl -fsS -b "$jar" "$BASE/config.json")
[ "$(jq -r .title <<<"$cfg")" = homeserver ] || fail "www/config.json was not moved to state: $cfg"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -H "Origin: $BASE" -X POST "$BASE/__ctl/refresh")
[ "$code" = 200 ] || fail "refresh: expected 200, got $code"
# capture first: `docker compose logs | grep -q` fails under pipefail when grep exits early
agent_log=$(docker compose -p "$PROJECT" logs agent)
grep -q 'event=agent.hub' <<<"$agent_log" || fail "agent never loaded its credentials"
```

Leave `cp www/config.example.json www/config.json` in place: it now exercises the move of `config.json` into `data/`.

Run: `bash test/compose-smoke.sh`
Expected: FAIL at `no data.json from the agent` (the old compose file still writes `www/data.json`).

- [ ] **Step 2: Update `docker-compose.example.yml`**

In the `gateway` service replace

```yaml
      - CTL_LAN_ONLY=${CTL_LAN_ONLY:-1}
      - REFRESH_FILE=/www/.refresh
```

with

```yaml
      - CTL_LAN_ONLY=${CTL_LAN_ONLY:-1}
      # the gateway writes data/local-agent.env for the agent container below
      - LOCAL_HUB_URL=http://gateway:8080
      # read once, to move an old www/config.json into data/
      - WWW_DIR=/www
```

and replace

```yaml
      - ./www:/www                                 # write the .refresh trigger
```

with

```yaml
      - ./www:/www:ro
```

Replace the whole `agent` service with:

```yaml
  agent:
    build:
      context: .
      dockerfile: agent/Dockerfile
    image: servitals-agent:local
    container_name: servitals-agent
    restart: unless-stopped
    environment:
      - HOST_ROOT=/host
      # credentials for the local node, written by the gateway on its first start
      - CREDENTIALS_FILE=/data/local-agent.env
      - CRED_WAIT=1
      - INTERVAL=${INTERVAL:-60}
      - NET_IFACE=${NET_IFACE:-}
      - DISKS=${DISKS:-/}
      - TZ=${TZ:-UTC}
    volumes:
      - ./data:/data:ro
      - agent-state:/var/lib/servitals-agent
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # Whole host FS, read-only, with rslave so nested mounts (e.g. /srv,
      # /mnt/*) are visible to the agent for per-drive usage.
      - type: bind
        source: /
        target: /host
        read_only: true
        bind:
          propagation: rslave
    depends_on:
      - gateway
```

and add at the end of the file:

```yaml
volumes:
  agent-state:
```

- [ ] **Step 3: Agent image from the repository root**

Replace `agent/Dockerfile` with:

```dockerfile
# SPDX-License-Identifier: AGPL-3.0-or-later
# Built from the repository root (it needs VERSION): see docker-compose.example.yml
FROM alpine:3.20

RUN apk add --no-cache bash coreutils jq curl vnstat util-linux tzdata

COPY agent/collect.sh /usr/local/lib/servitals-agent/collect.sh
COPY agent/lib /usr/local/lib/servitals-agent/lib
COPY VERSION /usr/local/lib/servitals-agent/VERSION
RUN chmod +x /usr/local/lib/servitals-agent/collect.sh

ENTRYPOINT ["/usr/local/lib/servitals-agent/collect.sh"]
```

In `.dockerignore` add after `!VERSION`:

```
!agent/collect.sh
!agent/lib/
```

In `nginx.conf` delete the `location = /data.json { ... }` block (the gateway answers `/data.json` itself now).

In `.env.example` make these replacements:

- `# (the per-row Portainer deep-link URL lives in www/config.json)` → `# (the per-row Portainer deep-link URL lives in data/config.json)`
- the agent block

  ```sh
  # Baseline heartbeat, in seconds. The agent samples on demand whenever the
  # dashboard is open (see config.json "refreshSec"), and falls back to this
  # slow tick when nobody is watching. 300 is plenty; lower it if you also
  # read data.json from scripts.
  INTERVAL=300
  ```

  becomes

  ```sh
  # Heartbeat, in seconds (5..3600). The gateway also wakes the agent whenever
  # the open dashboard asks for fresh data (see config.json "refreshSec").
  INTERVAL=60
  ```

- [ ] **Step 4: Run the smoke test**

Run: `bash test/compose-smoke.sh`
Expected: `compose smoke test passed`. If `alpine:3.20` or `node:22-alpine` cannot be pulled, pull `mirror.gcr.io/library/alpine:3.20` / `mirror.gcr.io/library/node:22-alpine` and `docker tag` them to the official names, then run again.

- [ ] **Step 5: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.example.yml agent/Dockerfile .dockerignore nginx.conf .env.example test/compose-smoke.sh
git commit -m "feat(docker): the agent container pushes to the gateway" -m "The gateway writes data/local-agent.env; the agent mounts data/ read-only and pushes to http://gateway:8080. Agent state lives in the agent-state volume. www/ is mounted read-only in the gateway, only to move an old config.json. Existing installs: copy the new agent service and volumes block into docker-compose.yml, then docker compose up -d --build."
```

---
### Task 12: systemd units, system users, default config, install script

**Files:**
- Create: `packaging/systemd/servitals.service`, `packaging/systemd/servitals-agent.service`, `packaging/sysusers/servitals.conf`, `packaging/sysusers/servitals-agent.conf`, `packaging/etc/hub.env`, `packaging/etc/agent.env`, `packaging/install-local.sh`, `test/packaging.test.js`

**Interfaces:**
- Consumes: `servitals-agent run` and `servitals-ctl hash-password` (Task 10); the hub's `local-agent.env` (Task 4); `STATE_DIRECTORY` handling (Tasks 2, 6).
- Produces: the installed layout from the Global Constraints; `sudo packaging/install-local.sh [--uninstall]` with first-install inputs `HUB_PORT` (default `20002`), `ADMIN_USER` (default `admin`), `ADMIN_PASSWORD` (else asked on the terminal). Sub-project 3's `debian/` reuses these unit, sysusers and env files unchanged (units then go to `/usr/lib/systemd/system`).

- [ ] **Step 1: Write the failing test**

Create `test/packaging.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const P = path.join(__dirname, "..", "packaging");
const read = (rel) => fs.readFileSync(path.join(P, rel), "utf8");
const lines = (text) => text.split("\n").map((l) => l.trim());

// spec section 13.2, verbatim
const HARDENING = [
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=read-only", "PrivateTmp=yes",
  "ProtectKernelTunables=yes", "ProtectControlGroups=yes", "RestrictSUIDSGID=yes",
  "LockPersonality=yes", "Restart=on-failure",
];

for (const [unit, user, state] of [["servitals.service", "_servitals", "servitals"],
                                   ["servitals-agent.service", "_servitals-agent", "servitals-agent"]]) {
  test(`${unit} carries the hardening set`, () => {
    const l = lines(read(`systemd/${unit}`));
    for (const want of [...HARDENING, `User=${user}`, `StateDirectory=${state}`]) {
      assert.ok(l.includes(want), `${unit}: missing ${want}`);
    }
    assert.ok(!l.some((x) => x.startsWith("MemoryDenyWriteExecute")), "left off for Node's JIT");
  });
}

test("the hub unit may write only its state directory", () => {
  assert.ok(lines(read("systemd/servitals.service")).includes("ReadWritePaths=/var/lib/servitals"));
});

test("the agent unit waits for credentials and never loads them into its environment", () => {
  const l = lines(read("systemd/servitals-agent.service"));
  assert.ok(l.includes("ConditionPathExists=/etc/servitals/agent-credentials.env"));
  assert.ok(!l.some((x) => x.startsWith("EnvironmentFile=") && x.includes("credentials")));
});

test("sysusers files declare the two system users", () => {
  assert.match(read("sysusers/servitals.conf"), /^u _servitals - "servitals hub" \/var\/lib\/servitals$/m);
  assert.match(read("sysusers/servitals-agent.conf"), /^u _servitals-agent - "servitals agent" \/var\/lib\/servitals-agent$/m);
});

test("default env files", () => {
  assert.match(read("etc/hub.env"), /^PORT=20002$/m);
  assert.match(read("etc/hub.env"), /^# AUTH_PASS_HASH=/m);
  assert.match(read("etc/agent.env"), /^INTERVAL=60$/m);
});

test("install-local.sh parses", () => {
  const r = spawnSync("bash", ["-n", path.join(P, "install-local.sh")], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
});
```

Run: `node --test test/packaging.test.js`
Expected: FAIL: `ENOENT ... packaging/systemd/servitals.service`.

- [ ] **Step 2: Write the units**

`packaging/systemd/servitals.service`:

```ini
# SPDX-License-Identifier: AGPL-3.0-or-later
[Unit]
Description=servitals dashboard hub
Documentation=https://github.com/shri-studio/servitals
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=_servitals
Group=_servitals
EnvironmentFile=/etc/servitals/hub.env
Environment=WWW_DIR=/usr/share/servitals/www
ExecStart=/usr/bin/node /usr/share/servitals/hub/server.js
StateDirectory=servitals
StateDirectoryMode=0750
ReadWritePaths=/var/lib/servitals
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`packaging/systemd/servitals-agent.service`:

```ini
# SPDX-License-Identifier: AGPL-3.0-or-later
[Unit]
Description=servitals agent (metrics collector)
Documentation=https://github.com/shri-studio/servitals
After=network-online.target servitals.service
Wants=network-online.target
# not paired yet: stay down instead of crash-looping (the installer or `join` starts it)
ConditionPathExists=/etc/servitals/agent-credentials.env

[Service]
Type=simple
User=_servitals-agent
Group=_servitals-agent
EnvironmentFile=/etc/servitals/agent.env
Environment=HOST_ROOT=/
Environment=CREDENTIALS_FILE=/etc/servitals/agent-credentials.env
ExecStart=/usr/bin/servitals-agent run
StateDirectory=servitals-agent
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Write the sysusers and env files**

`packaging/sysusers/servitals.conf`:

```
# SPDX-License-Identifier: AGPL-3.0-or-later
u _servitals - "servitals hub" /var/lib/servitals
```

`packaging/sysusers/servitals-agent.conf`:

```
# SPDX-License-Identifier: AGPL-3.0-or-later
u _servitals-agent - "servitals agent" /var/lib/servitals-agent
```

`packaging/etc/hub.env`:

```sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals hub settings. After editing: sudo systemctl restart servitals
PORT=20002
# empty = all addresses; 127.0.0.1 when only a local tunnel or proxy should connect
BIND_ADDR=
AUTH_USER=admin
# servitals-ctl hash-password prints this value
# AUTH_PASS_HASH=scrypt:...
# proxy headers are trusted only from these peers (a tunnel on this host connects from loopback)
TRUSTED_PROXIES=127.0.0.1,::1
PROXY_HEADER=x-forwarded-for
# https://dash.example.org when a proxy serves the dashboard under another origin
PUBLIC_URL=
MAX_FAILS=3
BAN_HOURS=0
SESSION_HOURS=720
# container controls: 1 = whitelisted (LAN) clients only, 0 = any logged-in user
CTL_LAN_ONLY=1
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

`packaging/etc/agent.env`:

```sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent settings. After editing: sudo systemctl restart servitals-agent
# heartbeat in seconds (5..3600); the hub wakes the agent sooner when someone looks
INTERVAL=60
# mountpoints to report, comma separated
DISKS=/
# network interface for the network panel; empty = the first one vnStat knows
NET_IFACE=
# metric groups: 0 turns one off
COLLECT_MEM=1
COLLECT_CPU=1
COLLECT_TEMP=1
COLLECT_DISKS=1
COLLECT_NET=1
COLLECT_DOCKER=1
# seconds before a statvfs on a dead network share is given up
STAT_TIMEOUT=5
# long-poll hold (5..55); lower it when a proxy or firewall cuts idle connections
WAIT_SECONDS=55
# outbound proxy for a remote hub; the local hub is never proxied
# HTTPS_PROXY=http://proxy.example:3128
# NO_PROXY=
LOG_LEVEL=info
```

- [ ] **Step 4: Write `packaging/install-local.sh`**

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Install servitals from this checkout as native systemd services, in the
# layout the Ubuntu packages use. For development, and for hosts that run
# from a checkout until the PPA exists.
#   sudo packaging/install-local.sh               install or upgrade
#   sudo packaging/install-local.sh --uninstall   remove programs and units;
#                                                 keeps /etc/servitals, state and users
# First install only: HUB_PORT (default 20002) and ADMIN_USER (default admin)
# go into /etc/servitals/hub.env; the admin password comes from ADMIN_PASSWORD
# or is asked for on the terminal. Later runs never change /etc/servitals.
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SHARE=/usr/share/servitals
AGENT_LIB=/usr/lib/servitals-agent
ETC=/etc/servitals
UNITS=/etc/systemd/system

die() { echo "install-local: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root: sudo $0"

if [ "${1:-}" = --uninstall ]; then
  systemctl disable --now servitals-agent.service servitals.service 2>/dev/null || true
  rm -rf "$SHARE" "$AGENT_LIB" "$UNITS/servitals.service.d" "$UNITS/servitals-agent.service.d"
  rm -f "$UNITS/servitals.service" "$UNITS/servitals-agent.service" \
        /usr/bin/servitals-ctl /usr/bin/servitals-agent \
        /usr/lib/sysusers.d/servitals.conf /usr/lib/sysusers.d/servitals-agent.conf
  systemctl daemon-reload
  echo "removed. kept: $ETC, /var/lib/servitals, /var/lib/servitals-agent and the system users"
  exit 0
fi

# 1. requirements
[ -x /usr/bin/node ] || die "needs Node.js 18 or newer at /usr/bin/node: apt install nodejs"
major=$(/usr/bin/node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || die "Node.js $major is too old, need 18 or newer"
for t in jq curl timeout sha256sum systemd-sysusers; do
  command -v "$t" >/dev/null || die "missing $t (apt install jq curl coreutils systemd)"
done

# 2. programs (replaced whole, so files removed upstream do not linger)
rm -rf "$SHARE/hub" "$SHARE/www" "$AGENT_LIB"
install -d -m 755 "$SHARE/hub/lib" "$SHARE/www" "$AGENT_LIB/lib"
install -m 644 "$SRC/hub/server.js" "$SHARE/hub/"
install -m 644 "$SRC"/hub/lib/*.js "$SHARE/hub/lib/"
install -m 644 "$SRC/VERSION" "$SHARE/VERSION"
# shipped web files only, never a Docker install's config.json or data.json
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
chmod -R u=rwX,go=rX "$SHARE/www/fonts"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
install -m 644 "$SRC/VERSION" "$AGENT_LIB/VERSION"
install -m 755 "$SRC/bin/servitals-ctl" "$SRC/bin/servitals-agent" /usr/bin/

# 3. system users
install -m 644 "$SRC/packaging/sysusers/servitals.conf" "$SRC/packaging/sysusers/servitals-agent.conf" /usr/lib/sysusers.d/
systemd-sysusers /usr/lib/sysusers.d/servitals.conf /usr/lib/sysusers.d/servitals-agent.conf

# 4. configuration, first install only
install -d -m 755 "$ETC"
if [ ! -e "$ETC/hub.env" ]; then
  echo "admin password for the dashboard (at least 8 characters):"
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    hash=$(printf '%s\n' "$ADMIN_PASSWORD" | /usr/bin/servitals-ctl hash-password)
  else
    hash=$(/usr/bin/servitals-ctl hash-password < /dev/tty)
  fi
  [[ $hash == scrypt:* ]] || die "could not hash the password"
  sed -e "s/^PORT=.*/PORT=${HUB_PORT:-20002}/" \
      -e "s/^AUTH_USER=.*/AUTH_USER=${ADMIN_USER:-admin}/" \
      -e "s|^# AUTH_PASS_HASH=.*|AUTH_PASS_HASH=$hash|" \
      "$SRC/packaging/etc/hub.env" > "$ETC/hub.env"
  chmod 600 "$ETC/hub.env"
fi
[ -e "$ETC/agent.env" ] || install -m 644 "$SRC/packaging/etc/agent.env" "$ETC/agent.env"

# 5. units
install -m 644 "$SRC/packaging/systemd/servitals.service" "$SRC/packaging/systemd/servitals-agent.service" "$UNITS/"
systemctl daemon-reload
systemctl enable servitals.service servitals-agent.service
systemctl restart servitals.service

# 6. pair the local agent, first install only: the hub wrote its credentials on start
port=$(sed -n 's/^PORT=//p' "$ETC/hub.env" | tail -n 1)
port=${port:-20002}
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/__auth/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$port/__auth/health" >/dev/null || die "hub not healthy: journalctl -u servitals"
if [ ! -e "$ETC/agent-credentials.env" ]; then
  install -m 600 -o _servitals-agent -g _servitals-agent /var/lib/servitals/local-agent.env "$ETC/agent-credentials.env"
fi
systemctl restart servitals-agent.service

echo "servitals is running: http://$(hostname):$port/"
echo "container list in the dashboard: sudo servitals-agent docker enable   (root-equivalent, see README)"
echo "container controls:              sudo servitals-ctl docker enable"
```

Run `chmod +x packaging/install-local.sh`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 6: Check the units with systemd's own linter**

Run: `systemd-analyze verify packaging/systemd/servitals.service packaging/systemd/servitals-agent.service 2>&1 | grep -v -e 'is not executable' -e 'No such file' -e 'Unit configuration has fatal error' || true`
Expected: no remaining lines. (The filtered messages only say `/usr/bin/node` and `/usr/bin/servitals-agent` are not installed yet; any other message is a real error in a unit file, fix it.)

- [ ] **Step 7: Commit**

```bash
git add packaging/ test/packaging.test.js
git commit -m "feat(packaging): hardened systemd units, system users, install script" -m "Units carry the spec 13.2 hardening set. install-local.sh installs a checkout in the package layout, creates hub.env with a hashed admin password on first install, and pairs the local agent from the hub's local-agent.env."
```

---

### Task 13: Documentation, changelog, CI

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: user docs for the native install and the new refresh flow; CI that lints the new shell files at warning level.

- [ ] **Step 1: README**

In `README.md`:

1. In the component table, replace the `agent` row

   ```markdown
   | `agent` | `alpine` + bash | reads host metrics and writes `www/data.json` on the `.refresh` trigger (the dashboard drops it while open) or, idle, every `INTERVAL` seconds |
   ```

   with

   ```markdown
   | `agent` | `alpine` + bash | reads host metrics and pushes a snapshot to the gateway over the signed agent API every `INTERVAL` seconds (default 60), and at once when the dashboard asks for fresh data |
   ```
2. Replace the paragraph that starts `**Refresh — demand-driven.**` with:

   ```markdown
   **Refresh — demand-driven.** The agent keeps one signed long-poll request
   open to the gateway (`GET /api/v1/agent/wait`). When the dashboard asks for
   fresh data (on load, every `refreshSec` while the tab is visible, or `r`),
   the gateway answers that request and the agent samples and pushes within
   about two seconds. A refresh within 5 s of the last push is answered from
   the latest snapshot. With no viewer the agent pushes every `INTERVAL`
   seconds (default 60). The live network rate is an average over whichever
   gap produced the latest snapshot.
   ```

3. Add a section `## Native install (systemd, no Docker)` after the Docker install section:

   ````markdown
   ## Native install (systemd, no Docker)

   Until the Ubuntu packages exist, install from a checkout. The layout,
   users and units are the ones the packages will use.

   ```bash
   sudo apt install nodejs jq curl vnstat
   git clone https://github.com/shri-studio/servitals && cd servitals
   sudo packaging/install-local.sh          # asks for the admin password
   ```

   | what | where |
   | --- | --- |
   | hub settings | `/etc/servitals/hub.env` (then `sudo systemctl restart servitals`) |
   | agent settings | `/etc/servitals/agent.env` (then `sudo systemctl restart servitals-agent`) |
   | hub state | `/var/lib/servitals` |
   | logs | `journalctl -u servitals -u servitals-agent` |
   | one sample, printed | `servitals-agent test` |

   Containers: the agent needs the Docker socket to list them and the hub
   needs it for the restart/stop/logs buttons. **The `docker` group can take
   over the host as root**, so both are off until you turn them on:
   `sudo servitals-agent docker enable`, `sudo servitals-ctl docker enable`.

   Upgrade: `git pull && sudo packaging/install-local.sh`.
   Remove: `sudo packaging/install-local.sh --uninstall` (keeps settings and state).
   ````

4. In the Docker install section, add after the first `docker compose up` instructions:

   ```markdown
   **Upgrading an existing Docker install:** copy the `agent` service and the
   `volumes:` block from `docker-compose.example.yml` into your
   `docker-compose.yml`, remove `REFRESH_FILE` from the gateway, then
   `docker compose up -d --build`. The gateway moves `www/config.json` into
   `data/` on its first start.
   ```

5. Settings now live in the state directory. Make these exact replacements (each find and replace text sits between double backticks):

   - ``Proxies authed traffic to `web`. Serves `/__ctl/*` (refresh trigger + LAN-only`` → ``Proxies authed traffic to `web`; answers `/data.json` and `/config.json` itself and takes the agent's signed pushes on `/api/v1/agent/*`. Serves `/__ctl/*` (refresh + LAN-only``
   - ``serve `www/` (the static page + `data.json`); internal only`` → ``serve `www/` (the static page and fonts); internal only``
   - ``(all of this is also editable live in the settings panel later).`` → ``(all of this is also editable live in the settings panel later). On its first start the gateway copies this file to `data/config.json`; from then on the settings panel writes `data/config.json`, and later edits to `www/config.json` are ignored.``
   - ``**Save** writes `www/config.json` via the auth gateway`` → ``**Save** writes `data/config.json` (native install: `/var/lib/servitals/config.json`) via the gateway``
   - `` `www/config.json` is git-ignored; ship-time defaults live in`` → `` `data/` is git-ignored; example settings live in``

   In the layout tree: under `hub/` change the `lib/` comment to `# log, password, clientip, origin, static, fsutil, agentsig, nodes, agentapi`; under `agent/` change `collect.sh          # the whole agent` to `collect.sh          # the agent loop` and add a line `│   └── lib/                # one file per metric group, plus log, hmac, api`; under `bin/` add `servitals-agent     # run · test · docker enable|disable`; add `├── packaging/              # systemd units, sysusers, default env files, install-local.sh`; change the `data/` comment to `# bans, whitelist, secret, audit.log, config.json, nodes.json, local-agent.env, snapshots/ (gitignored)`; delete the `data.json           # generated by the agent (gitignored)` line under `www/`.

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` in `CHANGELOG.md` add:

```markdown
### Added
- Native install without Docker: hardened systemd units, `_servitals` and
  `_servitals-agent` system users, `/etc/servitals/*.env`, and
  `packaging/install-local.sh`.
- The gateway serves the page itself when `UPSTREAM` is unset.
- Agent protocol v1: the agent pushes signed snapshots to
  `/api/v1/agent/push` and waits on `/api/v1/agent/wait`; the dashboard's
  refresh wakes it.
- `servitals-agent` CLI (`run`, `test`, `docker enable|disable`) and
  `servitals-ctl docker enable|disable`.
- Metric groups can be turned off with `COLLECT_<GROUP>=0`.

### Changed
- State lives in `STATE_DIR` (`/var/lib/servitals` natively, `./data` in
  Docker); `config.json` moves there from `www/`.
- The agent lists containers through the Docker API with `curl` and reads
  their CPU from cgroup counters (no Docker CLI, no `docker stats`).
- Default agent heartbeat is 60 s (was 300 s).

### Fixed
- A cifs share mounted over autofs was reported as autofs.
- A dead network share in `DISKS` could hang the agent.
- `DISKS` entries that are not mounted repeated the parent filesystem;
  they now show "not mounted".
```

- [ ] **Step 3: CI**

In `.github/workflows/ci.yml`:

- Replace the shellcheck step with:

  ```yaml
        - name: shellcheck
          run: |
            shellcheck -S warning agent/collect.sh agent/lib/*.sh bin/servitals-agent packaging/install-local.sh
            shellcheck -S error bin/servitals-ctl bin/bans bin/unban bin/whitelist test/budget.sh test/compose-smoke.sh
  ```

- In the `test` job's "Install agent tools" step install `jq curl`.

- [ ] **Step 4: Run everything locally**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/compose-smoke.sh`
Expected: all pass. `shellcheck` is not installed on this host; CI runs it (Step 6).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md .github/workflows/ci.yml
git commit -m "docs: native install, demand-driven refresh over the agent API; CI lints the agent at warning level"
```

- [ ] **Step 6: Push the branch and read CI (ask the user first)**

Ask the user before pushing. Then: `git push -u origin feat/native-mode` and `gh run watch` (or `gh run list --branch feat/native-mode`).
Expected: lint, test (Node 18 and 22), budget and compose jobs green. For a shellcheck finding in `agent/`, fix the code; disable a check only with a comment that gives the reason. Commit fixes as `fix(agent): shellcheck findings`.

---

### Task 14: Run both units on this host (spec section 20, row 2 "done when")

Native runs **next to** the live Docker install, on port 20012. Nothing in the main checkout changes.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` (section 22, first bullet), `.wolf/STATUS.md` (via `/handoff`)

**Interfaces:**
- Consumes: the whole branch.
- Produces: a verified native install on this host and a recorded result.

- [ ] **Step 1: Install (user, root)**

Ask the user to run in a normal terminal, from the worktree:

```bash
sudo apt install nodejs          # resolute: 22.x; nvm's node is not visible to system units
cd ~/projects/servitals/.claude/worktrees/servitals-native
sudo HUB_PORT=20012 packaging/install-local.sh
sudo sed -i -e 's|^DISKS=.*|DISKS=/,/srv,/mnt/elements,/mnt/router-usb|' -e 's|^NET_IFACE=.*|NET_IFACE=eno1|' /etc/servitals/agent.env
sudo servitals-agent docker enable
sudo systemctl restart servitals-agent
```

- [ ] **Step 2: Verify the services (Claude, no root needed)**

Run:

```bash
systemctl is-active servitals servitals-agent
curl -fsS http://127.0.0.1:20012/__auth/health; echo
journalctl -u servitals -u servitals-agent --since "-10 min" --no-pager | grep -E 'server.start|api.first_push|agent.start|agent.hub|level=(warn|error)'
```

Expected: `active` twice, `ok`, one `server.start` with `upstream=static:/usr/share/servitals/www`, `api.first_push`, `agent.start ... mode=push`, `agent.hub url=http://127.0.0.1:20012`, and no `level=warn` or `level=error` lines after the Docker enable restart.

- [ ] **Step 3: Verify the hardening took effect**

Run: `systemd-analyze security servitals.service servitals-agent.service --no-pager | tail -n 3`
Expected: an overall exposure level for each (record both numbers). Then run `systemctl show servitals-agent -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p SupplementaryGroups` and check the values match the unit plus `SupplementaryGroups=docker`.

- [ ] **Step 4: Verify the data in the browser (user)**

Ask the user to open `http://<this host>:20012/`, log in with the password chosen in Step 1, and check:
- all four disks show, `/mnt/router-usb` as `cifs` (not `autofs`);
- the network panel shows `eno1` with vnStat history;
- containers are listed; on the first view the CPU column may show `–`, and a number after the next refresh;
- pressing `r` updates the "updated" age within about 2 seconds;
- `/__ctl/whoami` shows the version and `lan: true` from the LAN.

- [ ] **Step 5: Budget on the real units**

Run:

```bash
for u in servitals servitals-agent; do pid=$(systemctl show -p MainPID --value $u); echo "$u RssAnon $(awk '/^RssAnon:/ {print $2}' /proc/$pid/status) kB"; done
systemctl show servitals-agent -p MemoryPeak
```

Expected: hub `RssAnon` ≤ 40960 kB; agent `MemoryPeak` recorded (the whole cgroup, including the long-poll `curl` and page cache, so it is larger than the per-tick `RssAnon` budget in spec 18; record it for information).

- [ ] **Step 6: Record the result**

In the spec, section 22, replace the first bullet

```markdown
- A system-unit run of the agent with the full hardening set (only the user
  manager was tested).
```

with

```markdown
- ~~A system-unit run of the agent with the full hardening set~~ Verified
  <date> on the development host (resolute): both units active with the 13.2
  set; `systemd-analyze security` exposure hub <n>, agent <n>.
```

Commit: `git commit -am "docs(spec): system-unit run verified on the development host"`.

- [ ] **Step 7: Finish the branch**

Use superpowers:finishing-a-development-branch (merge to `main` or open a PR, as the user chooses). Then run `/handoff` to regenerate `.wolf/STATUS.md` with: sub-project 2 done, native side by side on 20012, the cutover as the next optional step, sub-project 3 (packaging) next.

- [ ] **Step 8: Cutover from Docker to native (only when the user asks)**

This changes the live dashboard. List the steps for the user, run nothing without an explicit go-ahead:

1. Check the tunnel target first: in the Cloudflare Zero Trust dashboard, the public hostname `dash.shri.life` must point at `http://localhost:20002` or `http://127.0.0.1:20002`. A LAN address there would make the tunnel's connections look like LAN clients to the native hub (loopback is the only trusted proxy by default).
2. Copy the settings: `sudo install -m 600 -o _servitals -g _servitals ~/projects/servitals/data/config.json /var/lib/servitals/config.json`, and the same for `whitelist.txt` if it has custom entries.
3. Stop Docker: `cd ~/projects/servitals && docker compose down` (the `data/` and `www/` folders stay).
4. Move native to the old port, in this order (the hub rewrites `local-agent.env` with the new port when it starts):

   ```bash
   sudo sed -i 's/^PORT=.*/PORT=20002/' /etc/servitals/hub.env
   sudo systemctl restart servitals
   sudo install -m 600 -o _servitals-agent -g _servitals-agent /var/lib/servitals/local-agent.env /etc/servitals/agent-credentials.env
   sudo systemctl restart servitals-agent
   ```

   The live `.env` has `CTL_LAN_ONLY=0`; the native default is `1` (container controls for LAN clients only). Keep `1` unless the user says otherwise.
5. Verify through the tunnel: `/__ctl/whoami` from outside shows your public IP and `lan: false`.
6. Rollback: `sudo systemctl stop servitals-agent servitals && sudo sed -i 's/^PORT=.*/PORT=20012/' /etc/servitals/hub.env && cd ~/projects/servitals && docker compose up -d`. Before starting native again, repeat the `install` line from item 4 so the agent's `HUB_URL` matches the port.
