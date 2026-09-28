# servitals Config as Code (sub-project 4d-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin keep the dashboard's defaults and server tags in files (`/etc/servitals/conf.d/*.json`) that win over the page, are shown there as "managed by file", are checked by `servitals-ctl config check`, and are skipped whole when wrong (spec 12).

**Architecture:** `hub/lib/confd.js` reads `*.json` in name order, validates each file completely (settings keys and values, node tags and names, no unknown keys) and merges good files key by key; a file with any mistake is skipped whole. `createConfd(dir)` keeps the hub's copy fresh (it looks at the directory at most every 2 s and logs each bad file once). The hub overlays file settings on `config.json` when the page reads it and lists the managed paths in `_managed`; `/__ctl/nodes` shows file tags and names with a per-node `managed` list, and `POST /__ctl/node/<id>` answers `409` for a managed field. The page re-applies managed values over a copy saved in the browser and disables their controls. `servitals-ctl config check` runs `confd.js check`; the package ships `/etc/servitals/conf.d/README`.

**Tech Stack:** Node.js ≥ 18 built-ins, bash, the single page, Debian packaging from sub-project 3.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 12 (configuration: `conf.d`, "managed by file", `servitals-ctl config check`, invalid files skipped and never half-applied), 10.4.

**Scope (4d-2 of sub-project 4):** settings and node tags or names. Alert rules and channels in `conf.d` (named in spec 12) arrive with the alerts of sub-project 6, which will add their keys to the same validator. 4e (backup and rotation) follows.

**Proven before writing:** every code block was built and run in a scratch copy of `feat/custom` (48e6082) on 2026-09-28: node suite 245 tests, shellcheck, the budget, `test/screens.sh` (the demo hub with a conf.d file, settings checks at 1280 and 390 px), the Docker smoke test, both series built and lintian clean, and autopkgtest smoke and purge on noble and resolute.

## Global Constraints

- Everything from sub-projects 1-4d-1 still holds: zero runtime dependencies, Node 18 compatibility (no `fetch` in `hub/` or `test/`), SPDX headers, lintian clean, the lightness budget.
- Files are JSON objects with only `settings` and `nodes`; settings keys: `title` (1-64 characters), `refreshSec` (5-900), `kioskSec` (5-600), `kiosk`, `style` (`^[a-z0-9-]{1,32}$`), `mode` (system/light/dark), `density` (compact/comfortable/large), `units` (temp c/f, size binary/decimal, rate bytes/bits, clock auto/24h/12h), `fleet` (sort, group, card, pinned, hidden), `panels`, `panelSize`, `panelOrder` (panel names mem cpu temp storage network docker clocks weather). Nodes by 12-character id or name: `tags` (the node tag rule), `name`. At most 256 KB per file.
- A file with any mistake is skipped whole and logged (`config.file_skipped`, once per file and content); the hub never stops because of `conf.d`. A missing directory means no files.
- Values from files win: over `config.json`, over a copy saved in a browser, and over edits in the page (those controls are disabled). `_managed` is never written to `config.json`.
- Tests and the screenshot demo hub never read this host's `/etc/servitals/conf.d` (`CONFD_DIR` points elsewhere).
- The live dashboard runs on this host. Tests run in temp dirs and containers only.
- Work in a worktree `.claude/worktrees/servitals-confd` on branch `feat/confd` from `feat/custom` (48e6082), or from `main` once PRs #9 and #10 are merged.
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **A wrong, half-written or hostile file** (bad JSON, a wrong value deep inside, unknown keys, `__proto__`, a huge file, a file being written while read): nothing from it may apply, the hub keeps serving, the log says which file and where, once. Tests: Task 1 "a file with any mistake is skipped whole…", "no directory, an empty one, or a huge file", "the hub's copy follows edits…"; Task 2 the bad-file part of the conf.d test.
2. **Which value wins**: files over the page, files over a browser's saved copy, later files over earlier ones key by key, the page's own values where files are silent. Tests: Task 1 "files are read in name order…"; Task 2 conf.d test (units merge key by key); Task 3 "conf.d values win over a copy saved in this browser…".
3. **Editing something a file manages**: the page must not offer it, and the hub must refuse it. Tests: Task 2 (`409` for managed tags, `200` for an unmanaged name); Task 3 (disabled inputs).
4. **Tests that depend on the machine they run on**: no test may read `/etc/servitals/conf.d`. Test: Task 2 changes the test helper and the demo hub.
5. **The package**: `/etc/servitals/conf.d` exists with a README whose example is itself a valid file; `config check` works from the installed paths. Tests: Task 4 "the package and install-local.sh create /etc/servitals/conf.d…", "servitals-ctl config check…".

---

### Task 1: Reading and checking conf.d (`hub/lib/confd.js`)

**Files:**
- Create: `hub/lib/confd.js`, `test/confd.test.js`

**Interfaces:**
- Produces: `readConfd(dir) → { settings, nodes, managed: [paths], files: [{ name, ok, error? }] }` (paths such as `"title"`, `"units.temp"`, sorted); `createConfd(dir, { log, now }) → { get() }`; `parseFile(text) → { settings, nodes }` (throws with `"<path>: <what>"`); CLI `node hub/lib/confd.js check <dir>` (lines `ok     <file>` / `error  <file>: <message>`, `no files in <dir>`, exit 1 when any file is wrong). Task 2 uses `createConfd`; Task 4 runs the CLI and `parseFile`.

- [ ] **Step 1: Write the failing tests**

