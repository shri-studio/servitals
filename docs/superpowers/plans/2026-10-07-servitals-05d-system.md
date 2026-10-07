# servitals System: Updates, Reboot, Failed Units (sub-project 5d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "system" panel shows four things (spec 9):
- pending updates and security updates;
- whether the system asks for a reboot, and which packages ask;
- systemd's failed units.

Fleet cards can show the update count, with ↻ when a reboot is needed.

**Why:** an operator wants to know which servers need patching or a reboot, and what has failed, without logging in. The live host needs a reboot right now (three kernel packages), and `lxd-installer@….service` has failed there unnoticed.

**Architecture:**
- **Agent.** A new `agent/lib/ubuntu.sh` reads only files the system keeps up to date; it never runs apt.
  - `/var/lib/update-notifier/updates-available` (written by update-notifier's apt hook) gives the counts. One `LC_ALL=C awk` knows the current wording ("12 updates can be applied immediately." / "5 of these updates are standard security updates.") and the older one ("7 packages can be updated." / "2 updates are security updates."). A wording it does not know gives no counts rather than a guess.
  - `/run/reboot-required` and `.pkgs` give the reboot and its packages (unique, at most 32).
  - `failed_units` calls `systemctl --failed --no-legend --plain` (at most 32 names), but only on a native install (`HOST_ROOT=/` with `/run/systemd/system` present). A container agent's systemctl would speak for the container.
  - The group is null on a host with neither dpkg nor this host's systemd. `COLLECT_UBUNTU=0` turns it off.
- **Hub.** It already validates `ubuntu` (protocol 1). The fleet summary gains `updates` and `reboot`, and `docs/protocol.md` explains the fields.
- **Page.** A "system" panel (key `system`, normal size, after "processes"), built by `systemHtml(u)`:
  - counts the agent could not read show a dash;
  - security updates and a needed reboot are amber, failed units red;
  - unit names are escaped;
  - the reboot's packages go in its title.

  `CARD_KEYS` gains `updates`.

**Tech Stack:** bash, `awk`, `jq`, `systemctl` (agent); Node.js ≥ 18 (hub, tests); vanilla JS (page); Playwright (screenshots).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`, sections:
- 9: Ubuntu updates and security updates, `/run/reboot-required` and `.pkgs`, `systemctl --failed`; Linux-first; every group degrades;
- 6.3: validation;
- 10.3: every word from the dictionary;
- 13.2: the agent unit's sandbox allows `AF_UNIX`, so systemctl can ask systemd;
- 18: agent CPU per tick ≤ 400 ms.

**Scope:** 5d of sub-project 5. Fans, voltages and battery (5e) follow. ESM updates ("additional security updates can be applied with ESM Apps") are not counted: they need a subscription to install.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (448bf57) on 2026-10-07:
- node suite 323 tests, shellcheck, the budget (agent tick 283 ms), `test/screens.sh`;
- on the live host, `ubuntu_json` (17 ms) reports 0 updates, a reboot for three kernel packages, and the failed `lxd-installer` unit.

## Global Constraints

- Everything from sub-projects 1-5c still holds: zero runtime dependencies, the strict CSP, every word from `hub/lib/i18n.js`, Node 18 compatibility, SPDX headers, lintian clean.
- The agent never runs apt, and never asks systemd about a host it is not running on.
- The lightness budget: agent CPU per tick ≤ 400 ms. This group adds one `awk`, one `jq` and one `systemctl` (about 17 ms).
- Names from the host (unit names, package names) are escaped where they reach HTML.
- No new `agent.env` line: `COLLECT_UBUNTU` defaults to 1.
- Work in a worktree `.claude/worktrees/servitals-system` on branch `feat/system` from `main` (448bf57).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **update-notifier's wordings**: singular and plural forms, the older releases, another language, a missing file. Counts when the wording is known, nothing otherwise. Tests: Task 1 "ubuntu_json: the other wordings…".
2. **Where systemctl may speak**: only a native install, never a container agent or a fixture host. Tests: Task 1 (a fixture host gives no `failedUnits`), "failed_units: the names…".
3. **Hostile names** (a unit or package name with `<`): escaped. Test: Task 2 "the system panel…" (`a<b>.service`).
4. **An older agent, a container agent, a non-Debian host**: the panel hides or shows a dash, never a made-up "0". Tests: Task 2 ("unknown counts and a container agent: a dash"), the hide loop, and the fleet summary's null.
5. **The tick's cost**: one more `systemctl`. Test: `test/budget.sh`.

---

### Task 1: The agent reports updates, a needed reboot and failed units

**Files:**
- Create: `agent/lib/ubuntu.sh`
- Modify: `agent/collect.sh`, `docs/protocol.md`, `test/agent-groups.test.js`, `test/agent.test.js`

**Interfaces:**
- Produces:
  - `ubuntu_json` → `{updates?, security?, rebootRequired, rebootPkgs, failedUnits?}` or `null`;
  - `failed_units` (one name per line, at most 32);
  - the snapshot's `ubuntu` key (`COLLECT_UBUNTU`).

  Task 2 shows them.

- [ ] **Step 1: Write the failing tests**

In `test/agent-groups.test.js`:

1. Replace

```js
  assert.strictEqual(json(runGroup(host, "processes_json", env)).cpu[0].cpuPct, 50);
});

