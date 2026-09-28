# servitals Backups and Rotation (sub-project 4e) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back up and restore a hub with one command (optionally encrypted, optionally daily), and rotate node secrets and the session key without locking anyone out by surprise (spec 17).

**Architecture:** `servitals-ctl node rotate <id|--all>` gives a node a new secret and keeps the old one for 24 hours (`oldSecret`, `oldUntil` in `nodes.json`); the agent API accepts either while it lasts and signs each reply with the secret that matched; the hub's own agent is updated in place. `servitals-ctl rotate session-key` writes a new `STATE_DIR/secret` and restarts the hub. `servitals-ctl backup [--encrypt] <file>` stages the hub's state (without earlier backups), `/etc/servitals/hub.env` and `conf.d` plus a `manifest.json` and writes one 0600 tar (through `openssl enc` when encrypted, the passphrase via the environment). `servitals-ctl restore [--etc] <file>` reads and checks the whole backup first, then stops the hub, moves the current state aside, restores and starts it. `backup enable|disable` switches a hardened daily `servitals-backup.timer` that runs `backup --auto` and keeps the 7 newest.

**Tech Stack:** bash (`servitals-ctl`), tar, gzip, openssl (only for `--encrypt`), Node.js ≥ 18 (hub, tests), systemd timer, Debian packaging, autopkgtest.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 17 (backups and rotation), 12 (state files), 13.2 (unit hardening); `docs/threat-model.md` Rotation and Assets (backup files 0600, `--encrypt`).

**Scope:** `rotate vapid` (in the threat model's table) arrives with Web Push in sub-project 6; the relay key with sub-project 8. After 4e, 4f (ES modules, strict CSP, i18n, PWA shell) closes sub-project 4.

**Proven before writing:** every code block was built and run in a scratch copy of `feat/confd` (c1dfc3b) on 2026-09-28: node suite 258 tests, shellcheck, both series built and lintian clean, and autopkgtest smoke (now with a daily backup run and a restore) and purge on noble and resolute.

## Global Constraints

- Everything from sub-projects 1-4d still holds: zero runtime dependencies (openssl is optional and only for `--encrypt`; the package Suggests it), SPDX headers, lintian clean, systemd exposure of the two services ≤ 2.0, Node 18 compatibility.
- A backup file is created mode 0600 and never over an existing file; it holds the admin hash and every node secret. A passphrase never appears on a command line (`SERVITALS_BACKUP_PASSPHRASE` or the terminal; openssl gets it with `-pass env:`).
- `restore` changes nothing (and does not stop the hub) unless the whole backup was read and checked: format 1, a version not newer than the installed one, the right passphrase.
- Node rotation: the old secret works for exactly 24 hours after `rotate`, never after `revoke`; a reply is signed with the secret the request used; `list()` never shows either secret.
- Every temporary directory used by an `EXIT` trap is a global, never a `local` (this bit twice before).
- The daily backup unit keeps the hub unit's hardening set, including `SystemCallFilter=@system-service`; `debian/tests/smoke` runs it on noble and resolute.
- The live dashboard runs on this host. Tests run in temp dirs and containers only; `servitals-ctl` is always called with `STATE_DIR`, `ETC_DIR` and a `SYSTEMCTL` stub in tests.
- Work in a worktree `.claude/worktrees/servitals-backup` on branch `feat/backup` from `feat/confd` (c1dfc3b), or from `main` once the stacked PRs are merged.
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers. OpenWolf: log fixed bugs in `.wolf/buglog.json`.

## Review Focus

1. **A restore that should not happen** (wrong passphrase, damaged or foreign file, a backup from a newer servitals): nothing may change and the hub must keep running. Test: Task 3 "an encrypted backup needs its passphrase; a wrong one or a newer version changes nothing".
2. **Secrets leaking from backups**: file mode, an existing file overwritten, the passphrase on a command line, earlier backups inside a backup. Test: Task 3 "backup: one private tar…".
3. **Rotation cutting servers off early or never**: the overlap, the reply signature, the hub's own agent, revoke dropping both secrets. Tests: Task 1 all three.
4. **A restored hub that cannot start or read its state** (ownership, the safety copy, earlier backups). Tests: Task 3 "restore: stops the hub, keeps a copy…"; Task 4 smoke (owner `_servitals`, login after restore).
5. **The daily backup under its hardened unit on both series**: during proving, resolute's `tar -x` failed under the unit's seccomp filters (openat2 refused with ENOSYS), which is why staging uses `cp -a`. Test: Task 4 autopkgtest runs `servitals-backup.service`.

---

### Task 1: `node rotate` with a 24-hour overlap

**Files:**
- Modify: `hub/lib/nodes.js`, `hub/lib/agentapi.js`, `bin/servitals-ctl`, `test/nodes.test.js`, `test/multinode.test.js`, `test/cli.test.js`

**Interfaces:**
- Produces: store `rotate(id) → { id, secret }` (sets `oldSecret`, `oldUntil = now + 24 h`, `secret`), `revoke` also drops `oldSecret`/`oldUntil`; CLI `nodes.js <file> rotate <id>`; the agent API tries `secret`, then `oldSecret` while `oldUntil > now`, and signs replies (push and wait) with the one that matched; `servitals-ctl node rotate <id|--all>` via `rotate_node <id>` (prints `sudo servitals-agent join <url> <id>:<secret>` for remote nodes; rewrites `NODE_SECRET` in `$ETC_DIR/agent-credentials.env` and `$DATA_DIR/local-agent.env` for the local node and runs `$SYSTEMCTL try-restart servitals-agent.service`).

- [ ] **Step 1: Write the failing tests**

Append to `test/nodes.test.js`:

```js
test("rotate: a new secret, the old one kept for 24 hours; revoke drops both", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  const { id, secret: first } = store.add("nas");
  const before = Date.now();
  const { secret } = store.rotate(id);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(secret, first);
  const n = store.get(id);
  assert.deepStrictEqual([n.secret, n.oldSecret], [secret, first]);
  assert.ok(n.oldUntil >= before + 24 * 3600e3 && n.oldUntil <= Date.now() + 24 * 3600e3);
  assert.ok(!JSON.stringify(store.list()).includes(first), "never listed");
  store.revoke(id);
  const raw = JSON.parse(fs.readFileSync(f, "utf8"))[id];
  assert.deepStrictEqual([raw.secret, raw.oldSecret], ["", undefined]);
  assert.throws(() => store.rotate("aaaaaaaaaaaa"), /no node/);
});
```

Append to `test/multinode.test.js`:

```js
test("after a rotation both secrets work for 24 hours, each answered with its own signature; then only the new one", async () => {
  const hub = await startHub();
  try {
    const c = addNode(hub, "nas");
    const nodesFile = path.join(hub.dataDir, "nodes.json");
    const out = JSON.parse(execFileSync(process.execPath, [NODES_JS, nodesFile, "rotate", c.id]).toString());
    const fresh = { id: c.id, secret: out.secret };
    const { signReply } = require("../hub/lib/agentsig");
    let r = await signed(hub, c, { body: snap() });
    assert.strictEqual(r.status, 200, "the old secret, within 24 hours");
    assert.strictEqual(r.headers["x-servitals-sig"], signReply(c.secret, r.ts, r.body), "answered with the old secret");
    await sleep(5100);
    r = await signed(hub, fresh, { body: snap() });
    assert.strictEqual(r.status, 200, "the new secret");
    assert.strictEqual(r.headers["x-servitals-sig"], signReply(fresh.secret, r.ts, r.body));
    const all = JSON.parse(fs.readFileSync(nodesFile, "utf8"));
    all[c.id].oldUntil = Date.now() - 1;
    fs.writeFileSync(nodesFile, JSON.stringify(all));
    await sleep(5100);
    r = await signed(hub, c, { body: snap() });
    assert.deepStrictEqual([r.status, JSON.parse(r.body).error], [401, "bad_signature"], "after 24 hours the old one is refused");
  } finally { await hub.stop(); }
});
```

Append to `test/cli.test.js`:

```js
test("servitals-ctl node rotate prints new join lines; the hub's own agent is updated in place", () => {
  const state = tmp(), etc = tmp();
  fs.writeFileSync(path.join(etc, "hub.env"), "PUBLIC_URL=https://hub.example\n");
  const node = (args) => JSON.parse(spawnSync(process.execPath, [path.join(__dirname, "..", "hub", "lib", "nodes.js"),
    path.join(state, "nodes.json"), ...args], { encoding: "utf8" }).stdout);
  const nas = node(["add", "nas"]);
  // the hub's own node, as the hub creates it
  const all = JSON.parse(fs.readFileSync(path.join(state, "nodes.json"), "utf8"));
  all.localnodeid2 = { name: "hub", secret: "11".repeat(32), local: true, created: 1 };
  fs.writeFileSync(path.join(state, "nodes.json"), JSON.stringify(all));
  fs.writeFileSync(path.join(etc, "agent-credentials.env"), `HUB_URL=http://127.0.0.1:20002\nNODE_ID=localnodeid2\nNODE_SECRET=${"11".repeat(32)}\n`, { mode: 0o600 });
  const calls = path.join(state, "calls");
  const stub = path.join(state, "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });

  let r = run("servitals-ctl", ["node", "rotate", nas.id], { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /sudo servitals-agent join https:\/\/hub\.example ([a-z2-7]{12}):([0-9a-f]{64})/.exec(r.stdout);
  assert.ok(m && m[1] === nas.id && m[2] !== nas.secret, r.stdout);
  assert.match(r.stdout, /old secret keeps working for 24 hours/);

  r = run("servitals-ctl", ["node", "rotate", "--all"], { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  const creds = fs.readFileSync(path.join(etc, "agent-credentials.env"), "utf8");
  const secret = /^NODE_SECRET=([0-9a-f]{64})$/m.exec(creds)[1];
  assert.notStrictEqual(secret, "11".repeat(32));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, "nodes.json"), "utf8")).localnodeid2.secret, secret);
  assert.strictEqual(fs.statSync(path.join(etc, "agent-credentials.env")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(calls, "utf8"), /^try-restart servitals-agent\.service$/m);
  assert.match(r.stdout, /the hub's own agent was updated/);
  assert.strictEqual((r.stdout.match(/sudo servitals-agent join/g) || []).length, 1, "a join line for the remote node only");
  assert.notStrictEqual(run("servitals-ctl", ["node", "rotate", "aaaaaaaaaaaa"], { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub }).status, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/nodes.test.js test/multinode.test.js test/cli.test.js`
Expected: FAIL, 3 tests: `store.rotate is not a function`, `nodes.js … rotate` prints the usage text, `servitals-ctl node rotate` prints the usage text.

- [ ] **Step 3: The node store**

In `hub/lib/nodes.js`:

1. Replace

```js
    n.revoked = true;
    n.secret = "";
  });

  // every node that is not revoked, without secrets
```

   with

```js
    n.revoked = true;
    n.secret = "";
    delete n.oldSecret;
    delete n.oldUntil;
  });
  // a new secret; the old one keeps working for 24 hours (spec 17)
  const OVERLAP_MS = 24 * 3600e3;
  function rotate(id) {
    const secret = crypto.randomBytes(32).toString("hex");
    change(id, (n) => {
      n.oldSecret = n.secret;
      n.oldUntil = Date.now() + OVERLAP_MS;
      n.secret = secret;
    });
    return { id, secret };
  }

  // every node that is not revoked, without secrets
```

2. Replace

```js
  }

  return { get, localId, ensureLocal, check, add, rename, setTags, revoke, list, all: load };
}