Create `test/confd.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readConfd, createConfd } = require("../hub/lib/confd");

const CONFD_JS = path.join(__dirname, "..", "hub", "lib", "confd.js");
function dir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sv-confd-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), typeof body === "string" ? body : JSON.stringify(body));
  return d;
}

test("files are read in name order; later values win, key by key", () => {
  const d = dir({
    "10-base.json": { settings: { title: "home", units: { temp: "f", clock: "24h" }, fleet: { sort: "cpu" } } },
    "20-over.json": { settings: { units: { temp: "c" }, kiosk: true }, nodes: { nas: { tags: ["home"] } } },
    "README": "not json, not read",
    "30-off.json.example": "{ nope",
  });
  const c = readConfd(d);
  assert.deepStrictEqual(c.settings, { title: "home", units: { temp: "c", clock: "24h" }, fleet: { sort: "cpu" }, kiosk: true });
  assert.deepStrictEqual(c.nodes, { nas: { tags: ["home"] } });
  assert.deepStrictEqual(c.managed, ["fleet.sort", "kiosk", "title", "units.clock", "units.temp"]);
  assert.deepStrictEqual(c.files.map((f) => [f.name, f.ok]), [["10-base.json", true], ["20-over.json", true]]);
});

test("a file with any mistake is skipped whole and says where", () => {
  const cases = [
    ["{ not json", /not valid JSON/],
    ["[1]", /an object with "settings" and\/or "nodes"/],
    [{ setting: {} }, /unknown key "setting"/],
    [{ settings: { units: { temp: "k" } } }, /settings\.units\.temp: one of c, f/],
    [{ settings: { fleet: { card: ["cpu", "gpu"] } } }, /settings\.fleet\.card: a list of cpu, mem, temp, disk, containers/],
    [{ settings: { refreshSec: 2 } }, /settings\.refreshSec: a number from 5 to 900/],
    [{ settings: { title: "x".repeat(65) } }, /settings\.title: 1-64 characters/],
    [{ settings: { style: "Bad Style" } }, /settings\.style: a style name/],
    [{ settings: { panels: { mem: "yes" } } }, /settings\.panels\.mem: true or false/],
    [{ settings: { panelSize: { mem: "huge" } } }, /settings\.panelSize\.mem: one of normal, wide, full/],
    [{ settings: { favicon: "x" } }, /unknown key "favicon"/],
    [{ nodes: { nas: { tags: ["Bad Tag"] } } }, /nodes\.nas\.tags: tag "Bad Tag"/],
    [{ nodes: { nas: { colour: "red" } } }, /nodes\.nas: unknown key "colour"/],
    [{ nodes: { "": { tags: [] } } }, /nodes: a node id or name/],
    [JSON.stringify({ settings: { title: "ok" } }).replace("{", '{"__proto__":{"x":1},'), /unknown key "__proto__"/],
  ];
  for (const [body, want] of cases) {
    const d = dir({ "10-good.json": { settings: { title: "kept" } }, "20-bad.json": body });
    const c = readConfd(d);
    assert.deepStrictEqual(c.settings, { title: "kept" }, JSON.stringify(body));
    const bad = c.files.find((f) => f.name === "20-bad.json");
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, want, JSON.stringify(body));
  }
  assert.strictEqual(({}).x, undefined);
});

test("no directory, an empty one, or a huge file", () => {
  assert.deepStrictEqual(readConfd("/nonexistent/servitals/conf.d"), { settings: {}, nodes: {}, managed: [], files: [] });
  const d = dir({ "10-big.json": JSON.stringify({ settings: { title: "x" } }) + " ".repeat(300 * 1024) });
  assert.match(readConfd(d).files[0].error, /larger than 256 KB/);
});

test("the hub's copy follows edits, at most every 2 seconds, and logs each bad file once", () => {
  const d = dir({ "10-a.json": { settings: { title: "one" } } });
  let t = 1e12;
  const logged = [];
  const log = { warn: (event, f) => logged.push([event, f.file]) };
  const c = createConfd(d, { log, now: () => t });
  assert.strictEqual(c.get().settings.title, "one");
  fs.writeFileSync(path.join(d, "10-a.json"), JSON.stringify({ settings: { title: "two" } }));
  fs.writeFileSync(path.join(d, "20-b.json"), "{ bad");
  assert.strictEqual(c.get().settings.title, "one", "not looked at again within 2 s");
  t += 2001;
  assert.strictEqual(c.get().settings.title, "two");
  t += 2001; c.get();
  assert.deepStrictEqual(logged, [["config.file_skipped", "20-b.json"]]);
});

test("servitals-ctl config check: one line per file, exit 1 when any file is wrong", () => {
  const good = dir({ "10-a.json": { settings: { title: "one" } } });
  let r = spawnSync(process.execPath, [CONFD_JS, "check", good], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok +10-a\.json$/m);
  const bad = dir({ "10-a.json": { settings: { title: "one" } }, "20-b.json": { settings: { units: { temp: "k" } } } });
  r = spawnSync(process.execPath, [CONFD_JS, "check", bad], { encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error +20-b\.json: settings\.units\.temp: one of c, f$/m);
  r = spawnSync(process.execPath, [CONFD_JS, "check", "/nonexistent/dir"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no files in \/nonexistent\/dir/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/confd.test.js`
Expected: FAIL: `Cannot find module '../hub/lib/confd'`.

