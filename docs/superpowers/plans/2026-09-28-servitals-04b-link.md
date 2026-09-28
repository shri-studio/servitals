# servitals Code-based Linking (sub-project 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair a server without copying a secret: `sudo servitals-agent link https://hub` prints a short code, a person approves it on the hub's `/link` page, and the agent joins with a secret it made itself.

**Architecture:** `hub/lib/link.js` keeps pending link requests in memory (codes stored as SHA-256 hashes, found by hash), with the rate limits, expiry and single use from spec 6.1.1. `hub/server.js` answers the unsigned `POST /api/v1/link/start` and `/api/v1/link/poll` only when the request really travelled over TLS (or straight from loopback), and serves a server-rendered `/link` page behind the login, where a person looks up the code, sees the host, system, agent and source address, names the node and approves or denies. Approval stores the node with the agent's own secret (`nodes.add(name, tags, secret)`). `bin/servitals-agent link` makes the secret, polls, runs the same test push as `join`, saves the credentials and prints the account; `unlink` forgets the hub.

**Tech Stack:** Node.js ≥ 18 built-ins (hub), bash + curl + jq (agent), node:test, autopkgtest.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` sections 6.1 and 6.1.1 (pairing, code-based linking), 13.4 (autopkgtest pairs a second agent), 15.1 (`docs/networking.md`); `docs/protocol.md` section 5.3; `docs/threat-model.md` invariant 2.

**Scope (4b of sub-project 4):** self-hosted hubs, where the hub's admin approves. Node limits and account e-mail labels belong to the hosted service (sub-project 7). 4d, 4e and 4f follow as their own plans.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (228f2f5) on 2026-09-28: node suite 216 tests, shellcheck at CI settings, budget, Docker smoke test, both series built and lintian clean (160 KB / 22 KB), and autopkgtest smoke (a second agent joins, a third links by code) and purge on noble and resolute.

## Global Constraints

- Everything from sub-projects 1-4c still holds: zero runtime dependencies (hub: Node built-ins; agent: bash, coreutils, jq, curl), Node 18 compatibility (no `fetch` in `hub/` or `test/`), SPDX headers, lintian clean, `.deb` ≤ 500 KB, systemd exposure ≤ 2.0, the lightness budget.
- Protocol 5.3 exactly: `device_code` 32 random bytes as base64url (43 characters), `user_code` 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` shown as `XXXX-XXXX`, both stored only as hashes, valid 600 s, single use; poll interval 5 s, `429 slow_down` when faster; after `200` the device code is spent (`410 expired`).
- Rate limits: 5 starts per source address per hour; 10 code entries per address and per account per 10 minutes; at most 100 requests waiting.
- A node secret crosses the network only here, once, inside TLS (threat-model invariant 2). The hub accepts link requests only over TLS, from a trusted proxy whose `X-Forwarded-Proto` says `https`, or straight from loopback without forwarding headers; `link` in the agent refuses `http://` except to this machine itself.
- Secrets and device codes never reach a page, a log line or the agent's output. Strings that come from the other side are escaped in HTML, quoted in logs, and stripped of control characters on the terminal.
- The live dashboard runs on this host (native install, port 20002). All tests run in temp dirs and containers; do not touch `/etc/servitals`, `/var/lib/servitals` or the running units.
- Work in a worktree `.claude/worktrees/servitals-link` on branch `feat/link` from `main` (228f2f5).
- Docker Hub may time out on this host: `IMAGE_PREFIX=mirror.gcr.io/library/` for the package scripts.
- Every `local` variable used in an `EXIT` trap is a bug (twice in this project): use a global.
- Never run `git stash` to set work aside (the stash is shared between worktrees); use a WIP commit.
- Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers. OpenWolf: log fixed bugs in `.wolf/buglog.json`.

## Review Focus

1. **A link request that travelled as plain HTTP** (a LAN proxy that forwards HTTP, an https `PUBLIC_URL` with a plain-HTTP request, a forged `X-Forwarded-Proto` from an untrusted peer) must be refused with `403 https_required` before the body is read. Test: Task 3, "link needs HTTPS: a direct loopback connection or a trusted proxy that says https".
2. **Hostile strings from either side**: an unauthenticated agent's host name on the approval page and in the logs; a malicious hub's name, account and URL on the agent's terminal. Tests: Task 3, the escaping assertions in "a person approves on /link…"; Task 4, "link prints what a hostile hub sends without terminal escapes".
3. **Guessing, reusing or outliving a code**: rate limits, single use, expiry, polling too fast, and a restart of the hub. Tests: Task 1, "rate limits…", "poll: pending, then the node id once, then expired", "deny, expiry, unknown codes and polling too fast".
4. **Approving by accident or from another site**: CSRF, framing, and a logged-out browser. Tests: Task 3, "/link: deny, a wrong code, a bad tag, and no approval from another site" and the `x-frame-options` assertions.
5. **A link that works from the checkout but not from the package** (the agent sources `lib/api.sh` from `AGENT_HOME`, a proxy set in `agent.env`). Tests: Task 4, the `http_proxy` case in "link: shows a code…"; Task 5, the autopkgtest smoke test links a third agent.

---

### Task 1: Link requests in memory (`hub/lib/link.js`)

**Files:**
- Create: `hub/lib/link.js`, `test/link.test.js`

**Interfaces:**
- Produces: `createLinks({ now = Date.now }) → { start, poll, lookup, decide }`; `start({ secret, host, os, agent, ip }) → { status, body, retryAfter? }` (200 body `{ device_code, user_code, expires_in: 600, interval: 5 }`; 400 `invalid_request`; 429 `rate_limited` with `retryAfter: 3600`; 503 `busy` with `retryAfter: 60`); `poll(deviceCode) → { status, body }` (202 pending, 200 the approval result once, 410 `expired`/`denied`, 429 `slow_down`, 400 `invalid_request`); `lookup(code, { ip, account }) → { ok: true, request: { code, host, os, agent, ip, started, expires } } | { ok: false, error: "unknown"|"too_many" }`; `decide(code, approve, { ip, account }, onApprove) → { ok, host, from, result? } | { ok: false, error }` where `onApprove({ host, os, agent, ip, secret })` returns the poll body `{ node_id, account, name }`; `normalizeCode(s)`, `TTL_MS`, `INTERVAL_S`. Task 3 wires it into the hub.

- [ ] **Step 1: Write the failing tests**

Create `test/link.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createLinks, normalizeCode } = require("../hub/lib/link");

const SECRET = "ab".repeat(32);
const ask = (links, over = {}) => links.start({ secret: SECRET, host: "nas", os: "linux", agent: "bash/0.1.0", ip: "203.0.113.7", ...over });
function clock(t = 1e12) { const c = () => t; c.add = (ms) => { t += ms; }; return c; }

test("start hands out a long device code and a short user code without look-alikes", () => {
  const r = ask(createLinks());
  assert.strictEqual(r.status, 200);
  assert.match(r.body.device_code, /^[A-Za-z0-9_-]{43}$/);
  assert.match(r.body.user_code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.strictEqual(r.body.expires_in, 600);
  assert.strictEqual(r.body.interval, 5);
});

test("start refuses a bad secret, host, os or agent", () => {
  const links = createLinks();
  for (const bad of [{ secret: "xyz" }, { secret: SECRET.toUpperCase() }, { host: "" }, { host: "a\u0007b" }, { host: "x".repeat(65) },
                     { os: "linux; rm" }, { agent: "" }, { agent: "a".repeat(33) }, { secret: undefined }]) {
    const r = ask(links, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual(r.body.error, "invalid_request");
  }
});

test("the code is typed in any case, with or without the dash; lookup shows what is being approved", () => {
  const links = createLinks();
  const code = ask(links).body.user_code;
  assert.strictEqual(normalizeCode(" " + code.toLowerCase().replace("-", " ") + " "), code.replace("-", ""));
  const r = links.lookup(code.toLowerCase().replace("-", ""), { ip: "10.0.0.2", account: "admin" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual({ host: r.request.host, os: r.request.os, agent: r.request.agent, ip: r.request.ip },
                         { host: "nas", os: "linux", agent: "bash/0.1.0", ip: "203.0.113.7" });
  assert.strictEqual(r.request.code, code);
  assert.strictEqual(r.request.secret, undefined, "the secret never reaches the page");
});

test("poll: pending, then the node id once, then expired", () => {
  const t = clock(), links = createLinks({ now: t });
  const s = ask(links).body;
  assert.deepStrictEqual(links.poll(s.device_code), { status: 202, body: { status: "pending" } });
  t.add(5000);
  const d = links.decide(s.user_code, true, { ip: "10.0.0.2", account: "admin" }, (req) => {
    assert.strictEqual(req.secret, SECRET, "approval gets the agent's secret");
    return { node_id: "abcdefghijkm", account: "a***n on hub.lan", name: "nas" };
  });
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(links.poll(s.device_code), { status: 200, body: { node_id: "abcdefghijkm", account: "a***n on hub.lan", name: "nas" } });
  t.add(5000);
  assert.deepStrictEqual(links.poll(s.device_code), { status: 410, body: { error: "expired" } }, "the device code is spent");
  assert.strictEqual(links.lookup(s.user_code, { ip: "10.0.0.2", account: "admin" }).ok, false, "the user code is single use");
});

test("deny, expiry, unknown codes and polling too fast", () => {
  const t = clock(), links = createLinks({ now: t });
  const a = ask(links).body;
  assert.strictEqual(links.decide(a.user_code, false, { ip: "10.0.0.2", account: "admin" }).ok, true);
  assert.deepStrictEqual(links.poll(a.device_code), { status: 410, body: { error: "denied" } });
  const b = ask(links).body;
  links.poll(b.device_code);
  assert.deepStrictEqual(links.poll(b.device_code), { status: 429, body: { error: "slow_down" } });
  t.add(601e3);
  assert.deepStrictEqual(links.poll(b.device_code), { status: 410, body: { error: "expired" } });
  assert.strictEqual(links.lookup(b.user_code, { ip: "10.0.0.2", account: "admin" }).ok, false, "an expired code cannot be approved");
  assert.deepStrictEqual(links.poll("x".repeat(43)), { status: 410, body: { error: "expired" } });
  assert.deepStrictEqual(links.poll(undefined), { status: 400, body: { error: "invalid_request" } });
});

test("rate limits: 5 starts per address per hour, 10 code entries per address and per account per 10 minutes", () => {
  const t = clock(), links = createLinks({ now: t });
  for (let i = 0; i < 5; i++) assert.strictEqual(ask(links).status, 200);
  assert.deepStrictEqual(ask(links), { status: 429, body: { error: "rate_limited" }, retryAfter: 3600 });
  assert.strictEqual(ask(links, { ip: "203.0.113.8" }).status, 200, "another address is not affected");
  t.add(3600e3);
  assert.strictEqual(ask(links).status, 200);

  const who = { ip: "10.0.0.2", account: "admin" };
  for (let i = 0; i < 10; i++) assert.strictEqual(links.lookup("AAAA-AAAA", who).error, "unknown");
  assert.strictEqual(links.lookup("AAAA-AAAA", who).error, "too_many");
  assert.strictEqual(links.lookup("AAAA-AAAA", { ip: "10.0.0.3", account: "admin" }).error, "too_many", "per account too");
  t.add(600e3);
  assert.strictEqual(links.lookup("AAAA-AAAA", who).error, "unknown");
});

test("at most 100 requests wait at once", () => {
  const links = createLinks();
  for (let i = 0; i < 100; i++) assert.strictEqual(ask(links, { ip: `198.51.100.${i}` }).status, 200);
  assert.deepStrictEqual(ask(links, { ip: "198.51.100.200" }), { status: 503, body: { error: "busy" }, retryAfter: 60 });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/link.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/link'`.

