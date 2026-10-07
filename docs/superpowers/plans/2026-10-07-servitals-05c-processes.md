# servitals Top Processes (sub-project 5c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "processes" panel lists the five busiest processes by cpu and the five largest by memory, so a busy server shows what keeps it busy, also outside containers (spec 9).

**Why:** 5a showed this host's io pressure at 12-18 %, and 5b showed its disks reading terabytes. Neither says which program is responsible. On this host the new group names `qbittorrent-nox` at 28 % of a core and 4.3 GB.

**Architecture:**
- **Agent.** A new `agent/lib/processes.sh` reads every `/proc/[pid]/stat` in one pass. It pipes them through `cat`, which skips a process that exits or may not be read. mawk, Ubuntu's default `awk`, would stop at such a file.
  - The name ends at the last ") ", because a name may itself hold ") ".
  - `cpuPct` is the change in utime+stime since the last tick, as a share of one core (as `top` shows it). The time base is `/proc/uptime` and the tick rate is `CLK_TCK`.
  - A process is identified by pid plus start time, so a reused pid is never compared with the process it replaced.
  - The last tick's figures live in `$STATE/procs`.
  - rss is pages × `PAGE_SIZE`.
  - `jq` keeps the top five by cpu (only known, positive shares) and by rss (above 0, so no kernel threads).
  - `collect.sh` reads `CLK_TCK` and `PAGE_SIZE` once with `getconf`. `COLLECT_PROCESSES=0` turns the group off.
- **Hub.** It already validates `processes` (protocol 1); `docs/protocol.md` gains the meaning of `cpuPct`.
- **Page.** It adds a "processes" panel (key `procs`, size wide, after "services") with two columns, by cpu and by memory. `procRows(list, value)` escapes each name and puts the pid in the row's title. The panel hides when an agent sends no processes.

**Tech Stack:** bash, `cat`, `awk` (mawk or gawk), `jq` (agent); Node.js ≥ 18 (hub, tests); vanilla JS (page); Playwright (screenshots).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- section 9: processes, top 5 by cpu and by memory from `/proc/[pid]/stat`; Linux-first; every group degrades;
- 6.3: validation;
- 10.3: every word from the dictionary;
- 18: agent CPU per tick ≤ 400 ms.

**Scope:** 5c of sub-project 5. Ubuntu updates and failed units (5d) and fans, voltages and battery (5e) follow. Process names come from `stat`'s comm field (at most 15 characters); full command lines would cost one more read per process.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (175910a) on 2026-10-07:
- node suite 317 tests, shellcheck, the budget;
- `test/screens.sh`, which now also shoots the demo nas node;
- on this host, `processes_json` takes about 40 ms for 362 processes.

## Global Constraints

- Everything from sub-projects 1-5b still holds: zero runtime dependencies, the strict CSP, every word from `hub/lib/i18n.js`, Node 18 compatibility, SPDX headers, lintian clean.
- The lightness budget: agent CPU per tick ≤ 400 ms. Processes add about 40-60 ms (272-311 ms measured on this busy host).
- Works with mawk and gawk: no `asort`, no gawk-only functions, and no file `awk` might fail to open.
- A process name is data from the host: it is escaped where it reaches HTML, and tabs in it never split a field.
- No new `agent.env` line (a conffile): `COLLECT_PROCESSES` defaults to 1.
- Work in a worktree `.claude/worktrees/servitals-procs` on branch `feat/procs` from `main` (175910a).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Process names that try to break the parser or the page**:
   - ") " inside the name;
   - quotes and backslashes;
   - tabs;
   - `<script>`.

   The right name, escaped. Tests: Task 1 "processes_json: the five busiest…" (`web (worker) x`) and "…a name with quotes…"; Task 2 "the processes panel lists the busiest…" (`<rsync>`).
2. **Processes that come and go**:
   - a pid reused by a new process;
   - a process that exits between the glob and the read;
   - one the agent may not read, under mawk.

   No bogus share, no stopped tick. Tests: Task 1 (the reused pid 20; the denied pid 1 under mawk).