- [ ] **Step 3: Write `hub/lib/confd.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Config as code (spec 12): /etc/servitals/conf.d/*.json, read in name order.
 * A file holds "settings" (dashboard defaults) and/or "nodes" (tags or a name
 * per node id or name). Later files win, key by key; values from files win over
 * values edited in the page, which shows them as "managed by file". A file with
 * any mistake is skipped whole and logged, never half-applied.
 *
 *   node confd.js check <dir>     what servitals-ctl config check runs
 */
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 256 * 1024;
const CHECK_EVERY_MS = 2000;
const PANELS = ["mem", "cpu", "temp", "storage", "network", "docker", "clocks", "weather"];
const NODE_ID = /^[a-z2-7]{12}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;

class Invalid extends Error {}
const fail = (where, what) => { throw new Invalid(`${where}: ${what}`); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function onlyKeys(obj, where, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(where, `unknown key "${k}"`);
}
const oneOf = (choices) => (v, where) => { if (!choices.includes(v)) fail(where, `one of ${choices.join(", ")}`); return v; };
const bool = (v, where) => { if (typeof v !== "boolean") fail(where, "true or false"); return v; };
const range = (lo, hi) => (v, where) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fail(where, `a number from ${lo} to ${hi}`);
  return v;
};
const listOf = (choices, what) => (v, where) => {
  if (!Array.isArray(v) || !v.every((x) => choices.includes(x))) fail(where, `a list of ${what || choices.join(", ")}`);
  return [...v];
};
const strings = (v, where) => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(where, "a list of words");
  return [...v];
};
// an object whose keys come from `keys` and whose values pass `check`
const table = (keys, check) => (v, where) => {
  if (!isObject(v)) fail(where, "an object");
  onlyKeys(v, where, keys);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = typeof check === "function" ? check(x, `${where}.${k}`) : check[k](x, `${where}.${k}`);
  return out;
};

const SETTINGS = {
  title: (v, where) => { if (typeof v !== "string" || !NAME.test(v)) fail(where, "1-64 characters"); return v; },
  refreshSec: range(5, 900),
  kioskSec: range(5, 600),
  kiosk: bool,
  style: (v, where) => { if (typeof v !== "string" || !/^[a-z0-9-]{1,32}$/.test(v)) fail(where, "a style name"); return v; },
  mode: oneOf(["system", "light", "dark"]),
  density: oneOf(["compact", "comfortable", "large"]),
  units: table(["temp", "size", "rate", "clock"], {
    temp: oneOf(["c", "f"]), size: oneOf(["binary", "decimal"]), rate: oneOf(["bytes", "bits"]), clock: oneOf(["auto", "24h", "12h"]),
  }),
  fleet: table(["sort", "group", "card", "pinned", "hidden"], {
    sort: oneOf(["name", "status", "cpu", "mem", "temp", "disk"]), group: bool,
    card: listOf(["cpu", "mem", "temp", "disk", "containers"]), pinned: strings, hidden: strings,
  }),
  panels: table(PANELS, bool),
  panelSize: table(PANELS, oneOf(["normal", "wide", "full"])),
  panelOrder: listOf(PANELS, "panel names"),
};
const NESTED = ["units", "fleet", "panels", "panelSize"];   // merged key by key

function checkNode(key, v) {
  const where = `nodes.${key}`;
  if (!NODE_ID.test(key) && !NAME.test(key)) fail("nodes", "a node id or name for each entry");
  if (!isObject(v)) fail(where, "an object");
  onlyKeys(v, where, ["tags", "name"]);
  const out = {};
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags)) fail(`${where}.tags`, "a list");
    for (const t of v.tags) {
      if (typeof t !== "string" || !TAG.test(t)) fail(`${where}.tags`, `tag "${t}": lowercase letters, digits, dot, dash, underscore`);
    }
    out.tags = [...new Set(v.tags)];
  }
  if (v.name !== undefined) {
    if (typeof v.name !== "string" || !NAME.test(v.name.trim())) fail(`${where}.name`, "1-64 characters");
    out.name = v.name.trim();
  }
  return out;
}

// one file's text: { settings, nodes } or an Invalid error
function parseFile(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Invalid(`not valid JSON: ${e.message}`); }
  if (!isObject(obj)) throw new Invalid('an object with "settings" and/or "nodes"');
  onlyKeys(obj, "file", ["settings", "nodes"]);
  const settings = {}, nodes = {};
  if (obj.settings !== undefined) {
    if (!isObject(obj.settings)) fail("settings", "an object");
    onlyKeys(obj.settings, "settings", Object.keys(SETTINGS));
    for (const [k, v] of Object.entries(obj.settings)) settings[k] = SETTINGS[k](v, `settings.${k}`);
  }
  if (obj.nodes !== undefined) {
    if (!isObject(obj.nodes)) fail("nodes", "an object");
    for (const [k, v] of Object.entries(obj.nodes)) nodes[k] = checkNode(k, v);
  }
  return { settings, nodes };
}

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
      .map((name) => ({ name, file: path.join(dir, name), st: fs.statSync(path.join(dir, name)) }))
      .filter((f) => f.st.isFile());
  } catch (_) { return []; }
}

function readConfd(dir) {
  const out = { settings: {}, nodes: {}, managed: [], files: [] };
  for (const { name, file, st } of jsonFiles(dir)) {
    try {
      if (st.size > MAX_BYTES) throw new Invalid("larger than 256 KB");
      const { settings, nodes } = parseFile(fs.readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(settings)) {
        out.settings[k] = NESTED.includes(k) ? { ...(out.settings[k] || {}), ...v } : v;
      }
      for (const [k, v] of Object.entries(nodes)) out.nodes[k] = { ...(out.nodes[k] || {}), ...v };
      out.files.push({ name, ok: true });
    } catch (e) {
      if (!(e instanceof Invalid)) e.message = `could not read: ${e.code || e.message}`;
      out.files.push({ name, ok: false, error: e.message });
    }
  }
  for (const [k, v] of Object.entries(out.settings)) {
    if (NESTED.includes(k)) for (const n of Object.keys(v)) out.managed.push(`${k}.${n}`);
    else out.managed.push(k);
  }
  out.managed.sort();
  return out;
}

// the hub's copy: looks at the directory again at most every 2 s, logs each bad file once
function createConfd(dir, { log, now = Date.now } = {}) {
  let current = null, lastCheck = -Infinity, signature = "";
  const logged = new Set();
  function get() {
    const t = now();
    if (current && t - lastCheck < CHECK_EVERY_MS) return current;
    lastCheck = t;
    const sig = jsonFiles(dir).map((f) => `${f.name}:${f.st.mtimeMs}:${f.st.size}`).join("|");
    if (current && sig === signature) return current;
    signature = sig;
    current = readConfd(dir);
    for (const f of current.files) {
      const key = `${f.name}:${f.error}`;
      if (!f.ok && !logged.has(key)) { logged.add(key); if (log) log.warn("config.file_skipped", { file: f.name, error: f.error }); }
    }
    return current;
  }
  return { get };
}

module.exports = { readConfd, createConfd, parseFile };

if (require.main === module) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== "check" || !dir) { process.stderr.write("usage: confd.js check <dir>\n"); process.exit(2); }
  const c = readConfd(dir);
  if (!c.files.length) process.stdout.write(`no files in ${dir}\n`);
  for (const f of c.files) process.stdout.write(f.ok ? `ok     ${f.name}\n` : `error  ${f.name}: ${f.error}\n`);
  process.exit(c.files.every((f) => f.ok) ? 0 : 1);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/confd.js test/confd.test.js
git commit -m "feat(hub): read and check config files in conf.d" -m "readConfd() reads *.json in name order, checks every key and value, merges good files key by key and skips a file with any mistake whole, saying where. createConfd() keeps the hub's copy fresh and logs each bad file once. node hub/lib/confd.js check <dir> prints one line per file."
```

---

### Task 2: The hub applies conf.d

**Files:**
- Modify: `hub/server.js`, `test/multinode.test.js`, `test/state.test.js`, `test/helpers/hub.js`, `test/screens/demo-hub.js`

**Interfaces:**
- Consumes: `createConfd` (Task 1).
- Produces: `CONFD_DIR` (default `/etc/servitals/conf.d`); `GET /config.json` = saved settings with file settings on top (objects merged key by key) plus `_managed`; `POST /__ctl/config` drops `_managed`; `/__ctl/nodes` and `/__ctl/node/<id>` nodes carry file `tags`/`name` and `managed: ["name"?, "tags"?]`; `POST /__ctl/node/<id>` → `409 { error: "tags are managed by a file in conf.d" }` (or "the name is …"); log `config.confd` at start. Task 3's page reads `_managed` and `managed`.

