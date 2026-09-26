# servitals Debian Packaging and PPA (sub-project 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apt install servitals` from a Launchpad PPA on Ubuntu 24.04 (noble) and 26.04 (resolute): two packages with hardened units, a random first password, the local agent paired by the package, man pages, lintian clean, autopkgtest passing, and a login that can be changed from the command line or the dashboard.

**Architecture:** The admin login moves to `STATE_DIR/admin.json` (`hub/lib/admin.js`), which wins over `AUTH_*` in the environment and carries a generation number that ends sessions when it changes. `servitals-ctl passwd` and a new `POST /__ctl/account` (Settings → login) write it. `hub/lib/bootstrap.js` is the package's first-run step (admin.json, local node, `local-agent.env`), called by `debian/servitals.postinst`. `debian/` becomes the only home of the systemd units and sysusers files (tightened to a systemd exposure score ≤ 2.0) and `packaging/install-local.sh` installs those same files. Container scripts build the packages (`packaging/build-deb.sh`), run the autopkgtests on a booted systemd testbed in Docker (`packaging/autopkgtest.sh`), and build per-series PPA source uploads (`packaging/ppa-upload.sh`).

**Tech Stack:** Node.js ≥ 18 (built-ins), bash, debhelper 13 (`dh-sequence-installsysusers`, `dh_installsystemd`), lintian, autopkgtest 5.55 with `autopkgtest-virt-docker --init`, Docker, devscripts/dput (upload host only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` sections 2, 5.1 (admin.json), 6.1 (postinst pairs the local agent), 12, 13 (13.1-13.5), 16, 17 (`passwd`), 18 (`.deb` ≤ 500 KB), 20 row 3, 22.

**Proven before writing:** every file below was built and run in a scratch copy on 2026-09-26: both series built, lintian `-EvIL +pedantic` gave no errors or warnings, `.deb` sizes 127 KB and 18 KB, autopkgtest `smoke` and `purge` passed on noble and resolute with systemd running (exposure 1.4 hub, 1.5 agent), a Launchpad-style build from the source package worked, the install-local → package migration test passed, and the node suite passed (133 tests).

## Global Constraints

- Zero runtime dependencies beyond the spec's package `Depends`: `servitals`: `${misc:Depends}, nodejs (>= 18), jq, servitals-agent (= ${source:Version})`; `servitals-agent`: `${misc:Depends}, jq, curl`; Recommends `vnstat`; Suggests `apprise`. `bash`, `coreutils` and `awk` are Essential and are not listed (lintian error otherwise).
- Every Node file works on Node 18 (noble) and 22 (resolute); no `fetch` in `hub/` or `test/`.
- New source files start with `SPDX-License-Identifier: AGPL-3.0-or-later` (after the shebang). Files in `debian/` that allow comments carry it too.
- Package facts: source `servitals`, `3.0 (quilt)`, `debhelper-compat (= 13)`, `Standards-Version: 4.6.2` (noble's lintian warns about newer; resolute only notes older), `Section: admin`, `Priority: optional`, both packages `Architecture: all`. Maintainer `Rishabha Garg <rishabha.garg06@gmail.com>` (the git identity).
- Paths: `/usr/share/servitals/{hub,www,VERSION}`, `/usr/lib/servitals-agent/`, `/usr/bin/servitals-ctl`, `/usr/bin/servitals-agent`, units in `/usr/lib/systemd/system/`, `/etc/servitals/{hub.env,agent.env}` (conffiles), `/etc/servitals/agent-credentials.env` (state, 0600), `/var/lib/servitals/{admin.json,initial-password,...}` (0600), users `_servitals`, `_servitals-agent`, port 20002.
- Versions (spec 16): upstream from `VERSION`; Debian `<upstream>-1` where a `-` in `VERSION` becomes `~` (`0.1.0-dev` → `0.1.0~dev-1`); PPA `<debian>~ppa<N>~<series>1`.
- lintian `-EvIL +pedantic`: no `E:` or `W:` lines on either series; every override in `debian/*.lintian-overrides` has a reason comment. Each `.deb` ≤ 512000 bytes.
- `systemd-analyze security` exposure ≤ 2.0 for both units (checked by `debian/tests/smoke`).
- No network at package build time; no `npm`. The GPG key never enters the repository or CI; uploads run on the maintainer's host.
- Docker Hub may time out on this host: run the scripts with `IMAGE_PREFIX=mirror.gcr.io/library/`. CI uses Docker Hub directly.
- The live dashboard is the native install on this host (port 20002). Never run `install-local.sh`, `apt` or `systemctl` against it outside Task 11; all tests run in containers.
- Work in the worktree `.claude/worktrees/servitals-packaging` (branch `feat/packaging`, already created from `main` at de23ff9).
- `sudo` does not work from Claude's `!` prompt; the plan marks root steps **(user, root)**.
- OpenWolf: `openwolf bug search` before fixing a bug, log fixed bugs in `.wolf/buglog.json`; never edit `.wolf/anatomy.md` or `.wolf/memory.md`.
- Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Scope decisions

- **Upload from the maintainer's host, not CI.** Spec 16 wants tag-triggered signed uploads from CI. That needs the GPG key as a CI secret; this plan keeps the key on the host (`packaging/ppa-upload.sh`) and runs only a dry-run source build in CI. Moving the upload into CI is a later, separate decision.
- **No debconf, no admin-name prompt in the package** (spec 13.3). The first login is `admin` with a random password in `/var/lib/servitals/initial-password`; the name is changed with `servitals-ctl passwd --user` or Settings → login.
- **autopkgtest covers what exists today.** Spec 13.4 also lists "pair a second agent" (sub-project 4) and "a test alert" (sub-project 6); those tests join with their features.
- **Fonts:** the Press Start 2P Reserved Font Name question (spec 22) matters for a Debian upload, not for a PPA; it stays open.
- **The hub's Docker access stays opt-in** (`servitals-ctl docker enable`); the package does not add `_servitals` to the docker group.

## Review Focus

1. **Moving a live host from `install-local.sh` to the package** (this host, Task 11): the login in `hub.env`, the local node and the agent's credentials must survive; the admin must not get a conffile prompt for the `hub.env` it already has; no stale unit in `/etc/systemd/system` may shadow the package's. Test: Task 8, `test/deb-migrate.sh`.
2. **A wrong current password on Settings → login** is a password guess: it must count toward the lockout like a failed login (for clients that are not whitelisted) and be audited. Test: Task 2, "changing the login needs the current password and ends other sessions".
3. **A hand-edited `admin.json` that does not parse** must not silently fall back to the environment's (possibly old) password: the hub refuses to start, and at run time keeps the last good copy. Tests: Task 1, "a broken admin.json stops the gateway", "the admin store refuses records...".
4. **Purge** removes the hub's secrets (`admin.json`, `initial-password`, node secrets) and the agent credentials only when they point at this host's hub; an agent paired with another hub keeps working until the agent itself is purged. Test: Task 7, `debian/tests/purge`.
5. **Tighter hardening must not break real work**: the agent still reads `/proc`, `/sys` and mountinfo and pushes; the hub still serves and writes its state. Tests: Task 7, `debian/tests/smoke` (booted systemd testbed). Docker socket access and the cifs share are checked on this host in Task 11.

## File map

| path | status | responsibility |
| --- | --- | --- |
| `hub/lib/admin.js` | new | admin.json store: validate, load by mtime, save 0600 |
| `hub/lib/bootstrap.js` | new | package first run: admin.json + initial-password, local node, local-agent.env |
| `hub/server.js` | modified | login from admin.json or env, session generation, `/__ctl/account`, `user` in whoami |
| `www/index.html` | modified | Settings → login section |
| `bin/servitals-ctl` | modified | `passwd [--user NAME]` |
| `debian/` | new | control, rules, changelog, copyright, source/format, watch, `*.install`, `*.manpages`, units, sysusers, postinst/postrm, lintian overrides, `tests/` |
| `packaging/systemd/`, `packaging/sysusers/` | removed | moved to `debian/servitals{,-agent}.{service,sysusers}` |
| `packaging/install-local.sh` | modified | installs the units and sysusers from `debian/` |
| `man/servitals.8`, `man/servitals-ctl.1`, `man/servitals-agent.1` | new | man pages |
| `packaging/series.sh`, `packaging/build-deb.sh`, `packaging/autopkgtest.sh`, `packaging/ppa-upload.sh`, `packaging/docker/{build,autopkgtest,source}-in.sh` | new | container build, test and PPA scripts |
| `test/admin.test.js`, `test/bootstrap.test.js`, `test/deb-migrate.sh` | new | tests |
| `test/hub.test.js`, `test/cli.test.js`, `test/page.test.js`, `test/packaging.test.js`, `test/version.test.js` | modified | tests |
| `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `CHANGELOG.md`, `docs/release.md`, `VERSION` | modified/new | CI job `deb`, docs, release |

---
### Task 1: Admin login in `admin.json`, sessions tied to it

**Files:**
- Create: `hub/lib/admin.js`, `test/admin.test.js`
- Modify: `hub/server.js` (requires, startup checks, `creds()`, cookies, `checkPass`, whoami, `server.start` log), `test/hub.test.js` (whoami now also returns `user`)

**Interfaces:**
- Produces: `createAdminStore(file) → { load() → {user, hash, gen}|null, save({user, hash, gen}), isBroken() → boolean }`, `validAdmin(obj) → boolean`, `USER_RE = /^[A-Za-z0-9._-]{1,64}$/` from `hub/lib/admin.js`. In `server.js`: `creds()` returns the admin.json login or `{ user: AUTH_USER, hash: AUTH_PASS_HASH, plain: AUTH_PASS, gen: 0 }`; session payload `{ u, g, exp }`; `GET /__ctl/whoami` adds `user`. Tasks 2, 3 and 4 write admin.json in this format; `gen` rises on every change.

- [ ] **Step 1: Write the failing tests**

Create `test/admin.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startHub, runHubUntilExit, request, login, cookieFrom, ctlPost } = require("./helpers/hub");
const { createAdminStore } = require("../hub/lib/admin");
const { hashPassword, verifyPassword } = require("../hub/lib/password");

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-admin-"));
async function adminFile(dir, user, password, gen = 0) {
  fs.writeFileSync(path.join(dir, "admin.json"), JSON.stringify({ user, hash: await hashPassword(password), gen }), { mode: 0o600 });
}
const whoami = (port, cookie) => request(port, { path: "/__ctl/whoami", headers: { cookie } });
const account = (port, cookie, body) => ctlPost(port, cookie, "/__ctl/account", JSON.stringify(body));

test("the admin store refuses records without a scrypt hash or a sane name", async () => {
  const dir = tmpdir();
  const store = createAdminStore(path.join(dir, "admin.json"));
  assert.strictEqual(store.load(), null);
  const good = await hashPassword("x-long-enough");
  assert.throws(() => store.save({ user: "a b", hash: good, gen: 0 }));
  assert.throws(() => store.save({ user: "ok", hash: "0".repeat(64), gen: 0 }));
  store.save({ user: "ok", hash: await hashPassword("pw-123456"), gen: 2 });
  assert.strictEqual(store.load().gen, 2);
  assert.strictEqual(fs.statSync(path.join(dir, "admin.json")).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, "admin.json"), "{ not json");
  fs.utimesSync(path.join(dir, "admin.json"), new Date(), new Date(Date.now() + 5000));
  assert.strictEqual(store.load().user, "ok", "a bad edit keeps the last good copy");
  assert.strictEqual(store.isBroken(), true);
});

test("admin.json wins over the environment and needs no AUTH_PASS", async () => {
  const dir = tmpdir();
  await adminFile(dir, "owner", "file-pass-123");
  const hub = await startHub({ AUTH_PASS: "", STATE_DIR: dir });
  try {
    assert.strictEqual((await login(hub.port)).status, 401, "the environment's admin no longer works");
    const ok = await login(hub.port, { user: "owner", pass: "file-pass-123" });
    assert.strictEqual(ok.status, 302);
    const w = JSON.parse((await whoami(hub.port, cookieFrom(ok))).body);
    assert.strictEqual(w.user, "owner");
    assert.match(hub.logs(), /login=admin\.json/);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a broken admin.json stops the gateway", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "admin.json"), '{"user":"x"}');
  const r = await runHubUntilExit({ STATE_DIR: dir });
  assert.strictEqual(r.code, 1);
  assert.match(r.logs, /auth\.admin_unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

In `test/hub.test.js`, in the test "client identity follows the trusted-proxy rules", replace

```js
    const self = await whoami(hub, cookie); delete self.version;
```

with

```js
    const self = await whoami(hub, cookie); delete self.version; delete self.user;
```

and replace

```js
    delete spoof.version;
```

with

```js
    delete spoof.version; delete spoof.user;
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/admin.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/admin'`.

- [ ] **Step 3: Write `hub/lib/admin.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The admin login in STATE_DIR/admin.json: { "user", "hash", "gen" }. When the
 * file exists it wins over AUTH_USER / AUTH_PASS_HASH / AUTH_PASS from the
 * environment. Sessions carry `gen`; every change raises it, which ends every
 * other session. Re-read when the mtime changes (servitals-ctl passwd writes
 * it as root). A file that does not parse keeps the last good copy.
 */
const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");
const { describeHash } = require("./password");

const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validAdmin(a) {
  return !!a && typeof a === "object" && typeof a.user === "string" && USER_RE.test(a.user) &&
    describeHash(a.hash) === "scrypt" && Number.isInteger(a.gen) && a.gen >= 0;
}

function createAdminStore(file) {
  let cached = null;
  let mtime = -1;
  let broken = false;

  function load() {
    let st;
    try { st = fs.statSync(file); } catch (_) { cached = null; mtime = -1; broken = false; return null; }
    if (st.mtimeMs === mtime) return cached;
    mtime = st.mtimeMs;
    try {
      const a = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validAdmin(a)) throw new Error("invalid");
      cached = { user: a.user, hash: a.hash, gen: a.gen };
      broken = false;
    } catch (_) { broken = true; }
    return cached;
  }

  function save(a) {
    if (!validAdmin(a)) throw new Error("invalid admin record");
    writeFileAtomic(file, JSON.stringify({ user: a.user, hash: a.hash, gen: a.gen }, null, 2) + "\n", 0o600);
    mtime = -1;
  }

  return { load, save, isBroken: () => { load(); return broken; } };
}