```

   with

```js
  }

  return { get, localId, ensureLocal, check, add, rename, setTags, revoke, rotate, list, all: load };
}

```

3. Replace

```js
module.exports = { createNodeStore, newNodeId, localAgentEnv };

// CLI for servitals-ctl: node nodes.js <nodes.json> add <name> [tag...] | list | rename <id> <name> | revoke <id>
if (require.main === module) {
  const [file, cmd, ...args] = process.argv.slice(2);
```

   with

```js
module.exports = { createNodeStore, newNodeId, localAgentEnv };

// CLI for servitals-ctl: node nodes.js <nodes.json> add <name> [tag...] | list | rename <id> <name> | revoke <id> | rotate <id>
if (require.main === module) {
  const [file, cmd, ...args] = process.argv.slice(2);
```

4. Replace

```js
    else if (cmd === "rename") { store.rename(args[0], args[1]); out = { ok: true }; }
    else if (cmd === "revoke") { store.revoke(args[0]); out = { ok: true }; }
    else throw new Error("usage: nodes.js <nodes.json> add|list|rename|revoke ...");
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
```

   with

```js
    else if (cmd === "rename") { store.rename(args[0], args[1]); out = { ok: true }; }
    else if (cmd === "revoke") { store.revoke(args[0]); out = { ok: true }; }
    else if (cmd === "rotate") out = store.rotate(args[0]);
    else throw new Error("usage: nodes.js <nodes.json> add|list|rename|revoke|rotate ...");
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
```

- [ ] **Step 4: The agent API**

In `hub/lib/agentapi.js`:

1. Replace

```js
    const body = await readLimited(req, maxBody);
    if (body === null) return tooLarge();
    if (!verifyRequest(node.secret, req.method, pathname, tsRaw, body, h["x-servitals-sig"])) {
      failed(who);
      log.warn("api.refused", { node: id, error: "bad_signature" });
```

   with

```js
    const body = await readLimited(req, maxBody);
    if (body === null) return tooLarge();
    // after a rotation the old secret works for 24 hours; the reply is signed with the one that matched
    const candidates = [node.secret];
    if (node.oldSecret && Number(node.oldUntil) > hubMs) candidates.push(node.oldSecret);
    const secret = candidates.find((s) => verifyRequest(s, req.method, pathname, tsRaw, body, h["x-servitals-sig"]));
    if (!secret) {
      failed(who);
      log.warn("api.refused", { node: id, error: "bad_signature" });
```

2. Replace

```js
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, checked.value);
      return reply(res, 200, node.secret, tsRaw, { ok: true });
    }

```

   with

```js
      if (!seen.has(id)) { seen.add(id); log.info("api.first_push", { node: id }); }
      onSnapshot(id, checked.value);
      return reply(res, 200, secret, tsRaw, { ok: true });
    }

```

3. Replace

```js
    const prev = waiters.get(id);
    if (prev) finishWait(id, prev, 204);   // a reconnecting agent is never locked out
    const w = { res, secret: node.secret, ts: tsRaw };
    w.timer = setTimeout(() => finishWait(id, w, 204), clampWait(h["x-servitals-wait"]) * 1000);
    waiters.set(id, w);
```

   with

```js
    const prev = waiters.get(id);
    if (prev) finishWait(id, prev, 204);   // a reconnecting agent is never locked out
    const w = { res, secret, ts: tsRaw };
    w.timer = setTimeout(() => finishWait(id, w, 204), clampWait(h["x-servitals-wait"]) * 1000);
    waiters.set(id, w);
```

- [ ] **Step 5: The command**

In `bin/servitals-ctl`:

1. Replace

```bash
#   servitals-ctl node list            list servers (id, name, tags, last push)
#   servitals-ctl node rename <id> <name> | node revoke <id>
#   servitals-ctl bans                 list blocked IPs and the whitelist
#   servitals-ctl unban <ip>           remove a block (takes effect immediately)
```

   with

```bash
#   servitals-ctl node list            list servers (id, name, tags, last push)
#   servitals-ctl node rename <id> <name> | node revoke <id>
#   servitals-ctl node rotate <id|--all> new secrets; the old ones work for 24 hours
#   servitals-ctl bans                 list blocked IPs and the whitelist
#   servitals-ctl unban <ip>           remove a block (takes effect immediately)
```

2. Replace

```bash
}

