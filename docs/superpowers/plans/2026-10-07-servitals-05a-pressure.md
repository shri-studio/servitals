# servitals Waiting Shows: iowait, steal and pressure (sub-project 5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server stuck on its disk no longer looks idle. The agent reports iowait and steal beside cpu usage, plus the kernel's pressure stall information (PSI) for cpu, memory and io. The hub validates and keeps them, and the page shows them in the cpu panel (amber at 10 %, red at 30 %) and, if chosen, on fleet cards.

**Why:** on 2026-09-28 the live host was slow while its cpu panel read 11 %. The agent counts iowait as idle (`idle = idle + iowait`), and nothing showed the disk wait. `/proc/pressure/io` on the same host reads `some avg10=14.85 full avg10=13.29`: for 13 % of each 10 seconds, every task was stalled on io.

**Architecture:** `agent/lib/cpu.sh` keeps `usage` as before (time neither idle nor waiting on io) and adds `iowait` and `steal` as shares of the same `/proc/stat` delta. Its state file grows from `total idle` to `total idle iowait steal`; a state file from the older agent gives 0 for the new shares for one tick. A new `agent/lib/pressure.sh` reads the `avg10` values of `/proc/pressure/{cpu,memory,io}` into `{cpu, mem, io}`, each `{some, full}`. A missing file or `full` line gives null, and a kernel without PSI gives a null group. `COLLECT_PRESSURE=0` turns it off. The hub's snapshot schema accepts `cpu.iowait`, `cpu.steal` and `pressure` (0..100, nullable per resource), and `docs/protocol.md` documents them. The fleet summary gains `iowait`. The page adds two rows to the cpu panel, "iowait / steal" and "pressure cpu / mem / io". They stay hidden for an agent that sends neither. `iowait` also becomes a fleet card number.

**Tech Stack:** bash, `awk`, `jq` (agent); Node.js ≥ 18 (hub, tests); vanilla JS (page); Playwright (screenshots).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 9 (metrics: every group optional, a missing source gives null), 6.3 (snapshot validation), 10.3 (every word from the dictionary), 18 (lightness budget: agent CPU per tick ≤ 400 ms).

**Scope:** 5a of sub-project 5. Disk I/O and processes (5b), Ubuntu updates and failed units (5c), and fans, voltages and battery (5d) follow. The cpu panel's big number stays `usage`. No history and no alerts on pressure yet: those come with sub-project 6.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (c9ff79b) on 2026-10-01: node suite 306 tests, shellcheck, the budget, and `test/screens.sh`. The live host showed "pressure cpu / mem / io 0.3% / 0.1% / 17%" with the 17 % in amber.

## Global Constraints

- Everything from sub-projects 1-4 still holds: zero runtime dependencies, the strict CSP, every word from `hub/lib/i18n.js`, Node 18 compatibility, SPDX headers, lintian clean.
- The lightness budget: agent CPU per tick ≤ 400 ms and peak RSS ≤ 10 MB (`test/budget.sh`). Pressure adds one `awk` and one `jq` per tick.
- Schema version stays 1: every new field is optional, so an older agent's snapshot still validates and an older hub drops the new keys.
- `cpu.usage` keeps its meaning (time neither idle nor waiting on io), so the trend, the fleet card and every earlier reading stay comparable.
- A missing source gives null for that part, never an error (spec 9).
- Work in a worktree `.claude/worktrees/servitals-pressure` on branch `feat/pressure` from `main` (c9ff79b).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **An upgraded agent's first tick** (state file `total idle` from the older agent): it must give 0 for iowait and steal, not a crash or a garbage share. Test: Task 1 "cpu_json after an upgrade…".
2. **Kernels without PSI, without cpu `full` (before 5.13), or with only some files** (containers, `psi=0`): null for what is missing, never an error or a made-up 0. Test: Task 1 "pressure_json: a kernel without cpu 'full'…".
3. **A hostile or broken snapshot** (pressure above 100, strings, arrays, iowait 101): the hub refuses it and names the path. Test: Task 2 "the first bad value names its path".
4. **An older agent behind a newer hub** (no iowait, no pressure): the rows stay hidden, and the fleet card shows a dash. Tests: Task 2 "a card's numbers come from the view" (`iowait` null), Task 3 "the cpu panel shows iowait and steal… the rows hide…".
5. **A narrow or kiosk panel with the long captions**: they wrap, the panel keeps its width. Test: `test/screens.sh` (fails on any panel wider than its box), Task 3.

---

### Task 1: The agent reports iowait, steal and pressure

**Files:**
- Create: `agent/lib/pressure.sh`
- Modify: `agent/lib/cpu.sh`, `agent/collect.sh`, `packaging/etc/agent.env`, `test/agent-groups.test.js`, `test/agent.test.js`

**Interfaces:**
- Produces: `cpu_json` → `{usage, iowait, steal, cores, per, load}` (shares in whole percent); `$STATE/cpu` holds `total idle iowait steal`; `pressure_json` → `{cpu, mem, io}` with `{some, full}` floats or null each, or `null`; the snapshot's top-level `pressure` key; `COLLECT_PRESSURE` (default 1). Task 2 validates these.