- [ ] **Step 3: Write `hub/lib/link.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Code-based linking (spec 6.1.1, docs/protocol.md 5.3), after the OAuth
 * device authorization pattern (RFC 8628). An agent sends the secret it made
 * itself and gets a long device code to poll with and a short user code for a
 * person, who approves it on /link. Requests live in memory only: a hub
 * restart expires them, and the agent says so and can start again.
 *
 * Both codes are kept only as SHA-256 hashes and found by hash, so a guess is
 * never compared byte by byte against a stored code.
 */
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L look-alikes
const TTL_MS = 600e3;
const INTERVAL_S = 5;
const KEEP_MS = 2 * TTL_MS;          // answer "expired" (not "unknown") for a while after
const MAX_PENDING = 100;
const START_LIMIT = 5, START_WINDOW_MS = 3600e3;
const ENTRY_LIMIT = 10, ENTRY_WINDOW_MS = 600e3;

const SECRET_RE = /^[0-9a-f]{64}$/;
const HOST_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const OS_RE = /^[a-z0-9._-]{1,32}$/i;
const AGENT_RE = /^[A-Za-z0-9._/+-]{1,32}$/;

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const normalizeCode = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const newUserCode = () => [...crypto.randomBytes(8)].map((b) => ALPHABET[b & 31]).join("");

function createLinks({ now = Date.now } = {}) {
  const byDevice = new Map();   // hash(device code) -> request
  const byUser = new Map();     // hash(user code) -> request, while it can still be decided
  const starts = new Map();     // ip -> [times]
  const entries = new Map();    // "ip:<ip>" or "account:<name>" -> [times]

  // true when this attempt is within the limit (and records it)
  function allow(map, key, limit, windowMs) {
    const t = now();
    const recent = (map.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= limit) { map.set(key, recent); return false; }
    recent.push(t);
    map.set(key, recent);
    return true;
  }

  function sweep() {
    const t = now();
    for (const [k, r] of byDevice) {
      if (t > r.expires + KEEP_MS) byDevice.delete(k);
      if (t > r.expires || r.status !== "pending") byUser.delete(r.userHash);
    }
    for (const map of [starts, entries]) for (const [k, v] of map) if (!v.some((x) => t - x < START_WINDOW_MS)) map.delete(k);
  }

  function start({ secret, host, os, agent, ip }) {
    if (typeof secret !== "string" || !SECRET_RE.test(secret) || typeof host !== "string" || !HOST_RE.test(host) ||
        typeof os !== "string" || !OS_RE.test(os) || typeof agent !== "string" || !AGENT_RE.test(agent)) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    sweep();
    if (!allow(starts, ip || "?", START_LIMIT, START_WINDOW_MS)) {
      return { status: 429, body: { error: "rate_limited" }, retryAfter: START_WINDOW_MS / 1000 };
    }
    if (byUser.size >= MAX_PENDING) return { status: 503, body: { error: "busy" }, retryAfter: 60 };
    const device = crypto.randomBytes(32).toString("base64url");
    let code;
    do { code = newUserCode(); } while (byUser.has(hash(code)));
    const t = now();
    const req = { deviceHash: hash(device), userHash: hash(code), code, secret, host, os, agent, ip: ip || "",
                  started: t, expires: t + TTL_MS, status: "pending", lastPoll: 0, result: null };
    byDevice.set(req.deviceHash, req);
    byUser.set(req.userHash, req);
    return { status: 200, body: { device_code: device, user_code: showCode(code), expires_in: TTL_MS / 1000, interval: INTERVAL_S } };
  }

  function poll(device) {
    if (typeof device !== "string" || device.length > 64) return { status: 400, body: { error: "invalid_request" } };
    sweep();
    const r = byDevice.get(hash(device));
    if (!r || r.status === "spent") return { status: 410, body: { error: "expired" } };
    if (r.status === "denied") return { status: 410, body: { error: "denied" } };
    if (r.status === "approved") {
      r.status = "spent";
      r.secret = "";
      return { status: 200, body: r.result };
    }
    const t = now();
    if (t > r.expires) return { status: 410, body: { error: "expired" } };
    const early = t - r.lastPoll < (INTERVAL_S - 1) * 1000;
    r.lastPoll = t;
    if (early) return { status: 429, body: { error: "slow_down" } };
    return { status: 202, body: { status: "pending" } };
  }

  // a person typed a code: what would they approve? Counted against both limits.
  function find(code, { ip, account }) {
    const okIp = allow(entries, "ip:" + (ip || "?"), ENTRY_LIMIT, ENTRY_WINDOW_MS);
    const okAccount = allow(entries, "account:" + (account || "?"), ENTRY_LIMIT, ENTRY_WINDOW_MS);
    if (!okIp || !okAccount) return { error: "too_many" };
    sweep();
    const c = normalizeCode(code);
    const r = c.length === 8 ? byUser.get(hash(c)) : null;
    if (!r || r.status !== "pending" || now() > r.expires) return { error: "unknown" };
    return { r };
  }

  function lookup(code, who) {
    const f = find(code, who);
    if (f.error) return { ok: false, error: f.error };
    const r = f.r;
    return { ok: true, request: { code: showCode(r.code), host: r.host, os: r.os, agent: r.agent, ip: r.ip,
                                  started: r.started, expires: r.expires } };
  }

  // approve: onApprove(request with the secret) returns what the agent gets
  function decide(code, approve, who, onApprove) {
    const f = find(code, who);
    if (f.error) return { ok: false, error: f.error };
    const r = f.r;
    byUser.delete(r.userHash);   // single use, whatever the outcome
    if (!approve) { r.status = "denied"; r.secret = ""; return { ok: true, host: r.host, from: r.ip }; }
    r.result = onApprove({ host: r.host, os: r.os, agent: r.agent, ip: r.ip, secret: r.secret });
    r.status = "approved";
    return { ok: true, host: r.host, from: r.ip, result: r.result };
  }

  return { start, poll, lookup, decide };
}

module.exports = { createLinks, normalizeCode, TTL_MS, INTERVAL_S };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (7 new tests).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/link.js test/link.test.js
git commit -m "feat(hub): link requests for code-based pairing" -m "createLinks() keeps pending requests in memory with hashed device and user codes, 10-minute expiry, single use, the 5 s poll interval and the rate limits from spec 6.1.1."
```

---

### Task 2: Nodes that bring their own secret

**Files:**
- Modify: `hub/lib/nodes.js`, `test/nodes.test.js`

**Interfaces:**
- Consumes: `createNodeStore` from sub-project 4a.
- Produces: store method `check(name, tags = []) → cleanName` (throws with a message for the person); `add(name, tags = [], secret = <random 32 bytes hex>) → { id, secret }`, which refuses a secret that is not 64 hex characters and never writes over a `nodes.json` that does not parse. Task 3 calls `check` before approving and `add(name, tags, secret)` on approval.

- [ ] **Step 1: Write the failing test**

Append to `test/nodes.test.js`:

```js
test("a linked agent brings its own secret; add refuses a bad one and never overwrites an unreadable file", () => {
  const f = tmpfile();
  const store = createNodeStore(f);
  const secret = "ef".repeat(32);
  const { id, secret: got } = store.add("nas", ["home"], secret);
  assert.strictEqual(got, secret);
  assert.strictEqual(store.get(id).secret, secret);
  assert.throws(() => store.add("x", [], "short"), /secret: 64 hex characters/);
  assert.throws(() => store.check("x", ["Bad Tag"]), /tag "Bad Tag"/);
  assert.strictEqual(store.check("  nas  "), "nas");
  const g = tmpfile();
  fs.writeFileSync(g, "{ half written");
  assert.throws(() => createNodeStore(g).add("nas"), /does not parse/);
  assert.strictEqual(fs.readFileSync(g, "utf8"), "{ half written");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/nodes.test.js`
Expected: FAIL: "a linked agent brings its own secret…" (`store.add` ignores the secret; `store.check` is not a function).

- [ ] **Step 3: Change `hub/lib/nodes.js`**

In `hub/lib/nodes.js`:

1. Replace

```js
  }

  // a remote node: returns its id and secret (the secret is shown once, in the join string)
  function add(name, tags = []) {
    const clean = checkName(name);
    for (const t of tags) if (!TAG.test(t)) throw new Error(`tag "${t}": lowercase letters, digits, dot, dash, underscore`);
    load();
    let id;
    do { id = newNodeId(); } while (nodes[id]);
    const secret = crypto.randomBytes(32).toString("hex");
    nodes[id] = { name: clean, secret, local: false, created: Date.now(), tags };
    save();
```

   with

```js
  }

  // throws with a message for the person when a name or tag is not allowed
  function check(name, tags = []) {
    const clean = checkName(name);
    for (const t of tags) if (!TAG.test(t)) throw new Error(`tag "${t}": lowercase letters, digits, dot, dash, underscore`);
    return clean;
  }

  // a remote node: returns its id and secret (the secret is shown once, in the join string).
  // A linked agent brings its own secret (spec 6.1.1).
  function add(name, tags = [], secret = crypto.randomBytes(32).toString("hex")) {
    const clean = check(name, tags);
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("secret: 64 hex characters");
    load();
    if (unreadable) throw new Error(`${file} exists but does not parse; fix or remove it`);
    let id;
    do { id = newNodeId(); } while (nodes[id]);
    nodes[id] = { name: clean, secret, local: false, created: Date.now(), tags };
    save();
```

2. Replace

```js
  }

  return { get, localId, ensureLocal, add, rename, revoke, list, all: load };
}

```

   with

```js
  }

  return { get, localId, ensureLocal, check, add, rename, revoke, list, all: load };
}

```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/nodes.js test/nodes.test.js
git commit -m "feat(hub): a node can be added with the secret its agent made" -m "nodes.add(name, tags, secret) takes the linked agent's secret; check() validates a name and tags before anything is decided; add() never writes over a nodes.json that does not parse."
```

---

### Task 3: Link API and the `/link` approval page

**Files:**
- Modify: `hub/server.js`
- Create: `test/link-api.test.js`

**Interfaces:**
- Consumes: `createLinks` (Task 1); `nodes.check`, `nodes.add(name, tags, secret)` (Task 2); `login(port, { form })` from `test/helpers/hub.js` (sub-project 4c).
- Produces: `POST /api/v1/link/start` (adds `verify_url` = `PUBLIC_URL` or `<proto>://<Host>` + `/link`) and `POST /api/v1/link/poll`, both `403 https_required` unless `linkTransportOk`; `GET /link` (code form; login page with `next=link` when logged out); `POST /link` with `step=lookup&code=…` (what asks) or `step=decide&code=…&action=approve|deny&name=…&tags=…`; login redirects to `/link` for `next=link` only. The poll result's `account` is `<first letter>***<last letter> on <hub host>`. Audit events `link.started`, `link.approved`, `link.denied`. Task 4's agent talks to these endpoints.

- [ ] **Step 1: Write the failing tests**

Create `test/link-api.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { startHub, request, login, cookieFrom, formBody } = require("./helpers/hub");

const SECRET = "cd".repeat(32);
const startBody = (over = {}) => JSON.stringify({ secret: SECRET, host: "nas", os: "linux", agent: "bash/0.1.0", ...over });
const post = (port, p, body, headers = {}) => request(port, {
  method: "POST", path: p, body,
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
});
const form = (port, fields, cookie, origin = `http://127.0.0.1:${port}`) => {
  const body = formBody(fields);
  const headers = { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), cookie };
  if (origin) headers.origin = origin;
  return request(port, { method: "POST", path: "/link", headers, body });
};

test("link needs HTTPS: a direct loopback connection or a trusted proxy that says https", async () => {
  const hub = await startHub({ PUBLIC_URL: "https://hub.example" });
  try {
    const direct = await post(hub.port, "/api/v1/link/start", startBody());
    assert.strictEqual(direct.status, 200, direct.body);
    assert.strictEqual(JSON.parse(direct.body).verify_url, "https://hub.example/link");
    const viaTls = await post(hub.port, "/api/v1/link/start", startBody(),
      { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    assert.strictEqual(viaTls.status, 200, "a tunnel or proxy that terminated TLS");
    for (const h of [{ "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "http" }, { "x-forwarded-for": "203.0.113.9" }]) {
      const r = await post(hub.port, "/api/v1/link/start", startBody(), h);
      assert.strictEqual(r.status, 403, JSON.stringify(h));
      assert.deepStrictEqual(JSON.parse(r.body), { error: "https_required" }, "an https PUBLIC_URL is not enough: this request was plain HTTP");
      const p = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: "x" }), h);
      assert.strictEqual(p.status, 403);
    }
    const get = await request(hub.port, { path: "/api/v1/link/start" });
    assert.strictEqual(get.status, 405);
    const junk = await post(hub.port, "/api/v1/link/start", "{nope");
    assert.deepStrictEqual([junk.status, JSON.parse(junk.body)], [400, { error: "invalid_request" }]);
  } finally { await hub.stop(); }
});

test("a proxy the hub does not trust cannot vouch for https", async () => {
  const hub = await startHub({ TRUSTED_PROXIES: "" });
  try {
    const r = await post(hub.port, "/api/v1/link/start", startBody(), { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    assert.deepStrictEqual([r.status, JSON.parse(r.body)], [403, { error: "https_required" }]);
  } finally { await hub.stop(); }
});

test("a person approves on /link: login first, see what asks, name it, and the agent gets its node id", async () => {
  const hub = await startHub();
  try {
    const s = JSON.parse((await post(hub.port, "/api/v1/link/start", startBody({ host: "<b>nas</b>" }))).body);
    assert.strictEqual(s.verify_url, `http://127.0.0.1:${hub.port}/link`);

    const anon = await request(hub.port, { path: "/link" });
    assert.match(anon.body, /<input type="hidden" name="next" value="link">/, "the login page comes back to /link");
    const li = await login(hub.port, { form: { next: "link" } });
    assert.strictEqual(li.headers.location, "/link");
    assert.strictEqual((await login(hub.port, { form: { next: "https://evil.example" } })).headers.location, "/", "only /link");
    const cookie = cookieFrom(li);

    const page = await request(hub.port, { path: "/link", headers: { cookie } });
    assert.match(page.body, /name="code"/);
    assert.strictEqual(page.headers["x-frame-options"], "DENY", "no approving inside another site's frame");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(page.body, /servitals-agent link/, "the page says how to start");

    const seen = await form(hub.port, { step: "lookup", code: s.user_code.toLowerCase() }, cookie);
    assert.strictEqual(seen.status, 200);
    assert.match(seen.body, /&lt;b&gt;nas&lt;\/b&gt;/, "the host name is escaped");
    assert.doesNotMatch(seen.body, /<b>nas<\/b>/);
    assert.match(seen.body, /127\.0\.0\.1/, "the address the request came from");
    assert.match(seen.body, /linux/);
    assert.match(seen.body, /bash\/0\.1\.0/);
    assert.ok(!seen.body.includes(SECRET), "the secret never reaches the page");

    const pending = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: s.device_code }));
    assert.deepStrictEqual([pending.status, JSON.parse(pending.body)], [202, { status: "pending" }]);

    const done = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "nas", tags: "home, nas-box" }, cookie);
    assert.strictEqual(done.status, 200);
    assert.match(done.body, /linked/i);

    await new Promise((r) => setTimeout(r, 4100));   // the agent polls every 5 s at most
    const got = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: s.device_code }));
    assert.strictEqual(got.status, 200, got.body);
    const body = JSON.parse(got.body);
    assert.match(body.node_id, /^[a-z2-7]{12}$/);
    assert.strictEqual(body.name, "nas");
    assert.strictEqual(body.account, `a***n on 127.0.0.1:${hub.port}`);

    const stored = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "nodes.json"), "utf8"))[body.node_id];
    assert.strictEqual(stored.secret, SECRET, "the node signs with the secret the agent made");
    assert.deepStrictEqual(stored.tags, ["home", "nas-box"]);
    const list = JSON.parse((await request(hub.port, { path: "/__ctl/nodes", headers: { cookie } })).body);
    assert.ok(list.some((n) => n.id === body.node_id && n.name === "nas"));

    const audit = fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8");
    assert.match(audit, /link\.approved/);
    assert.ok(!audit.includes(SECRET) && !audit.includes(s.device_code) && !hub.logs().includes(SECRET), "no secrets in the logs");
  } finally { await hub.stop(); }
});