cmd_node() {
  local sub=${1:-} out id at
```

   with

```bash
}

# rotate one node's secret. The hub's own agent gets the new secret at once;
# every other server needs the printed join line within 24 hours.
rotate_node() {  # id
  local id=$1 out secret is_local name creds="$ETC_DIR/agent-credentials.env"
  out=$(nodes_js rotate "$id") || exit 1
  secret=$(jq -r .secret <<< "$out")
  is_local=$(nodes_js list | jq -r --arg id "$id" '.[] | select(.id == $id) | .local')
  name=$(nodes_js list | jq -r --arg id "$id" '.[] | select(.id == $id) | .name')
  if [ "$is_local" = true ]; then
    if [ -f "$creds" ] && grep -qx "NODE_ID=$id" "$creds"; then
      sed "s/^NODE_SECRET=.*/NODE_SECRET=$secret/" "$creds" | atomic_write "$creds"
    fi
    if [ -f "$DATA_DIR/local-agent.env" ]; then
      sed "s/^NODE_SECRET=.*/NODE_SECRET=$secret/" "$DATA_DIR/local-agent.env" | atomic_write "$DATA_DIR/local-agent.env"
    fi
    "${SYSTEMCTL:-systemctl}" try-restart servitals-agent.service >/dev/null 2>&1 || true
    echo "rotated \"$name\" ($id): the hub's own agent was updated"
  else
    echo "rotated \"$name\" ($id); the old secret keeps working for 24 hours. On that server run:"
    echo "  sudo servitals-agent join $(hub_url) $id:$secret"
  fi
}

cmd_node() {
  local sub=${1:-} out id at
```

3. Replace

```bash
      nodes_js revoke "$1" >/dev/null && echo "revoked $1: its agent is refused from now on"
      ;;
    *) die "usage: servitals-ctl node add|list|rename|revoke" ;;
  esac
}
```

   with

```bash
      nodes_js revoke "$1" >/dev/null && echo "revoked $1: its agent is refused from now on"
      ;;
    rotate)
      [ $# -eq 1 ] || die "usage: servitals-ctl node rotate <id|--all>"
      local ids
      if [ "$1" = --all ]; then ids=$(nodes_js list | jq -r '.[].id'); else ids=$1; fi
      for id in $ids; do rotate_node "$id"; done
      ;;
    *) die "usage: servitals-ctl node add|list|rename|revoke|rotate" ;;
  esac
}
```

4. Replace

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

   with

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

- [ ] **Step 6: Run the tests and shellcheck**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-ctl`
Expected: PASS (3 new tests; the push test waits about 10 s for the push rate limit), no shellcheck output.

- [ ] **Step 7: Commit**

```bash
git add hub/lib/nodes.js hub/lib/agentapi.js bin/servitals-ctl test/nodes.test.js test/multinode.test.js test/cli.test.js
git commit -m "feat(ctl): node rotate: new secrets, the old ones accepted for 24 hours" -m "servitals-ctl node rotate <id|--all> prints a new join line per server; the hub's own agent gets its new secret at once. The agent API accepts the old secret for 24 hours and answers with the secret the request used. revoke drops both."
```

---

### Task 2: `rotate session-key`

**Files:**
- Modify: `bin/servitals-ctl`, `test/cli.test.js`