- [ ] **Step 1: Keep tests off this host's conf.d, and write the failing test**

In `test/helpers/hub.js`:

1. Replace

```js
    AUTH_PASS: DEFAULT_PASS,
    LOG_LEVEL: "debug",
  };
}
```

   with

```js
    AUTH_PASS: DEFAULT_PASS,
    LOG_LEVEL: "debug",
    CONFD_DIR: "/nonexistent/servitals-test/conf.d",   // never this host's /etc/servitals/conf.d
  };
}
```

In `test/screens/demo-hub.js`:

1. Replace

```js
const hub = spawn(process.execPath, [path.join(REPO, "hub/server.js")], {
  env: { PATH: process.env.PATH, PORT: String(PORT), STATE_DIR: state, UPSTREAM: "", AUTH_USER: "demo",
         AUTH_PASS: "demo-pass-1", LOG_LEVEL: "error" },
  stdio: "inherit",
});
```

   with

```js
const hub = spawn(process.execPath, [path.join(REPO, "hub/server.js")], {
  env: { PATH: process.env.PATH, PORT: String(PORT), STATE_DIR: state, UPSTREAM: "", AUTH_USER: "demo",
         AUTH_PASS: "demo-pass-1", LOG_LEVEL: "error", CONFD_DIR: path.join(state, "conf.d") },
  stdio: "inherit",
});
```

In `test/state.test.js`:

1. Replace

```js
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.headers["cache-control"], "no-store");
    assert.deepStrictEqual(JSON.parse(empty.body), {});
    const saved = await ctlPost(hub.port, cookie, "/__ctl/config", JSON.stringify({ title: "lab" }));
    assert.strictEqual(saved.status, 200);
```

   with

```js
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.headers["cache-control"], "no-store");
    assert.deepStrictEqual(JSON.parse(empty.body), { _managed: [] }, "nothing saved, no conf.d files");
    const saved = await ctlPost(hub.port, cookie, "/__ctl/config", JSON.stringify({ title: "lab" }));
    assert.strictEqual(saved.status, 200);
```

In `test/multinode.test.js`:

1. Replace

```js
    assert.match(fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8"), /node\.revoked/);
  } finally { await hub.stop(); }
});

```

   with

```js
    assert.match(fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8"), /node\.revoked/);
  } finally { await hub.stop(); }
});

test("conf.d: file settings win in config.json and are listed as managed; file tags and names win for nodes", async () => {
  const confd = fs.mkdtempSync(path.join(os.tmpdir(), "sv-confd-"));
  fs.writeFileSync(path.join(confd, "10-site.json"), JSON.stringify({
    settings: { title: "from file", units: { temp: "f" } },
    nodes: { nas: { tags: ["storage"] } },
  }));
  const hub = await startHub({ CONFD_DIR: confd });
  try {
    const c = addNode(hub, "nas");
    const cookie = cookieFrom(await login(hub.port));
    assert.strictEqual((await ctlPost(hub.port, cookie, "/__ctl/config",
      JSON.stringify({ title: "from page", units: { temp: "c", clock: "12h" }, _managed: ["x"] }))).status, 200);
    const cfg = (await getJSON(hub, cookie, "/config.json")).body;
    assert.strictEqual(cfg.title, "from file");
    assert.deepStrictEqual(cfg.units, { temp: "f", clock: "12h" }, "key by key: the page's clock stays");
    assert.deepStrictEqual(cfg._managed, ["title", "units.temp"]);
    const saved = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "config.json"), "utf8"));
    assert.strictEqual(saved._managed, undefined, "the list is never saved");

    const n = (await getJSON(hub, cookie, "/__ctl/nodes")).body.find((x) => x.id === c.id);
    assert.deepStrictEqual([n.tags, n.managed], [["storage"], ["tags"]]);
    const r = await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ tags: ["other"] }));
    assert.deepStrictEqual([r.status, JSON.parse(r.body).error], [409, "tags are managed by a file in conf.d"]);
    assert.strictEqual((await ctlPost(hub.port, cookie, `/__ctl/node/${c.id}`, JSON.stringify({ name: "nas2" }))).status, 200, "the name is not managed");

    fs.writeFileSync(path.join(confd, "20-bad.json"), "{ nope");
    await sleep(2100);
    assert.strictEqual((await getJSON(hub, cookie, "/config.json")).body.title, "from file", "a bad file changes nothing");
    assert.match(hub.logs(), /config\.file_skipped.*20-bad\.json/);
  } finally { await hub.stop(); fs.rmSync(confd, { recursive: true, force: true }); }
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/state.test.js test/multinode.test.js`
Expected: FAIL, 2 tests: "config.json lives in the state dir…" (the body is `{}`, no `_managed`) and "conf.d: file settings win…" (`'from page' !== 'from file'`).

- [ ] **Step 3: Change the hub**

In `hub/server.js`:

1. Replace

```js
const { createAdminStore, USER_RE } = require("./lib/admin");
const { createLinks } = require("./lib/link");

const UP        = process.env.UPSTREAM     || "";   // unset: serve WWW_DIR directly (native install)
```

   with

```js
const { createAdminStore, USER_RE } = require("./lib/admin");
const { createLinks } = require("./lib/link");
const { createConfd } = require("./lib/confd");

const UP        = process.env.UPSTREAM     || "";   // unset: serve WWW_DIR directly (native install)
```

2. Replace

```js
    log.info("config.migrated", { from: LEGACY_CONFIG, to: CONFIG_F });
  } catch (e) { log.warn("config.migrate_failed", { from: LEGACY_CONFIG, error: e.code || String(e) }); }
}

```

   with

```js
    log.info("config.migrated", { from: LEGACY_CONFIG, to: CONFIG_F });
  } catch (e) { log.warn("config.migrate_failed", { from: LEGACY_CONFIG, error: e.code || String(e) }); }
}

/* ---------- config as code (spec 12): conf.d files win over the page ---------- */
const CONFD_DIR = process.env.CONFD_DIR || "/etc/servitals/conf.d";
const confd = createConfd(CONFD_DIR, { log });
{
  const c = confd.get();
  log.info("config.confd", { dir: CONFD_DIR, files: c.files.length, skipped: c.files.filter((f) => !f.ok).length });
}
// a node as the page sees it: tags and name from a conf.d file win (matched by id, else by name)
function withFile(n) {
  const all = confd.get().nodes;
  const f = all[n.id] || all[n.name] || null;
  if (!f) return { ...n, managed: [] };
  return { ...n, ...f, managed: Object.keys(f).sort() };
}

```