test("/link: deny, a wrong code, a bad tag, and no approval from another site", async () => {
  const hub = await startHub();
  try {
    const s = JSON.parse((await post(hub.port, "/api/v1/link/start", startBody())).body);
    const cookie = cookieFrom(await login(hub.port));
    const csrf = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "x" }, cookie, "http://evil.example");
    assert.strictEqual(csrf.status, 403);
    const noOrigin = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "x" }, cookie, null);
    assert.strictEqual(noOrigin.status, 403);
    const anon = await form(hub.port, { step: "lookup", code: s.user_code }, "");
    assert.strictEqual(anon.status, 401);

    const wrong = await form(hub.port, { step: "lookup", code: "ZZZZ-ZZZZ" }, cookie);
    assert.match(wrong.body, /unknown or expired code/);
    const badTag = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "nas", tags: "Bad Tag" }, cookie);
    assert.match(badTag.body, /tag/);
    const denied = await form(hub.port, { step: "decide", code: s.user_code, action: "deny" }, cookie);
    assert.match(denied.body, /denied/i);
    const p = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: s.device_code }));
    assert.deepStrictEqual([p.status, JSON.parse(p.body)], [410, { error: "denied" }]);
  } finally { await hub.stop(); }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/link-api.test.js`
Expected: FAIL, 4 tests: the link endpoints answer `404 not_found` from the agent API, and `/link` is the plain login page (no `next` field).

- [ ] **Step 3: Change `hub/server.js`**

In `hub/server.js`:

1. Replace

```js
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");

const UP        = process.env.UPSTREAM     || "";   // unset: serve WWW_DIR directly (native install)
```

   with

```js
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
const { createLinks } = require("./lib/link");

const UP        = process.env.UPSTREAM     || "";   // unset: serve WWW_DIR directly (native install)
```

2. Replace

```js

/* ---------- pages ---------- */
const SHELL = (title, inner) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
```

   with

```js

/* ---------- pages ---------- */
const SHELL = (title, inner, wide = false) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
```

3. Replace

```js
  font-size:13.5px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  -webkit-font-smoothing:antialiased}
.box{border:1px solid #2b3440;background:#0e131b;max-width:380px;width:100%}
.box h1{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:#8f9bad;
  padding:12px 16px;border-bottom:1px solid #2b3440}
```

   with

```js
  font-size:13.5px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  -webkit-font-smoothing:antialiased}
.box{border:1px solid #2b3440;background:#0e131b;max-width:${wide ? 520 : 380}px;width:100%}
.box h1{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:#8f9bad;
  padding:12px 16px;border-bottom:1px solid #2b3440}
```

4. Replace

```js
.err{color:#f57b72}.warn{color:#ecc05a}.ok{color:#74dd92}
.foot{color:#8f9bad;font-size:11.5px;padding:10px 16px;border-top:1px solid #2b3440}
</style></head><body><div class="box">${inner}</div></body></html>`;

```

   with

```js
.err{color:#f57b72}.warn{color:#ecc05a}.ok{color:#74dd92}
.foot{color:#8f9bad;font-size:11.5px;padding:10px 16px;border-top:1px solid #2b3440}
code{color:#f2f5f9;word-break:break-all}
a{color:#7db2ff}
.kv{display:grid;grid-template-columns:90px 1fr;gap:6px 12px;margin:14px 0 4px}
.kv dt{color:#8f9bad}.kv dd{color:#f2f5f9;word-break:break-all}
.row2{display:flex;gap:10px}.row2 button{flex:1}
button.deny{border-color:#7a3b37;color:#f57b72}button.deny:hover{border-color:#f57b72}
</style></head><body><div class="box">${inner}</div></body></html>`;

```

5. Replace

```js
  return m ? kioskValue(m[1] || "") : "";
};
const loginPage = (msg, kiosk = "") => SHELL(SITE + " · login", `
  <h1>${SITE} · authentication required</h1>
  <form class="body" method="POST" action="/__auth/login">
    ${kiosk ? `<input type="hidden" name="kiosk" value="${kiosk}">` : ""}
    <label>username</label><input name="username" autocomplete="username" autofocus>
    <label>password</label><input name="password" type="password" autocomplete="current-password">
```

   with

```js
  return m ? kioskValue(m[1] || "") : "";
};
// the login page can lead back to /link (and only there)
const nextValue = (v) => (v === "link" ? "link" : "");
const loginPage = (msg, kiosk = "", next = "") => SHELL(SITE + " · login", `
  <h1>${SITE} · authentication required</h1>
  <form class="body" method="POST" action="/__auth/login">
    ${kiosk ? `<input type="hidden" name="kiosk" value="${kiosk}">` : ""}
    ${next ? `<input type="hidden" name="next" value="${next}">` : ""}
    <label>username</label><input name="username" autocomplete="username" autofocus>
    <label>password</label><input name="password" type="password" autocomplete="current-password">
```

6. Replace

```js
  </div>
  <div class="foot">admin: <code>servitals-ctl unban ${escHtml(ip)}</code></div>`);

/* ---------- proxy ---------- */
```

   with

```js
  </div>
  <div class="foot">admin: <code>servitals-ctl unban ${escHtml(ip)}</code></div>`);

/* ---------- code-based linking (spec 6.1.1, protocol 5.3) ---------- */
const links = createLinks();
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const lastValue = (v) => String(v || "").split(",").pop().trim().toLowerCase();
// Stricter than requestIsHttps: the node secret crosses the network here, so this
// connection itself must be TLS, or come from a trusted proxy that says https,
// or come straight from this host. An https PUBLIC_URL alone is not enough.
function linkTransportOk(req, client) {
  if (req.socket && req.socket.encrypted) return true;
  if (client.peerTrusted && req.headers["x-forwarded-proto"]) return lastValue(req.headers["x-forwarded-proto"]) === "https";
  return LOOPBACK.has(req.socket && req.socket.remoteAddress) && !req.headers["x-forwarded-for"] && !req.headers[PROXY_HEADER];
}
// the address people type into a browser to reach this hub
function publicBase(req, client) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, "");
  const host = String(req.headers.host || "").toLowerCase();
  const https = (req.socket && req.socket.encrypted) || (client.peerTrusted && lastValue(req.headers["x-forwarded-proto"]) === "https");
  return /^[a-z0-9.:[\]-]{1,255}$/.test(host) ? `${https ? "https" : "http"}://${host}` : "";
}
// what the agent prints after linking: "a***n on hub.example"
function accountLabel(req, client) {
  const u = creds().user;
  const masked = u.length <= 2 ? u[0] + "***" : u[0] + "***" + u.slice(-1);
  let host = "";
  try { host = new URL(publicBase(req, client)).host; } catch (_) { /* no usable address */ }
  return host ? `${masked} on ${host}` : masked;
}

async function handleLinkApi(req, res, client) {
  const send = (code, o, extra = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(o));
  };
  const pathname = (req.url || "").split("?")[0];
  if (pathname !== "/api/v1/link/start" && pathname !== "/api/v1/link/poll") return send(404, { error: "not_found" });
  if (req.method !== "POST") return send(405, { error: "method_not_allowed" }, { allow: "POST" });
  if (!linkTransportOk(req, client)) return send(403, { error: "https_required" });
  let body = null;
  try { body = JSON.parse(await readBodyN(req, 2048)); } catch (_) { /* answered below */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "invalid_request" });
  if (pathname === "/api/v1/link/start") {
    const r = links.start({ secret: body.secret, host: body.host, os: body.os, agent: body.agent, ip: client.ip });
    if (r.status === 200) {
      r.body.verify_url = publicBase(req, client) + "/link";
      log.audit("link.started", { ip: client.ip, host: body.host });
    }
    return send(r.status, r.body, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
  }
  const r = links.poll(body.device_code);
  return send(r.status, r.body);
}

const linkPage = (inner) => SHELL(SITE + " · link a server", `<h1>${SITE} · link a server</h1>${inner}`, true);
const linkCodeForm = (base, msg = "") => linkPage(`
  <form class="body" method="POST" action="/link">
    <input type="hidden" name="step" value="lookup">
    <div class="msg">On the server, run <code>sudo servitals-agent link ${escHtml(base || "https://this-hub")}</code>
      and type the code it shows.</div>
    <label>code</label><input name="code" autocomplete="off" autofocus placeholder="XXXX-XXXX" maxlength="16">
    <button type="submit">continue</button>
    ${msg ? `<div class="msg err">${escHtml(msg)}</div>` : ""}
  </form>
  <div class="foot">only enter a code you started yourself, on your own server</div>`);
const minutes = (ms) => Math.max(0, Math.round(ms / 60000));
const linkAskForm = (q, msg = "") => linkPage(`
  <form class="body" method="POST" action="/link">
    <input type="hidden" name="step" value="decide">
    <input type="hidden" name="code" value="${escHtml(q.code)}">
    <div class="msg warn">A server asks to join this hub. Approve only if you ran
      <code>servitals-agent link</code> on it just now.</div>
    <dl class="kv">
      <dt>host</dt><dd>${escHtml(q.host)}</dd>
      <dt>system</dt><dd>${escHtml(q.os)} · agent ${escHtml(q.agent)}</dd>
      <dt>from</dt><dd>${escHtml(q.ip || "unknown address")}</dd>
      <dt>asked</dt><dd>${minutes(Date.now() - q.started)} min ago · expires in ${minutes(q.expires - Date.now())} min</dd>
      <dt>code</dt><dd>${escHtml(q.code)}</dd>
    </dl>
    <label>name</label><input name="name" value="${escHtml(q.host)}" maxlength="64">
    <label>tags (optional, comma separated)</label><input name="tags" placeholder="home, nas" maxlength="200">
    <div class="row2">
      <button type="submit" name="action" value="approve">approve</button>
      <button type="submit" name="action" value="deny" class="deny">deny</button>
    </div>
    ${msg ? `<div class="msg err">${escHtml(msg)}</div>` : ""}
  </form>`);
const LINK_ERRORS = { unknown: "unknown or expired code", too_many: "too many codes tried: wait 10 minutes" };

async function linkRoute(req, res, client) {
  // never inside another site's frame: approving is one click
  const html = (body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
                         "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
    res.end(body);
  };
  const base = publicBase(req, client);
  if (req.method !== "POST") return html(linkCodeForm(base));
  const f = new URLSearchParams(await readBody(req));
  const who = { ip: client.ip, account: creds().user };
  const code = f.get("code") || "";
  if (f.get("step") !== "decide") {
    const q = links.lookup(code, who);
    return html(q.ok ? linkAskForm(q.request) : linkCodeForm(base, LINK_ERRORS[q.error]));
  }
  if (f.get("action") === "deny") {
    const d = links.decide(code, false, who);
    if (!d.ok) return html(linkCodeForm(base, LINK_ERRORS[d.error]));
    log.audit("link.denied", { ip: client.ip, host: d.host, from: d.from });
    return html(linkPage(`<div class="body"><div class="msg">Denied. The server was told, and nothing was saved.</div>
      <div class="msg"><a href="/">back to the dashboard</a></div></div>`));
  }
  const tags = (f.get("tags") || "").split(/[\s,]+/).filter(Boolean);
  let name;
  try { name = nodes.check(f.get("name") || "", tags); }
  catch (e) {
    const q = links.lookup(code, who);
    return html(q.ok ? linkAskForm(q.request, e.message) : linkCodeForm(base, LINK_ERRORS[q.error]));
  }
  let d;
  try {
    d = links.decide(code, true, who, ({ secret }) => ({ node_id: nodes.add(name, tags, secret).id, account: accountLabel(req, client), name }));
  } catch (e) {
    log.error("link.save_failed", { error: e.message });
    return html(linkCodeForm(base, "could not save the node: " + e.message));
  }
  if (!d.ok) return html(linkCodeForm(base, LINK_ERRORS[d.error]));
  log.audit("link.approved", { ip: client.ip, node: d.result.node_id, name, from: d.from });
  return html(linkPage(`<div class="body"><div class="msg ok">Linked "${escHtml(name)}".</div>
    <div class="msg">The server shows up in the fleet within a few seconds.</div>
    <div class="msg"><a href="/#fleet">open the fleet</a></div></div>`));
}

/* ---------- proxy ---------- */
```

7. Replace

```js
async function handle(req, res) {
  // agents authenticate with signatures, never cookies; browser bans do not apply
  if ((req.url || "").startsWith("/api/v1/")) return agentApi.handle(req, res);

```

   with

```js
async function handle(req, res) {
  // agents authenticate with signatures, never cookies; browser bans do not apply
  if ((req.url || "").startsWith("/api/v1/link/")) return handleLinkApi(req, res, resolveClient(req));
  if ((req.url || "").startsWith("/api/v1/")) return agentApi.handle(req, res);

```

8. Replace

```js
  // CSRF: state-changing browser requests must come from our own origin
  const stateChange = req.method === "POST" && req.url && (
    req.url === "/__auth/login" || req.url === "/__auth/logout" || req.url.startsWith("/__ctl/"));
  if (stateChange && !originAllowed(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted })) {
    log.warn("auth.origin_refused", { ip, url: req.url, origin: req.headers.origin || "" });
```

   with

```js
  // CSRF: state-changing browser requests must come from our own origin
  const stateChange = req.method === "POST" && req.url && (
    req.url === "/__auth/login" || req.url === "/__auth/logout" || req.url.startsWith("/__ctl/") ||
    req.url.split("?")[0] === "/link");
  if (stateChange && !originAllowed(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted })) {
    log.warn("auth.origin_refused", { ip, url: req.url, origin: req.headers.origin || "" });
```

9. Replace

```js
    const ok = await checkPass(user, params.get("password") || "");
    const kiosk = kioskValue(params.get("kiosk"));
    if (ok) {
      clearFails(ip);
```

   with

```js
    const ok = await checkPass(user, params.get("password") || "");
    const kiosk = kioskValue(params.get("kiosk"));
    const next = nextValue(params.get("next"));
    if (ok) {
      clearFails(ip);
```

10. Replace

```js
      res.writeHead(302, {
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
        location: kiosk ? `/?kiosk=${kiosk}` : "/",
      });
      return res.end();
```

   with

```js
      res.writeHead(302, {
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
        location: next ? "/link" : kiosk ? `/?kiosk=${kiosk}` : "/",
      });
      return res.end();
```

11. Replace

```js
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg, kiosk));
  }

```

   with

```js
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg, kiosk, next));
  }