module.exports = { createAdminStore, validAdmin, USER_RE };
```

- [ ] **Step 4: Read the login from admin.json in `hub/server.js`**

After `const { createAgentApi } = require("./lib/agentapi");` add:

```js
const { createAdminStore, USER_RE } = require("./lib/admin");
```

Replace

```js
if (!PASS && !PASS_HASH) {
  log.error("auth.no_password", { hint: "set AUTH_PASS_HASH (servitals-ctl hash-password) or AUTH_PASS" });
  process.exit(1);
}
if (PASS_HASH && describeHash(PASS_HASH) === "invalid") {
```

with

```js
/* ---------- admin login: STATE_DIR/admin.json wins over the environment ---------- */
const admin = createAdminStore(path.join(DATA, "admin.json"));
if (admin.isBroken() && !admin.load()) {
  log.error("auth.admin_unreadable", { file: path.join(DATA, "admin.json"), hint: "fix it or run servitals-ctl passwd" });
  process.exit(1);
}
const ADMIN_FILE_LOGIN = !!admin.load();
if (!ADMIN_FILE_LOGIN && !PASS && !PASS_HASH) {
  log.error("auth.no_password", { hint: "run servitals-ctl passwd, or set AUTH_PASS_HASH (servitals-ctl hash-password)" });
  process.exit(1);
}
if (!ADMIN_FILE_LOGIN && PASS_HASH && describeHash(PASS_HASH) === "invalid") {
```

Replace `if (PASS_HASH && describeHash(PASS_HASH) === "sha256") {` with `if (!ADMIN_FILE_LOGIN && PASS_HASH && describeHash(PASS_HASH) === "sha256") {`, and `if (!PASS_HASH) {` (the `auth.plain_password` warning) with `if (!ADMIN_FILE_LOGIN && !PASS_HASH) {`.

Replace the `makeCookie` and `validCookie` functions:

```js
function makeCookie() {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = Buffer.from(JSON.stringify({ u: USER, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function validCookie(c) {
  if (!c) return false;
  const [payload, mac] = c.split(".");
  if (!payload || !mac || !eq(mac, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); }
  catch { return false; }
}
```

with

```js
// the current login: admin.json when present, else the environment (gen 0)
function creds() {
  return admin.load() || { user: USER, hash: PASS_HASH, plain: PASS, gen: 0 };
}
// sessions name the user and the login generation: a new name or password ends them
function makeCookie() {
  const c = creds();
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = Buffer.from(JSON.stringify({ u: c.user, g: c.gen, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function validCookie(c) {
  if (!c) return false;
  const [payload, mac] = c.split(".");
  if (!payload || !mac || !eq(mac, sign(payload))) return false;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    const now = creds();
    return s.exp > Date.now() && s.u === now.user && (s.g || 0) === now.gen;
  } catch { return false; }
}
```

Replace `checkPass`:

```js
async function checkPass(u, p) {
  const userOk = eq(u, USER);
  const passOk = PASS_HASH ? await verifyPassword(p || "", PASS_HASH) : eq(p, PASS);
  return userOk && passOk;
}
```

with

```js
async function checkPass(u, p) {
  const c = creds();
  const userOk = eq(u, c.user);
  const passOk = c.hash ? await verifyPassword(p || "", c.hash) : eq(p, c.plain);
  return userOk && passOk;
}
```

In the whoami handler replace `return json(200, { ip, lan: wl, controls: (!CTL_LAN_ONLY || wl), version: VERSION });` with `return json(200, { ip, lan: wl, controls: (!CTL_LAN_ONLY || wl), version: VERSION, user: creds().user });`.

In the `server.start` log replace `    user: USER, max_fails: MAX_FAILS,` with `    user: creds().user, login: ADMIN_FILE_LOGIN ? "admin.json" : "env", max_fails: MAX_FAILS,`.

- [ ] **Step 5: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS. Existing sessions made before this change (no `g`) stay valid while the login comes from the environment (`gen` 0).

- [ ] **Step 6: Commit**

```bash
git add hub/lib/admin.js hub/server.js test/admin.test.js test/hub.test.js
git commit -m "feat(hub): admin login in STATE_DIR/admin.json; sessions end when it changes" -m "admin.json ({user, hash, gen}) wins over AUTH_USER/AUTH_PASS_HASH/AUTH_PASS. Sessions carry the login generation, so a new name or password ends them. A broken admin.json stops the gateway instead of falling back to the environment; at run time the last good copy is kept. whoami returns the user name."
```

---

### Task 2: Change the login from the dashboard (`POST /__ctl/account`)

**Files:**
- Modify: `hub/server.js` (password require, account endpoint after whoami), `www/index.html` (Settings → login), `test/admin.test.js`, `test/page.test.js`

**Interfaces:**
- Consumes: `createAdminStore`, `USER_RE`, `creds()`, `makeCookie()`, `checkPass()`, `recordFail()` (Task 1 and existing code).
- Produces: `POST /__ctl/account` with JSON `{ current, user?, password? }` (session and same-Origin required, like every `/__ctl` POST): `200 {"ok": true, "user"}` plus a fresh `sv_session` cookie; `400` for a bad name, a password under 8 characters, or keeping an old sha256 password; `403` for a wrong current password (audited as `auth.account_denied`, counts toward the lockout unless whitelisted, 800 ms delay). Success is audited as `auth.account_changed` and raises `gen`.

- [ ] **Step 1: Write the failing tests**

Append to `test/admin.test.js`:

```js
test("changing the login needs the current password and ends other sessions", async () => {
  const hub = await startHub();
  try {
    const mine = cookieFrom(await login(hub.port));
    const other = cookieFrom(await login(hub.port));
    const wrong = await account(hub.port, mine, { current: "nope", user: "owner", password: "brand-new-pass" });
    assert.strictEqual(wrong.status, 403);
    assert.ok(!fs.existsSync(path.join(hub.dataDir, "admin.json")));
    const fails = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "fails.json"), "utf8"));
    assert.strictEqual(fails["127.0.0.1"].n, 1, "a wrong current password counts toward the lockout");
    assert.strictEqual((await account(hub.port, mine, { current: "correct horse battery", user: "a b" })).status, 400);
    assert.strictEqual((await account(hub.port, mine, { current: "correct horse battery", password: "short" })).status, 400);
    const ok = await account(hub.port, mine, { current: "correct horse battery", user: "owner", password: "brand-new-pass" });
    assert.strictEqual(ok.status, 200, ok.body);
    assert.deepStrictEqual(JSON.parse(ok.body), { ok: true, user: "owner" });
    const fresh = cookieFrom(ok);
    assert.strictEqual((await whoami(hub.port, fresh)).status, 200, "this browser stays logged in");
    assert.strictEqual((await whoami(hub.port, other)).status, 401, "other sessions end");
    assert.strictEqual((await whoami(hub.port, mine)).status, 401, "the old cookie ends too");
    assert.strictEqual((await login(hub.port, { user: "owner", pass: "brand-new-pass" })).status, 302);
    const saved = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "admin.json"), "utf8"));
    assert.strictEqual(saved.gen, 1);
    assert.strictEqual(await verifyPassword("brand-new-pass", saved.hash), true);
    assert.ok(!hub.logs().includes("brand-new-pass") && !hub.logs().includes("correct horse battery"));
    assert.match(hub.logs(), /auth\.account_changed/);
    assert.match(hub.logs(), /auth\.account_denied/);
  } finally { await hub.stop(); }
});

test("renaming alone keeps the password", async () => {
  const hub = await startHub();
  try {
    const c = cookieFrom(await login(hub.port));
    assert.strictEqual((await account(hub.port, c, { current: "correct horse battery", user: "renamed" })).status, 200);
    assert.strictEqual((await login(hub.port, { user: "renamed", pass: "correct horse battery" })).status, 302);
  } finally { await hub.stop(); }
});

test("an old sha256 login must pick a new password to move to admin.json", async () => {
  const legacy = require("node:crypto").createHash("sha256").update("legacy-pass-1").digest("hex");
  const hub = await startHub({ AUTH_PASS: "", AUTH_PASS_HASH: legacy });
  try {
    const c = cookieFrom(await login(hub.port, { pass: "legacy-pass-1" }));
    const r = await account(hub.port, c, { current: "legacy-pass-1", user: "admin2" });
    assert.strictEqual(r.status, 400);
    assert.match(JSON.parse(r.body).error, /new password/);
  } finally { await hub.stop(); }
});
```

Append to `test/page.test.js`:

```js
test("the settings panel has the login section wired up", () => {
  for (const id of ["acct-user", "acct-new", "acct-new2", "acct-current", "acct-save", "acct-msg"]) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /\$\("#acct-save"\)\.onclick = saveAccount;/);
  assert.match(HTML, /fetch\("\/__ctl\/account"/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/admin.test.js test/page.test.js`
Expected: FAIL: `/__ctl/account` answers `404 unknown control`; the page has no `#acct-user`.

- [ ] **Step 3: The endpoint**

In `hub/server.js` replace `const { verifyPassword, describeHash } = require("./lib/password");` with `const { verifyPassword, describeHash, hashPassword } = require("./lib/password");`.

Directly after the whoami handler (the `if (req.url === "/__ctl/whoami") { ... }` block), add:

```js
    // change the admin name and/or password: the current password is required;
    // every other session ends (the login generation goes up)
    if (req.method === "POST" && req.url === "/__ctl/account") {
      let body;
      try { body = JSON.parse(await readBodyN(req, 4096)); } catch { return json(400, { error: "invalid json" }); }
      const current = creds();
      const user = body && typeof body.user === "string" && body.user !== "" ? body.user : current.user;
      const password = body && typeof body.password === "string" ? body.password : "";
      if (!USER_RE.test(user)) return json(400, { error: "name: 1-64 letters, digits, dot, dash or underscore" });
      if (password !== "" && password.length < 8) return json(400, { error: "password: at least 8 characters" });
      if (!(await checkPass(current.user, body && typeof body.current === "string" ? body.current : ""))) {
        await new Promise((r) => setTimeout(r, 800));
        if (!wl) recordFail(ip);
        log.audit("auth.account_denied", { ip });
        return json(403, { error: "current password is wrong" });
      }
      if (!password && current.hash && describeHash(current.hash) !== "scrypt") {
        return json(400, { error: "choose a new password: the current one is stored in an old format" });
      }
      const hash = password ? await hashPassword(password) : (current.hash || await hashPassword(current.plain));
      try { admin.save({ user, hash, gen: current.gen + 1 }); }
      catch (e) { return json(500, { error: "could not save the login: " + (e.code || e.message) }); }
      log.audit("auth.account_changed", { ip, user, password_changed: password !== "" });
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
      });
      return res.end(JSON.stringify({ ok: true, user }));
    }
```

- [ ] **Step 4: Settings → login in the page**

In `www/index.html`:

1. After the refresh-interval section (`<input type="number" id="cfg-refresh" ...>` and its closing `</section>`), add:

```html
      <section>
        <label>login &mdash; name and password</label>
        <div class="addrow">
          <input type="text" id="acct-user" autocomplete="username" placeholder="name" style="max-width:160px">
          <input type="password" id="acct-new" autocomplete="new-password" placeholder="new password (blank: keep)">
          <input type="password" id="acct-new2" autocomplete="new-password" placeholder="again">
        </div>
        <div class="addrow">
          <input type="password" id="acct-current" autocomplete="current-password" placeholder="current password">
          <button id="acct-save">change login</button>
        </div>
        <div id="acct-msg" style="color:var(--dim);font-size:12px"></div>
      </section>
```

2. After `function closeSettings() { $("#overlay").classList.remove("open"); }` add:

```js

/* ------------------------------------------------------------------ login
   Name and password live in the hub (admin.json). Changing them needs the
   current password and logs out every other session. */
let whoUser = "";
async function saveAccount() {
  const msg = $("#acct-msg");
  const user = $("#acct-user").value.trim();
  const password = $("#acct-new").value;
  if (password !== $("#acct-new2").value) { msg.textContent = "the new passwords differ"; return; }
  let r, d;
  try {
    r = await fetch("/__ctl/account", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: $("#acct-current").value, user, password }),
    });
    d = await r.json();
  } catch (e) { msg.textContent = "could not reach the hub"; return; }
  if (!r.ok) { msg.textContent = d.error || "not saved"; return; }
  whoUser = d.user;
  ["#acct-current", "#acct-new", "#acct-new2"].forEach(sel => { $(sel).value = ""; });
  msg.textContent = `saved: log in as ${d.user} from now on; other sessions were logged out`;
}
```

3. In `openSettings()`, after `$("#export-wrap").classList.add("hidden");` add `$("#acct-user").value = whoUser;` and `$("#acct-msg").textContent = "";`.
4. In the boot code, after `ctlAllowed = !!w.controls;` add `whoUser = w.user || "";`.
5. After `$("#settings-close").onclick = closeSettings;` add `$("#acct-save").onclick = saveAccount;`.

- [ ] **Step 5: Run all tests and the budget**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS; first page load stays under 61440 bytes gzipped (about 21.3 KB).

- [ ] **Step 6: Commit**

```bash
git add hub/server.js www/index.html test/admin.test.js test/page.test.js
git commit -m "feat: change the admin name and password from Settings" -m "POST /__ctl/account needs the current password; a wrong one is audited and counts toward the lockout. A change raises the login generation, so every other session ends; this browser gets a new cookie."
```

---

### Task 3: `servitals-ctl passwd`

**Files:**
- Modify: `bin/servitals-ctl`, `test/cli.test.js`

**Interfaces:**
- Consumes: admin.json format (Task 1), `env_get` in `servitals-ctl`.
- Produces: `servitals-ctl passwd [--user NAME]`: reads the password twice from a terminal or one line from stdin (≥ 8 characters), writes `STATE_DIR/admin.json` (0600, owner of the state directory) with `gen` + 1, keeps the name when `--user` is absent (admin.json, then `hub.env` `AUTH_USER`, then `admin`), deletes `initial-password`.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.js`:

```js
test("servitals-ctl passwd writes admin.json and ends sessions", async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, "initial-password"), "old\n");
  const first = spawnSync("bash", [path.join(BIN, "servitals-ctl"), "passwd", "--user", "owner"],
    { env: { PATH: process.env.PATH, STATE_DIR: state }, input: "first-pass-1\n", encoding: "utf8" });
  assert.strictEqual(first.status, 0, first.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(state, "admin.json"), "utf8"));
  assert.strictEqual(a.user, "owner");
  assert.strictEqual(a.gen, 1);
  assert.strictEqual(await verifyPassword("first-pass-1", a.hash), true);
  assert.strictEqual(fs.statSync(path.join(state, "admin.json")).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(state, "initial-password")), "the first password is gone");
  const second = spawnSync("bash", [path.join(BIN, "servitals-ctl"), "passwd"],
    { env: { PATH: process.env.PATH, STATE_DIR: state }, input: "second-pass-2\n", encoding: "utf8" });
  assert.strictEqual(second.status, 0, second.stderr);
  const b = JSON.parse(fs.readFileSync(path.join(state, "admin.json"), "utf8"));
  assert.deepStrictEqual([b.user, b.gen], ["owner", 2], "keeps the name, raises the generation");
  for (const [args, input] of [[["passwd", "--user", "bad name"], "long-enough-1\n"], [["passwd"], "short\n"]]) {
    const r = spawnSync("bash", [path.join(BIN, "servitals-ctl"), ...args],
      { env: { PATH: process.env.PATH, STATE_DIR: state }, input, encoding: "utf8" });
    assert.notStrictEqual(r.status, 0, args.join(" "));
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/cli.test.js`
Expected: FAIL: `passwd` prints the usage text and exits 1.

- [ ] **Step 3: Add the command**

In `bin/servitals-ctl`, after the header line `#   servitals-ctl import-docker <dir>  copy settings, login and disks from a Docker install` add:

```bash
#   servitals-ctl passwd [--user NAME] set the admin password (and name); ends every session
```

and change the usage line to `  *) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;`.

Before the final `case "${1:-}" in`, add:

```bash
cmd_passwd() {  # [--user NAME]
  local user="" pw pw2 hash gen f="$DATA_DIR/admin.json" tmp
  while [ $# -gt 0 ]; do
    case "$1" in
      --user) user=${2:-}; shift 2 ;;
      *) die "usage: servitals-ctl passwd [--user NAME]" ;;
    esac
  done
  [ -d "$DATA_DIR" ] || die "state directory $DATA_DIR does not exist"
  if [ -z "$user" ]; then
    user=$(jq -r '.user // empty' "$f" 2>/dev/null || true)
    [ -n "$user" ] || user=$(env_get "$ETC_DIR/hub.env" AUTH_USER 2>/dev/null || true)
    [ -n "$user" ] || user=admin
  fi
  [[ $user =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "name: 1-64 letters, digits, dot, dash or underscore"
  if [ -t 0 ]; then
    read -rsp "new password for $user: " pw; echo >&2
    read -rsp "again: " pw2; echo >&2
    [ "$pw" = "$pw2" ] || die "passwords differ"
  else
    IFS= read -r pw || true
  fi
  [ "${#pw}" -ge 8 ] || die "use at least 8 characters"
  hash=$(printf '%s' "$pw" | node "$ROOT/hub/lib/password.js")
  gen=$(( $(jq -r '.gen // 0' "$f" 2>/dev/null || echo 0) + 1 ))
  tmp=$(mktemp "$f.XXXXXX")
  chmod 600 "$tmp"
  jq -n --arg u "$user" --arg h "$hash" --argjson g "$gen" '{user: $u, hash: $h, gen: $g}' > "$tmp"
  chown --reference="$DATA_DIR" "$tmp" 2>/dev/null || true
  mv "$tmp" "$f"
  rm -f "$DATA_DIR/initial-password"   # no longer the password
  echo "login is now $user; every session has ended (no restart needed)"
}
```

and add `  passwd) shift; cmd_passwd "$@" ;;` as the first entry of that `case`.

- [ ] **Step 4: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/servitals-ctl test/cli.test.js
git commit -m "feat(ctl): passwd sets the admin password and name in admin.json" -m "Reads the password from the terminal (twice) or stdin, raises the login generation so every session ends, and removes initial-password. No restart needed."
```

---

### Task 4: First-run bootstrap for the package

**Files:**
- Create: `hub/lib/bootstrap.js`, `test/bootstrap.test.js`

**Interfaces:**
- Consumes: `createAdminStore` (Task 1), `hashPassword`, `createNodeStore`, `localAgentEnv`, `writeFileAtomic`.
- Produces: `bootstrap(stateDir, etcDir, { hostname }) → Promise<string[]>` (`"admin"` when it made a login, `"node"` when it made the local node), `readEnvFile(file) → object`, `randomPassword(len = 20) → string`; CLI `node bootstrap.js <state-dir> <etc-dir>`. Idempotent. Skips the login when admin.json exists or `hub.env` sets `AUTH_PASS_HASH` or `AUTH_PASS`. Task 7's postinst runs it as root.

- [ ] **Step 1: Write the failing tests**

Create `test/bootstrap.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bootstrap, readEnvFile } = require("../hub/lib/bootstrap");
const { verifyPassword } = require("../hub/lib/password");

function dirs(hubEnv = "PORT=20002\nAUTH_USER=admin\n# AUTH_PASS_HASH=scrypt:...\n") {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-boot-"));
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), "sv-etc-"));
  fs.writeFileSync(path.join(etc, "hub.env"), hubEnv);
  return { state, etc };
}
const read = (d, f) => fs.readFileSync(path.join(d, f), "utf8");

test("first run creates a login, the password file and the local node", async () => {
  const { state, etc } = dirs();
  assert.deepStrictEqual(await bootstrap(state, etc, { hostname: "box" }), ["admin", "node"]);
  const pw = read(state, "initial-password").trim();
  assert.match(pw, /^[a-hjkmnp-z2-9]{20}$/);
  const admin = JSON.parse(read(state, "admin.json"));
  assert.strictEqual(admin.user, "admin");
  assert.strictEqual(await verifyPassword(pw, admin.hash), true);
  for (const f of ["admin.json", "initial-password", "nodes.json", "local-agent.env"]) {
    assert.strictEqual(fs.statSync(path.join(state, f)).mode & 0o777, 0o600, f);
  }
  assert.match(read(state, "local-agent.env"), /^HUB_URL=http:\/\/127\.0\.0\.1:20002\nNODE_ID=[a-z2-7]{12}\n/);
});

test("a second run changes nothing", async () => {
  const { state, etc } = dirs();
  await bootstrap(state, etc);
  const before = ["admin.json", "initial-password", "nodes.json"].map((f) => read(state, f));
  assert.deepStrictEqual(await bootstrap(state, etc), []);
  assert.deepStrictEqual(["admin.json", "initial-password", "nodes.json"].map((f) => read(state, f)), before);
});

test("an existing login in hub.env is kept, and PORT sets the agent's hub URL", async () => {
  const { state, etc } = dirs("PORT=20012\nAUTH_USER=rishabha\nAUTH_PASS_HASH='scrypt:1:2:3:x:y'\n");
  assert.deepStrictEqual(await bootstrap(state, etc), ["node"]);
  assert.ok(!fs.existsSync(path.join(state, "admin.json")));
  assert.ok(!fs.existsSync(path.join(state, "initial-password")));
  assert.match(read(state, "local-agent.env"), /^HUB_URL=http:\/\/127\.0\.0\.1:20012$/m);
});

test("hub.env is parsed, never evaluated", () => {
  const { etc } = dirs('A="x y"\nB=\'$(touch /tmp/nope)\'\n# C=1\nD=plain\n');
  assert.deepStrictEqual(readEnvFile(path.join(etc, "hub.env")), { A: "x y", B: "$(touch /tmp/nope)", D: "plain" });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/bootstrap.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/bootstrap'`.

- [ ] **Step 3: Write `hub/lib/bootstrap.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * First-run setup for the Ubuntu package, run as root by the servitals postinst:
 *   node bootstrap.js <state-dir> <etc-dir>
 * Idempotent. Creates admin.json with a random password (also written once to
 * initial-password, 0600) unless a login already exists (admin.json, or a
 * password in hub.env), and the local node with its local-agent.env. The
 * postinst hands file ownership to _servitals afterwards.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hashPassword } = require("./password");
const { createAdminStore } = require("./admin");
const { createNodeStore, localAgentEnv } = require("./nodes");
const { writeFileAtomic } = require("./fsutil");

// KEY=VALUE lines; quotes removed; never evaluated
function readEnvFile(file) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";   // no look-alikes (0/o, 1/l/i)
function randomPassword(len = 20) {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

async function bootstrap(stateDir, etcDir, { hostname = os.hostname() } = {}) {
  const env = readEnvFile(path.join(etcDir, "hub.env"));
  const done = [];
  fs.mkdirSync(stateDir, { recursive: true });

  const admin = createAdminStore(path.join(stateDir, "admin.json"));
  if (!fs.existsSync(path.join(stateDir, "admin.json")) && !env.AUTH_PASS_HASH && !env.AUTH_PASS) {
    const password = randomPassword();
    admin.save({ user: env.AUTH_USER || "admin", hash: await hashPassword(password), gen: 0 });
    writeFileAtomic(path.join(stateDir, "initial-password"), password + "\n", 0o600);
    done.push("admin");
  }

  const nodes = createNodeStore(path.join(stateDir, "nodes.json"));
  const local = nodes.ensureLocal(hostname.slice(0, 64));
  const port = /^\d{1,5}$/.test(env.PORT || "") ? env.PORT : "20002";
  writeFileAtomic(path.join(stateDir, "local-agent.env"),
    localAgentEnv(`http://127.0.0.1:${port}`, local.id, nodes.get(local.id).secret), 0o600);
  if (local.created) done.push("node");
  return done;
}

module.exports = { bootstrap, readEnvFile, randomPassword };

if (require.main === module) {
  const [stateDir, etcDir] = process.argv.slice(2);
  if (!stateDir || !etcDir) {
    process.stderr.write("usage: bootstrap.js <state-dir> <etc-dir>\n");
    process.exit(2);
  }
  bootstrap(stateDir, etcDir).then((done) => {
    if (done.includes("admin")) {
      process.stdout.write(`servitals: log in as ${readEnvFile(path.join(etcDir, "hub.env")).AUTH_USER || "admin"}; ` +
        `the first password is in ${path.join(stateDir, "initial-password")}\n`);
    }
  }).catch((e) => { process.stderr.write(`servitals bootstrap: ${e.message}\n`); process.exit(1); });
}
```

- [ ] **Step 4: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/bootstrap.js test/bootstrap.test.js
git commit -m "feat(hub): first-run bootstrap for the package" -m "Creates admin.json with a random 20-character password (also in initial-password, 0600) unless a login exists, and the local node with local-agent.env for the port in hub.env. Idempotent; hub.env is parsed, never evaluated."
```

---

### Task 5: Units and sysusers move to `debian/`, hardening tightened

**Files:**
- Move: `packaging/systemd/servitals.service` → `debian/servitals.service`, `packaging/systemd/servitals-agent.service` → `debian/servitals-agent.service`, `packaging/sysusers/servitals.conf` → `debian/servitals.sysusers`, `packaging/sysusers/servitals-agent.conf` → `debian/servitals-agent.sysusers`
- Modify: the two units (whole files), `packaging/install-local.sh`, `test/packaging.test.js` (whole file)

**Interfaces:**
- Produces: `debian/servitals{,-agent}.{service,sysusers}` as the only copy, used by the package (Task 6) and by `install-local.sh`. Hardening list below; `systemd-analyze security` ≤ 2.0 is checked in Task 7.

- [ ] **Step 1: Write the failing test**

Replace `test/packaging.test.js` with:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lines = (text) => text.split("\n").map((l) => l.trim());

// spec section 13.2, plus the tightening from sub-project 3 (systemd-analyze
// security rates both units 2.0 or lower; debian/tests/smoke checks that)
const HARDENING = [
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=read-only", "PrivateTmp=yes",
  "ProtectKernelTunables=yes", "ProtectControlGroups=yes", "RestrictSUIDSGID=yes",
  "LockPersonality=yes", "Restart=on-failure",
  "PrivateDevices=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectClock=yes",
  "ProtectHostname=yes", "RestrictNamespaces=yes", "RestrictRealtime=yes", "CapabilityBoundingSet=",
  "AmbientCapabilities=", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "SystemCallArchitectures=native", "SystemCallFilter=@system-service",
];

for (const [unit, user, state] of [["servitals.service", "_servitals", "servitals"],
                                   ["servitals-agent.service", "_servitals-agent", "servitals-agent"]]) {
  test(`${unit} carries the hardening set`, () => {
    const l = lines(read(`debian/${unit}`));
    for (const want of [...HARDENING, `User=${user}`, `StateDirectory=${state}`]) {
      assert.ok(l.includes(want), `${unit}: missing ${want}`);
    }
  });
}

test("the hub keeps writable code pages for Node's JIT; the bash agent does not need them", () => {
  assert.ok(!lines(read("debian/servitals.service")).some((x) => x.startsWith("MemoryDenyWriteExecute")));
  assert.ok(lines(read("debian/servitals-agent.service")).includes("MemoryDenyWriteExecute=yes"));
});

test("the hub unit may write only its state directory and hides other processes", () => {
  const l = lines(read("debian/servitals.service"));
  for (const want of ["ReadWritePaths=/var/lib/servitals", "ProtectProc=invisible", "ProcSubset=pid"]) {
    assert.ok(l.includes(want), want);
  }
});

test("the agent unit waits for credentials and never loads them into its environment", () => {
  const l = lines(read("debian/servitals-agent.service"));
  assert.ok(l.includes("ConditionPathExists=/etc/servitals/agent-credentials.env"));
  assert.ok(!l.some((x) => x.startsWith("EnvironmentFile=") && x.includes("credentials")));
  assert.ok(!l.some((x) => x.startsWith("ProtectProc") || x.startsWith("ProcSubset")),
    "the agent reads /proc/1/mountinfo and /proc/stat");
});

test("sysusers files declare the two system users", () => {
  assert.match(read("debian/servitals.sysusers"), /^u _servitals - "servitals hub" \/var\/lib\/servitals$/m);
  assert.match(read("debian/servitals-agent.sysusers"), /^u _servitals-agent - "servitals agent" \/var\/lib\/servitals-agent$/m);
});

test("default env files", () => {
  assert.match(read("packaging/etc/hub.env"), /^PORT=20002$/m);
  assert.match(read("packaging/etc/hub.env"), /^# AUTH_PASS_HASH=/m);
  assert.match(read("packaging/etc/agent.env"), /^INTERVAL=60$/m);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/packaging.test.js`
Expected: FAIL: `ENOENT ... debian/servitals.service`.

- [ ] **Step 3: Move the files**

```bash
mkdir -p debian
git mv packaging/systemd/servitals.service debian/servitals.service
git mv packaging/systemd/servitals-agent.service debian/servitals-agent.service
git mv packaging/sysusers/servitals.conf debian/servitals.sysusers
git mv packaging/sysusers/servitals-agent.conf debian/servitals-agent.sysusers
rmdir packaging/systemd packaging/sysusers
```

- [ ] **Step 4: Tighten the units**

Replace `debian/servitals.service` with:

```ini
# SPDX-License-Identifier: AGPL-3.0-or-later
[Unit]
Description=servitals dashboard hub
Documentation=man:servitals(8) https://github.com/shri-studio/servitals
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
# MemoryDenyWriteExecute= stays off: Node's JIT needs writable code pages
ProtectProc=invisible
ProcSubset=pid
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `debian/servitals-agent.service` with:

```ini
# SPDX-License-Identifier: AGPL-3.0-or-later
[Unit]
Description=servitals agent (metrics collector)
Documentation=man:servitals-agent(1) https://github.com/shri-studio/servitals
After=network-online.target servitals.service
Wants=network-online.target
# not paired yet: stay down instead of crash-looping (the hub package pairs the local agent)
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
MemoryDenyWriteExecute=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 5: `install-local.sh` installs the same files**

In `packaging/install-local.sh` replace

```bash
install -m 644 "$SRC/packaging/sysusers/servitals.conf" "$SRC/packaging/sysusers/servitals-agent.conf" /usr/lib/sysusers.d/
```

with

```bash
install -m 644 "$SRC/debian/servitals.sysusers" /usr/lib/sysusers.d/servitals.conf
install -m 644 "$SRC/debian/servitals-agent.sysusers" /usr/lib/sysusers.d/servitals-agent.conf
```

and replace

```bash
install -m 644 "$SRC/packaging/systemd/servitals.service" "$SRC/packaging/systemd/servitals-agent.service" "$UNITS/"
```

with

```bash
# the same units the package ships (debian/ is their only copy)
install -m 644 "$SRC/debian/servitals.service" "$SRC/debian/servitals-agent.service" "$UNITS/"
```

- [ ] **Step 6: Run the tests and the installer smoke test**

Run: `node --test test/*.test.js && INSTALL_SMOKE_IMAGE=mirror.gcr.io/library/ubuntu:26.04 bash test/install-smoke.sh`
Expected: PASS; `install smoke test passed`.

- [ ] **Step 7: Commit**

```bash
git add -A debian packaging test/packaging.test.js
git commit -m "feat(packaging): units and sysusers live in debian/, hardening tightened" -m "Adds PrivateDevices, ProtectKernelModules/Logs, ProtectClock, ProtectHostname, RestrictNamespaces, RestrictRealtime, an empty capability set, RestrictAddressFamilies, a native @system-service syscall filter; the hub also hides other processes (ProtectProc=invisible, ProcSubset=pid) and the agent denies writable code pages. install-local.sh installs the same files."
```

---
### Task 6: The Debian packages build, lint clean, fit the budget

**Files:**
- Create: `debian/control`, `debian/rules`, `debian/changelog`, `debian/copyright`, `debian/source/format`, `debian/watch`, `debian/servitals.install`, `debian/servitals-agent.install`, `debian/servitals.manpages`, `debian/servitals-agent.manpages`, `debian/servitals.lintian-overrides`, `debian/servitals-agent.lintian-overrides`, `man/servitals.8`, `man/servitals-ctl.1`, `man/servitals-agent.1`, `packaging/series.sh`, `packaging/docker/build-in.sh`, `packaging/build-deb.sh`
- Modify: `.gitignore` (add `build/`), `test/packaging.test.js`, `test/version.test.js`

**Interfaces:**
- Consumes: the units and sysusers in `debian/` (Task 5), `hub/lib/bootstrap.js` (Task 4, shipped in `hub/lib/`).
- Produces: `packaging/build-deb.sh [series...]` → `build/deb/<series>/servitals_<v>_all.deb`, `servitals-agent_<v>_all.deb`, `build/deb/lintian-<series>.txt`; exit 1 on any lintian `E:`/`W:` or a `.deb` over 512000 bytes. `packaging/series.sh`: `pick_series "$@"` (sets `SERIES`, default `noble resolute`), `series_image <series>` (honours `IMAGE_PREFIX`), `stage_source <src> <dst>` (working tree without git-ignored files). Tasks 7, 8 and 9 use all three.

- [ ] **Step 1: Write the failing checks**

Append to `test/packaging.test.js`:

```js
test("each package has a man page for each command", () => {
  assert.deepStrictEqual(read("debian/servitals.manpages").trim().split("\n"), ["man/servitals.8", "man/servitals-ctl.1"]);
  assert.deepStrictEqual(read("debian/servitals-agent.manpages").trim().split("\n"), ["man/servitals-agent.1"]);
});
```

Append to `test/version.test.js`:

```js

test("the Debian version follows VERSION", () => {
  const upstream = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim().replace(/-/g, "~");
  const first = fs.readFileSync(path.join(ROOT, "debian", "changelog"), "utf8").split("\n")[0];
  assert.match(first, new RegExp(`^servitals \\(${upstream.replace(/[.~]/g, "\\$&")}-\\d+\\) [a-z]+; urgency=`));
});
```

(If `test/version.test.js` has no `ROOT` constant, use `const ROOT = path.join(__dirname, "..");` at the top of the new test.)

Add `build/` as a new line in `.gitignore`.

Create `packaging/series.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# Ubuntu series this project builds for, and the container image for each.
# IMAGE_PREFIX lets a host without Docker Hub use a mirror, for example
# IMAGE_PREFIX=mirror.gcr.io/library/
# SERIES: the series named on the command line, or every supported one
pick_series() {
  # shellcheck disable=SC2034  # read by the scripts that source this file
  if [ $# -gt 0 ]; then SERIES=("$@"); else SERIES=(noble resolute); fi
}
series_image() {
  case "$1" in
    noble) echo "${IMAGE_PREFIX:-}ubuntu:24.04" ;;
    resolute) echo "${IMAGE_PREFIX:-}ubuntu:26.04" ;;
    *) echo "unknown series: $1" >&2; return 1 ;;
  esac
}
# the working tree without git-ignored files (never .env, data/ or build/)
stage_source() {  # src dst
  (cd "$1" && git ls-files -z --cached --others --exclude-standard) |
    while IFS= read -r -d '' f; do
      [ -e "$1/$f" ] && (cd "$1" && cp --parents -- "$f" "$2/")
    done
}
```

Create `packaging/docker/build-in.sh`:

```bash
#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Inside an Ubuntu container: build the binary packages from /src (a staged
# source tree) into /out/<series>/ and run lintian. Called by build-deb.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends build-essential debhelper devscripts lintian fakeroot >/dev/null
. /etc/os-release
series=$VERSION_CODENAME
version=$(dpkg-parsechangelog -l /src/debian/changelog -S Version)
upstream=${version%-*}
work=$(mktemp -d)
cd "$work"
tar -C /src --exclude=./debian -czf "servitals_$upstream.orig.tar.gz" --transform "s,^\.,servitals-$upstream," .
tar -xzf "servitals_$upstream.orig.tar.gz"
cp -r /src/debian "servitals-$upstream/"
sed -i "1s/) [a-z]*;/) $series;/" "servitals-$upstream/debian/changelog"
(cd "servitals-$upstream" && dpkg-buildpackage -us -uc -b) > "/out/build-$series.log" 2>&1 \
  || { tail -40 "/out/build-$series.log"; exit 1; }
mkdir -p "/out/$series"
rm -f "/out/$series"/*.deb
cp ./*.deb "/out/$series/"
lintian -EvIL +pedantic ./*.changes > "/out/lintian-$series.txt" 2>&1 || true
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out
```

Create `packaging/build-deb.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build the servitals and servitals-agent packages from this checkout in
# Ubuntu containers, run lintian, and enforce the checks from the spec:
# no lintian errors or warnings (section 13.5), each .deb at most 500 KB
# (section 18). Results land in build/deb/<series>/.
#   packaging/build-deb.sh [series...]        default: noble resolute
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
OUT="${OUT_DIR:-$SRC/build/deb}"
mkdir -p "$OUT"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
stage_source "$SRC" "$stage"
fail=0
pick_series "$@"
for series in "${SERIES[@]}"; do
  image=$(series_image "$series")
  echo "== $series ($image)"
  docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$stage:/src:ro" -v "$OUT:/out" -v "$SRC/packaging/docker/build-in.sh:/build-in.sh:ro" \
    "$image" bash /build-in.sh
  if grep -E '^[EW]: ' "$OUT/lintian-$series.txt"; then
    echo "FAIL  lintian errors or warnings on $series (see $OUT/lintian-$series.txt)"
    fail=1
  fi
  for deb in "$OUT/$series"/*.deb; do
    size=$(stat -c %s "$deb")
    if [ "$size" -gt 512000 ]; then echo "FAIL  $(basename "$deb") is $size bytes (> 500 KB)"; fail=1
    else echo "ok    $(basename "$deb") $size bytes"; fi
  done
done
exit "$fail"
```

Run `chmod +x packaging/build-deb.sh packaging/docker/build-in.sh`.

- [ ] **Step 2: Run the checks to see them fail**

Run: `node --test test/packaging.test.js test/version.test.js; IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh resolute`
Expected: FAIL: `ENOENT ... debian/servitals.manpages` and `debian/changelog`; `build-deb.sh` stops at `dpkg-parsechangelog: error: cannot open file /src/debian/changelog`.

- [ ] **Step 3: Write the package metadata**

`debian/source/format`:

```
3.0 (quilt)
```

`debian/changelog` (tabs are not used; the trailer line has two spaces before the date):

```
servitals (0.1.0~dev-1) resolute; urgency=medium

  * Initial release.

 -- Rishabha Garg <rishabha.garg06@gmail.com>  Sat, 26 Sep 2026 12:00:00 +0400
```

`debian/control`:

```
Source: servitals
Section: admin
Priority: optional
Maintainer: Rishabha Garg <rishabha.garg06@gmail.com>
Build-Depends: debhelper-compat (= 13), dh-sequence-installsysusers
Standards-Version: 4.6.2
Homepage: https://github.com/shri-studio/servitals
Vcs-Browser: https://github.com/shri-studio/servitals
Vcs-Git: https://github.com/shri-studio/servitals.git

Package: servitals
Architecture: all
Depends: ${misc:Depends}, nodejs (>= 18), jq, servitals-agent (= ${source:Version})
Suggests: apprise
Description: tiny terminal-styled dashboard for home servers
 servitals shows the health of one or more Linux servers on a single page:
 memory, CPU, temperatures, disks, network traffic and containers. It is a
 small Node.js gateway with no dependencies outside Node.js itself, a login
 with lockout, and container controls for the local host.
 .
 This package contains the hub (web gateway) and the servitals-ctl admin
 tool. The local agent is paired automatically.

Package: servitals-agent
Architecture: all
Depends: ${misc:Depends}, jq, curl
Recommends: vnstat
Description: metrics agent for the servitals dashboard
 A small bash agent that samples memory, CPU, temperatures, disks, network
 traffic and Docker containers, and pushes signed snapshots to a servitals
 hub over HTTP(S). It only makes outbound connections.
```

`debian/rules` (the recipe line starts with a **tab**):

```make
#!/usr/bin/make -f
%:
	dh $@

# the hub starts from postinst, after the first-run setup has created a login
override_dh_installsystemd:
	dh_installsystemd -pservitals --no-start
	dh_installsystemd -pservitals-agent
```

Run `chmod +x debian/rules`.

`debian/servitals.install`:

```
hub/server.js usr/share/servitals/hub/
hub/lib/*.js usr/share/servitals/hub/lib/
VERSION usr/share/servitals/
www/index.html usr/share/servitals/www/
www/config.example.json usr/share/servitals/www/
www/fonts/*.woff2 usr/share/servitals/www/fonts/
bin/servitals-ctl usr/bin/
packaging/etc/hub.env etc/servitals/
```

`debian/servitals-agent.install`:

```
agent/collect.sh usr/lib/servitals-agent/
agent/lib/*.sh usr/lib/servitals-agent/lib/
VERSION usr/lib/servitals-agent/
bin/servitals-agent usr/bin/
packaging/etc/agent.env etc/servitals/
```

`debian/servitals.manpages`:

```
man/servitals.8
man/servitals-ctl.1
```

`debian/servitals-agent.manpages`:

```
man/servitals-agent.1
```

`debian/watch`:

```
version=4
opts=filenamemangle=s%(?:.*?)?v?(\d[\d.]*)\.tar\.gz%servitals-$1.tar.gz% \
  https://github.com/shri-studio/servitals/tags (?:.*?/)?v?(\d[\d.]*)\.tar\.gz
```

`debian/servitals.lintian-overrides`:

```
# The dashboard page and its WOFF2 fonts are served by the hub to browsers;
# they are web assets, not documentation or system fonts (spec section 13.1).
servitals: package-contains-documentation-outside-usr-share-doc [usr/share/servitals/www/index.html]
servitals: font-in-non-font-package [usr/share/servitals/www/fonts/*]
servitals: font-outside-font-dir [usr/share/servitals/www/fonts/*]
# Distributed through a Launchpad PPA; not in Debian yet (ITP after 1.0, spec section 16).
servitals: initial-upload-closes-no-bugs [usr/share/doc/servitals/changelog.Debian.gz:1]
```

`debian/servitals-agent.lintian-overrides`:

```
# Distributed through a Launchpad PPA; not in Debian yet (ITP after 1.0, spec section 16).
servitals-agent: initial-upload-closes-no-bugs [usr/share/doc/servitals-agent/changelog.Debian.gz:1]
```

`debian/copyright`: DEP-5. Write the header and file stanzas below, then the two license stanzas. For `License: OFL-1.1`, copy the license text from `www/fonts/OFL-JetBrainsMono.txt`, starting at the line `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007`: prefix every line with one space, and write empty lines and the `-----` rule lines as ` .`. Generate it rather than typing it:

```bash
{
  cat <<'EOF'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: servitals
Upstream-Contact: Rishabha Garg <rishabha.garg06@gmail.com>
Source: https://github.com/shri-studio/servitals

Files: *
Copyright: 2026 Rishabha Garg
License: AGPL-3.0-or-later

Files: www/fonts/jetbrains-mono-*.woff2
Copyright: 2020 The JetBrains Mono Project Authors
License: OFL-1.1

Files: www/fonts/press-start-2p-*.woff2
Copyright: 2012 The Press Start 2P Project Authors (cody@zone38.net)
License: OFL-1.1

License: AGPL-3.0-or-later
 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU Affero General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.
 .
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU Affero General Public License for more details.
 .
 You should have received a copy of the GNU Affero General Public License
 along with this program.  If not, see <https://www.gnu.org/licenses/>.

EOF
  echo "License: OFL-1.1"
  sed -n '/^SIL OPEN FONT LICENSE Version 1.1/,$p' www/fonts/OFL-JetBrainsMono.txt |
    sed -e 's/[[:space:]]*$//' -e 's/^-*$/./' -e 's/^$/./' -e 's/^/ /' | sed -e '${/^ \.$/d}'
} > debian/copyright
```

Check: `grep -c '^License:' debian/copyright` prints `5`, and the file ends with the OFL disclaimer paragraph.

- [ ] **Step 4: Write the man pages**

`man/servitals.8`:

```
.\" SPDX-License-Identifier: AGPL-3.0-or-later
.TH SERVITALS 8 2026-09-26 servitals "System Administration"
.SH NAME
servitals \- tiny terminal-styled dashboard hub for home servers
.SH SYNOPSIS
.B systemctl
.RB { start | stop | restart | status }
.B servitals
.SH DESCRIPTION
The
.B servitals
service is a small Node.js gateway. It serves the dashboard page behind a
login with per-address lockout, receives signed snapshots from
.BR servitals-agent (1)
over
.IR /api/v1/agent/push ,
and wakes agents for fresh data when someone is looking.
.PP
It runs as the system user
.B _servitals
under a hardened systemd unit and listens on port 20002 by default.
.SH FILES
.TP
.I /etc/servitals/hub.env
Settings: PORT, BIND_ADDR, TRUSTED_PROXIES, PROXY_HEADER, PUBLIC_URL,
MAX_FAILS, BAN_HOURS, SESSION_HOURS, CTL_LAN_ONLY, LOG_LEVEL, LOG_FORMAT.
Restart the service after editing.
.TP
.I /var/lib/servitals/admin.json
The admin login (name, password hash). Change it with
.B servitals-ctl passwd
or in the dashboard settings.
.TP
.I /var/lib/servitals/initial-password
The random first password, until the login is changed.
.TP
.I /var/lib/servitals/
Other state: sessions key, bans, whitelist, nodes, snapshots, audit.log.
.SH SECURITY
Proxy headers are trusted only from TRUSTED_PROXIES (loopback by default).
Container controls need the docker group, which can take over the host as
root; they stay off until
.B servitals-ctl docker enable
and are limited to whitelisted (LAN) clients while CTL_LAN_ONLY=1.
.SH SEE ALSO
.BR servitals-ctl (1),
.BR servitals-agent (1),
.BR journalctl (1)
```

`man/servitals-ctl.1`:

```
.\" SPDX-License-Identifier: AGPL-3.0-or-later
.TH SERVITALS-CTL 1 2026-09-26 servitals "User Commands"
.SH NAME
servitals-ctl \- administer the servitals hub
.SH SYNOPSIS
.B servitals-ctl
.I command
.RI [ arguments ]
.SH COMMANDS
.TP
.BR passwd " [" \-\-user
.IR NAME ]
Set the admin password, and the name with
.BR \-\-user .
Reads the password twice from the terminal, or one line from standard
input. Every session ends; no restart is needed.
.TP
.B bans
List blocked addresses and the whitelist.
.TP
.BI unban " ip"
Remove a block.
.TP
.BI whitelist " ip|cidr"
Never block this address again; also unbans it.
.TP
.B hash-password
Print a password hash for AUTH_PASS_HASH (Docker installs).
.TP
.BR "docker enable" | disable
Add or remove the docker group for the hub, for the container buttons.
.B The docker group can take over the host as root.
.TP
.BI import-docker " dir"
Copy the login, dashboard settings, whitelist, bans and disk list from a
Docker install in
.IR dir .
.SH ENVIRONMENT
.TP
.B STATE_DIR
The hub's state directory (default /var/lib/servitals).
.SH SEE ALSO
.BR servitals (8),
.BR servitals-agent (1)
```

`man/servitals-agent.1`:

```
.\" SPDX-License-Identifier: AGPL-3.0-or-later
.TH SERVITALS-AGENT 1 2026-09-26 servitals "User Commands"
.SH NAME
servitals-agent \- metrics agent for the servitals dashboard
.SH SYNOPSIS
.B servitals-agent
.RB { run | test }
.br
.B servitals-agent docker
.RB { enable | disable }
.SH DESCRIPTION
The agent samples memory, CPU, temperatures, disks, network traffic and
Docker containers every INTERVAL seconds, and at once when the hub asks,
and pushes signed snapshots to the hub. It only makes outbound
connections and never runs anything the hub sends.
.SH COMMANDS
.TP
.B run
Run the agent (the systemd unit uses this).
.TP
.B test
Sample once with the settings from /etc/servitals/agent.env and print the
snapshot. Nothing is sent.
.TP
.BR "docker enable" | disable
Add or remove the docker group for the agent, to list containers.
.B The docker group can take over the host as root.
.SH FILES
.TP
.I /etc/servitals/agent.env
INTERVAL, DISKS (auto or a list of mountpoints), NET_IFACE, COLLECT_*
switches, STAT_TIMEOUT, WAIT_SECONDS, HTTPS_PROXY, NO_PROXY, LOG_LEVEL.
.TP
.I /etc/servitals/agent-credentials.env
HUB_URL, NODE_ID and NODE_SECRET (mode 0600). The servitals package writes
it for the agent on the same host.
.SH SEE ALSO
.BR servitals (8),
.BR servitals-ctl (1)
```

Check each renders without warnings: `for m in man/*; do man --warnings -l "$m" >/dev/null; done` (no output expected).

- [ ] **Step 5: Build and lint both series**

Run: `node --test test/*.test.js && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh`
Expected: PASS, then for each series two `ok` lines, about `servitals_0.1.0~dev-1_all.deb 127500 bytes` and `servitals-agent_0.1.0~dev-1_all.deb 17500 bytes`, and no `FAIL`. `build/deb/lintian-noble.txt` and `lintian-resolute.txt` contain only `I:`, `P:` and `N:` lines (expected ones: `repeated-path-segment lib`, `spare-manual-page`, `out-of-date-standards-version` on resolute, `older-debian-watch-file-standard`, `silent-on-rules-requiring-root`).

The package's postinst does not exist yet: installing these packages now leaves the hub without a login. Task 7 adds it.

- [ ] **Step 6: Commit**

```bash
git add .gitignore debian man packaging/series.sh packaging/docker/build-in.sh packaging/build-deb.sh test/packaging.test.js test/version.test.js
git commit -m "feat(packaging): Debian source package for servitals and servitals-agent" -m "debhelper 13 with sysusers and systemd helpers, DEP-5 copyright (AGPL-3.0-or-later, OFL-1.1 fonts), man pages, lintian overrides with reasons. packaging/build-deb.sh builds noble and resolute in containers and fails on lintian errors or warnings or a .deb over 500 KB."
```

---

### Task 7: postinst, postrm, and autopkgtest on a booted testbed

**Files:**
- Create: `debian/servitals.postinst`, `debian/servitals.postrm`, `debian/servitals-agent.postrm`, `debian/tests/control`, `debian/tests/smoke`, `debian/tests/purge`, `packaging/docker/autopkgtest-in.sh`, `packaging/autopkgtest.sh`
- Modify: `test/packaging.test.js`

**Interfaces:**
- Consumes: `bootstrap.js` (Task 4), `servitals-ctl passwd` (Task 3), `build-deb.sh` output (Task 6), `series.sh`.
- Produces: `packaging/autopkgtest.sh [series...]` runs `debian/tests` with the packages from `build/deb/<series>/` on a systemd testbed (`autopkgtest-build-docker --init systemd`, `autopkgtest-virt-docker --init --remote --privileged`, driven from a helper container that mounts the Docker socket); `PPA_SETUP=ppa:<owner>/<name>` installs from that PPA instead (Task 11). postinst on `configure`: bootstrap, chown the files it made, pair the local agent when `/etc/servitals/agent-credentials.env` is missing, restart the hub and start the agent when systemd runs.

- [ ] **Step 1: Write the failing tests**

Append to `test/packaging.test.js`:

```js
test("maintainer scripts keep the debhelper token and never chown recursively", () => {
  for (const f of ["debian/servitals.postinst", "debian/servitals.postrm", "debian/servitals-agent.postrm"]) {
    const s = read(f);
    assert.match(s, /^#DEBHELPER#$/m, f);
    assert.doesNotMatch(s, /chown\s+-R/, f);
  }
});
```

Create `debian/tests/control`:

```
Tests: smoke
Depends: servitals, curl, jq
Restrictions: needs-root, isolation-container, allow-stderr

Tests: purge
Depends: servitals, curl
Restrictions: needs-root, isolation-container, breaks-testbed, allow-stderr
```

Create `debian/tests/smoke`:

```sh
#!/bin/sh
# Installed packages on a booted system: the hub and the local agent run under
# their hardened units, the first password works, passwd ends old sessions,
# and reconfiguring keeps the login and the node.
set -eu
B=http://127.0.0.1:20002
fail() { echo "FAIL: $*"; journalctl -u servitals -u servitals-agent --no-pager | tail -40; exit 1; }
wait_for() { i=0; while ! sh -c "$1"; do i=$((i + 1)); [ "$i" -lt 60 ] || return 1; sleep 1; done; }
login() {
	curl -s -o /dev/null -w '%{http_code}' -c /tmp/jar -H "Origin: $B" \
		--data-urlencode "username=$1" --data-urlencode "password=$2" "$B/__auth/login"
}

wait_for "curl -fsS $B/__auth/health >/dev/null 2>&1" || fail "hub not healthy"
wait_for "systemctl is-active --quiet servitals-agent" || fail "agent not running"
[ "$(stat -c '%a %U' /var/lib/servitals/initial-password)" = "600 _servitals" ] || fail "initial-password mode or owner"
[ "$(stat -c '%a %U' /etc/servitals/agent-credentials.env)" = "600 _servitals-agent" ] || fail "agent credentials mode or owner"
pw=$(cat /var/lib/servitals/initial-password)
[ "$(login admin "$pw")" = 302 ] || fail "first login with the initial password"
wait_for "curl -fsS -b /tmp/jar $B/data.json 2>/dev/null | jq -e .host.name >/dev/null" || fail "no snapshot from the local agent"

printf 'another-pass-1\n' | servitals-ctl passwd --user owner
[ "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar "$B/__ctl/whoami")" = 401 ] || fail "old session survived passwd"
[ "$(login owner another-pass-1)" = 302 ] || fail "login after passwd"
[ ! -e /var/lib/servitals/initial-password ] || fail "initial-password kept after passwd"

node_id=$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)
dpkg-reconfigure servitals >/dev/null
wait_for "curl -fsS $B/__auth/health >/dev/null 2>&1" || fail "hub not back after reconfigure"
[ "$(login owner another-pass-1)" = 302 ] || fail "login lost on reconfigure"
[ "$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)" = "$node_id" ] || fail "node changed on reconfigure"

# the hardening holds: systemd rates both units 2.0 or lower ("OK")
for u in servitals servitals-agent; do
	line=$(systemd-analyze security "$u.service" --no-pager | tail -n 1)
	echo "$line"
	score=$(echo "$line" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+$/) print $i }')
	awk -v s="$score" 'BEGIN { exit !(s != "" && s + 0 <= 2.0) }' || fail "$u exposure $score is above 2.0"
done
echo "smoke: ok"
```

Create `debian/tests/purge`:

```sh
#!/bin/sh
# Purging removes each package's state. The agent's credentials go with the
# hub only when they point at this host's hub; the agent's own purge always
# removes them.
set -eu
fail() { echo "FAIL: $*"; exit 1; }
f=/etc/servitals/agent-credentials.env
sed -i 's|^HUB_URL=.*|HUB_URL=https://hub.example.org|' "$f"
apt-get purge -y servitals >/dev/null
[ ! -e /var/lib/servitals ] || fail "/var/lib/servitals kept"
[ -e "$f" ] || fail "credentials for another hub removed with the local hub"
apt-get purge -y servitals-agent >/dev/null
[ ! -e /var/lib/servitals-agent ] || fail "/var/lib/servitals-agent kept"
[ ! -e "$f" ] || fail "agent credentials kept"
[ ! -e /etc/servitals ] || fail "/etc/servitals kept"
echo "purge: ok"
```

Create `packaging/docker/autopkgtest-in.sh`:

```bash
#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Inside a helper container that can reach the Docker socket: build a booted
# (systemd) test image for the series and run the package's autopkgtests on it.
#   autopkgtest-in.sh <series> <base-image> [extra autopkgtest args...]
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
series=$1 image=$2
shift 2
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends autopkgtest docker.io python3 iproute2 >/dev/null
autopkgtest-build-docker --docker --init systemd -i "$image" --release "$series" \
  -t "servitals-autopkgtest/$series" >/dev/null
cp -r /src /tmp/src
debs=()
for d in /out/"$series"/*.deb; do [ -e "$d" ] && debs+=("$d"); done
autopkgtest "${debs[@]}" /tmp/src "$@" -- docker --init --remote "servitals-autopkgtest/$series" --privileged
```

Create `packaging/autopkgtest.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run debian/tests on a booted Ubuntu testbed (systemd in Docker) for each
# series, with the packages from build/deb/<series>/ (run build-deb.sh first).
#   packaging/autopkgtest.sh [series...]      default: noble resolute
# PPA_SETUP="ppa:prabzo/servitals" tests the packages from that PPA instead.
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
OUT="${OUT_DIR:-$SRC/build/deb}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
stage_source "$SRC" "$stage"
extra=()
if [ -n "${PPA_SETUP:-}" ]; then
  extra=(--setup-commands "apt-get install -y software-properties-common && add-apt-repository -y $PPA_SETUP && apt-get update")
  OUT=$(mktemp -d)   # no local packages: install from the PPA
fi
pick_series "$@"
for series in "${SERIES[@]}"; do
  echo "== autopkgtest $series"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$stage:/src:ro" -v "$OUT:/out:ro" -v "$SRC/packaging/docker/autopkgtest-in.sh:/run.sh:ro" \
    "$(series_image resolute)" bash /run.sh "$series" "$(series_image "$series")" "${extra[@]}"
done
```

Run `chmod +x debian/tests/smoke debian/tests/purge packaging/autopkgtest.sh packaging/docker/autopkgtest-in.sh`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/packaging.test.js; IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh resolute && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh resolute`
Expected: the node test fails with `ENOENT ... debian/servitals.postinst`; autopkgtest `smoke` FAILs with `FAIL: hub not healthy` (the hub has no login and restarts with `auth.no_password`), and `purge` may pass.

- [ ] **Step 3: Write the maintainer scripts**

`debian/servitals.postinst`:

```sh
#!/bin/sh
set -e

#DEBHELPER#

if [ "$1" = configure ]; then
	# first run: a random admin password and the local node (both idempotent)
	install -d -m 0750 -o _servitals -g _servitals /var/lib/servitals
	node /usr/share/servitals/hub/lib/bootstrap.js /var/lib/servitals /etc/servitals
	for f in admin.json initial-password nodes.json local-agent.env; do
		if [ -e "/var/lib/servitals/$f" ]; then chown _servitals:_servitals "/var/lib/servitals/$f"; fi
	done
	# pair the local agent, unless it already reports to some hub
	if [ ! -e /etc/servitals/agent-credentials.env ]; then
		install -m 0600 -o _servitals-agent -g _servitals-agent \
			/var/lib/servitals/local-agent.env /etc/servitals/agent-credentials.env
	fi
	if [ -d /run/systemd/system ]; then
		deb-systemd-invoke restart servitals.service >/dev/null || true
		deb-systemd-invoke try-restart servitals-agent.service >/dev/null || true
		deb-systemd-invoke start servitals-agent.service >/dev/null || true
	fi
fi
```

`debian/servitals.postrm`:

```sh
#!/bin/sh
set -e

if [ "$1" = purge ]; then
	rm -rf /var/lib/servitals /etc/systemd/system/servitals.service.d
	# the local agent's credentials point at this hub: remove them with it
	f=/etc/servitals/agent-credentials.env
	if [ -f "$f" ] && grep -Eq '^HUB_URL=https?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/?$' "$f"; then
		rm -f "$f"
	fi
	rmdir /etc/servitals 2>/dev/null || true
fi

#DEBHELPER#
```

`debian/servitals-agent.postrm`:

```sh
#!/bin/sh
set -e

if [ "$1" = purge ]; then
	rm -rf /var/lib/servitals-agent /etc/systemd/system/servitals-agent.service.d
	rm -f /etc/servitals/agent-credentials.env
	rmdir /etc/servitals 2>/dev/null || true
fi

#DEBHELPER#
```

(Indentation in the three scripts is tabs, as debhelper's snippets use.)

- [ ] **Step 4: Build and run autopkgtest on both series**

Run: `node --test test/*.test.js && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh`
Expected: PASS; for noble and resolute `smoke PASS` and `purge PASS`, and the smoke log shows `Overall exposure level for servitals.service: 1.4 OK` and `servitals-agent.service: 1.5 OK` (each must be ≤ 2.0). A run takes about 4 minutes per series.

- [ ] **Step 5: Commit**

```bash
git add debian packaging/autopkgtest.sh packaging/docker/autopkgtest-in.sh test/packaging.test.js
git commit -m "feat(packaging): postinst pairs the local agent; autopkgtest on a booted testbed" -m "First install: random admin password in /var/lib/servitals/initial-password, local node, agent credentials, units started. Purge removes state, and the agent credentials only when they point at this host's hub. debian/tests run on systemd-in-Docker for noble and resolute and check the login, a pushed snapshot, passwd, reconfigure, purge and a systemd exposure of 2.0 or lower."
```

---

### Task 8: Migration from `install-local.sh`, PPA source packages

**Files:**
- Create: `test/deb-migrate.sh`, `packaging/docker/source-in.sh`, `packaging/ppa-upload.sh`
- Modify: `test/packaging.test.js`

**Interfaces:**
- Consumes: `build-deb.sh` output, `series.sh`, `test/helpers/fake-systemctl`.
- Produces: `test/deb-migrate.sh [series]` (default resolute); `packaging/ppa-upload.sh ppa:<owner>/<name> [series...]` builds `build/ppa/<series>/servitals_<v>~ppa<N>~<series>1.{dsc,debian.tar.xz,_source.changes}` plus one shared `servitals_<upstream>.orig.tar.gz` from the committed `HEAD` (refuses a dirty tree); `UPLOAD=1 DEBSIGN_KEYID=<id>` signs with `debsign` and uploads with `dput` (Task 11).

- [ ] **Step 1: Write the failing tests**

Append to `test/packaging.test.js`:

```js
test("shell scripts parse", () => {
  for (const f of ["packaging/install-local.sh", "packaging/build-deb.sh", "packaging/autopkgtest.sh",
                   "packaging/ppa-upload.sh", "debian/servitals.postinst", "debian/servitals.postrm",
                   "debian/servitals-agent.postrm", "debian/tests/smoke", "debian/tests/purge"]) {
    const r = spawnSync("bash", ["-n", path.join(ROOT, f)], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, `${f}: ${r.stderr}`);
  }
});
```

Create `test/deb-migrate.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Moving a host from packaging/install-local.sh to the Ubuntu packages keeps
# the login, the local node and the agent's credentials. Runs in an Ubuntu
# container with test/helpers/fake-systemctl, on packages from build-deb.sh.
#   test/deb-migrate.sh [series]              default: resolute
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
series=${1:-resolute}
debs="${OUT_DIR:-$SRC/build/deb}/$series"
ls "$debs"/servitals_*.deb >/dev/null || { echo "build the packages first: packaging/build-deb.sh $series"; exit 1; }

docker run --rm -i -v "$SRC:/src:ro" -v "$debs:/debs:ro" \
  -v "$SRC/test/helpers/fake-systemctl:/usr/local/bin/systemctl:ro" "$(series_image "$series")" bash -s <<'IN_CONTAINER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null && apt-get -qq install -y nodejs jq curl systemd procps util-linux >/dev/null 2>&1
fail() { echo "FAIL: $*"; tail -20 /tmp/hub.log 2>/dev/null; exit 1; }
B=http://127.0.0.1:20002
login() {
  curl -s -o /dev/null -w '%{http_code}' -H "Origin: $B" \
    --data-urlencode "username=$1" --data-urlencode "password=$2" "$B/__auth/login"
}
wait_health() { for _ in $(seq 1 50); do curl -fsS "$B/__auth/health" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }

ADMIN_USER=rishabha ADMIN_PASSWORD=migrate-pass-1 bash /src/packaging/install-local.sh >/tmp/install.log 2>&1 \
  || { cat /tmp/install.log; fail "install-local"; }
[ "$(login rishabha migrate-pass-1)" = 302 ] || fail "login before the move"
node_id=$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)

bash /src/packaging/install-local.sh --uninstall >/dev/null
apt-get install -y -o Dpkg::Options::=--force-confold /debs/*.deb >/tmp/apt.log 2>&1 || { tail -30 /tmp/apt.log; fail "apt install"; }
systemctl restart servitals.service
wait_health || fail "hub after the move"

[ "$(login rishabha migrate-pass-1)" = 302 ] || fail "login after the move"
[ ! -e /var/lib/servitals/admin.json ] || fail "postinst created a second login"
[ ! -e /var/lib/servitals/initial-password ] || fail "postinst wrote an initial password"
[ "$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)" = "$node_id" ] || fail "agent credentials changed"
dpkg -S /usr/share/servitals/hub/server.js >/dev/null || fail "hub files not owned by the package"
[ ! -e /etc/systemd/system/servitals.service ] || fail "old unit left in /etc/systemd/system"
echo "deb migration test passed"
IN_CONTAINER
```

Run `chmod +x test/deb-migrate.sh`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/packaging.test.js; IMAGE_PREFIX=mirror.gcr.io/library/ bash test/deb-migrate.sh resolute`
Expected: the node test fails on `packaging/ppa-upload.sh` (missing); `deb-migrate.sh` passes already (it tests Tasks 5-7; this step records that the migration works before the upload tooling exists).

- [ ] **Step 3: Write the PPA scripts**

`packaging/docker/source-in.sh`:

```bash
#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Inside an Ubuntu container: build an unsigned source package for one PPA
# series from /in/servitals_<upstream>.orig.tar.gz and /in/debian.tar.
#   source-in.sh <series> <ppa-version>
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
series=$1 ppa_version=$2
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends dpkg-dev debhelper devscripts >/dev/null
work=$(mktemp -d)
cd "$work"
orig=$(basename /in/servitals_*.orig.tar.gz)
cp "/in/$orig" .
tar -xzf "$orig"
dir=$(find . -maxdepth 1 -type d -name 'servitals-*' | head -n 1)
tar -C "$dir" -xf /in/debian.tar
sed -i "1s/^servitals ([^)]*) [a-z]*;/servitals ($ppa_version) $series;/" "$dir/debian/changelog"
(cd "$dir" && dpkg-buildpackage -S -sa -us -uc -d) > "/out/source-$series.log" 2>&1 \
  || { tail -30 "/out/source-$series.log"; exit 1; }
mkdir -p "/out/$series"
cp ./*.dsc ./*.debian.tar.* ./*_source.changes ./*.orig.tar.gz "/out/$series/"
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out
```

`packaging/ppa-upload.sh`:

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build source packages of the committed HEAD for a Launchpad PPA, one per
# series, versioned <debian version>~ppa<N>~<series>1 (spec section 16), and
# upload them when asked.
#   packaging/ppa-upload.sh <ppa> [series...]         build only (a dry run)
#   UPLOAD=1 DEBSIGN_KEYID=<key id> packaging/ppa-upload.sh ppa:prabzo/servitals
# PPA_REV (default 1) raises ~ppaN to rebuild the same version. The upload
# needs devscripts and dput on this host and a GPG key known to Launchpad;
# the key never leaves this host.
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
die() { echo "ppa-upload: $*" >&2; exit 1; }
ppa=${1:-}
[[ $ppa == ppa:*/* ]] || die "usage: $0 ppa:<owner>/<name> [series...]"
shift
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || die "commit first: uploads are built from HEAD"
version=$(sed -n '1s/^servitals (\([^)]*\)).*/\1/p' "$SRC/debian/changelog")
[ -n "$version" ] || die "cannot read the version from debian/changelog"
upstream=${version%-*}
OUT="${OUT_DIR:-$SRC/build/ppa}"
in=$(mktemp -d)
trap 'rm -rf "$in"' EXIT
mkdir -p "$OUT"
# one orig tarball for every series: Launchpad refuses a second, different one
orig="$OUT/servitals_$upstream.orig.tar.gz"
if [ ! -e "$orig" ]; then
  git -C "$SRC" archive --format=tar --prefix="servitals-$upstream/" HEAD -- . ':(exclude)debian' | gzip -n -9 > "$orig"
fi
cp "$orig" "$in/"
git -C "$SRC" archive --format=tar HEAD debian > "$in/debian.tar"
pick_series "$@"
for series in "${SERIES[@]}"; do
  pv="$version~ppa${PPA_REV:-1}~${series}1"
  echo "== $series: servitals $pv"
  rm -rf "${OUT:?}/$series"
  docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$in:/in:ro" -v "$OUT:/out" -v "$SRC/packaging/docker/source-in.sh:/source-in.sh:ro" \
    "$(series_image "$series")" bash /source-in.sh "$series" "$pv"
  if [ "${UPLOAD:-0}" = 1 ]; then
    [ -n "${DEBSIGN_KEYID:-}" ] || die "set DEBSIGN_KEYID to the key Launchpad knows"
    debsign -k"$DEBSIGN_KEYID" "$OUT/$series"/*_source.changes
    dput "$ppa" "$OUT/$series"/*_source.changes
  fi
done
[ "${UPLOAD:-0}" = 1 ] || echo "dry run: source packages in $OUT/<series>/; UPLOAD=1 to sign and upload"
```

Run `chmod +x packaging/ppa-upload.sh packaging/docker/source-in.sh`.

- [ ] **Step 4: Dry run, and build binaries from the source package as Launchpad does**

Commit first (the script builds from `HEAD`), then:

```bash
git add test/deb-migrate.sh packaging/ppa-upload.sh packaging/docker/source-in.sh test/packaging.test.js
git commit -m "feat(packaging): PPA source packages per series; migration test from install-local.sh" -m "ppa-upload.sh builds <version>~ppa<N>~<series>1 source packages from HEAD with one shared orig tarball, and signs and uploads only with UPLOAD=1 on the maintainer's host. test/deb-migrate.sh moves an install-local.sh host to the packages and checks login, node and credentials survive."
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/ppa-upload.sh ppa:prabzo/servitals
docker run --rm -v "$PWD/build/ppa/noble:/in:ro" mirror.gcr.io/library/ubuntu:24.04 bash -c '
  set -e; export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update >/dev/null; apt-get -qq install -y --no-install-recommends build-essential dpkg-dev debhelper fakeroot >/dev/null
  cd /tmp && dpkg-source -x /in/*.dsc src >/dev/null && cd src && dpkg-checkbuilddeps && dpkg-buildpackage -b -us -uc >/dev/null && ls /tmp/*.deb'
```

Expected: `== noble: servitals 0.1.0~dev-1~ppa1~noble1`, `== resolute: ...~resolute1`, `dry run: source packages in .../build/ppa/<series>/`, then two `.deb` paths from the clean build.

- [ ] **Step 5: Run all tests**

Run: `node --test test/*.test.js`
Expected: PASS.

---

### Task 9: CI job, documentation

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `CHANGELOG.md`
- Create: `docs/release.md`

**Interfaces:**
- Consumes: all scripts above.
- Produces: CI job `deb` (build + lint + size, autopkgtest on both series, migration test, PPA dry run); install and release docs.

- [ ] **Step 1: CI job**

In `.github/workflows/ci.yml` add a job after `compose`:

```yaml
  deb:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - name: Build and lint the packages (noble, resolute)
        run: packaging/build-deb.sh
      - name: autopkgtest on booted testbeds
        run: packaging/autopkgtest.sh
      - name: Move from install-local.sh to the packages
        run: bash test/deb-migrate.sh resolute
      - name: PPA source packages (dry run)
        run: packaging/ppa-upload.sh ppa:prabzo/servitals
```

In the `lint` job's shellcheck step, add to the warning-level line: `packaging/*.sh packaging/docker/*.sh test/deb-migrate.sh debian/servitals.postinst debian/servitals.postrm debian/servitals-agent.postrm debian/tests/smoke debian/tests/purge`. In the `node --check` loop nothing changes (the new modules are under `hub/lib/`).

- [ ] **Step 2: README**

Add before `## Native install (systemd, no Docker)`:

````markdown
## Install on Ubuntu (24.04 and 26.04)

```bash
sudo add-apt-repository ppa:prabzo/servitals
sudo apt install servitals
sudo cat /var/lib/servitals/initial-password
```

Open `http://<host>:20002`, log in as `admin` with that password, then
change the name and password under settings → login (or
`sudo servitals-ctl passwd --user <name>`). The package pairs the local
agent and starts both services. `man servitals`, `man servitals-ctl` and
`man servitals-agent` describe the rest; settings live in
`/etc/servitals/hub.env` and `/etc/servitals/agent.env`.

Coming from `packaging/install-local.sh`: run
`sudo packaging/install-local.sh --uninstall`, then install the package
with `sudo apt install -o Dpkg::Options::=--force-confold servitals` to
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).
````

In the native install section, replace `Until the Ubuntu packages exist, install from a checkout.` with `To run a checkout without the packages (development), install it in the same layout:`.

- [ ] **Step 3: `docs/release.md`**

````markdown
# Releasing servitals

1. Set `VERSION` (for example `0.2.0`), move the `## [Unreleased]` notes in
   `CHANGELOG.md` under `## [0.2.0] - <date>`, and add a `debian/changelog`
   entry `servitals (0.2.0-1) resolute; urgency=medium` (`dch -v 0.2.0-1`).
   `test/version.test.js` checks that `VERSION` and `debian/changelog` agree.
2. `packaging/build-deb.sh && packaging/autopkgtest.sh`: both series build,
   lintian is clean, the autopkgtests pass.
3. Commit, tag `v0.2.0`, push the branch and the tag.
4. Upload to the PPA from a clean checkout of the tag:

   ```bash
   UPLOAD=1 DEBSIGN_KEYID=<your key id> packaging/ppa-upload.sh ppa:prabzo/servitals
   ```

   It builds `0.2.0-1~ppa1~noble1` and `~resolute1` source packages, signs
   them with `debsign` and uploads them with `dput`. To rebuild the same
   version, raise `PPA_REV=2`.
5. When Launchpad has built both series, test the published packages:

   ```bash
   PPA_SETUP=ppa:prabzo/servitals packaging/autopkgtest.sh
   ```

## One-time setup for uploads

- A Launchpad account with the PPA `servitals` (under the team or user in
  the `ppa:` name).
- A GPG key: `gpg --full-generate-key`, then
  `gpg --keyserver keyserver.ubuntu.com --send-keys <fingerprint>`, and add
  the fingerprint on Launchpad (OpenPGP keys) and confirm the emailed token.
- `sudo apt install devscripts dput` on the upload host. The key stays on
  that host; CI only builds the source packages as a dry run.
````

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]` → `### Added` add:

```markdown
- Ubuntu packages `servitals` and `servitals-agent` (noble, resolute) with a
  random first password in `/var/lib/servitals/initial-password`, the local
  agent paired on install, man pages, and autopkgtests.
- Change the admin name and password under settings → login or with
  `servitals-ctl passwd [--user NAME]`; both end every other session.
```

and under `### Changed`:

```markdown
- The admin login can live in `STATE_DIR/admin.json`, which wins over
  `AUTH_USER`/`AUTH_PASS_HASH`.
- The systemd units are hardened further: `systemd-analyze security` rates
  them 1.4 (hub) and 1.5 (agent), down from 7.8 and 7.9.
```

- [ ] **Step 5: Run everything, commit, push, read CI**

Run: `node --test test/*.test.js && bash test/budget.sh`, and shellcheck with the CI commands (`pipx run --spec shellcheck-py shellcheck ...`).
Expected: all pass.

```bash
git add .github/workflows/ci.yml README.md CHANGELOG.md docs/release.md
git commit -m "ci: package build, lint, autopkgtest and PPA dry run; docs for the PPA and releases"
```

Ask the user before pushing; then `git push -u origin feat/packaging`, open a PR, and read CI (`gh run watch`). Expected: every job green, `deb` in about 15 minutes.

---

### Task 10: Release 0.1.0

**Files:**
- Modify: `VERSION`, `CHANGELOG.md`, `debian/changelog`

**Interfaces:**
- Produces: version `0.1.0`, Debian `0.1.0-1`, tag `v0.1.0` (pushed only with the user's go-ahead).

- [ ] **Step 1: Bump**

- `VERSION`: `0.1.0`.
- `CHANGELOG.md`: rename `## [Unreleased]` to `## [0.1.0] - <today>` and add an empty `## [Unreleased]` above it.
- `debian/changelog`: replace the first line with `servitals (0.1.0-1) resolute; urgency=medium` and the trailer date with today's (`date -R`).

- [ ] **Step 2: Verify**

Run: `node --test test/*.test.js && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh && IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh`
Expected: PASS (the version test ties `VERSION` to `debian/changelog`); `servitals_0.1.0-1_all.deb`.

- [ ] **Step 3: Commit and tag**

```bash
git add VERSION CHANGELOG.md debian/changelog
git commit -m "release: 0.1.0"
git tag -a v0.1.0 -m "servitals 0.1.0: native packages for Ubuntu"
```

Merge the PR (user's decision), then push the tag only when the user says so: `git push origin v0.1.0`.

---

### Task 11: Publish to the PPA and move this host to the package

**Files:** none (operations). **Interfaces:** consumes everything above.

- [ ] **Step 1: One-time Launchpad setup (user)**

Confirm the PPA name (spec: `ppa:prabzo/servitals`; `prabzo` is an assumption). Follow `docs/release.md` "One-time setup for uploads". Record the key id.

- [ ] **Step 2: Upload (user, on this host, from the tag)**

```bash
git -C ~/projects/servitals fetch --tags && git -C ~/projects/servitals checkout v0.1.0
cd ~/projects/servitals && UPLOAD=1 DEBSIGN_KEYID=<key id> IMAGE_PREFIX=mirror.gcr.io/library/ packaging/ppa-upload.sh ppa:prabzo/servitals
git -C ~/projects/servitals checkout main
```

Expected: `dput` reports both uploads; Launchpad emails "Accepted"; both builds turn green on the PPA page (about 10-30 minutes).

- [ ] **Step 3: The "done when" check (Claude)**

Run: `PPA_SETUP=ppa:prabzo/servitals IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh`
Expected: `smoke PASS` and `purge PASS` on noble and resolute with the packages from the PPA. This is spec 20 row 3.

- [ ] **Step 4: Move this host from `install-local.sh` to the PPA (user, root)**

The live dashboard is down for about a minute.

```bash
cd ~/projects/servitals
sudo packaging/install-local.sh --uninstall
sudo add-apt-repository -y ppa:prabzo/servitals
sudo apt install -y -o Dpkg::Options::=--force-confold servitals
sudo servitals-agent docker enable
```

(`--uninstall` also removes the docker drop-ins, hence the last line; add `sudo servitals-ctl docker enable` only if the container buttons are wanted.)

- [ ] **Step 5: Verify on this host (Claude)**

```bash
systemctl is-active servitals servitals-agent
dpkg -l servitals servitals-agent | tail -n 2
curl -s -o /dev/null -w '%{http_code}\n' https://dash.shri.life/__auth/health
systemd-analyze security servitals.service servitals-agent.service --no-pager | grep -i overall
journalctl -u servitals -u servitals-agent --since -5min --no-pager | grep -E 'server.start|first_push|level=(warn|error)'
servitals-agent test | jq -c '{disks: [.disks[] | {mount, fstype}], net: .net.iface, today: .net.today.rx, containers: (.docker | length)}'
sudo -u _servitals-agent env AGENT_ENV=/etc/servitals/agent.env servitals-agent test >/dev/null && echo agent-user-ok
```

Expected: both `active`; version `0.1.0-1~ppa1~resolute1`; tunnel `200`; exposure about 1.4 and 1.5; `server.start ... login=env` (the Docker password is still in `hub.env`) and `api.first_push`; four disks with `/mnt/router-usb` as `cifs`, `eno1` with a non-zero `today` from vnStat (the only place vnStat runs under the new syscall filter; the autopkgtest testbed has no vnStat data), 17 containers (docker access through the drop-in works under the new hardening). Ask the user to log in on the dashboard and to change the login under settings → login, which moves it into `admin.json`.

- [ ] **Step 6: Handoff**

Run `/handoff`: sub-project 3 done, this host runs the PPA package, next is sub-project 4 (multi-node).