3. Replace

```js

  // dashboard settings: from the state dir, not www/ (the page falls back to its defaults)
  if (authed && req.method === "GET" && pathname === "/config.json") {
    let body = "{}\n";
    try { body = fs.readFileSync(CONFIG_F, "utf8"); } catch (_) { /* nothing saved yet */ }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(body);
  }

```

   with

```js

  // dashboard settings: from the state dir, not www/ (the page falls back to its defaults)
  // settings from the page, with conf.d values on top; _managed lists what the files set
  if (authed && req.method === "GET" && pathname === "/config.json") {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(CONFIG_F, "utf8")); } catch (_) { /* nothing saved yet */ }
    const out = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    const c = confd.get();
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    for (const [k, v] of Object.entries(c.settings)) out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
    out._managed = c.managed;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(out, null, 2) + "\n");
  }

```

4. Replace

```js
    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
      const list = nodes.list().map((n) => {
        const rec = latest.get(n.id);
        return { ...n, status: nodeStatus(n.id), lastSeen: rec ? rec.at : null,
```

   with

```js
    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
      const list = nodes.list().map(withFile).map((n) => {
        const rec = latest.get(n.id);
        return { ...n, status: nodeStatus(n.id), lastSeen: rec ? rec.at : null,
```

5. Replace

```js
    const nm = /^\/__ctl\/node\/([a-z2-7]{12})$/.exec(pathname);
    if (req.method === "GET" && nm) {
      const n = nodes.list().find((x) => x.id === nm[1]);
      if (!n) return json(404, { error: "no such node" });
      const rec = latest.get(n.id);
```

   with

```js
    const nm = /^\/__ctl\/node\/([a-z2-7]{12})$/.exec(pathname);
    if (req.method === "GET" && nm) {
      const n = nodes.list().map(withFile).find((x) => x.id === nm[1]);
      if (!n) return json(404, { error: "no such node" });
      const rec = latest.get(n.id);
```

6. Replace

```js
      try { body = JSON.parse(await readBodyN(req, 4096)); } catch (_) { /* answered below */ }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid json" });
      try {
        // check both before changing either
```

   with

```js
      try { body = JSON.parse(await readBodyN(req, 4096)); } catch (_) { /* answered below */ }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid json" });
      const managed = withFile(nodes.list().find((x) => x.id === id)).managed;
      for (const k of ["tags", "name"]) {
        if (body[k] !== undefined && managed.includes(k)) return json(409, { error: `${k === "tags" ? "tags are" : "the name is"} managed by a file in conf.d` });
      }
      try {
        // check both before changing either
```

7. Replace

```js
      try { obj = JSON.parse(body); } catch { return json(400, { error: "invalid json" }); }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return json(400, { error: "not an object" });
      if (obj.favicon && !/^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+$/.test(obj.favicon))
        return json(400, { error: "favicon must be a base64 data:image URI" });
```

   with

```js
      try { obj = JSON.parse(body); } catch { return json(400, { error: "invalid json" }); }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return json(400, { error: "not an object" });
      delete obj._managed;   // what conf.d sets comes from the files, never from a save
      if (obj.favicon && !/^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+$/.test(obj.favicon))
        return json(400, { error: "favicon must be a base64 data:image URI" });
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS (1 new test).

- [ ] **Step 5: Commit**

```bash
git add hub/server.js test/multinode.test.js test/state.test.js test/helpers/hub.js test/screens/demo-hub.js
git commit -m "feat(hub): conf.d settings and node tags win over the page" -m "GET /config.json puts file settings over the saved ones and lists the managed paths in _managed, which is never saved. The node list shows file tags and names with a managed list, and the page cannot change a managed field (409). Tests and the demo hub never read this host's /etc/servitals/conf.d."
```

---

### Task 3: The page shows what files manage

**Files:**
- Modify: `www/index.html`, `test/page.test.js`, `test/screens/demo-hub.js`

**Interfaces:**
- Consumes: `_managed` in `config.json` and `managed` on nodes (Task 2).
- Produces: `managedPaths()`, `applyManaged()` (called right after the saved-copy merge in `loadConfig`), `managedSelector(path) → selector | null`, `markManaged()` (disables and marks controls; called at the end of `openSettings`, `renderServers` and `drawPanelCfg`); name and tags inputs of a server row are disabled when its `managed` says so; CSS `.managed`.

- [ ] **Step 1: Write the failing test**

In `test/page.test.js`:

1. Replace

```js
  assert.deepStrictEqual(seen, [["en-GB", undefined], [undefined, undefined], [undefined, true]]);
});

```

   with

```js
  assert.deepStrictEqual(seen, [["en-GB", undefined], [undefined, undefined], [undefined, true]]);
});

test("conf.d values win over a copy saved in this browser, and their fields are marked managed", () => {
  const DEFAULTS = { title: "file", units: { temp: "f", clock: "12h" }, panels: { mem: false }, _managed: ["title", "units.temp", "panels.mem", 5] };
  const cfg = { title: "browser", units: { temp: "c", clock: "24h" }, panels: { mem: true, cpu: true } };
  pageFn("applyManaged", { cfg, DEFAULTS, managedPaths: pageFn("managedPaths", { DEFAULTS }) })();
  assert.deepStrictEqual(cfg, { title: "file", units: { temp: "f", clock: "24h" }, panels: { mem: false, cpu: true } });
  DEFAULTS.units.temp = "c";
  assert.strictEqual(cfg.units.temp, "f", "a copy, not the same object");
  const sel = pageFn("managedSelector", {});
  assert.strictEqual(sel("title"), "#cfg-name");
  assert.strictEqual(sel("units.temp"), "#cfg-u-temp");
  assert.strictEqual(sel("fleet.card"), "#cfg-f-card input");
  assert.strictEqual(sel("panels.mem"), '#cfg-panels [data-p="mem"] [data-vis]');
  assert.strictEqual(sel("panelSize.docker"), '#cfg-panels [data-p="docker"] [data-sz]');
  assert.strictEqual(sel("style"), "#cfg-lookdefault");
  assert.strictEqual(sel("nonsense"), null);
  assert.match(HTML, /cfg = saved \? deepMerge\(structuredClone\(DEFAULTS\), saved\) : structuredClone\(DEFAULTS\);\n  applyManaged\(\);/);
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /\(n\.managed \|\| \[\]\)\.includes\("tags"\) \? " disabled/, "file-managed tags cannot be edited");
  assert.match(fn("openSettings"), /markManaged\(\);/);
});