```

12. Replace

```js
  const authed = validCookie(getCookie(req, "sv_session"));
  const pathname = (req.url || "/").split("?")[0];

  // dashboard settings: from the state dir, not www/ (the page falls back to its defaults)
```

   with

```js
  const authed = validCookie(getCookie(req, "sv_session"));
  const pathname = (req.url || "/").split("?")[0];

  // a person approves a linking server here (spec 6.1.1)
  if (pathname === "/link") {
    if (authed) return linkRoute(req, res, client);
    if (req.method === "POST") { res.writeHead(401, { "content-type": "text/plain" }); return res.end("login required"); }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(loginPage(null, "", "link"));
  }

  // dashboard settings: from the state dir, not www/ (the page falls back to its defaults)
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (4 new tests; the approval test waits about 4 s for the poll interval).

- [ ] **Step 5: Commit**

```bash
git add hub/server.js test/link-api.test.js
git commit -m "feat(hub): link API and the /link approval page" -m "POST /api/v1/link/start and /poll answer only over TLS, from a trusted proxy that says https, or straight from loopback. /link, behind the login, looks up a code, shows the host, system, agent and source address, and approves (with a name and tags) or denies. The page cannot be framed; POST /link needs a same-origin Origin."
```

---

### Task 4: `servitals-agent link` and `unlink`

**Files:**
- Modify: `bin/servitals-agent`, `test/cli.test.js`

**Interfaces:**
- Consumes: the Task 3 endpoints; `hub_args` from `agent/lib/api.sh` and `agent_log` from `agent/lib/log.sh` (sourced from `AGENT_HOME`); `load_agent_env` and `join_result` in `bin/servitals-agent`.
- Produces: `servitals-agent link [--no-start] <https://hub>` (prints `Open <verify_url> and enter:  XXXX-XXXX`, waits, runs the same test push as `join`, saves `CREDENTIALS_FILE` 0600, prints `Linked as "<name>" to <account>.`); exit 1 with `denied on the hub; nothing was saved`, `the code expired…`, `unreachable: …`, or `link needs an https:// hub address…`; when the test push after an approval fails, it names the node the hub now lists and the `servitals-ctl node revoke` command; `servitals-agent unlink` (disable --now the unit, remove the credentials, print the revoke command). `join` now shares `work_dir` and `pair start url id secret` with `link`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
// servitals-agent link against a test hub: returns the process, its output so far and the code it printed
const { spawn } = require("node:child_process");
const { formBody } = require("./helpers/hub");
function startLink(url, env) {
  const child = spawn("bash", [path.join(BIN, "servitals-agent"), "link", "--no-start", url],
    { env: { PATH: process.env.PATH, ...env } });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { out.stdout += d; });
  child.stderr.on("data", (d) => { out.stderr += d; });
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  const code = (async () => {
    for (let i = 0; i < 100; i++) {
      const m = /enter: +([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out.stdout);
      if (m) return m[1];
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no code printed: " + out.stdout + out.stderr);
  })();
  return { child, out, exited, code };
}
async function decideOnPage(hub, code, action) {
  const cookie = cookieFrom(await login(hub.port));
  const body = formBody({ step: "decide", code, action, name: "linked-box", tags: "lab" });
  return request(hub.port, { method: "POST", path: "/link", body, headers: {
    "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), cookie,
    origin: `http://127.0.0.1:${hub.port}` } });
}

test("link: shows a code, waits for approval, saves the credentials and pushes", async () => {
  const hub = await startHub();
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    // a proxy for the internet must not catch a link to this machine itself
    const agentEnv = path.join(tmp(), "agent.env");
    fs.writeFileSync(agentEnv, "http_proxy=http://127.0.0.1:9\nHTTPS_PROXY=http://127.0.0.1:9\n");
    const l = startLink(`http://127.0.0.1:${hub.port}/`, joinEnv({ CREDENTIALS_FILE: creds, AGENT_ENV: agentEnv }));
    const code = await l.code;
    assert.match(l.out.stdout, new RegExp(`Open http://127\\.0\\.0\\.1:${hub.port}/link and enter: +${code}`));
    assert.match(l.out.stdout, /Only enter this code on that site/);
    assert.ok(!fs.existsSync(creds), "nothing saved before approval");
    assert.match((await decideOnPage(hub, code, "approve")).body, /Linked "linked-box"/);
    assert.strictEqual(await l.exited, 0, l.out.stdout + l.out.stderr);
    assert.match(l.out.stdout, /^ok$/m, "the test push landed");
    assert.match(l.out.stdout, new RegExp(`Linked as "linked-box" to a\\*\\*\\*n on 127\\.0\\.0\\.1:${hub.port}\\.`));
    assert.strictEqual(fs.statSync(creds).mode & 0o777, 0o600);
    const saved = fs.readFileSync(creds, "utf8");
    const secret = /^NODE_SECRET=([0-9a-f]{64})$/m.exec(saved)[1];
    assert.ok(!l.out.stdout.includes(secret) && !l.out.stderr.includes(secret), "the secret is never printed");
    const id = /^NODE_ID=([a-z2-7]{12})$/m.exec(saved)[1];
    const cookie = cookieFrom(await login(hub.port));
    const list = JSON.parse((await request(hub.port, { path: "/__ctl/nodes", headers: { cookie } })).body);
    assert.strictEqual(list.find((x) => x.id === id).status, "online");
  } finally { await hub.stop(); }
});