```

   with

```js
  assert.strictEqual(json(runGroup(host, "processes_json", env)).cpu[0].cpuPct, 50);
});

const NOTIFIER = "var/lib/update-notifier/updates-available";

test("ubuntu_json: pending updates, security updates and a reboot with the packages that ask for it", () => {
  const host = fakeHost({ ...BASE, "var/lib/dpkg/status": "",
    [NOTIFIER]: "\nExpanded Security Maintenance for Applications is not enabled.\n\n12 updates can be applied immediately.\n" +
      "5 of these updates are standard security updates.\nTo see these additional updates run: apt list --upgradable\n",
    "run/reboot-required": "*** System restart required ***\n",
    "run/reboot-required.pkgs": "linux-image-7.0.0-38-generic\nlinux-base\nlinux-image-7.0.0-38-generic\n" });
  assert.deepStrictEqual(json(runGroup(host, "ubuntu_json")),
    { updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-image-7.0.0-38-generic", "linux-base"] });
});

test("ubuntu_json: the other wordings, nothing pending, no update-notifier, and a host without dpkg or systemd", () => {
  const run = (text) => json(runGroup(fakeHost({ ...BASE, "var/lib/dpkg/status": "", ...(text === null ? {} : { [NOTIFIER]: text }) }), "ubuntu_json"));
  assert.deepStrictEqual(run("0 updates can be applied immediately.\n"), { updates: 0, security: 0, rebootRequired: false, rebootPkgs: [] });
  assert.deepStrictEqual(run("1 update can be applied immediately.\n1 of these updates is a standard security update.\n"),
    { updates: 1, security: 1, rebootRequired: false, rebootPkgs: [] });
  // Ubuntu 20.04 and older
  assert.deepStrictEqual(run("7 packages can be updated.\n2 updates are security updates.\n"),
    { updates: 7, security: 2, rebootRequired: false, rebootPkgs: [] });
  assert.deepStrictEqual(run("Mises à jour : 3\n"), { rebootRequired: false, rebootPkgs: [] }, "a wording it does not know: no counts, no guess");
  assert.deepStrictEqual(run(null), { rebootRequired: false, rebootPkgs: [] }, "no update-notifier: no counts");
  assert.strictEqual(runGroup(fakeHost(BASE), "ubuntu_json").stdout.trim(), "null", "no dpkg, not this host's systemd: null");
});

test("failed_units: the names of systemd's failed units, at most 32", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sv-bin-"));
  const units = Array.from({ length: 40 }, (_, i) => `unit${i}.service loaded failed failed Something ${i}`).join("\n");
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\n[ "$*" = "--failed --no-legend --plain" ] || exit 9\ncat <<'X'\n${units}\nX\n`, { mode: 0o755 });
  const r = runGroup(fakeHost(BASE), "failed_units", { PATH: `${bin}:${process.env.PATH}` });
  assert.strictEqual(r.status, 0, r.stderr);
  const names = r.stdout.trim().split("\n");
  assert.strictEqual(names.length, 32);
  assert.deepStrictEqual(names.slice(0, 2), ["unit0.service", "unit1.service"]);
});

```

In `test/agent.test.js`:

1. Replace

```js
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0",
           COLLECT_PROCESSES: "0" },
    timeout: 30000,
  });
```

   with

```js
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0",
           COLLECT_PROCESSES: "0", COLLECT_UBUNTU: "0" },
    timeout: 30000,
  });
```

2. Replace

```js
  assert.strictEqual(d.io, null, "io follows COLLECT_DISKS");
  assert.strictEqual(d.processes, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

   with

```js
  assert.strictEqual(d.io, null, "io follows COLLECT_DISKS");
  assert.strictEqual(d.processes, null);
  assert.strictEqual(d.ubuntu, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL, 4 tests:
- the two `ubuntu_json` tests (`bash: line 1: ubuntu_json: command not found`);
- "failed_units: …" (`failed_units: command not found`);
- "COLLECT_<GROUP>=0 turns a group off" (`ubuntu` is missing, not null).

- [ ] **Step 3: The group**

Create `agent/lib/ubuntu.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# ubuntu: pending updates and security updates as update-notifier last counted them
# (apt's hook rewrites the file; the agent never runs apt), a reboot the system asks
# for and the packages behind it, and systemd's failed units. Only files the system
# keeps, and one systemctl call on a native install. null on a host with neither dpkg
# nor this host's systemd.

# the names of systemd's failed units, one per line, at most 32
failed_units() {
  systemctl --failed --no-legend --plain 2>/dev/null | awk 'NF { print $1 }' | head -n 32
}

ubuntu_json() {
  local units="" native=""
  # systemctl speaks for the system it runs on: only a native install (HOST_ROOT=/)
  if [ "${HOST%/}" = "" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
    native=1; units=$(failed_units)
  fi
  [ -d "$HOST/var/lib/dpkg" ] || [ -n "$native" ] || { echo null; return; }
  # update-notifier writes English when apt's hook runs: "12 updates can be applied
  # immediately." / "5 of these updates are standard security updates." (Ubuntu 20.04
  # and older: "7 packages can be updated." / "2 updates are security updates."); a
  # wording it does not know gives no counts rather than a guess
  local counts=""
  if [ -r "$HOST/var/lib/update-notifier/updates-available" ]; then
    counts=$(LC_ALL=C awk '
      /^[0-9]+ updates? can be applied immediately/ || /^[0-9]+ packages? can be updated/ { u = $1 }
      /^[0-9]+ of these updates (are|is a) (standard )?security updates?/ || /^[0-9]+ updates? (are|is a) security updates?/ { s = $1 }
      END { if (u != "") print u, (s == "" ? 0 : s) }' "$HOST/var/lib/update-notifier/updates-available" 2>/dev/null)
  fi
  local pkgs=""
  [ -r "$HOST/run/reboot-required.pkgs" ] && pkgs=$(awk 'NF && !seen[$0]++' "$HOST/run/reboot-required.pkgs" 2>/dev/null | head -n 32)
  jq -cn --arg counts "$counts" --arg pkgs "$pkgs" --arg units "$units" --arg native "$native" \
     --argjson reboot "$([ -e "$HOST/run/reboot-required" ] && echo true || echo false)" '
    ($counts | split(" ")) as $c
    | (if ($c | length) == 2 then {updates: ($c[0] | tonumber), security: ($c[1] | tonumber)} else {} end)
      + {rebootRequired: $reboot, rebootPkgs: ($pkgs | split("\n") | map(select(length > 0)))}
      + (if $native == "1" then {failedUnits: ($units | split("\n") | map(select(length > 0)))} else {} end)'
}
```

In `agent/collect.sh`:

1. Replace

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null processes=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

   with

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null processes=null ubuntu=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

2. Replace

```bash
  if on "${COLLECT_DOCKER:-1}"; then group docker docker_json; fi
  if on "${COLLECT_PROCESSES:-1}"; then group processes processes_json; fi

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson io "$io" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson processes "$processes" --argjson pressure "$pressure" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, pressure: $pressure, temp: $temp,
      disks: $disks, io: $io, net: $net, docker: $docker, processes: $processes}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}
```

   with

```bash
  if on "${COLLECT_DOCKER:-1}"; then group docker docker_json; fi
  if on "${COLLECT_PROCESSES:-1}"; then group processes processes_json; fi
  if on "${COLLECT_UBUNTU:-1}"; then group ubuntu ubuntu_json; fi

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson io "$io" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson processes "$processes" --argjson ubuntu "$ubuntu" --argjson pressure "$pressure" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, pressure: $pressure, temp: $temp,
      disks: $disks, io: $io, net: $net, docker: $docker, processes: $processes, ubuntu: $ubuntu}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}
```

In `docs/protocol.md`:

1. Replace

```markdown
  agent's last tick (as `top` shows it, so above 100 for a busy multi-threaded
  process), or null when there is nothing to compare yet.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

   with

```markdown
  agent's last tick (as `top` shows it, so above 100 for a busy multi-threaded
  process), or null when there is nothing to compare yet.
- `ubuntu` counts updates as update-notifier last wrote them (the agent never
  runs apt): `updates` and `security` are absent when that file is missing or
  worded in a way the agent does not know. `failedUnits` comes from the
  host's own systemd and is absent where the agent cannot ask it (a container
  agent). The group is null on a host with neither dpkg nor systemd.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

- [ ] **Step 4: Run the tests and look at this host**

Run: `node --test test/*.test.js && HOST=/ bash -c 'for f in agent/lib/*.sh; do . "$f"; done; ubuntu_json'`
Expected: PASS, 322 tests. The JSON line shows:
- this host's counts (absent if it has no update-notifier);
- `rebootRequired`;
- `failedUnits` (`[]` when none have failed).

Run: `pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh && bash test/budget.sh`
Expected: shellcheck prints nothing; `ok    agent tick CPU (user+sys)` below 400 ms.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/ubuntu.sh agent/collect.sh docs/protocol.md test/agent-groups.test.js test/agent.test.js
git commit -m "feat(agent): pending and security updates, a reboot the system asks for, and failed units"
```

---

### Task 2: The system panel and the updates card

**Files:**
- Modify: `www/index.html`, `www/app.css`, `www/js/app.js`, `hub/lib/i18n.js`, `hub/lib/fleet.js`, `test/page.test.js`, `test/fleet.test.js`, `test/screens/demo-hub.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the snapshot's `ubuntu` (Task 1; the hub's validation predates this plan).
- Produces:
  - panel `system` (in `DEFAULTS.panels`, `panelOrder` after `procs`, `panelSize` normal);
  - `systemHtml(u)` → `{updates, reboot, rebootTitle, failed, units}`;
  - `summary(view).updates` (number or null) and `.reboot` (boolean);
  - `CARD_KEYS` gains `updates`;
  - dictionary keys `panel.system`, `sys.*`, `card.updates`, `set.card.updates`;
  - CSS `.sysunits`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\], \["procs", "processes"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| shown\[panel\] === false\)/);
});
```

   with

```js

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\], \["procs", "processes"\], \["system", "ubuntu"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| shown\[panel\] === false\)/);
});
```

2. Replace

```js
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
```

   with

```js
});