```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 1 test: "conf.d values win over a copy saved in this browser…" (`applyManaged` is not found).

- [ ] **Step 3: Change the page**

In `www/index.html`:

1. Replace

```html
  .srv input[type=text] { flex: 1 1 140px; min-width: 0; }
  .srv .local { color: var(--dim); font-size: 11px; }
  .ncard .kv small { display: block; color: var(--dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .ncard .foot { display: flex; justify-content: space-between; gap: 6px; color: var(--dim); font-size: 12px; }
```

   with

```html
  .srv input[type=text] { flex: 1 1 140px; min-width: 0; }
  .srv .local { color: var(--dim); font-size: 11px; }
  .modal .managed { opacity: .8; }
  .modal .field.managed > span::after, .modal .check.managed::after { content: " · managed by file"; color: var(--dim); }
  .ncard .kv small { display: block; color: var(--dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
  .ncard .foot { display: flex; justify-content: space-between; gap: 6px; color: var(--dim); font-size: 12px; }
```

2. Replace

```html
  try { saved = JSON.parse(lsGet("cfg") || "null"); } catch (e) {}
  cfg = saved ? deepMerge(structuredClone(DEFAULTS), saved) : structuredClone(DEFAULTS);
  fixPanelOrder();
}
// every panel appears exactly once in the order list
```

   with

```html
  try { saved = JSON.parse(lsGet("cfg") || "null"); } catch (e) {}
  cfg = saved ? deepMerge(structuredClone(DEFAULTS), saved) : structuredClone(DEFAULTS);
  applyManaged();
  fixPanelOrder();
}
/* config as code (spec 12): what files in /etc/servitals/conf.d set (the hub
   lists it in _managed) wins, also over a copy saved in this browser */
function managedPaths() {
  return Array.isArray(DEFAULTS._managed) ? DEFAULTS._managed.filter(p => typeof p === "string") : [];
}
function applyManaged() {
  for (const p of managedPaths()) {
    const [k, sub] = p.split(".");
    if (sub === undefined) { if (DEFAULTS[k] !== undefined) cfg[k] = structuredClone(DEFAULTS[k]); }
    else if (DEFAULTS[k] && DEFAULTS[k][sub] !== undefined) {
      if (!cfg[k] || typeof cfg[k] !== "object") cfg[k] = {};
      cfg[k][sub] = structuredClone(DEFAULTS[k][sub]);
    }
  }
}
// the settings control for a managed path, or null
function managedSelector(p) {
  const plain = { title: "#cfg-name", refreshSec: "#cfg-refresh", kiosk: "#cfg-kiosk", kioskSec: "#cfg-kiosksec",
                  style: "#cfg-lookdefault", mode: "#cfg-lookdefault", density: "#cfg-lookdefault",
                  panelOrder: "#cfg-panels [data-up], #cfg-panels [data-down]",
                  "fleet.sort": "#cfg-f-sort", "fleet.group": "#cfg-f-group", "fleet.card": "#cfg-f-card input",
                  "fleet.pinned": "#cfg-servers .srv-pin", "fleet.hidden": "#cfg-servers .srv-hide" };
  if (plain[p]) return plain[p];
  const m = /^(units|panels|panelSize)\.([a-z]+)$/.exec(p);
  if (!m) return null;
  if (m[1] === "units") return `#cfg-u-${m[2]}`;
  return `#cfg-panels [data-p="${m[2]}"] [data-${m[1] === "panels" ? "vis" : "sz"}]`;
}
function markManaged() {
  const note = "managed by a file in /etc/servitals/conf.d";
  for (const p of managedPaths()) {
    const sel = managedSelector(p);
    if (!sel) continue;
    for (const el of $$(sel)) {
      el.disabled = true;
      el.title = note;
      const box = el.closest(".field, .check, .pcf");
      if (box) box.classList.add("managed");
    }
  }
}
// every panel appears exactly once in the order list
```

3. Replace

```html
  const typed = (n, k, saved) => (f.names[n.id] ? f.names[n.id][k] : saved);
  $("#cfg-servers").innerHTML = fleetNodes.map(n => `<div class="srv" data-id="${esc(n.id)}">`
    + `<input type="text" class="srv-name" value="${esc(typed(n, "name", n.name))}" maxlength="64" aria-label="name of ${esc(n.name)}">`
    + `<input type="text" class="srv-tags" value="${esc(typed(n, "tags", (n.tags || []).join(", ")))}" placeholder="tags" aria-label="tags of ${esc(n.name)}">`
    + `<label class="check"><input type="checkbox" class="srv-pin"${pinned.has(n.id) ? " checked" : ""}> pin</label>`
    + `<label class="check"><input type="checkbox" class="srv-hide"${hidden.has(n.id) ? " checked" : ""}> hide</label>`
    + (n.local ? `<span class="local">this hub</span>` : `<button class="srv-revoke">revoke</button>`)
    + `</div>`).join("");
}
async function saveServer(row) {
```

   with

```html
  const typed = (n, k, saved) => (f.names[n.id] ? f.names[n.id][k] : saved);
  $("#cfg-servers").innerHTML = fleetNodes.map(n => `<div class="srv" data-id="${esc(n.id)}">`
    + `<input type="text" class="srv-name" value="${esc(typed(n, "name", n.name))}" maxlength="64" aria-label="name of ${esc(n.name)}"`
    + `${(n.managed || []).includes("name") ? " disabled title=\"managed by a file in conf.d\"" : ""}>`
    + `<input type="text" class="srv-tags" value="${esc(typed(n, "tags", (n.tags || []).join(", ")))}" placeholder="tags" aria-label="tags of ${esc(n.name)}"`
    + `${(n.managed || []).includes("tags") ? " disabled title=\"managed by a file in conf.d\"" : ""}>`
    + `<label class="check"><input type="checkbox" class="srv-pin"${pinned.has(n.id) ? " checked" : ""}> pin</label>`
    + `<label class="check"><input type="checkbox" class="srv-hide"${hidden.has(n.id) ? " checked" : ""}> hide</label>`
    + (n.local ? `<span class="local">this hub</span>` : `<button class="srv-revoke">revoke</button>`)
    + `</div>`).join("");
  markManaged();
}
async function saveServer(row) {
```

4. Replace

```html
  renderServers();
  loadNodes().then(() => renderServers({ keep: true }));
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

   with

```html
  renderServers();
  loadNodes().then(() => renderServers({ keep: true }));
  markManaged();
  $("#acct-msg").textContent = "";
  $("#overlay").classList.add("open");
```

5. Replace

```html
    };
  });
}

```

   with

```html
    };
  });
  markManaged();
}

```

- [ ] **Step 4: A managed setting in the screenshots**

In `test/screens/demo-hub.js`:

1. Replace

```js
const { signRequest } = require(path.join(REPO, "hub/lib/agentsig"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-demo-"));
const hub = spawn(process.execPath, [path.join(REPO, "hub/server.js")], {
  env: { PATH: process.env.PATH, PORT: String(PORT), STATE_DIR: state, UPSTREAM: "", AUTH_USER: "demo",
```

   with

```js
const { signRequest } = require(path.join(REPO, "hub/lib/agentsig"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-demo-"));
// config as code: one setting and one node's tags come from a file (shown as managed)
fs.mkdirSync(path.join(state, "conf.d"));
fs.writeFileSync(path.join(state, "conf.d", "10-demo.json"),
  JSON.stringify({ settings: { refreshSec: 60 }, nodes: { nas: { tags: ["home", "storage"] } } }));
const hub = spawn(process.execPath, [path.join(REPO, "hub/server.js")], {
  env: { PATH: process.env.PATH, PORT: String(PORT), STATE_DIR: state, UPSTREAM: "", AUTH_USER: "demo",
```

- [ ] **Step 5: Run the tests and look**

Run: `node --test test/*.test.js && bash test/screens.sh`
Expected: PASS (1 new test); `screenshots in /out: no page errors`; in `build/screens/settings-390.png` the refresh field reads "refresh every (seconds) · managed by file" and is disabled.

- [ ] **Step 6: Commit**

```bash
git add www/index.html test/page.test.js test/screens/demo-hub.js
git commit -m "feat(ui): settings from conf.d files show as managed and cannot be edited" -m "The page puts managed values back over a copy saved in the browser, and disables their controls with a 'managed by file' note, including server names and tags a file sets."
```

---

### Task 4: `servitals-ctl config check`, packaging, docs, full validation

**Files:**
- Create: `packaging/etc/conf.d/README`
- Modify: `bin/servitals-ctl`, `debian/servitals.install`, `packaging/install-local.sh`, `packaging/etc/hub.env`, `man/servitals-ctl.1`, `README.md`, `CHANGELOG.md`, `test/cli.test.js`, `test/packaging.test.js`

**Interfaces:**
- Consumes: `confd.js check` and `parseFile` (Task 1).
- Produces: `servitals-ctl config check [dir]` (default `$ETC_DIR/conf.d`); `/etc/servitals/conf.d/README` in the package and from `install-local.sh`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test("servitals-ctl config check reads ETC_DIR/conf.d and fails on a bad file", () => {
  const etc = tmp();
  fs.mkdirSync(path.join(etc, "conf.d"));
  fs.writeFileSync(path.join(etc, "conf.d", "10-site.json"), JSON.stringify({ settings: { title: "lab" } }));
  let r = run("servitals-ctl", ["config", "check"], { ETC_DIR: etc });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok +10-site\.json$/m);
  fs.writeFileSync(path.join(etc, "conf.d", "20-bad.json"), "{ nope");
  r = run("servitals-ctl", ["config", "check"], { ETC_DIR: etc });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error +20-bad\.json: not valid JSON/m);
  const other = run("servitals-ctl", ["config", "check", path.join(etc, "conf.d")], {});
  assert.strictEqual(other.status, 1, "a directory can be named");
  assert.notStrictEqual(run("servitals-ctl", ["config"], {}).status, 0);
});
```

Append to `test/packaging.test.js`:

````js
test("the package and install-local.sh create /etc/servitals/conf.d with a README", () => {
  assert.match(read("debian/servitals.install"), /^packaging\/etc\/conf\.d\/README etc\/servitals\/conf\.d\/$/m);
  assert.match(read("packaging/install-local.sh"), /install -d -m 755 "\$ETC\/conf\.d"/);
  const readme = read("packaging/etc/conf.d/README");
  assert.match(readme, /servitals-ctl config check/);
  // the example in the README is a valid conf.d file
  const example = /```json\n([\s\S]*?)\n```/.exec(readme)[1];
  assert.doesNotThrow(() => require("../hub/lib/confd").parseFile(example));
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/cli.test.js test/packaging.test.js`
Expected: FAIL, 2 tests: `servitals-ctl config` prints the usage text; `debian/servitals.install` does not list the README.