**Interfaces:**
- Produces: `servitals-ctl rotate session-key` (64 new hex characters into `$DATA_DIR/secret` through `atomic_write`, keeping owner and mode; `$SYSTEMCTL try-restart servitals.service`); any other `rotate` argument prints the usage and exits 1.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.js`:

```js
test("servitals-ctl rotate session-key: a new key, same owner and mode, the hub restarts, every session ends", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hub-"));   // kept across the two hubs
  const hub = await startHub({}, { dataDir });
  const port = hub.port;
  const cookie = cookieFrom(await login(port));
  assert.strictEqual((await request(port, { path: "/__ctl/whoami", headers: { cookie } })).status, 200);
  await hub.stop();
  const key = path.join(dataDir, "secret");
  const before = fs.readFileSync(key, "utf8");
  const calls = path.join(tmp(), "calls");
  const stub = path.join(path.dirname(calls), "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
  const r = run("servitals-ctl", ["rotate", "session-key"], { STATE_DIR: dataDir, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /every session ends/);
  const after = fs.readFileSync(key, "utf8");
  assert.match(after, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(after, before);
  assert.strictEqual(fs.statSync(key).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(calls, "utf8"), /^try-restart servitals\.service$/m);
  const again = await startHub({}, { dataDir, port });
  try {
    assert.strictEqual((await request(port, { path: "/__ctl/whoami", headers: { cookie } })).status, 401, "the old session is gone");
  } finally { await again.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.notStrictEqual(run("servitals-ctl", ["rotate", "vapid"], { STATE_DIR: dataDir }).status, 0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --test-name-pattern="session-key" test/cli.test.js`
Expected: FAIL: `1 !== 0` (`servitals-ctl rotate` prints the usage text).

- [ ] **Step 3: The command**

In `bin/servitals-ctl`:

1. Replace

```bash
#   servitals-ctl passwd [--user NAME] set the admin password (and name); ends every session
#   servitals-ctl config check [dir]   check the files in /etc/servitals/conf.d (config as code)
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail
```

   with

```bash
#   servitals-ctl passwd [--user NAME] set the admin password (and name); ends every session
#   servitals-ctl config check [dir]   check the files in /etc/servitals/conf.d (config as code)
#   servitals-ctl rotate session-key   a new session signing key; every session ends
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail
```

2. Replace

```bash
}

cmd_config() {
  case "${1:-}" in
```

   with

```bash
}

cmd_rotate() {
  case "${1:-}" in
    session-key)
      [ -f "$DATA_DIR/secret" ] || die "no session key in $DATA_DIR (has the hub run yet?)"
      od -An -tx1 -N32 /dev/urandom | tr -d ' \n' | atomic_write "$DATA_DIR/secret"
      "${SYSTEMCTL:-systemctl}" try-restart "$UNIT" >/dev/null 2>&1 || true
      echo "new session key in $DATA_DIR/secret; the hub restarted and every session ends (log in again)"
      ;;
    *) die "usage: servitals-ctl rotate session-key" ;;
  esac
}

cmd_config() {
  case "${1:-}" in
```

3. Replace

```bash
  node) shift; cmd_node "$@" ;;
  config) shift; cmd_config "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

   with

```bash
  node) shift; cmd_node "$@" ;;
  config) shift; cmd_config "$@" ;;
  rotate) shift; cmd_rotate "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

4. Replace

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

   with

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test).

- [ ] **Step 5: Commit**

```bash
git add bin/servitals-ctl test/cli.test.js
git commit -m "feat(ctl): rotate session-key" -m "A new session signing key in the state directory (same owner and mode); the hub restarts and every browser logs in again."
```

---

### Task 3: Backup, restore and daily backups

**Files:**
- Create: `debian/servitals.servitals-backup.service`, `debian/servitals.servitals-backup.timer`
- Modify: `bin/servitals-ctl`, `debian/rules`, `packaging/install-local.sh`, `test/cli.test.js`, `test/packaging.test.js`

**Interfaces:**
- Produces: `servitals-ctl backup [--encrypt] <file>` (`backup written: <file>[ (encrypted)]`), `backup --auto` (`$DATA_DIR/backups/servitals-<YYYYmmdd-HHMMSS>-<pid>.tar.gz`, the 7 newest kept), `backup enable|disable` (`$SYSTEMCTL enable|disable --now servitals-backup.timer`), `restore [--etc] <file>` (prints `the state before the restore is in <dir>`); archive layout `./manifest.json` (`{ format: 1, version, created, host }`), `./state/…`, `./etc/hub.env`, `./etc/conf.d/…`; helpers `sv_version`, `backup_passphrase [twice]`; units `servitals-backup.service` (oneshot, hardened) and `.timer` (daily, off until enabled).

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
// a hub's state and /etc/servitals, as tests make them
function hubFiles() {
  const state = tmp(), etc = tmp();
  fs.writeFileSync(path.join(state, "nodes.json"), '{"a":1}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(state, "admin.json"), '{"user":"admin"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(state, "secret"), "ab".repeat(32), { mode: 0o600 });
  fs.mkdirSync(path.join(state, "snapshots"));
  fs.writeFileSync(path.join(state, "snapshots", "a.json"), "{}");
  fs.mkdirSync(path.join(state, "backups"));
  fs.writeFileSync(path.join(state, "backups", "old.tar.gz"), "x");
  fs.writeFileSync(path.join(etc, "hub.env"), "PORT=20002\n");
  fs.mkdirSync(path.join(etc, "conf.d"));
  fs.writeFileSync(path.join(etc, "conf.d", "10-site.json"), '{"settings":{"title":"lab"}}');
  const calls = path.join(tmp(), "calls");
  const stub = path.join(path.dirname(calls), "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
  return { state, etc, calls, env: { STATE_DIR: state, ETC_DIR: etc, SYSTEMCTL: stub } };
}
const list = (file) => spawnSync("tar", ["-tzf", file], { encoding: "utf8" });

test("backup: one private tar of the hub's state and /etc/servitals, never over an existing file", () => {
  const h = hubFiles();
  const out = path.join(tmp(), "hub.tar.gz");
  const r = run("servitals-ctl", ["backup", out], h.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^backup written: .*hub\.tar\.gz/m);
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600, "it holds the admin hash and node secrets");
  const names = list(out).stdout.split("\n").map((n) => n.replace(/^\.\//, "")).filter(Boolean);
  for (const n of ["manifest.json", "state/nodes.json", "state/admin.json", "state/secret", "state/snapshots/a.json", "etc/hub.env", "etc/conf.d/10-site.json"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => n.startsWith("state/backups")), "not the backups themselves");
  const manifest = JSON.parse(spawnSync("tar", ["-xzOf", out, "./manifest.json"], { encoding: "utf8" }).stdout);
  assert.strictEqual(manifest.format, 1);
  assert.strictEqual(manifest.version, fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim());
  assert.notStrictEqual(run("servitals-ctl", ["backup", out], h.env).status, 0, "an existing file is never replaced");
});

test("restore: stops the hub, keeps a copy of the current state, puts the backup back, starts the hub", () => {
  const h = hubFiles();
  const out = path.join(tmp(), "hub.tar.gz");
  assert.strictEqual(run("servitals-ctl", ["backup", out], h.env).status, 0);
  fs.writeFileSync(path.join(h.state, "nodes.json"), '{"changed":true}\n');
  fs.writeFileSync(path.join(h.etc, "conf.d", "10-site.json"), '{"changed":true}');
  let r = run("servitals-ctl", ["restore", out], h.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(h.state, "nodes.json"), "utf8"), '{"a":1}\n');
  assert.strictEqual(fs.statSync(path.join(h.state, "nodes.json")).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(h.state, "backups", "old.tar.gz")), "earlier backups stay");
  const kept = /the state before the restore is in (\S+)/.exec(r.stdout)[1];
  assert.strictEqual(fs.readFileSync(path.join(kept, "nodes.json"), "utf8"), '{"changed":true}\n');
  assert.strictEqual(fs.readFileSync(path.join(h.etc, "conf.d", "10-site.json"), "utf8"), '{"changed":true}', "/etc only with --etc");
  assert.deepStrictEqual(fs.readFileSync(h.calls, "utf8").trim().split("\n"), ["stop servitals.service", "start servitals.service"]);
  r = run("servitals-ctl", ["restore", "--etc", out], h.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(h.etc, "conf.d", "10-site.json"), "utf8"), '{"settings":{"title":"lab"}}');
});

test("an encrypted backup needs its passphrase; a wrong one or a newer version changes nothing", () => {
  const h = hubFiles();
  const out = path.join(tmp(), "hub.tar.gz.enc");
  let r = run("servitals-ctl", ["backup", "--encrypt", out], { ...h.env, SERVITALS_BACKUP_PASSPHRASE: "correct horse" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(out).subarray(0, 8).toString(), "Salted__");
  assert.notStrictEqual(list(out).status, 0, "not readable without the passphrase");
  fs.writeFileSync(path.join(h.state, "nodes.json"), '{"changed":true}\n');
  r = run("servitals-ctl", ["restore", out], { ...h.env, SERVITALS_BACKUP_PASSPHRASE: "wrong" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /wrong passphrase or a damaged file/);
  assert.strictEqual(fs.readFileSync(path.join(h.state, "nodes.json"), "utf8"), '{"changed":true}\n');
  assert.ok(!fs.existsSync(h.calls), "the hub was not stopped");
  r = run("servitals-ctl", ["restore", out], { ...h.env, SERVITALS_BACKUP_PASSPHRASE: "correct horse" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(h.state, "nodes.json"), "utf8"), '{"a":1}\n');

  // a backup from a newer servitals
  const staged = tmp();
  fs.writeFileSync(path.join(staged, "manifest.json"), JSON.stringify({ format: 1, version: "99.0.0" }));
  fs.mkdirSync(path.join(staged, "state"));
  const newer = path.join(tmp(), "newer.tar.gz");
  spawnSync("tar", ["-C", staged, "-czf", newer, "."]);
  r = run("servitals-ctl", ["restore", newer], h.env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /made by servitals 99\.0\.0, newer than this one/);
});

test("backup --auto keeps the 7 newest in the state dir; backup enable and disable switch the daily timer", () => {
  const h = hubFiles();
  fs.rmSync(path.join(h.state, "backups"), { recursive: true });
  for (let i = 0; i < 9; i++) assert.strictEqual(run("servitals-ctl", ["backup", "--auto"], h.env).status, 0);
  const kept = fs.readdirSync(path.join(h.state, "backups"));
  assert.strictEqual(kept.length, 7);
  assert.ok(kept.every((n) => /^servitals-\d{8}-\d{6}-\d+\.tar\.gz$/.test(n)), kept.join(" "));
  assert.strictEqual(fs.statSync(path.join(h.state, "backups")).mode & 0o777, 0o700);
  let r = run("servitals-ctl", ["backup", "enable"], h.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /daily backups on: 7 kept in .*backups/);
  r = run("servitals-ctl", ["backup", "disable"], h.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readFileSync(h.calls, "utf8").trim().split("\n"),
    ["enable --now servitals-backup.timer", "disable --now servitals-backup.timer"]);
});
```

Append to `test/packaging.test.js`:

```js
test("daily backups: a hardened oneshot service and a daily timer, shipped off", () => {
  const svc = lines(read("debian/servitals.servitals-backup.service"));
  for (const want of ["Type=oneshot", "ExecStart=/usr/bin/servitals-ctl backup --auto", "UMask=0077", "ProtectSystem=strict",
                      "ReadWritePaths=-/var/lib/servitals/backups", "PrivateTmp=yes", "NoNewPrivileges=yes", "ProtectHome=yes"]) {
    assert.ok(svc.includes(want), want);
  }
  assert.ok(svc.includes("SystemCallFilter=@system-service"));
  const timer = lines(read("debian/servitals.servitals-backup.timer"));
  for (const want of ["OnCalendar=daily", "Persistent=true", "WantedBy=timers.target"]) assert.ok(timer.includes(want), want);
  assert.match(read("debian/rules"), /dh_installsystemd -pservitals --name=servitals-backup --no-enable --no-start/);
  assert.match(read("packaging/install-local.sh"), /debian\/servitals\.servitals-backup\.service" "\$UNITS\/servitals-backup\.service"/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/cli.test.js test/packaging.test.js`
Expected: FAIL, 5 tests: `backup` and `restore` print the usage text; the unit files do not exist. The old `servitals-ctl backup enable` takes `enable` as a file name and leaves a file called `enable` in the working directory: delete it (`rm enable`).

- [ ] **Step 3: The commands**

In `bin/servitals-ctl`:

1. Replace

```bash
#   servitals-ctl config check [dir]   check the files in /etc/servitals/conf.d (config as code)
#   servitals-ctl rotate session-key   a new session signing key; every session ends
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail
```

   with

```bash
#   servitals-ctl config check [dir]   check the files in /etc/servitals/conf.d (config as code)
#   servitals-ctl rotate session-key   a new session signing key; every session ends
#   servitals-ctl backup [--encrypt] <file>  one private tar of the hub's state and /etc/servitals
#   servitals-ctl restore [--etc] <file>     put a backup back (stops and starts the hub)
#   servitals-ctl backup enable|disable      daily backups, the 7 newest kept in the state dir
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail
```

2. Replace

```bash
}

cmd_rotate() {
  case "${1:-}" in
```

   with

```bash
}

# ---- backups (spec 17): one private tar of the hub's state and /etc/servitals
sv_version() { head -n 1 "$ROOT/VERSION" 2>/dev/null || echo 0; }

# the passphrase: SERVITALS_BACKUP_PASSPHRASE, else asked on the terminal
backup_passphrase() {  # [twice]
  local a b
  if [ -n "${SERVITALS_BACKUP_PASSPHRASE:-}" ]; then printf '%s' "$SERVITALS_BACKUP_PASSPHRASE"; return; fi
  [ -r /dev/tty ] || die "set SERVITALS_BACKUP_PASSPHRASE, or run this in a terminal"
  read -rsp "passphrase: " a < /dev/tty; echo >&2
  if [ "${1:-}" = twice ]; then
    read -rsp "passphrase again: " b < /dev/tty; echo >&2
    [ "$a" = "$b" ] || die "the two passphrases differ"
  fi
  [ -n "$a" ] || die "the passphrase is empty"
  printf '%s' "$a"
}

cmd_backup() {
  local encrypt=0 auto=0 out="" pass
  case "${1:-}" in
    enable)
      install -d -m 700 "$DATA_DIR/backups"
      "${SYSTEMCTL:-systemctl}" enable --now servitals-backup.timer
      echo "daily backups on: 7 kept in $DATA_DIR/backups (not encrypted: copy them somewhere safe)"
      return ;;
    disable)
      "${SYSTEMCTL:-systemctl}" disable --now servitals-backup.timer
      echo "daily backups off; the ones in $DATA_DIR/backups stay"
      return ;;
  esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --encrypt) encrypt=1 ;;
      --auto) auto=1 ;;
      -*) die "usage: servitals-ctl backup [--encrypt] <file>" ;;
      *) out=$1 ;;
    esac
    shift
  done
  if [ "$auto" = 1 ]; then
    install -d -m 700 "$DATA_DIR/backups"
    out="$DATA_DIR/backups/servitals-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
  fi
  [ -n "$out" ] || die "usage: servitals-ctl backup [--encrypt] <file>"
  [ ! -e "$out" ] || die "$out exists; choose another name"
  [ -d "$DATA_DIR" ] || die "no hub state in $DATA_DIR"
  [ "$encrypt" = 0 ] || command -v openssl >/dev/null || die "--encrypt needs openssl (apt install openssl)"
  # global, not local: the EXIT trap runs after this function has returned
  BACKUP_DIR=$(mktemp -d)
  trap 'rm -rf "$BACKUP_DIR"' EXIT
  chmod 700 "$BACKUP_DIR"
  mkdir "$BACKUP_DIR/state" "$BACKUP_DIR/etc"
  # cp, not tar -x: under the backup unit's filters tar on newer releases cannot create
  # files in subdirectories (openat2 is refused with ENOSYS)
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name backups -exec cp -a -t "$BACKUP_DIR/state/" {} +
  if [ -r "$ETC_DIR/hub.env" ]; then cp -p "$ETC_DIR/hub.env" "$BACKUP_DIR/etc/"; fi
  if [ -d "$ETC_DIR/conf.d" ]; then cp -rp "$ETC_DIR/conf.d" "$BACKUP_DIR/etc/"; fi
  jq -n --arg v "$(sv_version)" --arg h "$(hostname 2>/dev/null || echo unknown)" --arg t "$(date -u +%FT%TZ)" \
    '{format: 1, version: $v, created: $t, host: $h}' > "$BACKUP_DIR/manifest.json"
  if [ "$encrypt" = 1 ]; then
    pass=$(backup_passphrase twice)
    # the passphrase goes through the environment, never the command line (ps shows that)
    (umask 077; tar -C "$BACKUP_DIR" -czf - . | SV_BACKUP_PASS="$pass" openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
       -pass env:SV_BACKUP_PASS -out "$out")
  else
    (umask 077; tar -C "$BACKUP_DIR" -czf "$out" .)
  fi
  chmod 600 "$out"
  echo "backup written: $out$([ "$encrypt" = 1 ] && echo " (encrypted)")"
  if [ "$auto" = 1 ]; then   # keep the 7 newest
    find "$DATA_DIR/backups" -maxdepth 1 -name 'servitals-*.tar.gz' -printf '%T@ %p\n' | sort -rn | tail -n +8 | cut -d' ' -f2- |
      while IFS= read -r old; do rm -f -- "$old"; done
  fi
}

cmd_restore() {
  local with_etc=0 in="" pass made here keep
  while [ $# -gt 0 ]; do
    case "$1" in
      --etc) with_etc=1 ;;
      -*) die "usage: servitals-ctl restore [--etc] <file>" ;;
      *) in=$1 ;;
    esac
    shift
  done
  [ -n "$in" ] && [ -f "$in" ] || die "usage: servitals-ctl restore [--etc] <file>"
  # global, not local: the EXIT trap runs after this function has returned
  RESTORE_DIR=$(mktemp -d)
  trap 'rm -rf "$RESTORE_DIR"' EXIT
  chmod 700 "$RESTORE_DIR"
  if [ "$(head -c 8 "$in" | tr -d '\000')" = "Salted__" ]; then   # openssl's header
    command -v openssl >/dev/null || die "this backup is encrypted; restoring it needs openssl"
    pass=$(backup_passphrase)
    SV_BACKUP_PASS="$pass" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:SV_BACKUP_PASS -in "$in" 2>/dev/null |
      tar -C "$RESTORE_DIR" -xzf - 2>/dev/null || die "could not read $in: a wrong passphrase or a damaged file"
  else
    tar -C "$RESTORE_DIR" -xzf "$in" 2>/dev/null || die "could not read $in: not a servitals backup, or damaged"
  fi
  [ -f "$RESTORE_DIR/manifest.json" ] && [ -d "$RESTORE_DIR/state" ] || die "$in is not a servitals backup"
  [ "$(jq -r .format "$RESTORE_DIR/manifest.json")" = 1 ] || die "$in has a backup format this servitals does not know"
  made=$(jq -r '.version // "0"' "$RESTORE_DIR/manifest.json")
  here=$(sv_version)
  if [ "$(printf '%s\n%s\n' "$made" "$here" | sort -V | tail -n 1)" != "$here" ]; then
    die "$in was made by servitals $made, newer than this one ($here); update servitals first"
  fi
  "${SYSTEMCTL:-systemctl}" stop "$UNIT" >/dev/null 2>&1 || true
  keep=$(mktemp -d "$DATA_DIR.before-restore-$(date +%Y%m%d-%H%M%S)-XXXX")   # 0700, never an old one
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name backups -exec mv -t "$keep" {} +
  cp -a "$RESTORE_DIR/state/." "$DATA_DIR/"
  chown -R --reference="$DATA_DIR" "$DATA_DIR" 2>/dev/null || true
  if [ "$with_etc" = 1 ]; then
    if [ -f "$RESTORE_DIR/etc/hub.env" ]; then cp -p "$RESTORE_DIR/etc/hub.env" "$ETC_DIR/hub.env"; fi
    if [ -d "$RESTORE_DIR/etc/conf.d" ]; then install -d -m 755 "$ETC_DIR/conf.d"; cp -rp "$RESTORE_DIR/etc/conf.d/." "$ETC_DIR/conf.d/"; fi
  fi
  "${SYSTEMCTL:-systemctl}" start "$UNIT" >/dev/null 2>&1 || true
  echo "restored $in (made by servitals $made)$([ "$with_etc" = 1 ] && echo ", with /etc/servitals")"
  echo "the state before the restore is in $keep"
}

cmd_rotate() {
  case "${1:-}" in
```

3. Replace

```bash
  config) shift; cmd_config "$@" ;;
  rotate) shift; cmd_rotate "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

   with

```bash
  config) shift; cmd_config "$@" ;;
  rotate) shift; cmd_rotate "$@" ;;
  backup) shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

