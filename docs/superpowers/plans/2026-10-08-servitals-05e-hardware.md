# servitals Hardware: Fans, Voltages, Battery (sub-project 5e) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "hardware" panel shows fan speeds, voltages and the battery (spec 9), and fleet cards can show the battery. The panel hides on hosts that have none of these.

**Why:** a stopped pump or a failing fan, a sagging 12 V rail, or a UPS-backed board running on its battery are among the first signs of hardware trouble. Spec 9 lists fans, voltages and the battery as metric groups of v1. The hub has validated `fans` and `battery` since protocol 1; `voltages` is new.

**Architecture:**
- **Agent:**
  - A new `agent/lib/hardware.sh` runs one `grep -sH` over every hwmon chip's `name`, `fan*_input/_label` and `in*_input/_label`. It skips unreadable files, and one `LC_ALL=C awk` lists them per chip in numeric order (fan2 before fan10).
  - A fan is reported when it spins or has a label, because boards list empty headers at 0 rpm. A named fan at 0 rpm stays, because it should be spinning.
  - An unlabelled input is named "chip fanN" or "chip inN".
  - Voltages are converted from millivolts to volts.
  - The battery is the first `/sys/class/power_supply/*` that is one (named `BAT*`, or of type `Battery`, not a charger), with `capacity` at most 100 and `status`.
  - `collect.sh` merges `{fans, voltages, battery}` into the snapshot's top level. Each is null when the host has none. `COLLECT_HARDWARE=0` turns it off.
  - It uses `line_of` from `temp.sh`.
- **Hub:** `voltages` joins the schema: at most 32, each `{label ≤ 128, value -1000..1000}`. The fleet summary gains `battery` (its capacity).
- **Page:**
  - The "hardware" panel (key `hw`, normal size, after "system") is built by `hardwareHtml(d)`:
    - the battery, red below 20 % and amber below 40 % while discharging, with its status in words from the dictionary (a status the dictionary lacks is shown escaped, as sent);
    - "fans", with a named fan at 0 rpm in red;
    - "voltages".
  - A separate toggle hides the panel when none of the three is present.
  - `CARD_KEYS` gains `battery`.

**Tech Stack:** bash, `grep`, `awk`, `jq` (agent); Node.js ≥ 18 (hub, tests); vanilla JS (page); Playwright (screenshots).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- section 9: fans and voltages from hwmon `fan*_input` and `in*_input`, the battery from `/sys/class/power_supply/BAT*`; Linux-first; every group degrades;
- 6.3: validation;
- 10.3: every word from the dictionary;
- 18: agent CPU per tick ≤ 400 ms.

**Scope:** 5e, the last part of sub-project 5. The roadmap's Termux battery (`termux-battery-status`) is not part of this plan. Min/max alarms of hwmon inputs are not read.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (1c3d7ff) on 2026-10-08:
- node suite 334 tests, shellcheck, the budget (agent tick 226 ms), `test/screens.sh`;
- the live host (one coretemp chip, no fans, voltages or battery) gives `{"fans":null,"voltages":null,"battery":null}`.

## Global Constraints

- Everything from sub-projects 1-5d and the tick diet still holds: zero runtime dependencies, the strict CSP, every word from `hub/lib/i18n.js`, Node 18 compatibility, SPDX headers, lintian clean.
- The agent tick stays well within 400 ms: one `grep`, one `awk`, one `jq` and no fork per sensor.
- Works with mawk and gawk.
- Labels from the host are escaped where they reach HTML.
- No new `agent.env` line: `COLLECT_HARDWARE` defaults to 1.
- Work in a worktree `.claude/worktrees/servitals-hw` on branch `feat/hw` from `main` (1c3d7ff).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Boards with many empty fan headers, odd readings, and chips without labels:**
   - No phantom fans or 0 V rails.
   - Readable names.
   - Numeric order.

   Tests: Task 1 "hardware_json: fans that spin or have a name…" and "…an odd reading is skipped…".
2. **Power supplies that are not the battery** (AC adapters, USB-C sources with a capacity file): never chosen. Test: Task 1 (an AC supply with capacity 50 sorts before BAT0).
3. **A hostile or broken snapshot:**
   - voltages out of range, or without a value;
   - more than 32.

   Refused with the path, or cut. Test: Task 2 "voltages pass with their label…".