test("the system panel: updates and security updates, a reboot and its packages, failed units by name", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const systemHtml = pageFn("systemHtml", { esc });
  assert.deepStrictEqual(systemHtml({ updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-base"],
    failedUnits: ["a<b>.service", "c.service"] }), {
    updates: '12 · <span class="hl-amber">5 security</span>',
    reboot: '<span class="hl-amber">required</span>', rebootTitle: "linux-base",
    failed: '<span class="hl-red">2</span>', units: "a&#60;b&#62;.service, c.service",
  });
  assert.deepStrictEqual(systemHtml({ updates: 0, security: 0, rebootRequired: false, rebootPkgs: [], failedUnits: [] }),
    { updates: "up to date", reboot: "not needed", rebootTitle: "", failed: "none", units: "" });
  assert.deepStrictEqual(systemHtml({ rebootRequired: false, rebootPkgs: [] }),
    { updates: "–", reboot: "not needed", rebootTitle: "", failed: "–", units: "" }, "unknown counts and a container agent: a dash");
  for (const id of ["sys-updates", "sys-reboot", "sys-failed", "sys-units"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /data-panel="system"/);
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
```

3. Replace

```js
  const cardValue = pageFn("cardValue", { fmtVal: pageFunction("fmtVal"), fmtTemp: () => "" });
  assert.deepStrictEqual([cardValue("iowait", { iowait: 31 }), cardValue("iowait", { iowait: null })], ["31%", "–"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
```

   with

```js
  const cardValue = pageFn("cardValue", { fmtVal: pageFunction("fmtVal"), fmtTemp: () => "" });
  assert.deepStrictEqual([cardValue("iowait", { iowait: 31 }), cardValue("iowait", { iowait: null })], ["31%", "–"]);
  assert.deepStrictEqual([cardValue("updates", { updates: 12, reboot: true }), cardValue("updates", { updates: 0, reboot: false }),
    cardValue("updates", { updates: null, reboot: true }), cardValue("updates", {})], ["12 ↻", "0", "↻", "–"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
```

4. Replace

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

   with

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

In `test/fleet.test.js`:

1. Replace

```js
  assert.deepStrictEqual([s.cpu, s.iowait, s.mem, s.temp, s.containers, s.running], [12.4, 31, 25, 46, 2, 1]);
  assert.strictEqual(summary({ cpu: { usage: 5 } }).iowait, null, "an older agent sends no iowait");
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
```

   with

```js
  assert.deepStrictEqual([s.cpu, s.iowait, s.mem, s.temp, s.containers, s.running], [12.4, 31, 25, 46, 2, 1]);
  assert.strictEqual(summary({ cpu: { usage: 5 } }).iowait, null, "an older agent sends no iowait");
  assert.deepStrictEqual([summary({ ubuntu: { updates: 3, rebootRequired: true } }).updates, summary({ ubuntu: { updates: 3, rebootRequired: true } }).reboot], [3, true]);
  assert.deepStrictEqual([summary({}).updates, summary({}).reboot], [null, false]);
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js test/fleet.test.js`
Expected: FAIL, 5 tests:
- "the system panel…" (`ReferenceError: systemHtml is not defined`);
- "a panel whose group the node does not send is hidden…";
- "conf.d review: a file with a few panels…";
- "fleet cards show the numbers chosen in settings" (no `"updates"` in `CARD_KEYS`);
- "a card's numbers come from the view" (no `updates` or `reboot`).

- [ ] **Step 3: The panel, the card and the summary**

In `www/index.html`:

1. Replace

```html
        <div><div class="plbl" data-i18n="procs.byMem">by memory</div><div id="procs-mem"></div></div>
      </div>
    </div>

```

   with

```html
        <div><div class="plbl" data-i18n="procs.byMem">by memory</div><div id="procs-mem"></div></div>
      </div>
    </div>

    <div class="panel" data-panel="system">
      <h2 data-i18n="panel.system">system</h2>
      <div class="row"><span class="k" data-i18n="sys.updates">updates</span><span class="v" id="sys-updates">--</span></div>
      <div class="row"><span class="k" data-i18n="sys.reboot">reboot</span><span class="v" id="sys-reboot">--</span></div>
      <div class="row"><span class="k" data-i18n="sys.failed">failed units</span><span class="v" id="sys-failed">--</span></div>
      <div class="sysunits" id="sys-units"></div>
    </div>

```

In `www/js/app.js`:

1. Replace

```js
}

function meter(pct, forceCls) {
  pct = clamp(pct, 0, 100);
```

   with

```js
}

// the system panel's rows: updates, a reboot the system asks for, systemd's failed units;
// a count the agent could not read is a dash
function systemHtml(u) {
  const units = Array.isArray(u.failedUnits) ? u.failedUnits : null;
  return {
    updates: typeof u.updates !== "number" ? "–" : u.updates === 0 ? esc(tr("sys.upToDate"))
      : u.updates + (u.security > 0 ? ` · <span class="hl-amber">${esc(tr("sys.security", { n: u.security }))}</span>` : ""),
    reboot: u.rebootRequired ? `<span class="hl-amber">${esc(tr("sys.rebootYes"))}</span>` : esc(tr("sys.rebootNo")),
    rebootTitle: (u.rebootPkgs || []).join(", "),
    failed: !units ? "–" : units.length ? `<span class="hl-red">${units.length}</span>` : esc(tr("sys.none")),
    units: esc((units || []).join(", ")),
  };
}

function meter(pct, forceCls) {
  pct = clamp(pct, 0, 100);
```

2. Replace

```js
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, storage: 1, network: 1, docker: 1, procs: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", storage: "wide",
                 network: "wide", docker: "full", procs: "wide", clocks: "normal", weather: "normal" }
  };
  // a conf.d file may set only a few panels: the others keep their built-in values
```

   with

```js
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, storage: 1, network: 1, docker: 1, procs: 1, system: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", storage: "wide",
                 network: "wide", docker: "full", procs: "wide", system: "normal", clocks: "normal", weather: "normal" }
  };
  // a conf.d file may set only a few panels: the others keep their built-in values
```

3. Replace

```js
}
// the numbers a fleet card can show; their labels are card.<key> in the dictionary
const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
function cardValue(k, s) {
  if (k === "cpu" || k === "mem" || k === "iowait") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
  return s.containers ? `${s.running}/${s.containers}` : "–";
}
```

   with

```js
}
// the numbers a fleet card can show; their labels are card.<key> in the dictionary
const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates"];
function cardValue(k, s) {
  if (k === "cpu" || k === "mem" || k === "iowait") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
  // pending updates, and ↻ when the system asks for a reboot
  if (k === "updates") return [typeof s.updates === "number" ? s.updates : "", s.reboot ? "↻" : ""].filter(String).join(" ") || "–";
  return s.containers ? `${s.running}/${s.containers}` : "–";
}
```

4. Replace

```js
  }

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;

  // a node without a group: hide its panel, never keep the previous node's
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"], ["procs", "processes"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
```

   with

```js
  }

  // system: updates, reboot, failed units (Debian and Ubuntu hosts, and any with systemd)
  if (d.ubuntu) {
    const sys = systemHtml(d.ubuntu);
    $("#sys-updates").innerHTML = sys.updates;
    $("#sys-reboot").innerHTML = sys.reboot;
    $("#sys-reboot").title = sys.rebootTitle;
    $("#sys-failed").innerHTML = sys.failed;
    $("#sys-units").innerHTML = sys.units;
  }

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;

  // a node without a group: hide its panel, never keep the previous node's
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"], ["procs", "processes"], ["system", "ubuntu"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
```

In `hub/lib/fleet.js`:

1. Replace

```js
    cpu: v.cpu && typeof v.cpu.usage === "number" ? v.cpu.usage : null,
    iowait: v.cpu && typeof v.cpu.iowait === "number" ? v.cpu.iowait : null,
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
```

   with

```js
    cpu: v.cpu && typeof v.cpu.usage === "number" ? v.cpu.usage : null,
    iowait: v.cpu && typeof v.cpu.iowait === "number" ? v.cpu.iowait : null,
    updates: v.ubuntu && typeof v.ubuntu.updates === "number" ? v.ubuntu.updates : null,
    reboot: !!(v.ubuntu && v.ubuntu.rebootRequired),
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "panel.docker": "services",
  "panel.procs": "processes",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

   with