4. Replace

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

   with

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

- [ ] **Step 4: The daily unit and timer**

Create `debian/servitals.servitals-backup.service`:

```ini
# SPDX-License-Identifier: AGPL-3.0-or-later
# Daily backup of the hub's state (servitals-ctl backup enable turns on the timer).
[Unit]
Description=servitals daily backup of the hub's state
Documentation=man:servitals-ctl(1)

[Service]
Type=oneshot
ExecStart=/usr/bin/servitals-ctl backup --auto
UMask=0077
ProtectSystem=strict
ReadWritePaths=-/var/lib/servitals/backups
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateNetwork=yes
NoNewPrivileges=yes
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
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service
```

Create `debian/servitals.servitals-backup.timer`:

```ini
# SPDX-License-Identifier: AGPL-3.0-or-later
[Unit]
Description=servitals daily backup of the hub's state
Documentation=man:servitals-ctl(1)

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

In `debian/rules`:

1. Replace

```
override_dh_installsystemd:
	dh_installsystemd -pservitals --no-start
	dh_installsystemd -pservitals-agent

```

   with

```
override_dh_installsystemd:
	dh_installsystemd -pservitals --no-start
	dh_installsystemd -pservitals --name=servitals-backup --no-enable --no-start
	dh_installsystemd -pservitals-agent