- [ ] **Step 3: The README with an example**

Create `packaging/etc/conf.d/README`:

````
# SPDX-License-Identifier: AGPL-3.0-or-later
servitals: configuration as code

Every *.json file in this directory is read by the hub in name order (for
example 10-site.json, then 20-units.json). Later files win, key by key.
Values set here win over values edited in the dashboard, which shows them as
"managed by file" and read-only. A file with any mistake is skipped whole and
logged; nothing in it is applied. Check files before relying on them:

  sudo servitals-ctl config check

The hub notices changes within a few seconds; no restart is needed.

A file holds "settings" (the dashboard's defaults) and/or "nodes" (tags or a
name for a server, found by its node id or by its name):

```json
{
  "settings": {
    "title": "home lab",
    "refreshSec": 60,
    "units": { "temp": "c", "size": "binary", "rate": "bits", "clock": "24h" },
    "fleet": { "sort": "status", "group": true, "card": ["cpu", "mem", "disk"] },
    "style": "nord",
    "mode": "system",
    "density": "comfortable",
    "kiosk": false,
    "kioskSec": 20,
    "panels": { "weather": false },
    "panelSize": { "docker": "full" },
    "panelOrder": ["cpu", "mem", "temp", "storage", "network", "docker", "clocks", "weather"]
  },
  "nodes": {
    "nas": { "tags": ["home", "storage"] },
    "k3j7q2m4x5ab": { "name": "garage pi", "tags": ["home"] }
  }
}
```

Allowed values: units.temp c|f, units.size binary|decimal, units.rate
bytes|bits, units.clock auto|24h|12h; fleet.sort name|status|cpu|mem|temp|disk,
fleet.card any of cpu mem temp disk containers; mode system|light|dark;
density compact|comfortable|large; refreshSec 5-900; kioskSec 5-600; panel
names mem cpu temp storage network docker clocks weather, sizes
normal|wide|full; tags lowercase letters, digits, dot, dash, underscore.
Match servers by node id (servitals-ctl node list) when names may change.
````

- [ ] **Step 4: The command and the packaging**

In `bin/servitals-ctl`:

1. Replace