```js
  "panel.docker": "services",
  "panel.procs": "processes",
  "panel.system": "system",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

2. Replace

```js
  "procs.pid": "pid {pid}",

  // dialogs
  "dlg.close": "[esc]",
```

   with

```js
  "procs.pid": "pid {pid}",

  // system: updates, reboot, failed units
  "sys.updates": "updates",
  "sys.reboot": "reboot",
  "sys.failed": "failed units",
  "sys.upToDate": "up to date",
  "sys.security": "{n} security",
  "sys.rebootYes": "required",
  "sys.rebootNo": "not needed",
  "sys.none": "none",

  // dialogs
  "dlg.close": "[esc]",
```

3. Replace

```js
  "card.containers": "up",
  "card.iowait": "iowait",

  // clocks and weather
```

   with

```js
  "card.containers": "up",
  "card.iowait": "iowait",
  "card.updates": "updates",

  // clocks and weather
```

4. Replace

```js
  "set.card.containers": "containers",
  "set.card.iowait": "iowait (waiting on disk)",
  "set.serversHint": "name and tags save at once; pin and hide with the other settings",
  "set.srvName": "name of {name}",
```

   with

```js
  "set.card.containers": "containers",
  "set.card.iowait": "iowait (waiting on disk)",
  "set.card.updates": "updates (↻ reboot needed)",
  "set.serversHint": "name and tags save at once; pin and hide with the other settings",
  "set.srvName": "name of {name}",