- [ ] **Step 1: Write the failing tests**

In `test/agent-groups.test.js`:

1. Replace

```js
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  assert.deepStrictEqual(json(runGroup(host, "cpu_json", { STATE: state })),
    { usage: 0, cores: 2, per: [0, 0], load: [0.5, 0.4, 0.3] });
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1600 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\ncpu1 100 0 100 800 0 0 0 0 0 0\n");
```

   with

```js
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  assert.deepStrictEqual(json(runGroup(host, "cpu_json", { STATE: state })),
    { usage: 0, iowait: 0, steal: 0, cores: 2, per: [0, 0], load: [0.5, 0.4, 0.3] });
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1600 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\ncpu1 100 0 100 800 0 0 0 0 0 0\n");
```

2. Replace

```js
  assert.strictEqual(second.usage, 20);
  assert.deepStrictEqual(second.per, [20, 20]);
});

```

   with

```js
  assert.strictEqual(second.usage, 20);
  assert.deepStrictEqual(second.per, [20, 20]);
});

test("cpu_json: time waiting on disk (iowait) and taken by the hypervisor (steal) are their own numbers", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  runGroup(host, "cpu_json", { STATE: state });
  // of 1000 more ticks: 100 user, 100 system, 500 idle, 250 iowait, 50 steal
  fs.writeFileSync(path.join(host, "proc/stat"),
    "cpu  200 0 200 1300 250 0 0 50 0 0\ncpu0 100 0 100 650 125 0 0 25 0 0\ncpu1 100 0 100 650 125 0 0 25 0 0\n");
  const d = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(d.usage, 25, "busy: user, system and steal; iowait is idle time the CPU could not use");
  assert.strictEqual(d.iowait, 25);
  assert.strictEqual(d.steal, 5);
});

test("cpu_json after an upgrade: a state file from the older agent gives 0, not an error", () => {
  const host = fakeHost(BASE);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-state-"));
  fs.writeFileSync(path.join(state, "cpu"), "1000 800\n");   // total idle, as the older agent wrote it
  const d = json(runGroup(host, "cpu_json", { STATE: state }));
  assert.strictEqual(d.iowait, 0);
  assert.strictEqual(d.steal, 0);
  assert.strictEqual(fs.readFileSync(path.join(state, "cpu"), "utf8").trim().split(" ").length, 4, "the new state has four fields");
});

const PRESSURE = {
  "proc/pressure/cpu": "some avg10=0.43 avg60=0.18 avg300=0.05 total=10361151074\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  "proc/pressure/memory": "some avg10=0.04 avg60=0.15 avg300=0.20 total=8494872319\nfull avg10=0.04 avg60=0.15 avg300=0.18 total=8074947564\n",
  "proc/pressure/io": "some avg10=14.85 avg60=17.50 avg300=18.90 total=140135240655\nfull avg10=13.29 avg60=15.99 avg300=17.46 total=130849769659\n",
};

test("pressure_json: the share of the last 10 s that some (or all) tasks waited for cpu, memory or disk", () => {
  const host = fakeHost({ ...BASE, ...PRESSURE });
  assert.deepStrictEqual(json(runGroup(host, "pressure_json")), {
    cpu: { some: 0.43, full: 0 }, mem: { some: 0.04, full: 0.04 }, io: { some: 14.85, full: 13.29 },
  });
});

test("pressure_json: a kernel without cpu 'full' (before 5.13) gives null there; without PSI, null", () => {
  const host = fakeHost({ ...BASE, ...PRESSURE, "proc/pressure/cpu": "some avg10=1.50 avg60=0.18 avg300=0.05 total=1\n" });
  assert.deepStrictEqual(json(runGroup(host, "pressure_json")).cpu, { some: 1.5, full: null });
  assert.strictEqual(runGroup(fakeHost(BASE), "pressure_json").stdout.trim(), "null");
  const partial = fakeHost({ ...BASE, "proc/pressure/io": PRESSURE["proc/pressure/io"] });
  assert.deepStrictEqual(json(runGroup(partial, "pressure_json")), { cpu: null, mem: null, io: { some: 14.85, full: 13.29 } });
});

```

In `test/agent.test.js`:

1. Replace

```js
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0" },
    timeout: 30000,
  });
```

   with

```js
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0" },
    timeout: 30000,
  });
```

2. Replace