4. **Hosts with none of it, and older agents:** the panel hides, and the card shows a dash. Tests: Task 3 (`hardwareHtml({})` is `""`, the hide toggle), Task 2 (`battery` null).
5. **Hostile labels and battery statuses**: escaped. Test: Task 3 (`CPU <fan>`, `<Odd>`).

---

### Task 1: The agent reports fans, voltages and the battery

**Files:**
- Create: `agent/lib/hardware.sh`
- Modify: `agent/collect.sh`, `test/agent-groups.test.js`, `test/agent.test.js`

**Interfaces:**
- Consumes: `line_of` (`agent/lib/temp.sh`).
- Produces:
  - `hardware_json` → `{fans, voltages, battery}`, each null when absent:
    - `fans`: `[{label, rpm}]`;
    - `voltages`: `[{label, value}]`, in V;
    - `battery`: `{capacity, status}`;
  - their merge into the snapshot's top level under `COLLECT_HARDWARE`.

- [ ] **Step 1: Write the failing tests**

In `test/agent-groups.test.js`:

1. Replace

```js
  assert.deepStrictEqual(d.sensors.find((s) => s.value === 45), { label: "coretemp", value: 45 });
});

```

   with

```js
  assert.deepStrictEqual(d.sensors.find((s) => s.value === 45), { label: "coretemp", value: 45 });
});

test("hardware_json: fans that spin or have a name, voltages in volts, and the battery", () => {
  const host = fakeHost({ ...BASE,
    "sys/class/hwmon/hwmon1/name": "nct6798\n",
    "sys/class/hwmon/hwmon1/fan1_input": "1200\n", "sys/class/hwmon/hwmon1/fan1_label": "CPU fan\n",
    "sys/class/hwmon/hwmon1/fan2_input": "0\n",                                       // an empty header: left out
    "sys/class/hwmon/hwmon1/fan3_input": "0\n", "sys/class/hwmon/hwmon1/fan3_label": "Pump\n", // named and stopped: kept
    "sys/class/hwmon/hwmon1/fan4_input": "860\n",
    "sys/class/hwmon/hwmon1/in0_input": "1216\n", "sys/class/hwmon/hwmon1/in0_label": "Vcore\n",
    "sys/class/hwmon/hwmon1/in1_input": "12096\n",
    "sys/class/power_supply/BAT0/type": "Battery\n", "sys/class/power_supply/BAT0/capacity": "87\n",
    "sys/class/power_supply/BAT0/status": "Discharging\n",
    "sys/class/power_supply/AC/type": "Mains\n", "sys/class/power_supply/AC/capacity": "50\n" });   // not a battery
  assert.deepStrictEqual(json(runGroup(host, "hardware_json")), {
    fans: [{ label: "CPU fan", rpm: 1200 }, { label: "Pump", rpm: 0 }, { label: "nct6798 fan4", rpm: 860 }],
    voltages: [{ label: "Vcore", value: 1.216 }, { label: "nct6798 in1", value: 12.096 }],
    battery: { capacity: 87, status: "Discharging" },
  });
});

test("hardware_json: nothing to read gives nulls; an odd reading is skipped, not a failed tick", () => {
  assert.deepStrictEqual(json(runGroup(fakeHost(BASE), "hardware_json")), { fans: null, voltages: null, battery: null });
  const host = fakeHost({ ...BASE, "sys/class/hwmon/hwmon1/name": "it87\n",
    "sys/class/hwmon/hwmon1/fan1_input": "abc\n", "sys/class/hwmon/hwmon1/in0_input": "\n",
    "sys/class/hwmon/hwmon1/fan2_input": "900\n",
    "sys/class/power_supply/BAT1/capacity": "140\n", "sys/class/power_supply/BAT1/status": "Full\n" });
  assert.deepStrictEqual(json(runGroup(host, "hardware_json")),
    { fans: [{ label: "it87 fan2", rpm: 900 }], voltages: null, battery: { capacity: 100, status: "Full" } }, "capacity at most 100");
});

```

In `test/agent.test.js`:

1. Replace

```js
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0",
           COLLECT_PROCESSES: "0", COLLECT_UBUNTU: "0" },
    timeout: 30000,
  });
```

   with