```

In `www/app.css`:

1. Replace

```css
.procs .plbl { color: var(--dim); font-size: 11px; letter-spacing: .06em; margin-bottom: 4px; }
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }
```

   with

```css
.procs .plbl { color: var(--dim); font-size: 11px; letter-spacing: .06em; margin-bottom: 4px; }
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sysunits { color: var(--dim); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }
```

- [ ] **Step 4: The screenshots show a server waiting for a reboot**

In `test/screens/demo-hub.js`:

1. Replace

```js
            proc(812, "rsync", 38.5, 52), proc(1, "systemd", 0.3, 14)],
    } : undefined;
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
```

   with

```js
            proc(812, "rsync", 38.5, 52), proc(1, "systemd", 0.3, 14)],
    } : undefined;
    // the nas waits for a reboot and has a failed unit; the pi's older agent sends neither
    s.ubuntu = i === 1 ? { updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-image-7.0.0-38-generic"],
                           failedUnits: ["smartd.service"] } : undefined;
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
```

In `test/screens/shoot.js`:

1. Replace

```js
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "iowait", "temp"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
```

   with

```js
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "iowait", "updates"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Processes (spec 9): a new panel lists the five busiest processes by cpu
  (share of one core since the last tick, as `top` shows it) and the five
```

   with

```markdown