```

In `packaging/install-local.sh`:

1. Replace

```bash

if [ "${1:-}" = --uninstall ]; then
  systemctl disable --now servitals-agent.service servitals.service 2>/dev/null || true
  rm -rf "$SHARE" "$AGENT_LIB" "$UNITS/servitals.service.d" "$UNITS/servitals-agent.service.d"
  rm -f "$UNITS/servitals.service" "$UNITS/servitals-agent.service" \
        /usr/bin/servitals-ctl /usr/bin/servitals-agent \
        /usr/lib/sysusers.d/servitals.conf /usr/lib/sysusers.d/servitals-agent.conf
```

   with

```bash

if [ "${1:-}" = --uninstall ]; then
  systemctl disable --now servitals-agent.service servitals.service servitals-backup.timer 2>/dev/null || true
  rm -rf "$SHARE" "$AGENT_LIB" "$UNITS/servitals.service.d" "$UNITS/servitals-agent.service.d"
  rm -f "$UNITS/servitals.service" "$UNITS/servitals-agent.service" "$UNITS/servitals-backup.service" "$UNITS/servitals-backup.timer" \
        /usr/bin/servitals-ctl /usr/bin/servitals-agent \
        /usr/lib/sysusers.d/servitals.conf /usr/lib/sysusers.d/servitals-agent.conf