```js
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0",
           COLLECT_PROCESSES: "0", COLLECT_UBUNTU: "0",
           COLLECT_HARDWARE: "0" },
    timeout: 30000,
  });
```

2. Replace

```js
  assert.strictEqual(d.processes, null);
  assert.strictEqual(d.ubuntu, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

   with

```js
  assert.strictEqual(d.processes, null);
  assert.strictEqual(d.ubuntu, null);
  for (const k of ["fans", "voltages", "battery"]) assert.strictEqual(d[k], null, k);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL, 3 tests:
- the two `hardware_json` tests (`bash: line 1: hardware_json: command not found`);
- "COLLECT_<GROUP>=0 turns a group off" (`fans` is missing, not null).

- [ ] **Step 3: The group**

Create `agent/lib/hardware.sh`:

```bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# hardware: fan speeds and voltages from every hwmon chip, and the battery. One
# grep over the chips' files (a file that cannot be read is skipped) and one awk.
# A fan is reported when it spins or has a name: boards list empty headers at 0 rpm.
# Each part is null when the host has none (most servers have no battery; many
# chips need a driver that sensors-detect loads).

hardware_json() {
  local hw=$HOST/sys/class/hwmon rows bat="" b cap="" st=""
  rows=$(grep -sH '' "$hw"/hwmon*/name "$hw"/hwmon*/fan*_input "$hw"/hwmon*/fan*_label \
           "$hw"/hwmon*/in*_input "$hw"/hwmon*/in*_label 2>/dev/null | LC_ALL=C awk '
    {
      i = index($0, ":"); path = substr($0, 1, i - 1); val = substr($0, i + 1)
      n = split(path, part, "/"); file = part[n]; dir = substr(path, 1, length(path) - length(file) - 1)
      if (!(dir in seen)) { seen[dir] = 1; dirs[++nd] = dir }
      if (file == "name") { name[dir] = val; next }
      if (match(file, /^(fan|in)[0-9]+_(input|label)$/)) {
        kind = (substr(file, 1, 3) == "fan") ? "fan" : "in"
        num = substr(file, length(kind) + 1) + 0
        if (num > top[dir, kind]) top[dir, kind] = num
        if (file ~ /_label$/) label[dir, kind, num] = val; else value[dir, kind, num] = val
      }
    }
    END {
      for (d = 1; d <= nd; d++) {
        dir = dirs[d]
        for (kind_i = 1; kind_i <= 2; kind_i++) {
          kind = kind_i == 1 ? "fan" : "in"
          for (k = 0; k <= top[dir, kind]; k++) {
            if (!((dir, kind, k) in value) || value[dir, kind, k] !~ /^-?[0-9]+$/) continue
            l = ((dir, kind, k) in label) ? label[dir, kind, k] : name[dir] " " kind k
            gsub(/\t/, " ", l)
            if (kind == "fan") { if (value[dir, kind, k] > 0 || ((dir, kind, k) in label)) print "fan\t" l "\t" value[dir, kind, k] + 0 }
            else printf "volt\t%s\t%.3f\n", l, value[dir, kind, k] / 1000
          }
        }
      }
    }')
  # the battery: the first power supply that is one (type Battery, or named BAT*)
  for b in "$HOST"/sys/class/power_supply/*; do
    [ -r "$b/capacity" ] || continue
    line_of "$b/type"   # line_of: agent/lib/temp.sh
    case ${b##*/} in BAT*) ;; *) [ "$REPLY" = Battery ] || continue ;; esac
    line_of "$b/capacity"; cap=$REPLY; line_of "$b/status"; st=$REPLY
    [[ $cap =~ ^[0-9]+$ ]] && { bat=1; break; }
  done
  jq -R -s -c --arg bat "$bat" --arg cap "$cap" --arg st "$st" '
    [split("\n")[] | select(length > 0) | split("\t")] as $r
    | ([$r[] | select(.[0] == "fan") | {label: .[1], rpm: (.[2] | tonumber)}]) as $fans
    | ([$r[] | select(.[0] == "volt") | {label: .[1], value: (.[2] | tonumber)}]) as $volts
    | {fans: (if $fans == [] then null else $fans[:32] end),
       voltages: (if $volts == [] then null else $volts[:32] end),
       battery: (if $bat == "1" then {capacity: ([($cap | tonumber), 100] | min), status: $st[:16]} else null end)}' <<< "$rows"
}
```