test("link: a denied code saves nothing; a plain-http hub elsewhere is refused", async () => {
  const hub = await startHub();
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    const l = startLink(`http://127.0.0.1:${hub.port}`, joinEnv({ CREDENTIALS_FILE: creds }));
    await decideOnPage(hub, await l.code, "deny");
    assert.strictEqual(await l.exited, 1);
    assert.match(l.out.stderr, /denied on the hub; nothing was saved/);
    assert.ok(!fs.existsSync(creds));
  } finally { await hub.stop(); }
  for (const url of ["http://hub.example", "http://192.168.1.5:20002", "ftp://hub.example", "https://user:pw@hub.example"]) {
    const r = run("servitals-agent", ["link", url], joinEnv({ CREDENTIALS_FILE: path.join(tmp(), "c.env") }));
    assert.strictEqual(r.status, 1, url);
    assert.match(r.stderr, /https:\/\/ hub address/, url);
  }
  const down = run("servitals-agent", ["link", "https://127.0.0.1:9"], joinEnv({ CREDENTIALS_FILE: path.join(tmp(), "c.env") }));
  assert.match(down.stderr, /^servitals-agent: unreachable: /m);
});

test("link prints what a hostile hub sends without terminal escapes", async () => {
  const http = require("node:http");
  const { signReply } = require("../hub/lib/agentsig");
  let secret = "";
  const ESC = "\u001b";
  const hub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/v1/link/start") {
        secret = JSON.parse(body).secret;
        return send(200, { device_code: "d".repeat(43), user_code: "ABCD-EFGH", expires_in: 60, interval: 1,
                           verify_url: `http://127.0.0.1/${ESC}[2Jlink` });
      }
      if (req.url === "/api/v1/link/poll") {
        return send(200, { node_id: "abcdefghijkm", name: `evil${ESC}[31mname`, account: `${ESC}]0;pwned\u0007acct` });
      }
      // the test push: a correctly signed empty answer
      const reply = "{}", ts = req.headers["x-servitals-ts"];
      return send(200, {}, { "x-servitals-sig": signReply(secret, ts, reply) });
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    const l = startLink(`http://127.0.0.1:${hub.address().port}`, joinEnv({ CREDENTIALS_FILE: creds }));
    assert.strictEqual(await l.exited, 0, l.out.stdout + l.out.stderr);
    assert.ok(!l.out.stdout.includes(ESC) && !l.out.stdout.includes("\u0007"), JSON.stringify(l.out.stdout));
    assert.match(l.out.stdout, /Linked as "evil\[31mname" to \]0;pwnedacct\./);
  } finally { hub.close(); }
});

test("link approved but the test push fails: says which node the hub now lists and saves nothing", async () => {
  const http = require("node:http");
  const hub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/v1/link/start") return send(200, { device_code: "d".repeat(43), user_code: "ABCD-EFGH", expires_in: 60, interval: 1 });
      if (req.url === "/api/v1/link/poll") return send(200, { node_id: "abcdefghijkm", name: "nas", account: "a***n on hub" });
      return send(401, { error: "clock_skew" });
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  try {
    const creds = path.join(tmp(), "agent-credentials.env");
    const l = startLink(`http://127.0.0.1:${hub.address().port}`, joinEnv({ CREDENTIALS_FILE: creds }));
    assert.strictEqual(await l.exited, 1);
    assert.match(l.out.stdout, /^clock skew: /m);
    assert.match(l.out.stdout, /The hub now lists this server as node abcdefghijkm.*servitals-ctl node revoke abcdefghijkm/s);
    assert.ok(!fs.existsSync(creds));
  } finally { hub.close(); }
});

test("unlink removes the credentials, stops the agent and says how to revoke on the hub", () => {
  const dir = tmp();
  const creds = path.join(dir, "agent-credentials.env");
  fs.writeFileSync(creds, `HUB_URL=https://hub.example\nNODE_ID=abcdefghijkm\nNODE_SECRET=${"ab".repeat(32)}\n`, { mode: 0o600 });
  const calls = path.join(dir, "calls");
  const stub = path.join(dir, "systemctl");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
  const r = run("servitals-agent", ["unlink"], { CREDENTIALS_FILE: creds, SYSTEMCTL: stub });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(creds));
  assert.match(fs.readFileSync(calls, "utf8"), /^disable --now servitals-agent\.service$/m);
  assert.match(r.stdout, /servitals-ctl node revoke abcdefghijkm/);
  const again = run("servitals-agent", ["unlink"], { CREDENTIALS_FILE: creds, SYSTEMCTL: stub });
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /not paired/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --test-name-pattern="link" test/cli.test.js`
Expected: FAIL, 5 tests: `servitals-agent link` and `unlink` print the usage text.

- [ ] **Step 3: Change `bin/servitals-agent`**

In `bin/servitals-agent`:

1. Replace

```bash
# servitals-agent: run and inspect the servitals agent.
#   servitals-agent join <hub-url> <node-id>:<secret>   pair with a hub (from servitals-ctl node add)
#   servitals-agent status           show the hub, the node and the last push
#   servitals-agent run              run the agent (the systemd unit uses this)
```

   with

```bash
# servitals-agent: run and inspect the servitals agent.
#   servitals-agent join <hub-url> <node-id>:<secret>   pair with a hub (from servitals-ctl node add)
#   servitals-agent link <https://hub>   pair by typing a short code on the hub's /link page
#   servitals-agent unlink           forget the hub and stop the agent
#   servitals-agent status           show the hub, the node and the last push
#   servitals-agent run              run the agent (the systemd unit uses this)
```

2. Replace

```bash
}