```js
  assert.strictEqual(d.temp, null);
  assert.strictEqual(d.net, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

   with

```js
  assert.strictEqual(d.temp, null);
  assert.strictEqual(d.net, null);
  assert.strictEqual(d.pressure, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL, 6 tests: the three `cpu_json` tests (no `iowait` and `steal`), the two `pressure_json` tests (`bash: line 1: pressure_json: command not found`), and "COLLECT_<GROUP>=0 turns a group off" (`pressure` is missing, not null).

- [ ] **Step 3: iowait and steal**

In `agent/lib/cpu.sh`:

1. Replace

```bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# cpu: total and per-core usage from /proc/stat deltas, load averages

cpu_json() {
  local line idle total v pct=0 dt di
  line=$(grep '^cpu ' "$HOST/proc/stat")
  # cpu user nice system idle iowait irq softirq steal guest guest_nice
  set -- $line
  idle=$(( $5 + $6 ))
  total=0; shift
  for v in "$@"; do total=$((total + v)); done
  if [ -f "$STATE/cpu" ]; then
    read -r pt pi < "$STATE/cpu"
    dt=$((total - pt)); di=$((idle - pi))
    [ "$dt" -gt 0 ] && pct=$(( (100 * (dt - di)) / dt ))
  fi
  echo "$total $idle" > "$STATE/cpu"
  [ "$pct" -lt 0 ] && pct=0
  [ "$pct" -gt 100 ] && pct=100

  # per-core usage from cpuN lines, delta vs previous tick
```

   with

```bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# cpu: total and per-core usage from /proc/stat deltas, the share spent waiting on
# disk (iowait) and taken by the hypervisor (steal), load averages

# a share of dt in whole percent, 0..100
share() { local p=0; [ "$2" -gt 0 ] && p=$(( (100 * $1) / $2 )); [ "$p" -lt 0 ] && p=0; [ "$p" -gt 100 ] && p=100; echo "$p"; }

cpu_json() {
  local line idle total wait steal v pct=0 iowait=0 stolen=0 dt pt pi pw ps
  line=$(grep '^cpu ' "$HOST/proc/stat")
  # cpu user nice system idle iowait irq softirq steal guest guest_nice
  set -- $line
  idle=$(( $5 + $6 )); wait=$6; steal=${9:-0}
  total=0; shift
  for v in "$@"; do total=$((total + v)); done
  if [ -f "$STATE/cpu" ]; then
    # the older agent wrote only "total idle": then iowait and steal start next tick
    read -r pt pi pw ps < "$STATE/cpu"
    dt=$((total - pt))
    pct=$(share $((dt - (idle - pi))) "$dt")
    if [ -n "$ps" ]; then iowait=$(share $((wait - pw)) "$dt"); stolen=$(share $((steal - ps)) "$dt"); fi
  fi
  echo "$total $idle $wait $steal" > "$STATE/cpu"

  # per-core usage from cpuN lines, delta vs previous tick
```

2. Replace

```bash
  load=$(cut -d' ' -f1-3 "$HOST/proc/loadavg" 2>/dev/null || echo "0 0 0")
  set -- $load
  jq -cn --argjson pct "$pct" --argjson n "$NCPU" --argjson per "$per" \
     --argjson l1 "${1:-0}" --argjson l5 "${2:-0}" --argjson l15 "${3:-0}" \
     '{usage:$pct, cores:$n, per:$per, load:[$l1,$l5,$l15]}'
}

```

   with

```bash
  load=$(cut -d' ' -f1-3 "$HOST/proc/loadavg" 2>/dev/null || echo "0 0 0")
  set -- $load
  jq -cn --argjson pct "$pct" --argjson iowait "$iowait" --argjson steal "$stolen" --argjson n "$NCPU" \
     --argjson per "$per" --argjson l1 "${1:-0}" --argjson l5 "${2:-0}" --argjson l15 "${3:-0}" \
     '{usage:$pct, iowait:$iowait, steal:$steal, cores:$n, per:$per, load:[$l1,$l5,$l15]}'
}

```

- [ ] **Step 4: Pressure**

Create `agent/lib/pressure.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# pressure: the kernel's pressure stall information (PSI, /proc/pressure). For cpu,
# memory and io: the share of the last 10 seconds in which some tasks ("some") or
# all of them ("full") waited for that resource. A busy disk shows here even when
# the cpu looks idle. null without PSI (kernels before 4.20, or booted with psi=0).

pressure_json() {
  local dir="$HOST/proc/pressure"
  [ -d "$dir" ] || { echo null; return; }
  # one "kind line" per file: "cpu some 0.43", "cpu full 0.00", ...
  local f
  for f in cpu memory io; do
    [ -r "$dir/$f" ] || continue
    awk -v r="$f" '$1 == "some" || $1 == "full" { sub("avg10=", "", $2); print r, $1, $2 }' "$dir/$f" 2>/dev/null
  done | jq -cRn '
    [inputs | split(" ") | select(length == 3 and (.[2] | test("^[0-9]+(\\.[0-9]+)?$")))] as $l
    | def one($r): ([$l[] | select(.[0] == $r)] | if length == 0 then null
        else (map({(.[1]): (.[2] | tonumber)}) | add) as $v | {some: ($v.some // null), full: ($v.full // null)} end);
      {cpu: one("cpu"), mem: one("memory"), io: one("io")}'
}
```

In `agent/collect.sh`:

1. Replace

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
```

   with

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null pressure=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_PRESSURE:-1}"; then pressure=$(pressure_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
```

2. Replace

```bash
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, temp: $temp,
      disks: $disks, net: $net, docker: $docker}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
```

   with

```bash
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson pressure "$pressure" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, pressure: $pressure, temp: $temp,
      disks: $disks, net: $net, docker: $docker}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
```

In `packaging/etc/agent.env`:

1. Replace

```bash
COLLECT_MEM=1
COLLECT_CPU=1
COLLECT_TEMP=1
COLLECT_DISKS=1
```

   with

```bash
COLLECT_MEM=1
COLLECT_CPU=1
COLLECT_PRESSURE=1
COLLECT_TEMP=1
COLLECT_DISKS=1
```

- [ ] **Step 5: Run the tests and look at this host**

Run: `node --test test/*.test.js && HOST=/ bash -c 'for f in agent/lib/*.sh; do . "$f"; done; pressure_json'`
Expected: PASS, 304 tests. Then one JSON line such as `{"cpu":{"some":0.11,"full":0.00},"mem":{…},"io":{"some":12.51,"full":11.15}}` on a host with PSI, or `null` without.

Run: `pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add agent/lib/cpu.sh agent/lib/pressure.sh agent/collect.sh packaging/etc/agent.env test/agent-groups.test.js test/agent.test.js
git commit -m "feat(agent): iowait and steal beside cpu usage; pressure stall information for cpu, memory and io"
```

---

### Task 2: The hub validates them; fleet cards can use iowait

**Files:**
- Modify: `hub/lib/snapshot.js`, `hub/lib/fleet.js`, `docs/protocol.md`, `test/snapshot.test.js`, `test/fleet.test.js`

**Interfaces:**
- Consumes: the agent's fields (Task 1).
- Produces: validated `cpu.iowait`, `cpu.steal` (0..100) and `pressure.{cpu,mem,io}.{some,full}` (0..100, null allowed) in the stored snapshot and the page's view; `summary(view).iowait` (number or null). Task 3 shows them.

- [ ] **Step 1: Write the failing tests**

In `test/snapshot.test.js`:

1. Replace

```js
});

test("the first bad value names its path", () => {
  const cases = [
```

   with

```js
});

test("iowait, steal and pressure pass; a pressure resource the kernel lacks may be null", () => {
  const pressure = { cpu: { some: 0.43, full: null }, mem: { some: 0, full: 0 }, io: { some: 14.85, full: 13.29 } };
  const r = validate(base({ cpu: { usage: 11, iowait: 34, steal: 0, cores: 4 }, pressure }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.value.cpu.iowait, r.value.cpu.steal], [34, 0]);
  assert.deepStrictEqual(r.value.pressure, pressure);
  assert.deepStrictEqual(validate(base({ pressure: { cpu: null, mem: null, io: { some: 1, full: 1 } } })).value.pressure,
    { cpu: null, mem: null, io: { some: 1, full: 1 } });
  assert.strictEqual(validate(base({ pressure: null })).value.pressure, null, "no PSI: the group is null");
});

test("the first bad value names its path", () => {
  const cases = [
```

2. Replace

```js
    [{ ...base(), host: { name: "x", os: "plan9" } }, "$.host.os"],
    [base({ cpu: { usage: 101 } }), "$.cpu.usage"], [base({ cpu: { usage: Infinity } }), "$.cpu.usage"],
    [base({ mem: { total: "1" } }), "$.mem.total"], [base({ temp: { package: 900 } }), "$.temp.package"],
    [base({ disks: [{ mount: "/", pct: 150 }] }), "$.disks[0].pct"], [base({ disks: "x" }), "$.disks"],
```

   with

```js
    [{ ...base(), host: { name: "x", os: "plan9" } }, "$.host.os"],
    [base({ cpu: { usage: 101 } }), "$.cpu.usage"], [base({ cpu: { usage: Infinity } }), "$.cpu.usage"],
    [base({ cpu: { iowait: 101 } }), "$.cpu.iowait"], [base({ cpu: { steal: -1 } }), "$.cpu.steal"],
    [base({ pressure: { io: { some: 100.5 } } }), "$.pressure.io.some"], [base({ pressure: { mem: { full: "9" } } }), "$.pressure.mem.full"],
    [base({ pressure: { cpu: [] } }), "$.pressure.cpu"],
    [base({ mem: { total: "1" } }), "$.mem.total"], [base({ temp: { package: 900 } }), "$.temp.package"],
    [base({ disks: [{ mount: "/", pct: 150 }] }), "$.disks[0].pct"], [base({ disks: "x" }), "$.disks"],
```

In `test/fleet.test.js`:

1. Replace

```js
test("a card's numbers come from the view", () => {
  const s = summary({
    host: { name: "nas", distro: "Ubuntu" }, cpu: { usage: 12.4 }, mem: { total: 200, used: 50 }, temp: { package: 46 },
    disks: [{ mount: "/", pct: 40 }, { mount: "/srv", pct: 93 }, { mount: "/mnt/x", mounted: false }],
    docker: [{ state: "running" }, { state: "exited" }], trend: Array.from({ length: 30 }, (_, i) => ({ cpu: i })),
  });
  assert.deepStrictEqual(s.disk, { mount: "/srv", pct: 93 });
  assert.deepStrictEqual([s.cpu, s.mem, s.temp, s.containers, s.running], [12.4, 25, 46, 2, 1]);
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
```

   with

```js
test("a card's numbers come from the view", () => {
  const s = summary({
    host: { name: "nas", distro: "Ubuntu" }, cpu: { usage: 12.4, iowait: 31 }, mem: { total: 200, used: 50 }, temp: { package: 46 },
    disks: [{ mount: "/", pct: 40 }, { mount: "/srv", pct: 93 }, { mount: "/mnt/x", mounted: false }],
    docker: [{ state: "running" }, { state: "exited" }], trend: Array.from({ length: 30 }, (_, i) => ({ cpu: i })),
  });
  assert.deepStrictEqual(s.disk, { mount: "/srv", pct: 93 });
  assert.deepStrictEqual([s.cpu, s.iowait, s.mem, s.temp, s.containers, s.running], [12.4, 31, 25, 46, 2, 1]);
  assert.strictEqual(summary({ cpu: { usage: 5 } }).iowait, null, "an older agent sends no iowait");
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/snapshot.test.js test/fleet.test.js`
Expected: FAIL, 3 tests: "iowait, steal and pressure pass…" (the unknown keys are dropped), "the first bad value names its path" (`{"schema":1,…,"cpu":{"iowait":101}}` passes), "a card's numbers come from the view" (`iowait` undefined).

- [ ] **Step 3: The schema, the summary and the protocol**

In `hub/lib/snapshot.js`:

1. Replace

```js
  rx: counter(x.rx, `${p}.rx`), tx: counter(x.tx, `${p}.tx`),
}), { optional: false });
const proc = (x, p) => obj(x, p, (o) => clean({
  pid: num(o.pid, 0, 2 ** 32, `${p}.pid`, { int: true }), name: str(o.name, 64, `${p}.name`),
```

   with

```js
  rx: counter(x.rx, `${p}.rx`), tx: counter(x.tx, `${p}.tx`),
}), { optional: false });
// one resource's pressure stall information: % of the last 10 s, "full" is null before kernel 5.13 for cpu
const stall = (x, p) => obj(x, p, (o) => clean({
  some: num(o.some, 0, 100, `${p}.some`), full: num(o.full, 0, 100, `${p}.full`),
}));
const proc = (x, p) => obj(x, p, (o) => clean({
  pid: num(o.pid, 0, 2 ** 32, `${p}.pid`, { int: true }), name: str(o.name, 64, `${p}.name`),
```

2. Replace

```js
    cpu: obj(s.cpu, "$.cpu", (c, p) => clean({
      usage: num(c.usage, 0, 100, `${p}.usage`), cores: num(c.cores, 1, 4096, `${p}.cores`, { int: true }),
      per: list(c.per, 1024, `${p}.per`, (v, q) => num(v, 0, 100, q, { optional: false })),
      load: list(c.load, 3, `${p}.load`, (v, q) => num(v, 0, 1e6, q, { optional: false })),
    })),
    temp: obj(s.temp, "$.temp", (t, p) => clean({
```

   with

```js
    cpu: obj(s.cpu, "$.cpu", (c, p) => clean({
      usage: num(c.usage, 0, 100, `${p}.usage`), cores: num(c.cores, 1, 4096, `${p}.cores`, { int: true }),
      iowait: num(c.iowait, 0, 100, `${p}.iowait`), steal: num(c.steal, 0, 100, `${p}.steal`),
      per: list(c.per, 1024, `${p}.per`, (v, q) => num(v, 0, 100, q, { optional: false })),
      load: list(c.load, 3, `${p}.load`, (v, q) => num(v, 0, 1e6, q, { optional: false })),
    })),
    pressure: obj(s.pressure, "$.pressure", (x, p) => clean({
      cpu: stall(x.cpu, `${p}.cpu`), mem: stall(x.mem, `${p}.mem`), io: stall(x.io, `${p}.io`),
    })),
    temp: obj(s.temp, "$.temp", (t, p) => clean({
```

In `hub/lib/fleet.js`:

1. Replace

```js
    host: v.host ? { name: v.host.name, distro: v.host.distro } : null,
    cpu: v.cpu && typeof v.cpu.usage === "number" ? v.cpu.usage : null,
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
```

   with

```js
    host: v.host ? { name: v.host.name, distro: v.host.distro } : null,
    cpu: v.cpu && typeof v.cpu.usage === "number" ? v.cpu.usage : null,
    iowait: v.cpu && typeof v.cpu.iowait === "number" ? v.cpu.iowait : null,
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
```

In `docs/protocol.md`:

1. Replace

```markdown
  "mem":  { "total": 0, "used": 0, "available": 0, "free": 0, "cache": 0,
            "swapTotal": 0, "swapUsed": 0 },                        // bytes, ≥ 0
  "cpu":  { "usage": 12, "cores": 8, "per": [10, 14],               // % 0..100, per ≤ 1024 entries
            "load": [0.5, 0.4, 0.3] },
  "temp": { "package": 46, "max": 51,                               // °C, -50..150 or null
            "sensors": [ { "label": "Package id 0", "value": 46 } ] }, // ≤ 64
```

   with

```markdown
  "mem":  { "total": 0, "used": 0, "available": 0, "free": 0, "cache": 0,
            "swapTotal": 0, "swapUsed": 0 },                        // bytes, ≥ 0
  "cpu":  { "usage": 12, "iowait": 34, "steal": 0,                 // % 0..100 of the tick
            "cores": 8, "per": [10, 14],                            // per ≤ 1024 entries
            "load": [0.5, 0.4, 0.3] },
  "pressure": { "cpu": { "some": 0.4, "full": null },               // PSI avg10, % 0..100;
                "mem": { "some": 0, "full": 0 },                    // a resource or "full" the
                "io":  { "some": 14.9, "full": 13.3 } },            // kernel lacks is null
  "temp": { "package": 46, "max": 51,                               // °C, -50..150 or null
            "sensors": [ { "label": "Package id 0", "value": 46 } ] }, // ≤ 64
```

2. Replace

```markdown
  numbers follow the rules above and `days`/`hours` hold at most 31 and 24
  entries with `label`/`title` strings ≤ 32.
- Rates are never sent. The hub derives them from counters.

Schema versioning: the hub accepts the current schema and the one before it.
```

   with

```markdown
  numbers follow the rules above and `days`/`hours` hold at most 31 and 24
  entries with `label`/`title` strings ≤ 32.
- Rates are never sent. The hub derives them from counters. The cpu shares
  (`usage`, `iowait`, `steal`, `per`) are the agent's own delta over its tick,
  and `pressure` is the kernel's 10-second average: both are shares of time,
  not rates of a counter the hub holds.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
  with a high `iowait` and `pressure.io`.

Schema versioning: the hub accepts the current schema and the one before it.
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 305 tests.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/snapshot.js hub/lib/fleet.js docs/protocol.md test/snapshot.test.js test/fleet.test.js
git commit -m "feat(hub): the snapshot carries iowait, steal and pressure; fleet cards can show iowait"
```

---

### Task 3: The page shows them

**Files:**
- Modify: `www/index.html`, `www/app.css`, `www/js/app.js`, `hub/lib/i18n.js`, `test/page.test.js`, `test/screens/demo-hub.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `cpu.iowait`, `cpu.steal`, `pressure`, `summary.iowait` (Task 2).
- Produces: `fmtShare(v)`, `waitHtml(c)`, `pressureHtml(p)` in `www/js/app.js`; rows `#cpu-wait-row` / `#cpu-wait` and `#cpu-psi-row` / `#cpu-psi` (class `row long`); `CARD_KEYS` gains `"iowait"`; dictionary keys `cpu.wait`, `cpu.waitTitle`, `cpu.pressure`, `cpu.pressureTitle`, `card.iowait`, `set.card.iowait`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
  assert.deepStrictEqual(cardNumbers(), ["disk", "containers"]);
  assert.deepStrictEqual(pageFn("cardNumbers", { CARD_KEYS, cfg: {} })(), ["cpu", "mem", "temp"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
```

   with

```js
});

test("the cpu panel shows iowait and steal, and pressure, coloured when high; the rows hide when an agent sends neither", () => {
  const HL = { ok: "", warn: "hl-amber", crit: "hl-red" };
  const health = pageFunction("health");
  const fmtShare = pageFunction("fmtShare");
  assert.deepStrictEqual([fmtShare(34), fmtShare(0), fmtShare(0.43), fmtShare(14.85), fmtShare(null), fmtShare(NaN)],
    ["34%", "0%", "0.4%", "15%", "–", "–"]);
  const waitHtml = pageFn("waitHtml", { HL, health, fmtShare });
  assert.strictEqual(waitHtml({ iowait: 34, steal: 0 }), '<span class="hl-red">34%</span> / <span class="">0%</span>');
  assert.strictEqual(waitHtml({ iowait: 12 }), '<span class="hl-amber">12%</span> / <span class="">0%</span>', "no steal: 0");
  const pressureHtml = pageFn("pressureHtml", { HL, health, fmtShare });
  assert.strictEqual(pressureHtml({ cpu: { some: 0.43, full: null }, mem: { some: 0, full: 0 }, io: { some: 14.85, full: 13.29 } }),
    '<span class="">0.4%</span> / <span class="">0%</span> / <span class="hl-amber">15%</span>');
  assert.strictEqual(pressureHtml({ cpu: null, mem: null, io: { some: 41 } }), '– / – / <span class="hl-red">41%</span>');
  for (const id of ["cpu-wait-row", "cpu-wait", "cpu-psi-row", "cpu-psi"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /\$\("#cpu-wait-row"\)\.classList\.toggle\("hidden", typeof c\.iowait !== "number"\);/);
  assert.match(HTML, /\$\("#cpu-psi-row"\)\.classList\.toggle\("hidden", !d\.pressure\);/);
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
  assert.deepStrictEqual(cardNumbers(), ["disk", "containers"]);
  assert.deepStrictEqual(pageFn("cardNumbers", { CARD_KEYS, cfg: {} })(), ["cpu", "mem", "temp"]);
  const cardValue = pageFn("cardValue", { fmtVal: pageFunction("fmtVal"), fmtTemp: () => "" });
  assert.deepStrictEqual([cardValue("iowait", { iowait: 31 }), cardValue("iowait", { iowait: null })], ["31%", "–"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 2 tests: "the cpu panel shows iowait and steal…" (`function fmtShare not found in the page`), "fleet cards show the numbers chosen in settings" (`const CARD_KEYS = […, "iowait"]` not found).

- [ ] **Step 3: The rows, the card number and their words**

In `www/index.html`:

1. Replace

```html
      <div class="row mt8"><span class="k" data-i18n="cpu.load">load 1m / 5m / 15m</span><span class="v" id="cpu-load">-- / -- / --</span></div>
      <div class="row"><span class="k" data-i18n="cpu.loadCore">load / core</span><span class="v" id="cpu-loadn">--</span></div>
      <div id="cpu-cores-wrap">
        <div class="cores" id="cpu-cores"></div>
```

   with

```html
      <div class="row mt8"><span class="k" data-i18n="cpu.load">load 1m / 5m / 15m</span><span class="v" id="cpu-load">-- / -- / --</span></div>
      <div class="row"><span class="k" data-i18n="cpu.loadCore">load / core</span><span class="v" id="cpu-loadn">--</span></div>
      <div class="row long hidden" id="cpu-wait-row"><span class="k" title="share of the last tick the CPU sat idle waiting on disk, and the share a hypervisor took" data-i18n-title="cpu.waitTitle" data-i18n="cpu.wait">iowait / steal</span><span class="v" id="cpu-wait">--</span></div>
      <div class="row long hidden" id="cpu-psi-row"><span class="k" title="share of the last 10 s in which tasks waited for cpu, memory or disk (pressure stall information)" data-i18n-title="cpu.pressureTitle" data-i18n="cpu.pressure">pressure cpu / mem / io</span><span class="v" id="cpu-psi">--</span></div>
      <div id="cpu-cores-wrap">
        <div class="cores" id="cpu-cores"></div>
```

In `www/app.css` (the long captions wrap instead of widening a narrow or kiosk panel):

1. Replace

```css
.row > .v { white-space: normal; text-align: right; min-width: 0; }
.row + .row { margin-top: 3px; }
.k { color: var(--dim); }
.v { color: var(--fg-bright); }
```

   with

```css
.row > .v { white-space: normal; text-align: right; min-width: 0; }
.row + .row { margin-top: 3px; }
/* a long caption (iowait, pressure) wraps rather than widen a narrow or kiosk panel */
.row.long > .k { white-space: normal; min-width: 0; }
.k { color: var(--dim); }
.v { color: var(--fg-bright); }
```

In `www/js/app.js`:

1. Replace

```js
const HCLS = { ok: "c-green", warn: "c-amber", crit: "c-red" };   // big numbers / meters
const HL   = { ok: "",        warn: "hl-amber", crit: "hl-red" };  // inline value highlight

function meter(pct, forceCls) {
```

   with

```js
const HCLS = { ok: "c-green", warn: "c-amber", crit: "c-red" };   // big numbers / meters
const HL   = { ok: "",        warn: "hl-amber", crit: "hl-red" };  // inline value highlight

// a share of time: whole percent, one decimal below 10 for the kernel's averages
function fmtShare(v) {
  if (v == null || !Number.isFinite(Number(v))) return "–";
  v = Number(v);
  return (v < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v)) + "%";
}
// iowait / steal: the cpu idle while the disk works, and time a hypervisor took
function waitHtml(c) {
  const steal = c.steal || 0;
  return `<span class="${HL[health(c.iowait, 10, 30)]}">${fmtShare(c.iowait)}</span>`
    + ` / <span class="${HL[health(steal, 5, 20)]}">${fmtShare(steal)}</span>`;
}
// pressure (PSI "some", last 10 s) for cpu / mem / io; a resource the kernel lacks is a dash
function pressureHtml(p) {
  return ["cpu", "mem", "io"].map(k => {
    const v = p[k] && p[k].some;
    return v == null ? "–" : `<span class="${HL[health(v, 10, 30)]}">${fmtShare(v)}</span>`;
  }).join(" / ");
}

function meter(pct, forceCls) {
```

2. Replace

```js
}
// the numbers a fleet card can show; their labels are card.<key> in the dictionary
const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers"];
function cardValue(k, s) {
  if (k === "cpu" || k === "mem") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
```

   with

```js
}
// the numbers a fleet card can show; their labels are card.<key> in the dictionary
const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
function cardValue(k, s) {
  if (k === "cpu" || k === "mem" || k === "iowait") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
```

3. Replace

```js
    $("#cpu-loadn").textContent = c.cores ? ratio.toFixed(2) + " × " + c.cores : "—";
    $("#cpu-note").textContent = tr("cpu.threads", { n: c.cores });
    const per = c.per || [];
    $("#cpu-cores").innerHTML = per.map(v => {
```

   with

```js
    $("#cpu-loadn").textContent = c.cores ? ratio.toFixed(2) + " × " + c.cores : "—";
    $("#cpu-note").textContent = tr("cpu.threads", { n: c.cores });
    // an agent from before 5a sends no iowait: the row stays hidden
    $("#cpu-wait-row").classList.toggle("hidden", typeof c.iowait !== "number");
    if (typeof c.iowait === "number") $("#cpu-wait").innerHTML = waitHtml(c);
    const per = c.per || [];
    $("#cpu-cores").innerHTML = per.map(v => {
```

4. Replace

```js
    $("#cpu-cores-wrap").classList.toggle("hidden", !per.length);
  }

  // thermal
```

   with

```js
    $("#cpu-cores-wrap").classList.toggle("hidden", !per.length);
  }

  // pressure: the kernel's own measure of waiting, shown in the cpu panel
  $("#cpu-psi-row").classList.toggle("hidden", !d.pressure);
  if (d.pressure) $("#cpu-psi").innerHTML = pressureHtml(d.pressure);

  // thermal
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "cpu.perCore": "per-core utilisation",
  "cpu.threads": "{n} threads",

  // thermal
```

   with

```js
  "cpu.perCore": "per-core utilisation",
  "cpu.threads": "{n} threads",
  "cpu.wait": "iowait / steal",
  "cpu.waitTitle": "share of the last tick the CPU sat idle waiting on disk, and the share a hypervisor took",
  "cpu.pressure": "pressure cpu / mem / io",
  "cpu.pressureTitle": "share of the last 10 s in which tasks waited for cpu, memory or disk (pressure stall information)",

  // thermal
```

2. Replace

```js
  "card.disk": "disk",
  "card.containers": "up",

  // clocks and weather
```

   with

```js
  "card.disk": "disk",
  "card.containers": "up",
  "card.iowait": "iowait",

  // clocks and weather
```

3. Replace

```js
  "set.card.disk": "fullest disk",
  "set.card.containers": "containers",
  "set.serversHint": "name and tags save at once; pin and hide with the other settings",
  "set.srvName": "name of {name}",
```

   with

```js
  "set.card.disk": "fullest disk",
  "set.card.containers": "containers",
  "set.card.iowait": "iowait (waiting on disk)",
  "set.serversHint": "name and tags save at once; pin and hide with the other settings",
  "set.srvName": "name of {name}",
```

- [ ] **Step 4: The screenshots show a node waiting on its disk**

In `test/screens/demo-hub.js`:

1. Replace

```js
    s.host.name = c.name;
    s.cpu.usage = [0, 4, 23][i] + round;
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
```

   with

```js
    s.host.name = c.name;
    s.cpu.usage = [0, 4, 23][i] + round;
    // the nas waits on its disks: low cpu, high iowait and io pressure
    Object.assign(s.cpu, { iowait: [0, 34, 1][i], steal: 0 });
    s.pressure = { cpu: { some: [0, 0.4, 2.1][i], full: 0 }, mem: { some: 0, full: 0 },
                   io: { some: [0, 41.2, 0.3][i], full: [0, 37.5, 0.1][i] } };
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
```

In `test/screens/shoot.js`:

1. Replace

```js
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "containers", "temp"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
```

   with

```js
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "iowait", "temp"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Every word servitals shows comes from one dictionary, `hub/lib/i18n.js`
  (spec 10.3): the dashboard, its settings and the hub's login, blocked and
```

   with

```markdown

### Added
- Waiting shows (spec 9): the cpu panel adds iowait and steal (time the cpu
  sat idle waiting on disk, and time a hypervisor took) and the kernel's
  pressure stall information for cpu, memory and io. A server stuck on its
  disk no longer looks idle at "11% cpu". Fleet cards can show iowait.
  `COLLECT_PRESSURE=0` in `agent.env` turns pressure off.
- Every word servitals shows comes from one dictionary, `hub/lib/i18n.js`
  (spec 10.3): the dashboard, its settings and the hub's login, blocked and
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/screens.sh`
Expected: PASS, 306 tests; the budget passes (agent tick CPU and RSS within limits); `screenshots in /out: no page errors`. In `build/screens/1280-comfortable-node.png` the cpu panel shows "iowait / steal" and "pressure cpu / mem / io"; `fleet-custom.png` shows IOWAIT 34% on the nas card.

Then the packaging checks: `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` (`compose smoke test passed`), `bash packaging/build-deb.sh` (both packages `ok`; `agent/lib/pressure.sh` is installed with the other `agent/lib` files), `bash packaging/autopkgtest.sh` (smoke and purge PASS on both series).

- [ ] **Step 6: Commit**

```bash
git add www/index.html www/app.css www/js/app.js hub/lib/i18n.js test/page.test.js test/screens/demo-hub.js test/screens/shoot.js CHANGELOG.md
git commit -m "feat(ui): the cpu panel shows iowait, steal and pressure; fleet cards can show iowait"
```