In `agent/collect.sh`:

1. Replace

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null processes=null ubuntu=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

   with

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null processes=null ubuntu=null hardware=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

2. Replace

```bash
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

   with

```bash
  if on "${COLLECT_PROCESSES:-1}"; then group processes processes_json; fi
  if on "${COLLECT_UBUNTU:-1}"; then group ubuntu ubuntu_json; fi
  if on "${COLLECT_HARDWARE:-1}"; then group hardware hardware_json; fi

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson io "$io" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson processes "$processes" --argjson ubuntu "$ubuntu" --argjson hardware "$hardware" --argjson pressure "$pressure" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, pressure: $pressure, temp: $temp,
      disks: $disks, io: $io, net: $net, docker: $docker, processes: $processes, ubuntu: $ubuntu}
      + ($hardware // {fans: null, voltages: null, battery: null})' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}
```

- [ ] **Step 4: Run the tests and look at this host**

Run: `node --test test/*.test.js && HOST=/ bash -c 'for f in agent/lib/*.sh; do . "$f"; done; hardware_json'`
Expected: PASS, 332 tests. Then the host's fans, voltages and battery, or nulls on a host without them.

Run: `pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh && bash test/budget.sh`
Expected: shellcheck prints nothing; `ok    agent tick CPU (user+sys)` well below 400 ms.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/hardware.sh agent/collect.sh test/agent-groups.test.js test/agent.test.js
git commit -m "feat(agent): fan speeds, voltages and the battery"
```

---

### Task 2: The hub validates voltages; fleet cards can use the battery

**Files:**
- Modify: `hub/lib/snapshot.js`, `hub/lib/fleet.js`, `docs/protocol.md`, `test/snapshot.test.js`, `test/fleet.test.js`

**Interfaces:**
- Consumes: the snapshot's `voltages` and `battery` (Task 1).
- Produces:
  - validated `voltages` (≤ 32 of `{label ≤ 128, value -1000..1000}`);
  - `summary(view).battery`, the capacity or null.

- [ ] **Step 1: Write the failing tests**

In `test/snapshot.test.js`:

1. Replace

```js
  assert.strictEqual(r.value.processes.mem[0].cpuPct, null);
  assert.deepStrictEqual(validate(base({ processes: { cpu: [p(1, { rss: -1 })] } })), { ok: false, path: "$.processes.cpu[0].rss" });
});

```

   with

```js
  assert.strictEqual(r.value.processes.mem[0].cpuPct, null);
  assert.deepStrictEqual(validate(base({ processes: { cpu: [p(1, { rss: -1 })] } })), { ok: false, path: "$.processes.cpu[0].rss" });
});

test("voltages pass with their label; fans and the battery as before", () => {
  const r = validate(base({ voltages: [{ label: "Vcore", value: 1.216 }, { label: "-12V", value: -11.9 }],
    fans: [{ label: "CPU fan", rpm: 1200 }], battery: { capacity: 87, status: "Discharging" } }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.value.voltages, [{ label: "Vcore", value: 1.216 }, { label: "-12V", value: -11.9 }]);
  assert.deepStrictEqual(validate(base({ voltages: [{ label: "x", value: 5000 }] })), { ok: false, path: "$.voltages[0].value" });
  assert.deepStrictEqual(validate(base({ voltages: [{ label: "x" }] })), { ok: false, path: "$.voltages[0].value" });
  assert.strictEqual(validate(base({ voltages: Array.from({ length: 40 }, () => ({ label: "v", value: 1 })) })).value.voltages.length, 32);
});

```

In `test/fleet.test.js`:

1. Replace

```js
  assert.deepStrictEqual([summary({ ubuntu: { updates: 3, rebootRequired: true } }).updates, summary({ ubuntu: { updates: 3, rebootRequired: true } }).reboot], [3, true]);
  assert.deepStrictEqual([summary({}).updates, summary({}).reboot], [null, false]);
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
```

   with

```js
  assert.deepStrictEqual([summary({ ubuntu: { updates: 3, rebootRequired: true } }).updates, summary({ ubuntu: { updates: 3, rebootRequired: true } }).reboot], [3, true]);
  assert.deepStrictEqual([summary({}).updates, summary({}).reboot], [null, false]);
  assert.deepStrictEqual([summary({ battery: { capacity: 87, status: "Discharging" } }).battery, summary({}).battery], [87, null]);
  assert.strictEqual(s.trend.length, 20);
  assert.strictEqual(summary(null), null);
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/snapshot.test.js test/fleet.test.js`
Expected: FAIL, 2 tests:
- "voltages pass with their label…" (the unknown key is dropped);
- "a card's numbers come from the view" (no `battery`).

- [ ] **Step 3: The schema, the summary and the protocol**

In `hub/lib/snapshot.js`:

1. Replace

```js
      label: str(o.label, 128, `${q}.label`), rpm: num(o.rpm, 0, 1e6, `${q}.rpm`, { optional: false }),
    }), { optional: false })),
    battery: obj(s.battery, "$.battery", (b, p) => clean({
      capacity: num(b.capacity, 0, 100, `${p}.capacity`), status: str(b.status, 16, `${p}.status`),
```

   with

```js
      label: str(o.label, 128, `${q}.label`), rpm: num(o.rpm, 0, 1e6, `${q}.rpm`, { optional: false }),
    }), { optional: false })),
    voltages: list(s.voltages, 32, "$.voltages", (x, q) => obj(x, q, (o) => clean({
      label: str(o.label, 128, `${q}.label`), value: num(o.value, -1000, 1000, `${q}.value`, { optional: false }),
    }), { optional: false })),
    battery: obj(s.battery, "$.battery", (b, p) => clean({
      capacity: num(b.capacity, 0, 100, `${p}.capacity`), status: str(b.status, 16, `${p}.status`),
```

In `hub/lib/fleet.js`:

1. Replace

```js
    updates: v.ubuntu && typeof v.ubuntu.updates === "number" ? v.ubuntu.updates : null,
    reboot: !!(v.ubuntu && v.ubuntu.rebootRequired),
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
```

   with

```js
    updates: v.ubuntu && typeof v.ubuntu.updates === "number" ? v.ubuntu.updates : null,
    reboot: !!(v.ubuntu && v.ubuntu.rebootRequired),
    battery: v.battery && typeof v.battery.capacity === "number" ? v.battery.capacity : null,
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
```

In `docs/protocol.md`:

1. Replace

```markdown
            "sensors": [ { "label": "Package id 0", "value": 46 } ] }, // ≤ 64
  "fans": [ { "label": "fan1", "rpm": 1200 } ],                     // ≤ 32
  "battery": { "capacity": 87, "status": "Discharging" },           // % 0..100, status ≤ 16
  "disks": [ { "mount": "/srv", "mounted": true, "source": "/dev/sdb1",
```

   with

```markdown
            "sensors": [ { "label": "Package id 0", "value": 46 } ] }, // ≤ 64
  "fans": [ { "label": "fan1", "rpm": 1200 } ],                     // ≤ 32
  "voltages": [ { "label": "Vcore", "value": 1.216 } ],             // V, -1000..1000, ≤ 32
  "battery": { "capacity": 87, "status": "Discharging" },           // % 0..100, status ≤ 16
  "disks": [ { "mount": "/srv", "mounted": true, "source": "/dev/sdb1",
```

2. Replace

```markdown
  it cannot ask (a container agent, no bus, no answer within 5 s). The group
  is null on a host with neither dpkg nor the agent's own systemd.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

   with

```markdown
  it cannot ask (a container agent, no bus, no answer within 5 s). The group
  is null on a host with neither dpkg nor the agent's own systemd.
- `fans`, `voltages` and `battery` are null on a host without them. A fan is
  listed when it spins or has a name (boards list empty headers at 0 rpm).
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 333 tests.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/snapshot.js hub/lib/fleet.js docs/protocol.md test/snapshot.test.js test/fleet.test.js
git commit -m "feat(hub): voltages in the snapshot; fleet cards can use the battery"
```

---

### Task 3: The hardware panel and the battery card

**Files:**
- Modify: `www/index.html`, `www/app.css`, `www/js/app.js`, `hub/lib/i18n.js`, `test/page.test.js`, `test/screens/demo-hub.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the snapshot's `fans`, `voltages` and `battery`, and `summary.battery` (Tasks 1-2).
- Produces:
  - panel `hw` (in `DEFAULTS.panels`; `panelOrder` after `system`; `panelSize` normal);
  - `hardwareHtml(d)`;
  - `CARD_KEYS` gains `battery`;
  - dictionary keys `panel.hw`, `hw.*`, `card.battery`, `set.card.battery`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
```

   with

```js
});

test("the hardware panel: the battery, fans (a named one stopped is red) and voltages; names escaped", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const { STRINGS } = require("../hub/lib/i18n");
  const hardwareHtml = pageFn("hardwareHtml", { esc, STRINGS });
  const html = hardwareHtml({ battery: { capacity: 15, status: "Discharging" },
    fans: [{ label: "CPU <fan>", rpm: 1200 }, { label: "Pump", rpm: 0 }], voltages: [{ label: "Vcore", value: 1.216 }] });
  assert.strictEqual(html,
    '<div class="row"><span class="k">battery</span><span class="v"><span class="hl-red">15%</span> · discharging</span></div>'
    + '<div class="plbl">fans</div>'
    + '<div class="row"><span class="k">CPU &#60;fan&#62;</span><span class="v">1200 rpm</span></div>'
    + '<div class="row"><span class="k">Pump</span><span class="v"><span class="hl-red">0 rpm</span></span></div>'
    + '<div class="plbl">voltages</div>'
    + '<div class="row"><span class="k">Vcore</span><span class="v">1.22 V</span></div>');
  assert.match(hardwareHtml({ battery: { capacity: 30, status: "Charging" } }), /<span class="">30%<\/span> · charging/, "charging: never red");
  assert.match(hardwareHtml({ battery: { capacity: 80, status: "<Odd>" } }), /80%<\/span> · &#60;Odd&#62;/, "a status the dictionary lacks: as sent, escaped");
  assert.strictEqual(hardwareHtml({}), "");
  assert.match(HTML, /data-panel="hw"/);
  assert.match(HTML, /\$\("\[data-panel=hw\]"\)\.classList\.toggle\("hidden", !\(d\.fans \|\| d\.voltages \|\| d\.battery\) \|\| shown\.hw === false\);/);
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates", "battery"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
```

2. Replace

```js
  assert.deepStrictEqual([cardValue("updates", { updates: 12, reboot: true }), cardValue("updates", { updates: 0, reboot: false }),
    cardValue("updates", { updates: null, reboot: true }), cardValue("updates", {})], ["12 ↻", "0", "↻", "–"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
```

   with

```js
  assert.deepStrictEqual([cardValue("updates", { updates: 12, reboot: true }), cardValue("updates", { updates: 0, reboot: false }),
    cardValue("updates", { updates: null, reboot: true }), cardValue("updates", {})], ["12 ↻", "0", "↻", "–"]);
  assert.deepStrictEqual([cardValue("battery", { battery: 87 }), cardValue("battery", { battery: null })], ["87%", "–"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
```

3. Replace

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

   with

```js
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 3 tests:
- "the hardware panel…" (`ReferenceError: hardwareHtml is not defined`);
- "conf.d review: a file with a few panels…" (`panelOrder` lacks `hw`);
- "fleet cards show the numbers chosen in settings" (no `"battery"` in `CARD_KEYS`).

- [ ] **Step 3: The panel and the card**

In `www/index.html`:

1. Replace

```html
      <div class="row"><span class="k" data-i18n="sys.failed">failed units</span><span class="v" id="sys-failed">--</span></div>
      <div class="sysunits" id="sys-units"></div>
    </div>

```

   with

```html
      <div class="row"><span class="k" data-i18n="sys.failed">failed units</span><span class="v" id="sys-failed">--</span></div>
      <div class="sysunits" id="sys-units"></div>
    </div>

    <div class="panel" data-panel="hw">
      <h2 data-i18n="panel.hw">hardware</h2>
      <div id="hw-body"></div>
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

// the hardware panel: the battery (red or amber when low and draining), fans (one the
// agent lists at 0 rpm has a name, so it should spin: red) and voltages
function hardwareHtml(d) {
  const row = (k, v) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  let h = "";
  if (d.battery) {
    const b = d.battery, draining = b.status === "Discharging";
    const cls = draining && b.capacity < 20 ? "hl-red" : draining && b.capacity < 40 ? "hl-amber" : "";
    // the kernel's words (Charging, Not charging...) in the dictionary; others as sent
    const word = String(b.status || "").toLowerCase().replace(/ /g, "");
    const status = b.status ? " · " + esc(STRINGS["hw.bat." + word] ? tr("hw.bat." + word) : b.status) : "";
    h += row(tr("hw.battery"), `<span class="${cls}">${b.capacity}%</span>${status}`);
  }
  if (d.fans && d.fans.length) {
    h += `<div class="plbl">${esc(tr("hw.fans"))}</div>` + d.fans.map(f => row(f.label,
      f.rpm > 0 ? esc(tr("hw.rpm", { n: f.rpm })) : `<span class="hl-red">${esc(tr("hw.rpm", { n: f.rpm }))}</span>`)).join("");
  }
  if (d.voltages && d.voltages.length) {
    h += `<div class="plbl">${esc(tr("hw.voltages"))}</div>` + d.voltages.map(v => row(v.label, esc(tr("hw.volts", { v: v.value.toFixed(2) })))).join("");
  }
  return h;
}

function meter(pct, forceCls) {
  pct = clamp(pct, 0, 100);
```

2. Replace

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

   with

```js
    title: "servitals", favicon: "", refreshSec: 60,
    weather: [], clocks: [], disks: {},
    panels: { mem: 1, cpu: 1, temp: 1, storage: 1, network: 1, docker: 1, procs: 1, system: 1, hw: 1, clocks: 1, weather: 1 },
    panelOrder: ["mem", "cpu", "temp", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"],
    panelSize: { mem: "normal", cpu: "normal", temp: "normal", storage: "wide",
                 network: "wide", docker: "full", procs: "wide", system: "normal", hw: "normal", clocks: "normal", weather: "normal" }
  };
  // a conf.d file may set only a few panels: the others keep their built-in values
```

3. Replace

```js
}
// the numbers a fleet card can show; their labels are card.<key> in the dictionary
const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates"];
function cardValue(k, s) {
  if (k === "cpu" || k === "mem" || k === "iowait") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
```

   with

```js
}
// the numbers a fleet card can show; their labels are card.<key> in the dictionary
const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates", "battery"];
function cardValue(k, s) {
  if (k === "cpu" || k === "mem" || k === "iowait" || k === "battery") return fmtVal(s[k], "%");
  if (k === "temp") return fmtTemp(s.temp, true);
  if (k === "disk") return s.disk ? s.disk.pct + "%" : "–";
```

4. Replace

```js
  }

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;
```

   with

```js
  }

  // hardware: fans, voltages, the battery (most servers have some of these, many none)
  $("#hw-body").innerHTML = hardwareHtml(d);

  // docker — stash and render (sort / expand handled separately)
  if (d.docker) { dockerData = d.docker; renderDocker(); } else dockerData = null;
```

5. Replace

```js
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
  }
}

```

   with

```js
    if (el) el.classList.toggle("hidden", !d[group] || shown[panel] === false);
  }
  $("[data-panel=hw]").classList.toggle("hidden", !(d.fans || d.voltages || d.battery) || shown.hw === false);
}

```

In `hub/lib/i18n.js`:

1. Replace

```js
  "panel.procs": "processes",
  "panel.system": "system",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

   with

```js
  "panel.procs": "processes",
  "panel.system": "system",
  "panel.hw": "hardware",
  "panel.clocks": "world clocks",
  "panel.weather": "weather",
```

2. Replace

```js
  "sys.none": "none",

  // dialogs
  "dlg.close": "[esc]",
```

   with

```js
  "sys.none": "none",

  // hardware: fans, voltages, battery
  "hw.battery": "battery",
  "hw.fans": "fans",
  "hw.voltages": "voltages",
  "hw.rpm": "{n} rpm",
  "hw.volts": "{v} V",
  "hw.bat.charging": "charging",
  "hw.bat.discharging": "discharging",
  "hw.bat.full": "full",
  "hw.bat.notcharging": "not charging",
  "hw.bat.unknown": "unknown",

  // dialogs
  "dlg.close": "[esc]",
```

3. Replace

```js
  "card.iowait": "iowait",
  "card.updates": "updates",

  // clocks and weather
```

   with

```js
  "card.iowait": "iowait",
  "card.updates": "updates",
  "card.battery": "battery",

  // clocks and weather
```

4. Replace

```js
  "set.card.iowait": "iowait (waiting on disk)",
  "set.card.updates": "updates (↻ reboot needed)",
  "set.serversHint": "name and tags save at once; pin and hide with the other settings",
  "set.srvName": "name of {name}",
```

   with

```js
  "set.card.iowait": "iowait (waiting on disk)",
  "set.card.updates": "updates (↻ reboot needed)",
  "set.card.battery": "battery",
  "set.serversHint": "name and tags save at once; pin and hide with the other settings",
  "set.srvName": "name of {name}",
```

In `www/app.css`:

1. Replace

```css
/* processes: two columns (one on a phone); a long name is cut, never widens the panel */
.procs { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 22px; }
.procs .plbl { color: var(--dim); font-size: 11px; letter-spacing: .06em; margin-bottom: 4px; }
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sysunits { color: var(--dim); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
```

   with

```css
/* processes: two columns (one on a phone); a long name is cut, never widens the panel */
.procs { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 22px; }
.procs .plbl, #hw-body .plbl { color: var(--dim); font-size: 11px; letter-spacing: .06em; margin-bottom: 4px; }
#hw-body .plbl { margin-top: 10px; }
.procs .pname { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sysunits { color: var(--dim); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
```

- [ ] **Step 4: The screenshots show fans, voltages and a battery**

In `test/screens/demo-hub.js`:

1. Replace

```js
    s.ubuntu = i === 1 ? { updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-image-7.0.0-38-generic"],
                           failedUnits: ["smartd.service"] } : undefined;
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
```

   with

```js
    s.ubuntu = i === 1 ? { updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-image-7.0.0-38-generic"],
                           failedUnits: ["smartd.service"] } : undefined;
    // the nas: its board's fans (the pump has stopped) and voltages; the pi runs on a battery
    s.fans = i === 1 ? [{ label: "CPU fan", rpm: 1180 }, { label: "Case fan 1", rpm: 820 }, { label: "Pump", rpm: 0 }] : undefined;
    s.voltages = i === 1 ? [{ label: "Vcore", value: 1.216 }, { label: "+12V", value: 12.096 }, { label: "+5V", value: 5.04 }] : undefined;
    s.battery = i === 2 ? { capacity: 64, status: "Discharging" } : undefined;
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
```

In `test/screens/shoot.js`:

1. Replace

```js
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "iowait", "updates"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
```

   with

```js
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "iowait", "updates", "battery"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- System (spec 9): a new panel shows pending and security updates (as
  update-notifier counted them; the agent never runs apt), whether the system
```

   with

```markdown

### Added
- Hardware (spec 9): a new panel shows fan speeds (a named fan that stopped
  in red), voltages and the battery, from hwmon and
  `/sys/class/power_supply`; it hides on hosts with none. Fleet cards can
  show the battery. `COLLECT_HARDWARE=0` turns it off.
- System (spec 9): a new panel shows pending and security updates (as
  update-notifier counted them; the agent never runs apt), whether the system
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/screens.sh`
Expected: PASS, 334 tests; the budget passes; `screenshots in /out: no page errors`. Check two screenshots:
- `build/screens/1280-comfortable-nas.png`: the hardware panel shows "fans" (CPU fan 1180 rpm, Case fan 1 820 rpm, Pump 0 rpm in red) and "voltages" (Vcore 1.22 V, +12V 12.10 V, +5V 5.04 V);
- `fleet-custom.png`: a BATTERY 64% on pi-garage.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` (`compose smoke test passed`);
- `bash packaging/build-deb.sh` (both packages `ok`);
- `bash packaging/autopkgtest.sh` (smoke and purge PASS).

- [ ] **Step 6: Commit**

```bash
git add www/index.html www/app.css www/js/app.js hub/lib/i18n.js test/page.test.js test/screens/demo-hub.js test/screens/shoot.js CHANGELOG.md
git commit -m "feat(ui): a hardware panel: the battery, fans and voltages; fleet cards can show the battery"
```