cmd_join() {
  local start=1 url cred id secret state status err result
  if [ "${1:-}" = --no-start ]; then start=0; shift; fi
  [ $# -eq 2 ] || die "usage: servitals-agent join [--no-start] <hub-url> <node-id>:<secret>"
  url=${1%/} cred=$2
  id=${cred%%:*} secret=${cred#*:}
  [[ $url =~ ^https?://[^[:space:]/@]+(/[^[:space:]@]*)?$ ]] || die "hub url: http:// or https://, no user:password@"
  [[ $id =~ ^[a-z2-7]{12}$ && $secret =~ ^[0-9a-f]{64}$ ]] || die "the join string is <12-character node id>:<64 hex characters>"
  # global, not local: the EXIT trap runs after this function has returned
  JOIN_DIR=$(mktemp -d)
  trap 'rm -rf "$JOIN_DIR"' EXIT
  chmod 700 "$JOIN_DIR"
  printf 'HUB_URL=%s\nNODE_ID=%s\nNODE_SECRET=%s\n' "$url" "$id" "$secret" > "$JOIN_DIR/credentials.env"
  state="$JOIN_DIR/state"
  echo "testing $url as node $id ..."
  # the same settings the service uses (proxy, HUB_HEADERS, HUB_CA_FILE, disks)
  load_agent_env "${AGENT_ENV:-/etc/servitals/agent.env}"
  STATE_DIR="$state" CREDENTIALS_FILE="$JOIN_DIR/credentials.env" ONCE=1 HOST_ROOT="${HOST_ROOT:-/}" \
    bash "$AGENT_HOME/collect.sh" > "$JOIN_DIR/log" 2>&1 || true
  read -r _ status err 2>/dev/null < "$state/last-push" || { status=000; err=-; }
  result=$(join_result "$status" "$err")
  echo "$result"
  [ "$result" = ok ] || exit 1
  install -m 600 "$JOIN_DIR/credentials.env" "$CREDENTIALS_FILE"
  # the service reads it as _servitals-agent (only root can hand it over)
  if [ "$(id -u)" = 0 ] && getent passwd _servitals-agent >/dev/null 2>&1; then
```

   with

```bash
}

# a private scratch directory, removed on exit. A global, not a local: the
# EXIT trap runs after the function that made it has returned.
work_dir() {
  WORK_DIR=$(mktemp -d)
  trap 'rm -rf "$WORK_DIR"' EXIT
  chmod 700 "$WORK_DIR"
}

# one test push with these credentials; on "ok" save them and start the service
pair() {  # start url id secret
  local start=$1 url=$2 id=$3 secret=$4 state="$WORK_DIR/state" status err result
  printf 'HUB_URL=%s\nNODE_ID=%s\nNODE_SECRET=%s\n' "$url" "$id" "$secret" > "$WORK_DIR/credentials.env"
  echo "testing $url as node $id ..."
  STATE_DIR="$state" CREDENTIALS_FILE="$WORK_DIR/credentials.env" ONCE=1 HOST_ROOT="${HOST_ROOT:-/}" \
    bash "$AGENT_HOME/collect.sh" > "$WORK_DIR/log" 2>&1 || true
  read -r _ status err 2>/dev/null < "$state/last-push" || { status=000; err=-; }
  result=$(join_result "$status" "$err")
  echo "$result"
  if [ "$result" != ok ]; then
    # after a link the hub already made the node, with a secret only this run knew
    [ -n "${LINKED:-}" ] && echo "The hub now lists this server as node $id, which nothing can use." \
      "Ask its admin to run: servitals-ctl node revoke $id, then fix this and run servitals-agent link again."
    exit 1
  fi
  install -m 600 "$WORK_DIR/credentials.env" "$CREDENTIALS_FILE"
  # the service reads it as _servitals-agent (only root can hand it over)
  if [ "$(id -u)" = 0 ] && getent passwd _servitals-agent >/dev/null 2>&1; then
```

3. Replace

```bash
    "${SYSTEMCTL:-systemctl}" restart servitals-agent.service && echo "servitals-agent started"
  fi
}

```

   with

```bash
    "${SYSTEMCTL:-systemctl}" restart servitals-agent.service && echo "servitals-agent started"
  fi
}

cmd_join() {
  local start=1 url cred id secret
  if [ "${1:-}" = --no-start ]; then start=0; shift; fi
  [ $# -eq 2 ] || die "usage: servitals-agent join [--no-start] <hub-url> <node-id>:<secret>"
  url=${1%/} cred=$2
  id=${cred%%:*} secret=${cred#*:}
  [[ $url =~ ^https?://[^[:space:]/@]+(/[^[:space:]@]*)?$ ]] || die "hub url: http:// or https://, no user:password@"
  [[ $id =~ ^[a-z2-7]{12}$ && $secret =~ ^[0-9a-f]{64}$ ]] || die "the join string is <12-character node id>:<64 hex characters>"
  work_dir
  # the same settings the service uses (proxy, HUB_HEADERS, HUB_CA_FILE, disks)
  load_agent_env "${AGENT_ENV:-/etc/servitals/agent.env}"
  pair "$start" "$url" "$id" "$secret"
}

# strings from the hub reach the terminal without control characters
printable() { printf '%s' "$1" | tr -d '\000-\037\177' | head -c 200; }

link_post() {  # url json-file: sets LINK_STATUS, the reply is in $WORK_DIR/out
  LINK_STATUS=$(curl -sS -o "$WORK_DIR/out" -w '%{http_code}' -X POST --max-time 20 \
    -H "Content-Type: application/json" -H "Expect:" "${HUB_ARGS[@]}" \
    --data-binary @"$2" "$1" 2>/dev/null) || LINK_STATUS=000
}
reply() { jq -r "$1 // empty" "$WORK_DIR/out" 2>/dev/null; }

# pair by code (spec 6.1.1, protocol 5.3): this machine makes its own secret,
# sends it once over HTTPS, and a person approves the short code on the hub
cmd_link() {
  local start=1 url secret host version device code verify interval expires deadline id name account
  if [ "${1:-}" = --no-start ]; then start=0; shift; fi
  [ $# -eq 1 ] || die "usage: servitals-agent link [--no-start] <https://hub>"
  url=${1%/}
  # plain http only to this machine itself: the secret must not cross a network unencrypted
  [[ $url =~ ^https://[^[:space:]/@]+(/[^[:space:]@]*)?$ ||
     $url =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/[^[:space:]@]*)?$ ]] ||
    die "link needs an https:// hub address (the new secret travels to the hub once). For a plain-http hub, use servitals-agent join"
  work_dir
  load_agent_env "${AGENT_ENV:-/etc/servitals/agent.env}"
  # like the service: a proxy never carries requests to this machine itself
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
  export no_proxy="$NO_PROXY"
  # HUB_HEADERS and HUB_CA_FILE exactly as the service sends them
  # shellcheck disable=SC2034  # read by hub_args in lib/api.sh
  STATE=$WORK_DIR
  # shellcheck source=/dev/null
  . "$AGENT_HOME/lib/log.sh"
  # shellcheck source=/dev/null
  . "$AGENT_HOME/lib/api.sh"
  hub_args
  secret=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  host=$(hostname 2>/dev/null | tr -d '\000-\037\177' | head -c 64)
  version=$(cat "$AGENT_HOME/VERSION" "$AGENT_HOME/../VERSION" 2>/dev/null | head -n 1 || true)
  jq -n --arg s "$secret" --arg h "${host:-server}" --arg a "bash/${version:-unknown}" \
    '{secret: $s, host: $h, os: "linux", agent: $a}' > "$WORK_DIR/start.json"
  link_post "$url/api/v1/link/start" "$WORK_DIR/start.json"
  case $LINK_STATUS in
    200) ;;
    000) die "unreachable: no answer from $url (address, port, firewall, proxy, certificate?)" ;;
    403) die "the hub only links over HTTPS; use its https:// address, or servitals-agent join" ;;
    404|405) die "this hub cannot link by code (update servitals on the hub), or use servitals-agent join" ;;
    429) die "too many link attempts from this address; try again in an hour" ;;
    *) die "the hub answered HTTP $LINK_STATUS $(printable "$(reply .error)")" ;;
  esac
  device=$(reply .device_code) code=$(reply .user_code) verify=$(printable "$(reply .verify_url)")
  interval=$(reply .interval) expires=$(reply .expires_in)
  [[ $device =~ ^[A-Za-z0-9_-]{16,64}$ && $code =~ ^[A-Z0-9]{4}-[A-Z0-9]{4}$ &&
     $interval =~ ^[0-9]{1,3}$ && $expires =~ ^[0-9]{1,5}$ ]] || die "the hub's answer does not look like servitals"
  [[ $verify =~ ^https?://[^[:space:]]+$ ]] || verify="$url/link"
  [ "$interval" -ge 1 ] || interval=5
  echo "Open $verify and enter:  $code"
  echo "Only enter this code on that site, in your own account."
  echo "Waiting for approval... (expires in $(( (expires + 59) / 60 )) min)"
  jq -n --arg d "$device" '{device_code: $d}' > "$WORK_DIR/poll.json"
  deadline=$(( $(date +%s) + expires + 30 ))
  while :; do
    sleep "$interval"
    link_post "$url/api/v1/link/poll" "$WORK_DIR/poll.json"
    case $LINK_STATUS in
      200) break ;;
      202|000) ;;   # still waiting, or a network blip: ask again
      429) interval=$(( interval + 5 )) ;;
      410) [ "$(reply .error)" = denied ] && die "denied on the hub; nothing was saved"
           die "the code expired (or the hub restarted); run servitals-agent link again" ;;
      *) die "the hub answered HTTP $LINK_STATUS $(printable "$(reply .error)")" ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || die "the code expired; run servitals-agent link again"
  done
  id=$(reply .node_id) name=$(printable "$(reply .name)") account=$(printable "$(reply .account)")
  [[ $id =~ ^[a-z2-7]{12}$ ]] || die "the hub's answer does not look like servitals"
  LINKED=1
  pair "$start" "$url" "$id" "$secret"
  echo "Linked as \"$name\" to ${account:-this hub}."
  echo "Not your account? Run: sudo servitals-agent unlink"
}

cmd_unlink() {
  local k v id=""
  [ -e "$CREDENTIALS_FILE" ] || die "not paired: nothing to unlink"
  [ -r "$CREDENTIALS_FILE" ] || die "run with sudo to change $CREDENTIALS_FILE"
  while IFS='=' read -r k v; do [ "$k" = NODE_ID ] && id=${v%$'\r'}; done < "$CREDENTIALS_FILE"
  "${SYSTEMCTL:-systemctl}" disable --now servitals-agent.service >/dev/null 2>&1 || true
  rm -f "$CREDENTIALS_FILE" || die "could not remove $CREDENTIALS_FILE"
  echo "unlinked: removed $CREDENTIALS_FILE and stopped servitals-agent."
  echo "The hub still lists this server until its admin runs: servitals-ctl node revoke ${id:-<node id>}"
}

```

4. Replace

```bash
case "${1:-}" in
  join)   shift; cmd_join "$@" ;;
  status) shift; cmd_status "$@" ;;
  run)    shift; exec bash "$AGENT_HOME/collect.sh" "$@" ;;
  test)   shift; cmd_test ;;
  docker) shift; docker_access "$@" ;;
  *) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

   with

```bash
case "${1:-}" in
  join)   shift; cmd_join "$@" ;;
  link)   shift; cmd_link "$@" ;;
  unlink) shift; cmd_unlink ;;
  status) shift; cmd_status "$@" ;;
  run)    shift; exec bash "$AGENT_HOME/collect.sh" "$@" ;;
  test)   shift; cmd_test ;;
  docker) shift; docker_access "$@" ;;
  *) sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

- [ ] **Step 4: Run the tests and shellcheck**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-agent`
Expected: PASS (5 new tests; the join tests still pass), no shellcheck output.

- [ ] **Step 5: Commit**

```bash
git add bin/servitals-agent test/cli.test.js
git commit -m "feat(agent): servitals-agent link and unlink" -m "link makes a secret, asks the hub for a code over HTTPS (or to this machine itself), waits for approval, runs the same test push as join, saves the credentials and prints the account it joined. Strings from the hub reach the terminal without control characters; a proxy in agent.env never carries requests to this machine. unlink stops the agent and removes its credentials."
```

---

### Task 5: Docs, the package smoke test, full validation

**Files:**
- Modify: `docs/protocol.md`, `docs/threat-model.md`, `docs/networking.md`, `README.md`, `man/servitals-agent.1`, `CHANGELOG.md`, `debian/tests/smoke`

**Interfaces:**
- Consumes: everything above, installed from the packages.

- [ ] **Step 1: The smoke test links a third agent**

In `debian/tests/smoke`:

1. Replace

```bash
#!/bin/sh
# Installed packages on a booted system: the hub and the local agent run under
# their hardened units, the first password works, passwd ends old sessions,
# and reconfiguring keeps the login and the node.
set -eu
```

   with