```

2. Replace

```bash
# the same units the package ships (debian/ is their only copy)
install -m 644 "$SRC/debian/servitals.service" "$SRC/debian/servitals-agent.service" "$UNITS/"
systemctl daemon-reload
systemctl enable servitals.service servitals-agent.service
```

   with

```bash
# the same units the package ships (debian/ is their only copy)
install -m 644 "$SRC/debian/servitals.service" "$SRC/debian/servitals-agent.service" "$UNITS/"
# daily backups: off until servitals-ctl backup enable
install -m 644 "$SRC/debian/servitals.servitals-backup.service" "$UNITS/servitals-backup.service"
install -m 644 "$SRC/debian/servitals.servitals-backup.timer" "$UNITS/servitals-backup.timer"
systemctl daemon-reload
systemctl enable servitals.service servitals-agent.service
```

- [ ] **Step 5: Run the tests and shellcheck**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-ctl packaging/install-local.sh`
Expected: PASS (5 new tests; needs `openssl` on the test machine), no shellcheck output.

- [ ] **Step 6: Commit**

```bash
git add bin/servitals-ctl debian/servitals.servitals-backup.service debian/servitals.servitals-backup.timer debian/rules packaging/install-local.sh test/cli.test.js test/packaging.test.js
git commit -m "feat(ctl): backup, restore and daily backups" -m "backup writes one 0600 tar of the hub's state (without earlier backups), hub.env and conf.d with a manifest; --encrypt uses openssl with the passphrase in the environment. restore reads and checks the whole file first, then stops the hub, moves the current state aside and restores. backup enable turns on a hardened daily timer that keeps the 7 newest."
```

---

### Task 4: Docs, the package smoke test, full validation

**Files:**
- Create: `docs/backup.md`
- Modify: `debian/tests/smoke`, `debian/control`, `docs/threat-model.md`, `man/servitals-ctl.1`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: The smoke test runs the daily backup and a restore**

In `debian/tests/smoke`:

1. Replace

```bash
[ "$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)" = "$node_id" ] || fail "node changed on reconfigure"

# the hardening holds: systemd rates both units 2.0 or lower ("OK")
for u in servitals servitals-agent; do
```

   with

```bash
[ "$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)" = "$node_id" ] || fail "node changed on reconfigure"

# backups (spec 17): the daily service makes one; a restore brings the state back
servitals-ctl backup enable >/dev/null || fail "backup enable"
systemctl is-enabled --quiet servitals-backup.timer || fail "backup timer not enabled"
systemctl start servitals-backup.service || { journalctl -u servitals-backup --no-pager | tail -20; fail "backup service"; }
ls /var/lib/servitals/backups/servitals-*.tar.gz >/dev/null 2>&1 || fail "no daily backup file"
servitals-ctl backup /tmp/hub.tar.gz >/dev/null || fail "backup"
servitals-ctl node add after-backup >/dev/null
servitals-ctl restore /tmp/hub.tar.gz >/dev/null || fail "restore"
servitals-ctl node list | grep -q ' after-backup ' && fail "restore kept a node added after the backup"
wait_for "curl -fsS $B/__auth/health >/dev/null 2>&1" || fail "hub not back after restore"
[ "$(login owner another-pass-1)" = 302 ] || fail "login after restore"
[ "$(stat -c '%U' /var/lib/servitals/nodes.json)" = _servitals ] || fail "restored files not owned by the hub"

# the hardening holds: systemd rates both units 2.0 or lower ("OK")
for u in servitals servitals-agent; do
```

In `debian/control`:

1. Replace

```
Architecture: all
Depends: ${misc:Depends}, nodejs (>= 18), jq, servitals-agent (= ${source:Version})
Suggests: apprise
Description: tiny terminal-styled dashboard for home servers
 servitals shows the health of one or more Linux servers on a single page:
```

   with

```
Architecture: all
Depends: ${misc:Depends}, nodejs (>= 18), jq, servitals-agent (= ${source:Version})
Suggests: apprise, openssl
Description: tiny terminal-styled dashboard for home servers
 servitals shows the health of one or more Linux servers on a single page:
```

- [ ] **Step 2: Docs**

Create `docs/backup.md`:

````markdown
# Backups and rotation

## What a backup holds

`servitals-ctl backup <file>` writes one tar of:

- the hub's state (`/var/lib/servitals`): the login (`admin.json`, a scrypt
  hash), the session key, the servers and their secrets (`nodes.json`),
  dashboard settings, bans, the whitelist, the latest snapshots and the audit
  log; not earlier backups;
- `/etc/servitals/hub.env` and `/etc/servitals/conf.d`;
- a `manifest.json` with the servitals version that made it.

The file is created mode 0600: whoever reads it can pose as any of your
servers and try to crack the admin password. Keep it like a key.