### Added
- System (spec 9): a new panel shows pending and security updates (as
  update-notifier counted them; the agent never runs apt), whether the system
  asks for a reboot and which packages ask, and systemd's failed units. Fleet
  cards can show updates, with ↻ when a reboot is needed.
  `COLLECT_UBUNTU=0` turns it off.
- Processes (spec 9): a new panel lists the five busiest processes by cpu
  (share of one core since the last tick, as `top` shows it) and the five
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/screens.sh`
Expected:
- PASS, 323 tests;
- the budget passes;
- `screenshots in /out: no page errors`.

In the screenshots:
- `fleet-custom.png` shows UPDATES "12 ↻" on the nas card and "–" on pi-garage;
- `1280-comfortable-nas.png` shows the system panel with "12 · 5 security", reboot "required", failed units "1" and `smartd.service`.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` (`compose smoke test passed`);
- `bash packaging/build-deb.sh` (both packages `ok`);
- `bash packaging/autopkgtest.sh` (smoke and purge PASS).

- [ ] **Step 6: Commit**

```bash
git add www/index.html www/app.css www/js/app.js hub/lib/i18n.js hub/lib/fleet.js test/page.test.js test/fleet.test.js test/screens/demo-hub.js test/screens/shoot.js CHANGELOG.md
git commit -m "feat(ui): a system panel: updates, a needed reboot and failed units; fleet cards can show updates"
```