```bash
#   servitals-ctl import-docker <dir>  copy settings, login and disks from a Docker install
#   servitals-ctl passwd [--user NAME] set the admin password (and name); ends every session
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail
```

   with

```bash
#   servitals-ctl import-docker <dir>  copy settings, login and disks from a Docker install
#   servitals-ctl passwd [--user NAME] set the admin password (and name); ends every session
#   servitals-ctl config check [dir]   check the files in /etc/servitals/conf.d (config as code)
# State: STATE_DIR, else DATA_DIR, else ./data of a Docker checkout, else /var/lib/servitals.
set -euo pipefail
```

2. Replace

```bash
}

case "${1:-}" in
  node) shift; cmd_node "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

   with

```bash
}

cmd_config() {
  case "${1:-}" in
    check) node "$ROOT/hub/lib/confd.js" check "${2:-$ETC_DIR/conf.d}" ;;
    *) die "usage: servitals-ctl config check [dir]" ;;
  esac
}

case "${1:-}" in
  node) shift; cmd_node "$@" ;;
  config) shift; cmd_config "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  import-docker) shift; cmd_import_docker "$@" ;;
```

3. Replace

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

   with

```bash
  whitelist)     shift; cmd_whitelist "$@" ;;
  hash-password) shift; cmd_hash_password "$@" ;;
  *) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

```

In `debian/servitals.install`:

1. Replace

```
bin/servitals-ctl usr/bin/
packaging/etc/hub.env etc/servitals/

```

   with

```
bin/servitals-ctl usr/bin/
packaging/etc/hub.env etc/servitals/
packaging/etc/conf.d/README etc/servitals/conf.d/

```

In `packaging/install-local.sh`:

1. Replace

```bash
# 4. configuration, first install only
install -d -m 755 "$ETC"
if [ ! -e "$ETC/hub.env" ]; then
  port=${HUB_PORT:-20002}
```

   with

```bash
# 4. configuration, first install only
install -d -m 755 "$ETC"
install -d -m 755 "$ETC/conf.d"
[ -e "$ETC/conf.d/README" ] || install -m 644 "$SRC/packaging/etc/conf.d/README" "$ETC/conf.d/README"
if [ ! -e "$ETC/hub.env" ]; then
  port=${HUB_PORT:-20002}
```

In `packaging/etc/hub.env`:

1. Replace

```sh
# container controls: 1 = whitelisted (LAN) clients only, 0 = any logged-in user
CTL_LAN_ONLY=1
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

   with

```sh
# container controls: 1 = whitelisted (LAN) clients only, 0 = any logged-in user
CTL_LAN_ONLY=1
# config as code: *.json here win over the page (servitals-ctl config check)
# CONFD_DIR=/etc/servitals/conf.d
LOG_LEVEL=info
LOG_FORMAT=logfmt
```

- [ ] **Step 5: Docs**

In `man/servitals-ctl.1`:

1. Replace

```
Docker install in
.IR dir .
.SH ENVIRONMENT
.TP
.B STATE_DIR
The hub's state directory (default /var/lib/servitals).
.SH SEE ALSO
.BR servitals (8),
```

   with

```
Docker install in
.IR dir .
.TP
.BR "config check" " [" \fIdir\fR ]
Check the configuration files in
.I /etc/servitals/conf.d
(or
.IR dir ):
one line per file,
.B ok
or
.B error
with the place of the first mistake; exit status 1 when any file is wrong.
The hub skips such a file whole.
.SH ENVIRONMENT
.TP
.B STATE_DIR
The hub's state directory (default /var/lib/servitals).
.TP
.B ETC_DIR
Where hub.env and conf.d are (default /etc/servitals).
.SH SEE ALSO
.BR servitals (8),
```

In `README.md`:

1. Replace

```markdown
- **Export and import** the settings as one JSON file. An imported file fills
  the form; nothing changes until you save.

## Styles, modes and kiosk
```

   with

```markdown
- **Export and import** the settings as one JSON file. An imported file fills
  the form; nothing changes until you save.

## Config as code

Settings can also come from files: every `*.json` in `/etc/servitals/conf.d`
(read in name order, later files win) can set the dashboard's defaults and
tags or names for servers. Values from files win over the page, which shows
them as "managed by file". A file with a mistake is skipped whole and logged.
`sudo servitals-ctl config check` checks them; the hub picks up changes
within a few seconds. `/etc/servitals/conf.d/README` has an example and every
allowed value. Docker installs: mount a directory and set `CONFD_DIR`.

## Styles, modes and kiosk
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Customize (spec 10.4): units (°C/°F, 1024/1000 sizes, bits or bytes per
  second, 12/24 hour clock); rename, tag, pin, hide and revoke servers from
```

   with

```markdown

### Added
- Config as code (spec 12): `/etc/servitals/conf.d/*.json` sets dashboard
  defaults and server tags or names; file values win and show as "managed by
  file"; a bad file is skipped whole and logged; `servitals-ctl config check`.
- Customize (spec 10.4): units (°C/°F, 1024/1000 sizes, bits or bytes per
  second, 12/24 hour clock); rename, tag, pin, hide and revoke servers from
```

- [ ] **Step 6: Full validation**

Run each and compare:

```bash
node --test test/*.test.js                          # Expected: all pass (245)
pipx run --spec shellcheck-py shellcheck -S error bin/servitals-ctl
pipx run --spec shellcheck-py shellcheck -S warning packaging/install-local.sh
man -l man/servitals-ctl.1 | grep -A2 "config check" # Expected: the new entry
bash test/budget.sh                                 # Expected: every line ok
bash test/compose-smoke.sh                          # Expected: compose smoke test passed
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/build-deb.sh    # Expected: both series, no lintian E:/W:
dpkg-deb -c build/deb/noble/servitals_*_all.deb | grep conf.d # Expected: ./etc/servitals/conf.d/README
IMAGE_PREFIX=mirror.gcr.io/library/ packaging/autopkgtest.sh  # Expected: smoke PASS, purge PASS on both series
```

- [ ] **Step 7: Commit**

```bash
git add packaging/etc/conf.d/README bin/servitals-ctl debian/servitals.install packaging/install-local.sh packaging/etc/hub.env man/servitals-ctl.1 README.md CHANGELOG.md test/cli.test.js test/packaging.test.js
git commit -m "feat(ctl): servitals-ctl config check; ship /etc/servitals/conf.d with a README" -m "The package and install-local.sh create /etc/servitals/conf.d with a README whose example is a valid file. servitals-ctl config check [dir] checks the files. README, man page and CHANGELOG describe config as code."
```