3. **The first tick and an older agent**: no cpu figures yet ("none yet"), and the panel is hidden without `processes`. Tests: Task 1 (`cpu: []` first), Task 2 ("none yet", and the hide loop).
4. **A long name in a narrow panel**: it is cut with an ellipsis and never widens the panel. Test: `test/screens.sh`, which now shoots the nas at every width.
5. **The tick's cost** on a host with many processes. Test: `test/budget.sh` (≤ 400 ms).

---

### Task 1: The agent reports the busiest and the largest processes

**Files:**
- Create: `agent/lib/processes.sh`
- Modify: `agent/collect.sh`, `docs/protocol.md`, `test/agent-groups.test.js`, `test/agent.test.js`

**Interfaces:**
- Produces:
  - `processes_json` → `{cpu: [≤5], mem: [≤5]}` of `{pid, name, cpuPct, rss}` (`cpuPct` null when unknown), or `null` without `/proc/uptime`;
  - `$STATE/procs` (`uptime`, then `pid start ticks` per line);
  - `CLK_TCK` and `PAGE_SIZE` globals;
  - the snapshot's `processes` key (`COLLECT_PROCESSES`).

  Task 2 shows them.

- [ ] **Step 1: Write the failing tests**

In `test/agent-groups.test.js`:

1. Replace

```js
module.exports = { fakeHost, runGroup, BASE, json };

```

   with

```js
module.exports = { fakeHost, runGroup, BASE, json };

// /proc/[pid]/stat: pid (comm) state ppid ... utime(14) stime(15) ... starttime(22) vsize rss(24) ...
const stat = (pid, comm, utime, stime, start, rss) =>
  `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 1000 ${rss} 0 0 0 0\n`;

test("processes_json: the five busiest by cpu (share of one core since the last tick) and the five largest by memory", () => {
  const procs = {
    "proc/uptime": "100.00 50.00\n",
    "proc/10/stat": stat(10, "postgres", 1000, 500, 111, 2000),
    "proc/20/stat": stat(20, "web (worker) x", 100, 0, 222, 500),   // a name may hold ") "
    "proc/30/stat": stat(30, "kworker/0:1", 50, 50, 333, 0),
    "proc/40/stat": stat(40, "gone", 10, 10, 444, 100),
  };
  const host = fakeHost({ ...BASE, ...procs });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  const first = json(runGroup(host, "processes_json", { STATE: state }));
  assert.deepStrictEqual(first.cpu, [], "nothing to compare on the first tick");
  assert.deepStrictEqual(first.mem.map((p) => [p.pid, p.name, p.rss]),
    [[10, "postgres", 2000 * 4096], [20, "web (worker) x", 500 * 4096], [40, "gone", 100 * 4096]], "largest first; no kernel threads");
  // 10 s later: postgres used 5 s of cpu, the kworker 1 s; pid 40 exited and a new process took pid 20
  fs.writeFileSync(path.join(host, "proc/uptime"), "110.00 50.00\n");
  fs.writeFileSync(path.join(host, "proc/10/stat"), stat(10, "postgres", 1300, 700, 111, 2100));
  fs.writeFileSync(path.join(host, "proc/20/stat"), stat(20, "newcomer", 900, 0, 999, 10));
  fs.writeFileSync(path.join(host, "proc/30/stat"), stat(30, "kworker/0:1", 100, 100, 333, 0));
  fs.rmSync(path.join(host, "proc/40"), { recursive: true });
  const second = json(runGroup(host, "processes_json", { STATE: state }));
  assert.deepStrictEqual(second.cpu, [
    { pid: 10, name: "postgres", cpuPct: 50, rss: 2100 * 4096 },
    { pid: 30, name: "kworker/0:1", cpuPct: 10, rss: 0 },
  ], "a reused pid (new start time) is not compared with the old process");
  assert.strictEqual(second.mem[0].cpuPct, 50);
  assert.strictEqual(second.mem.find((p) => p.pid === 20).cpuPct, null);
});

test("processes_json: more than five, a name with quotes, no /proc/uptime, and a process the agent may not read", () => {
  const many = { "proc/uptime": "100.00 50.00\n" };
  for (let i = 1; i <= 8; i++) many[`proc/${i}/stat`] = stat(i, i === 3 ? 'say "hi"\\' : `p${i}`, 0, 0, i, i * 10);
  const host = fakeHost({ ...BASE, ...many });
  const d = json(runGroup(host, "processes_json"));
  assert.deepStrictEqual(d.mem.map((p) => p.pid), [8, 7, 6, 5, 4], "the top five");
  const quoted = fakeHost({ ...BASE, ...many, "proc/8/stat": stat(8, 'say "hi"\\', 0, 0, 8, 999) });
  assert.strictEqual(json(runGroup(quoted, "processes_json")).mem[0].name, 'say "hi"\\');
  const noUptime = fakeHost({ ...BASE, ...many });
  fs.rmSync(path.join(noUptime, "proc/uptime"));
  assert.strictEqual(runGroup(noUptime, "processes_json").stdout.trim(), "null");
  if (process.getuid && process.getuid() !== 0) {
    // another user's process the agent may not read (Android hides them): skipped, the rest still counts.
    // mawk (Ubuntu's default awk) stops at a file it cannot open, so the agent must not hand it one.
    const denied = fakeHost({ ...BASE, ...many });
    fs.chmodSync(path.join(denied, "proc/1/stat"), 0);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sv-bin-"));
    const mawk = spawnSync("bash", ["-c", "command -v mawk"], { encoding: "utf8" }).stdout.trim();
    if (mawk) fs.symlinkSync(mawk, path.join(bin, "awk"));
    const r = runGroup(denied, "processes_json", { PATH: `${bin}:${process.env.PATH}` });
    assert.deepStrictEqual(json(r).mem.map((p) => p.pid), [8, 7, 6, 5, 4]);
  }
});

```