```bash
sudo servitals-ctl backup /root/servitals-$(date +%F).tar.gz
sudo servitals-ctl backup --encrypt /mnt/usb/servitals.tar.gz.enc   # asks for a passphrase
```

`--encrypt` uses `openssl enc -aes-256-cbc -pbkdf2 -iter 600000` (install
`openssl` if it is missing). For scripts, put the passphrase in
`SERVITALS_BACKUP_PASSPHRASE`; it never appears on a command line.

## Daily backups

```bash
sudo servitals-ctl backup enable    # a systemd timer, once a day
sudo servitals-ctl backup disable
```

They go to `/var/lib/servitals/backups/` (0700), and the 7 newest are kept.
They are not encrypted and live on the same disk: copy them elsewhere, for
example with `rsync` from another machine, if the disk itself matters.

## Restore

```bash
sudo servitals-ctl restore /root/servitals-2026-09-28.tar.gz
sudo servitals-ctl restore --etc /root/servitals-2026-09-28.tar.gz   # also hub.env and conf.d
```

`restore` reads the whole file first (and asks for the passphrase of an
encrypted one); a wrong passphrase, a damaged file, or a backup made by a
newer servitals stops it before anything changes. Then it stops the hub,
moves the current state to `/var/lib/servitals.before-restore-…`, puts the
backup in place, gives the files to the hub's user and starts the hub.
Earlier daily backups stay. Every browser logs in again only if the backup
holds another session key.

Agents keep their own credentials, so a restore that brings back the same
servers needs nothing on them. Servers paired after the backup was made are
gone from the hub: pair them again.

## Rotation

| secret | command | effect |
| --- | --- | --- |
| a server's secret | `sudo servitals-ctl node rotate <id>` | prints a new join line; the old secret keeps working for 24 hours |
| every server's secret | `sudo servitals-ctl node rotate --all` | the same for each; the hub's own agent is updated at once |
| session key | `sudo servitals-ctl rotate session-key` | the hub restarts; every browser logs in again |
| admin password | `sudo servitals-ctl passwd` | every session ends |

After `node rotate`, run the printed `servitals-agent join` line on each
server within 24 hours; after that the old secret is refused. On a Docker
install, restart the agent container after rotating the hub's own node.
````

In `docs/threat-model.md`:

1. Replace

```markdown
| admin password | `servitals-ctl passwd` | all sessions end |
| session signing key | `servitals-ctl rotate session-key` | all sessions end |
| VAPID keys | `servitals-ctl rotate vapid` | browsers must enable notifications again |
| relay key | hosted UI, then `servitals-ctl relay set` | old key rejected at once |
| hosted master key | operator runbook | re-encrypts stored secrets |

```

   with

```markdown
| admin password | `servitals-ctl passwd` | all sessions end |
| session signing key | `servitals-ctl rotate session-key` | all sessions end |
| VAPID keys | `servitals-ctl rotate vapid` (arrives with Web Push, sub-project 6) | browsers must enable notifications again |
| relay key | hosted UI, then `servitals-ctl relay set` | old key rejected at once |
| hosted master key | operator runbook | re-encrypts stored secrets |

Commands and details: [backup.md](backup.md).

```

In `man/servitals-ctl.1`:

1. Replace

```
.B The docker group can take over the host as root.
.TP
.BI import-docker " dir"
Copy the login, dashboard settings, whitelist, bans and disk list from a
```

   with

```
.B The docker group can take over the host as root.
.TP
.BR "node rotate" " \fIid\fR|\-\-all"
A new secret for a server; the old one keeps working for 24 hours. Prints a
join line to run on that server; the hub's own agent is updated at once.
.TP
.BR "backup" " [" \-\-encrypt "] \fIfile\fR"
Write one tar (mode 0600) of the hub's state, /etc/servitals/hub.env and
conf.d. It holds the admin hash and every node secret.
.B \-\-encrypt
asks for a passphrase (or reads SERVITALS_BACKUP_PASSPHRASE) and uses openssl.
.TP
.BR "backup enable" | disable
A daily backup by systemd timer, the 7 newest kept in
.IR /var/lib/servitals/backups .
.TP
.BR "restore" " [" \-\-etc "] \fIfile\fR"
Check the backup, stop the hub, move the current state aside, restore, and
start the hub.
.B \-\-etc
also restores hub.env and conf.d.
.TP
.B rotate session\-key
A new session signing key; the hub restarts and every browser logs in again.
.TP
.BI import-docker " dir"
Copy the login, dashboard settings, whitelist, bans and disk list from a
```

In `README.md`:

1. Replace

```markdown
within a few seconds. `/etc/servitals/conf.d/README` has an example and every
allowed value. Docker installs: mount a directory and set `CONFD_DIR`.

## Styles, modes and kiosk
```

   with

````markdown
within a few seconds. `/etc/servitals/conf.d/README` has an example and every
allowed value. Docker installs: mount a directory and set `CONFD_DIR`.

## Backups and rotation

```bash
sudo servitals-ctl backup /root/servitals.tar.gz         # --encrypt asks for a passphrase
sudo servitals-ctl backup enable                         # daily, the 7 newest kept
sudo servitals-ctl restore /root/servitals.tar.gz        # --etc also restores hub.env and conf.d
sudo servitals-ctl node rotate <id|--all>                # new secrets; old ones work for 24 hours
sudo servitals-ctl rotate session-key                    # every browser logs in again
```

See [docs/backup.md](docs/backup.md).

## Styles, modes and kiosk
````

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Config as code (spec 12): `/etc/servitals/conf.d/*.json` sets dashboard
  defaults and server tags or names; file values win and show as "managed by
```

   with

```markdown

### Added
- Backups and rotation (spec 17): `servitals-ctl backup [--encrypt]`,
  `restore [--etc]` (stops and starts the hub, keeps the state it replaces),
  daily backups on a timer (`backup enable`, 7 kept), `node rotate <id|--all>`
  (the old secret works for 24 hours), `rotate session-key`; `docs/backup.md`.
- Config as code (spec 12): `/etc/servitals/conf.d/*.json` sets dashboard
  defaults and server tags or names; file values win and show as "managed by
```

- [ ] **Step 3: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                          # Expected: all pass (258)
pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-ctl packaging/install-local.sh debian/tests/smoke
man -l man/servitals-ctl.1 | grep -E "node rotate|backup enable|session-key"   # Expected: three entries
bash test/budget.sh                                 # Expected: every line ok
bash test/compose-smoke.sh                          # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh    # Expected: both series, no lintian E:/W:
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh  # Expected: smoke PASS, purge PASS on both series
```

- [ ] **Step 4: Commit**

```bash
git add docs/backup.md debian/tests/smoke debian/control docs/threat-model.md man/servitals-ctl.1 README.md CHANGELOG.md
git commit -m "docs: backups and rotation; the package smoke test runs a daily backup and a restore"
```