```bash
#!/bin/sh
# Installed packages on a booted system: the hub and the local agent run under
# their hardened units, the first password works, a second agent joins and a
# third links by code, passwd ends old sessions,
# and reconfiguring keeps the login and the node.
set -eu
```

2. Replace

```bash
	|| fail "second node not online in the fleet"

printf 'another-pass-1\n' | servitals-ctl passwd --user owner
[ "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar "$B/__ctl/whoami")" = 401 ] || fail "old session survived passwd"
```

   with

```bash
	|| fail "second node not online in the fleet"

# a third links by code (spec 6.1.1), over loopback, approved on /link as a person would
CREDENTIALS_FILE=/tmp/third.env servitals-agent link --no-start "$B" > /tmp/link.out 2>&1 &
linker=$!
wait_for "grep -q 'enter:' /tmp/link.out" || { cat /tmp/link.out; fail "link printed no code"; }
code=$(sed -n 's/.*enter: *//p' /tmp/link.out)
curl -fsS -b /tmp/jar -H "Origin: $B" --data-urlencode step=decide --data-urlencode "code=$code" \
	--data-urlencode action=approve --data-urlencode name=third "$B/link" | grep -q 'Linked "third"' \
	|| fail "approving the code on /link"
wait "$linker" || { cat /tmp/link.out; fail "servitals-agent link"; }
grep -q '^ok$' /tmp/link.out || { cat /tmp/link.out; fail "the linked agent's test push"; }
wait_for "curl -fsS -b /tmp/jar $B/__ctl/nodes | jq -e 'map(select(.name == \"third\" and .status == \"online\")) | length == 1' >/dev/null" \
	|| fail "linked node not online in the fleet"

printf 'another-pass-1\n' | servitals-ctl passwd --user owner
[ "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar "$B/__ctl/whoami")" = 401 ] || fail "old session survived passwd"
```

- [ ] **Step 2: Docs**

In `docs/protocol.md`:

1. Replace

```markdown
### 5.3 Code-based linking

Unsigned (the agent has no node id yet); HTTPS only, else
`403 https_required`. JSON bodies.

`POST /api/v1/link/start`
```

   with

```markdown
### 5.3 Code-based linking

Unsigned (the agent has no node id yet). JSON bodies of at most 2 KiB.

HTTPS only, else `403 https_required`: the connection itself is TLS, or comes
from a trusted proxy whose `X-Forwarded-Proto` says `https`, or comes straight
from the hub's own host (loopback, no forwarding headers). An `https://`
`PUBLIC_URL` alone is not enough, because the request itself may still have
travelled as plain HTTP. Pending requests live in the hub's memory; a hub
restart expires them.

`POST /api/v1/link/start`
```

2. Replace

````markdown
  "expires_in": 600, "interval": 5 }
```

`POST /api/v1/link/poll` with `{ "device_code": "…" }`:
````

   with

````markdown
  "expires_in": 600, "interval": 5 }
```

Other answers: `400 invalid_request` (a field is missing or out of range:
`secret` 64 lowercase hex, `host` 1-64 characters without control characters,
`os` and `agent` 1-32 of `A-Za-z0-9._-` and, for `agent`, `/+`),
`429 rate_limited` with `Retry-After` (more than 5 starts from one address in
an hour), `503 busy` with `Retry-After` (100 requests already waiting).

`POST /api/v1/link/poll` with `{ "device_code": "…" }`:
````

In `docs/threat-model.md`:

1. Replace

```markdown
- Cloudflare Bot Fight Mode can block agents that report through a tunnel.
  This is an availability issue documented in the tunnel guide.

## Compromise and recovery
```

   with

```markdown
- Cloudflare Bot Fight Mode can block agents that report through a tunnel.
  This is an availability issue documented in the tunnel guide.
- Code-based linking can be abused by talking someone into approving a code
  they did not start. The approval page shows the requesting host, system,
  agent version and source address and says to approve only a code started
  just now; the agent prints the account it joined, so a person tricked the
  other way round (a code approved in someone else's account) sees the wrong
  account and runs `servitals-agent unlink`. Codes are single use, valid 10
  minutes, stored hashed, and rate limited per address and per account.

## Compromise and recovery
```

In `docs/networking.md`:

1. Replace

```markdown
`/etc/servitals/hub.env` when agents should use another address than the
hub's host name, for example a tunnel hostname.

## Pick a setup
```

   with

````markdown
`/etc/servitals/hub.env` when agents should use another address than the
hub's host name, for example a tunnel hostname.

### Or link with a short code (HTTPS hubs)

When the hub is reachable over HTTPS (a tunnel, a reverse proxy with TLS, or
Tailscale with `tailscale cert`), skip the copying. On the server:

```bash
sudo servitals-agent link https://dash.example.org
#   Open https://dash.example.org/link and enter:  WXKP-4M7R
#   Only enter this code on that site, in your own account.
#   Waiting for approval... (expires in 10 min)
```

Open `/link` on the hub, log in, type the code, check the host name, system
and address shown, pick a name and tags, and approve. The agent then tests
a push, saves its credentials and starts:
`Linked as "nas" to a***n on dash.example.org.` If that is not your hub,
run `sudo servitals-agent unlink`.

The server makes its own secret and sends it to the hub once, inside TLS.
For that reason `link` refuses `http://` addresses (except this machine
itself), and the hub refuses link requests that did not arrive over HTTPS.
Plain-HTTP hubs on a LAN keep using `join`.

## Pick a setup
````

2. Replace

```markdown
| `clock skew` | the server's clock is more than 2 minutes off | enable NTP: `timedatectl set-ntp true` |
| `unsupported protocol` | the agent and hub versions do not share a protocol | update both packages |

Protocol errors in the agent's log (`journalctl -u servitals-agent`):
```

   with

```markdown
| `clock skew` | the server's clock is more than 2 minutes off | enable NTP: `timedatectl set-ntp true` |
| `unsupported protocol` | the agent and hub versions do not share a protocol | update both packages |
| `the hub only links over HTTPS` | `link` reached the hub over plain HTTP, or through a proxy that does not send `X-Forwarded-Proto: https` | use the `https://` address; check `TRUSTED_PROXIES`; or use `join` |
| `the code expired (or the hub restarted)` | not approved within 10 minutes, or the hub restarted meanwhile | run `servitals-agent link` again |

Protocol errors in the agent's log (`journalctl -u servitals-agent`):
```

In `README.md`:

1. Replace

````markdown
sudo servitals-agent join http://hub.lan:20002 <node-id>:<secret>   # on the server
```

With a second server the dashboard opens on the fleet grid: one card per
````

   with

````markdown
sudo servitals-agent join http://hub.lan:20002 <node-id>:<secret>   # on the server
```

On an HTTPS hub (a tunnel or a reverse proxy with TLS) there is nothing to
copy: run `sudo servitals-agent link https://dash.example.org` on the server,
then open `/link` on the hub and type the short code it shows.

With a second server the dashboard opens on the fleet grid: one card per
````

In `man/servitals-agent.1`:

1. Replace

```
.I hub-url node-id:secret
.br
.B servitals-agent
.RB { status | run | test }
.br
.B servitals-agent docker
```

   with

```
.I hub-url node-id:secret
.br
.B servitals-agent link
.RB [ \-\-no\-start ]
.I https://hub
.br
.B servitals-agent
.RB { unlink | status | run | test }
.br
.B servitals-agent docker
```

2. Replace

```
.RB ( \-\-no\-start
skips that).
.TP
.B status
```

   with

```
.RB ( \-\-no\-start
skips that).
.TP
.BI link " https://hub"
Pair by code, without copying a secret. The agent makes its own secret,
sends it to the hub once over HTTPS and prints a short code; open
.I /link
on the hub, log in, check what asks and approve. The agent then tests a
push like
.BR join ,
saves the credentials, starts the service and prints the account it
joined. Refuses
.B http://
addresses other than this machine; use
.B join
for plain-HTTP hubs.
.TP
.B unlink
Remove the credentials file and stop and disable the service. The hub keeps
listing the node until its admin runs
.BR "servitals\-ctl node revoke" .
.TP
.B status
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Styles: phosphor, e-ink, high contrast, nord, gruvbox, dracula,
  catppuccin and solarized join classic and 8bit. Each loads only when chosen
```

   with

```markdown

### Added
- Link a server by code on HTTPS hubs: `servitals-agent link https://hub`
  prints a short code, a person approves it on the hub's `/link` page, and the
  agent joins with a secret it made itself (RFC 8628 pattern).
  `servitals-agent unlink` forgets the hub again.
- Styles: phosphor, e-ink, high contrast, nord, gruvbox, dracula,
  catppuccin and solarized join classic and 8bit. Each loads only when chosen
```

- [ ] **Step 3: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                          # Expected: all pass (216)
pipx run --spec shellcheck-py shellcheck -S warning bin/servitals-agent debian/tests/smoke
man -l man/servitals-agent.1 | sed -n 6,10p        # Expected: link and unlink in the synopsis
bash test/budget.sh                                 # Expected: every line ok
bash test/compose-smoke.sh                          # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh    # Expected: both series, no lintian E:/W:
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh  # Expected: smoke PASS, purge PASS on both series
```

- [ ] **Step 4: Commit**

```bash
git add docs/protocol.md docs/threat-model.md docs/networking.md README.md man/servitals-agent.1 CHANGELOG.md debian/tests/smoke
git commit -m "docs: code-based linking; the package smoke test links a third agent" -m "Protocol 5.3 lists every answer and the HTTPS rule; the threat model records the approval-phishing risk and its defences; the networking guide, README and man page show servitals-agent link and unlink."
```