In `test/agent.test.js`:

1. Replace

```js
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0" },
    timeout: 30000,
  });
```

   with

```js
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0",
           COLLECT_PROCESSES: "0" },
    timeout: 30000,
  });
```

2. Replace

```js
  assert.strictEqual(d.disks, null);
  assert.strictEqual(d.io, null, "io follows COLLECT_DISKS");
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

   with

```js
  assert.strictEqual(d.disks, null);
  assert.strictEqual(d.io, null, "io follows COLLECT_DISKS");
  assert.strictEqual(d.processes, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL, 3 tests:
- the two `processes_json` tests (`bash: line 1: processes_json: command not found`);
- "COLLECT_<GROUP>=0 turns a group off" (`processes` is missing, not null).

- [ ] **Step 3: The group**

Create `agent/lib/processes.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE, CLK_TCK and PAGE_SIZE are set by collect.sh)
# processes: the five busiest by cpu and the five largest by memory, from
# /proc/[pid]/stat in one pass. cpuPct is the share of one core since the last
# tick (as top shows it); pid and start time together name a process, so a
# reused pid is never compared with the process it replaced. Only processes the
# agent may read count (Android shows an app its own); null without /proc/uptime.

processes_json() {
  local now _
  read -r now _ < "$HOST/proc/uptime" 2>/dev/null || { echo null; return; }
  # cat, not awk's own file list: a process that exits (or may not be read) after
  # the glob is skipped by cat, where mawk, Ubuntu's default awk, would stop
  cat "$HOST"/proc/[0-9]*/stat 2>/dev/null | awk -v now="$now" -v hz="${CLK_TCK:-100}" \
      -v page="${PAGE_SIZE:-4096}" -v prev="$STATE/procs" -v out="$STATE/procs.new" '
    BEGIN {
      # the last tick: its uptime, then "pid start ticks" per process
      if ((getline line < prev) > 0) {
        before = line + 0
        while ((getline line < prev) > 0) { split(line, p, " "); seen[p[1] " " p[2]] = p[3] }
      }
      close(prev)
      print now > out
    }
    /^[0-9]+ \(/ {
      # the name ends at the last ") ": a name may hold ") " itself
      e = 0
      for (j = length($0) - 1; j > 0; j--) if (substr($0, j, 2) == ") ") { e = j; break }
      if (!e) next
      s = index($0, "(")
      name = substr($0, s + 1, e - s - 1); gsub(/\t/, " ", name)
      if (split(substr($0, e + 2), f, " ") < 22) next
      ticks = f[12] + f[13]; key = ($1 + 0) " " f[20]
      print key, ticks > out
      cpu = ""
      if (before > 0 && now > before && (key in seen) && ticks >= seen[key])
        cpu = sprintf("%.1f", 100 * (ticks - seen[key]) / ((now - before) * hz))
      printf "%d\t%s\t%s\t%.0f\n", $1, name, cpu, f[22] * page
    }' | jq -R -s -c '
      [split("\n")[] | select(length > 0) | split("\t")
        | {pid: (.[0] | tonumber), name: .[1], cpuPct: (if .[2] == "" then null else (.[2] | tonumber) end),
           rss: (.[3] | tonumber)}] as $all
      | {cpu: ([$all[] | select(.cpuPct != null and .cpuPct > 0)] | sort_by(-.cpuPct, .pid) | .[:5]),
         mem: ([$all[] | select(.rss > 0)] | sort_by(-.rss, .pid) | .[:5])}'
  mv -f "$STATE/procs.new" "$STATE/procs" 2>/dev/null
}
```

In `agent/collect.sh`:

1. Replace

```bash
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# cpu delta counters, wake trigger, last push; systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
```

   with

```bash
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# clock ticks per second and the page size, for the processes group
CLK_TCK=$(getconf CLK_TCK 2>/dev/null || echo 100)
PAGE_SIZE=$(getconf PAGESIZE 2>/dev/null || echo 4096)
# cpu delta counters, wake trigger, last push; systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
```

2. Replace

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

   with

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null processes=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

3. Replace

```bash
  fi
  if on "${COLLECT_DOCKER:-1}"; then group docker docker_json; fi

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson io "$io" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson pressure "$pressure" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, pressure: $pressure, temp: $temp,
      disks: $disks, io: $io, net: $net, docker: $docker}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}
```

   with

```bash
  fi
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

In `docs/protocol.md`:

1. Replace

```markdown
  shares, btrfs and zfs. `io` holds the counters of those devices, each once,
  in bytes (`/proc/diskstats` sectors × 512); the hub derives the rates.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

   with

```markdown
  shares, btrfs and zfs. `io` holds the counters of those devices, each once,
  in bytes (`/proc/diskstats` sectors × 512); the hub derives the rates.
- `processes` holds the five busiest processes by cpu and the five largest by
  memory (`rss` in bytes). `cpuPct` is the share of one core since the
  agent's last tick (as `top` shows it, so above 100 for a busy multi-threaded
  process), or null when there is nothing to compare yet.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

- [ ] **Step 4: Run the tests and look at this host**

Run: `node --test test/*.test.js && HOST=/ STATE=$(mktemp -d) bash -c 'for f in agent/lib/*.sh; do . "$f"; done; processes_json >/dev/null; sleep 2; processes_json | jq -c "{cpu: [.cpu[] | [.name, .cpuPct]], mem: [.mem[] | [.name, .rss]]}"'`
Expected:
- PASS, 315 tests;
- the second call shows up to five names with cpu shares, and five with rss in bytes.

Run: `pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh && bash test/budget.sh`
Expected: shellcheck prints nothing; the budget prints `ok    agent tick CPU (user+sys)` below 400 ms.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/processes.sh agent/collect.sh docs/protocol.md test/agent-groups.test.js test/agent.test.js
git commit -m "feat(agent): the five busiest processes by cpu and the five largest by memory"
```

---

### Task 2: The processes panel

**Files:**
- Modify: `www/index.html`, `www/app.css`, `www/js/app.js`, `hub/lib/i18n.js`, `test/page.test.js`, `test/snapshot.test.js`, `test/screens/demo-hub.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the snapshot's `processes` (Task 1; the hub's validation predates this plan).
- Produces:
  - panel `procs` (in `DEFAULTS.panels`, `panelOrder` after `docker`, `panelSize` wide);
  - `procRows(list, value)` in `www/js/app.js`;
  - dictionary keys `panel.procs`, `procs.byCpu`, `procs.byMem`, `procs.none`, `procs.pid`;
  - CSS `.procs`, `.plbl`, `.pname`;
  - the screenshots' `*-nas.png`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| shown\[panel\] === false\)/);
});
```

   with

```js

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\], \["procs", "processes"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| shown\[panel\] === false\)/);
});
```

2. Replace

```js
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
```

   with

```js
});

test("the processes panel lists the busiest and the largest, names escaped, the pid in the title", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const procRows = pageFn("procRows", { esc });
  const rows = procRows([{ pid: 812, name: "<rsync>", cpuPct: 38.5, rss: 5 }], (p) => p.cpuPct + "%");
  assert.strictEqual(rows, '<div class="row" title="pid 812"><span class="k pname">&#60;rsync&#62;</span><span class="v">38.5%</span></div>');
  assert.strictEqual(procRows([], (p) => p), '<span class="muted">none yet</span>', "the first tick has no cpu figures");
  assert.strictEqual(procRows(undefined, (p) => p), '<span class="muted">none yet</span>');
  for (const id of ["procs-cpu", "procs-mem"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /data-panel="procs"/);
  assert.match(HTML, /procRows\(d\.processes\.cpu, p => fmtShare\(p\.cpuPct\)\)/);
  assert.match(HTML, /procRows\(d\.processes\.mem, p => fmtBytes\(p\.rss\)\)/);
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
```

3. Replace

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

   with

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

In `test/snapshot.test.js` (it pins the hub's existing validation for what the panel relies on; it passes before and after):

1. Replace

```js
    { cpu: null, mem: null, io: { some: 1, full: 1 } });
  assert.strictEqual(validate(base({ pressure: null })).value.pressure, null, "no PSI: the group is null");
});

```

   with

```js
    { cpu: null, mem: null, io: { some: 1, full: 1 } });
  assert.strictEqual(validate(base({ pressure: null })).value.pressure, null, "no PSI: the group is null");
});

test("processes pass with a cpu share still unknown; names are cut to 64 and lists to five", () => {
  const p = (pid, extra = {}) => ({ pid, name: "n" + pid, cpuPct: null, rss: pid, ...extra });
  const r = validate(base({ processes: { cpu: [p(1, { cpuPct: 250.5 })], mem: [1, 2, 3, 4, 5, 6, 7].map((i) => p(i, { name: "x".repeat(99) })) } }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.processes.cpu[0].cpuPct, 250.5, "a multi-threaded process may pass 100 %");
  assert.strictEqual(r.value.processes.mem.length, 5);
  assert.strictEqual(r.value.processes.mem[0].name.length, 64);
  assert.strictEqual(r.value.processes.mem[0].cpuPct, null);
  assert.deepStrictEqual(validate(base({ processes: { cpu: [p(1, { rss: -1 })] } })), { ok: false, path: "$.processes.cpu[0].rss" });
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js test/snapshot.test.js`
Expected: FAIL, 3 tests:
- "the processes panel lists the busiest…" (`ReferenceError: procRows is not defined`);
- "a panel whose group the node does not send is hidden…" (no `["procs", "processes"]`);
- "conf.d review: a file with a few panels…" (`panelOrder` lacks `procs`).

"processes pass with a cpu share still unknown…" passes.

- [ ] **Step 3: The panel**

In `www/index.html`:

1. Replace

```html
      <div class="svclist" id="docker-list"></div>
      <span class="svmore hidden" id="svc-more"></span>
    </div>

```

   with

```html
      <div class="svclist" id="docker-list"></div>
      <span class="svmore hidden" id="svc-more"></span>
    </div>

    <div class="panel" data-panel="procs">
      <h2 data-i18n="panel.procs">processes</h2>
      <div class="procs">
        <div><div class="plbl" data-i18n="procs.byCpu">by cpu</div><div id="procs-cpu"></div></div>
        <div><div class="plbl" data-i18n="procs.byMem">by memory</div><div id="procs-mem"></div></div>
      </div>
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

// one column of the processes panel: name (pid in the title) and a value
function procRows(list, value) {
  if (!list || !list.length) return `<span class="muted">${esc(tr("procs.none"))}</span>`;
  return list.map(p => `<div class="row" title="${esc(tr("procs.pid", { pid: p.pid }))}">`
    + `<span class="k pname">${esc(p.name)}</span><span class="v">${value(p)}</span></div>`).join("");
}

function meter(pct, forceCls) {
  pct = clamp(pct, 0, 100);
```

2. Replace

```js
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, storage: 1, network: 1, docker: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "storage", "network", "docker", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", storage: "wide",
                 network: "wide", docker: "full", clocks: "normal", weather: "normal" }
  };
  // a conf.d file may set only a few panels: the others keep their built-in values
```

   with

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

3. Replace

```js
    !d.net || shown.network === false);

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;

  // a node without a group: hide its panel, never keep the previous node's
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
```

   with

```js
    !d.net || shown.network === false);

  // processes: the busiest and the largest (an older agent sends none: the panel hides)
  if (d.processes) {
    $("#procs-cpu").innerHTML = procRows(d.processes.cpu, p => fmtShare(p.cpuPct));
    $("#procs-mem").innerHTML = procRows(d.processes.mem, p => fmtBytes(p.rss));
  }

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;

  // a node without a group: hide its panel, never keep the previous node's
  for (const [panel, group] of [["mem", "mem"], ["cpu", "cpu"], ["temp", "temp"], ["storage", "disks"], ["docker", "docker"], ["procs", "processes"]]) {
    const el = $(`[data-panel=${panel}]`);
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "panel.network": "network",
  "panel.docker": "services",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

   with

```js
  "panel.network": "network",
  "panel.docker": "services",
  "panel.procs": "processes",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

2. Replace

```js
  "logs.error": "error: {text}",
  "logs.failed": "failed to fetch logs",

  // dialogs
```

   with

```js
  "logs.error": "error: {text}",
  "logs.failed": "failed to fetch logs",

  // processes
  "procs.byCpu": "by cpu",
  "procs.byMem": "by memory",
  "procs.none": "none yet",
  "procs.pid": "pid {pid}",

  // dialogs
```

In `www/app.css`:

1. Replace

```css
.disk .dmodel { color: var(--dim); font-size: 12px; }
.disk .dmodel .dfree { color: var(--fg); }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }
```

   with

```css
.disk .dmodel { color: var(--dim); font-size: 12px; }
.disk .dmodel .dfree { color: var(--fg); }
/* processes: two columns (one on a phone); a long name is cut, never widens the panel */
.procs { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 22px; }
.procs .plbl { color: var(--dim); font-size: 11px; letter-spacing: .06em; margin-bottom: 4px; }
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }
```

- [ ] **Step 4: The screenshots show a node with processes**

In `test/screens/demo-hub.js`:

1. Replace

```js
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.io = [{ device: "sda1", readBytes: 0, writeBytes: 0 }];
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
```

   with

```js
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.io = [{ device: "sda1", readBytes: 0, writeBytes: 0 }];
    // the nas: what keeps its disk busy; the pi runs an older agent without processes
    const proc = (pid, name, cpuPct, mb) => ({ pid, name, cpuPct, rss: mb * 1048576 });
    s.processes = i === 1 ? {
      cpu: [proc(812, "rsync", 38.5, 52), proc(1290, "smbd", 12.1, 96), proc(640, "jellyfin", 6.4, 1410),
            proc(77, "kworker/u8:2-events_unbound", 2.2, 0), proc(1, "systemd", 0.3, 14)],
      mem: [proc(640, "jellyfin", 6.4, 1410), proc(911, "postgres", 0.1, 820), proc(1290, "smbd", 12.1, 96),
            proc(812, "rsync", 38.5, 52), proc(1, "systemd", 0.3, 14)],
    } : undefined;
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
```

In `test/screens/shoot.js` (the nas at every width and density, checked for clipping like the others):

1. Replace

```js
  await page.waitForTimeout(1500);
  const local = await page.evaluate(() => localNode);
  const shots = { fleet: [], node: [] };
  for (const style of STYLES) for (const mode of ["dark", "light"]) {
```

   with

```js
  await page.waitForTimeout(1500);
  const local = await page.evaluate(() => localNode);
  // the demo nas carries the panels the local agent cannot fake (processes with cpu figures)
  const nas = await page.evaluate(() => (fleetNodes.find((n) => n.name === "nas") || {}).id);
  const shots = { fleet: [], node: [] };
  for (const style of STYLES) for (const mode of ["dark", "light"]) {
```

2. Replace

```js
  // a phone and a desktop in every density and in kiosk: nothing cut off
  for (const width of [390, 600, 768, 1024, 1280, 1920]) for (const [density, q] of [["compact", ""], ["comfortable", ""], ["large", ""], ["comfortable", "?kiosk"]]) {
    for (const hash of ["#fleet", "#node=" + local]) {
      await page.evaluate((d) => { localStorage.clear(); localStorage.setItem("servitals.density", d); }, density);
      await page.setViewportSize({ width, height: 844 });
      const name = `${width}-${q ? "kiosk" : density}-${hash === "#fleet" ? "fleet" : "node"}`;
      await page.goto(`${base}/?shot=${name}${q ? "&kiosk" : ""}${hash}`);   // a new query: a real reload
      await page.waitForTimeout(1200);
```

   with

```js
  // a phone and a desktop in every density and in kiosk: nothing cut off
  for (const width of [390, 600, 768, 1024, 1280, 1920]) for (const [density, q] of [["compact", ""], ["comfortable", ""], ["large", ""], ["comfortable", "?kiosk"]]) {
    for (const hash of ["#fleet", "#node=" + local, "#node=" + nas]) {
      await page.evaluate((d) => { localStorage.clear(); localStorage.setItem("servitals.density", d); }, density);
      await page.setViewportSize({ width, height: 844 });
      const name = `${width}-${q ? "kiosk" : density}-${hash === "#fleet" ? "fleet" : hash.endsWith(local) ? "node" : "nas"}`;
      await page.goto(`${base}/?shot=${name}${q ? "&kiosk" : ""}${hash}`);   // a new query: a real reload
      await page.waitForTimeout(1200);
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Disk activity (spec 9): each disk in the storage panel shows how fast its
  device reads and writes, from `/proc/diskstats` (LVM and dm devices too;
```

   with

```markdown

### Added
- Processes (spec 9): a new panel lists the five busiest processes by cpu
  (share of one core since the last tick, as `top` shows it) and the five
  largest by memory, so a busy server shows what keeps it busy even outside
  containers. `COLLECT_PROCESSES=0` turns it off.
- Disk activity (spec 9): each disk in the storage panel shows how fast its
  device reads and writes, from `/proc/diskstats` (LVM and dm devices too;
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/screens.sh`
Expected:
- PASS, 317 tests;
- the budget passes;
- `screenshots in /out: no page errors`;
- `build/screens/1280-comfortable-nas.png` shows "processes" with rsync 39% at the top of "by cpu" and jellyfin 1.4G at the top of "by memory".

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash packaging/build-deb.sh` builds both packages `ok`, with `agent/lib/processes.sh` installed with the other libs;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 6: Commit**

```bash
git add www/index.html www/app.css www/js/app.js hub/lib/i18n.js test/page.test.js test/snapshot.test.js test/screens/demo-hub.js test/screens/shoot.js CHANGELOG.md
git commit -m "feat(ui): a processes panel: the busiest by cpu and the largest by memory"
```
