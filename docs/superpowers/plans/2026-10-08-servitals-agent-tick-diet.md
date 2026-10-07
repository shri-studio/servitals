# servitals Agent Tick Diet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the agent's CPU per tick back down before 5e adds more groups. Output stays identical.

**Why:** After 5a-5d the tick measured 283-292 ms alone, and 395 ms under load, against the 400 ms budget (spec 18). A profile on the live host found the two groups that start processes in loops:
- `disks_json` took about 150 ms for four disks, at about 11 processes per disk:
  - `echo | xargs` to trim each DISKS entry;
  - one `awk` per mountpoint over mountinfo;
  - `cat | xargs` for the model, and `cat` for rotational;
  - `basename` and `readlink` for a partition's parent.
- `temp_json` took about 50 ms for five sensors: a `cat` per label and an `awk` per value.

**Architecture:** Both groups move from per-item processes to bash builtins and a single pass.
- **disks_json:**
  - Trims each DISKS entry with parameter expansion.
  - `mount_infos` makes one `awk` pass over mountinfo for every wanted mountpoint (the last line per mountpoint still wins) into an associative array. It replaces `mount_info`, which only `disks_json` used.
  - Reads the model with `read -ra` and joins the words with one space, as `xargs` did.
  - Reads rotational with `read`.
  - Resolves a partition's parent with one `readlink -f` and `${link##*/}`.
  - Keeps only the bounded `timeout stat` per disk and the device `readlink`.
- **temp_json:**
  - `line_of` reads a file's first line into REPLY.
  - `deg_of` converts millidegrees to whole degrees in bash, rounding exactly as `printf "%.0f"` does (half to even).
  - Unreadable labels still fall back to the chip's name, and zone types to "zone".

**Tech Stack:** bash (agent), Node.js ≥ 18 (tests).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` section 18 (agent CPU per tick ≤ 400 ms, agent RSS ≤ 10 MB) and section 9 (every group degrades; output unchanged).

**Scope:** No change in what the agent reports. Two characterization tests pin behaviour that no test covered before; they pass before and after. Other groups are already lean (docker: one curl, two jq; processes: one grep, one awk, one jq).

**Proven before writing:** on 2026-10-08, a scratch copy of `main` (3414cd7) gave:
- node suite 328 tests and shellcheck pass;
- `disks_json` about 150 ms down to 75 ms, and `temp_json` about 50 ms down to 10 ms;
- the budget's tick 214-219 ms, down from 283-292 ms;
- the live host's `disks_json` and `temp_json` output identical to `main`'s.

## Global Constraints

- Output identical to before for every input the tests and the live host cover: the same JSON from each group.
- Works under mawk and gawk, and under `set -uo pipefail` (collect.sh).
- Everything from sub-projects 1-5d still holds: zero runtime dependencies, Linux-first, every group degrades, SPDX headers, shellcheck clean.
- Work in a worktree `.claude/worktrees/servitals-tick` on branch `perf/tick` from `main` (3414cd7).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Output drift**:
   - trimming (spaces, tabs, a DISKS list like "/, /srv");
   - model whitespace;
   - a partition against a whole disk;
   - rounding at .5;
   - negative temperatures;
   - an unreadable label.

   Tests: "disks_json reads a partition's disk model…", "temp_json rounds millidegrees as printf %.0f does…" and every earlier disks and temp test.
2. **The last mountinfo line per mountpoint** (cifs over autofs). Test: "a stacked mount reports the top of the stack".
3. **A mountpoint that is not mounted, or a DISKS entry with only spaces**: "not mounted" and skipped, as before. Tests: "DISKS entries that are not mountpoints say so", "disks_json reports each DISKS entry…".
4. **A dead network share**: still bounded by `timeout`. Tests: "a hung statvfs is cut off", "a statvfs that ignores SIGTERM is killed".
5. **The budget itself**. Test: `test/budget.sh` (agent tick CPU).

---

### Task 1: disks without a process per entry

**Files:**
- Modify: `agent/lib/disks.sh`, `test/agent-groups.test.js`

**Interfaces:**
- Produces: `mount_infos LIST` (mountpoints one per line → `mountpoint<TAB>fstype source maj:min`), which replaces `mount_info`. `disks_json` output is unchanged.

- [ ] **Step 1: Pin the model and kind reading**

In `test/agent-groups.test.js`:

1. Replace

```js
  assert.strictEqual(json(runGroup(one, "ubuntu_json")).security, 1);
});

```

   with

```js
  assert.strictEqual(json(runGroup(one, "ubuntu_json")).security, 1);
});

test("disks_json reads a partition's disk model and kind from sysfs, its words joined by one space", () => {
  const host = fakeHost({ ...BASE, "sys/class/block/sdb/device/model": "  WD   Red  Plus \n", "sys/class/block/sdb/queue/rotational": "1\n",
    "sys/class/block/sdb/sdb1/partition": "1\n", "sys/class/block/sda/device/model": "PNY\n", "sys/class/block/sda/queue/rotational": "0\n" });
  fs.symlinkSync("sdb/sdb1", path.join(host, "sys/class/block/sdb1"));
  const d = json(runGroup(host, "disks_json", { DISKS: "/srv" }));
  assert.deepStrictEqual([d[0].model, d[0].rotational], ["WD Red Plus", true]);
});

```

- [ ] **Step 2: Run it before the change**

Run: `node --test test/agent-groups.test.js`
Expected: PASS. It pins behaviour that no test covered before; it must stay green through the change.

- [ ] **Step 3: One mountinfo pass, builtins for the rest**

In `agent/lib/disks.sh`:

1. Replace

```bash
# read and written by the block devices behind them, from /proc/diskstats

mount_info() {  # $1 = mountpoint -> "fstype source maj:min" of its LAST mountinfo line
  # A mountpoint can appear several times (cifs stacked on autofs); the last
  # line is the mount on top, the one a path lookup reaches.
  awk -v m="$1" '$5 == m { for (i = 7; i <= NF; i++) if ($i == "-") { v = $(i+1) " " $(i+2) " " $3; break } }
    END { if (v != "") print v }' "$HOST/proc/1/mountinfo" 2>/dev/null
}

```

   with

```bash
# read and written by the block devices behind them, from /proc/diskstats

mount_infos() {  # $1 = mountpoints, one per line -> "mountpoint<TAB>fstype source maj:min" each
  # One pass for all of them. A mountpoint can appear several times (cifs stacked
  # on autofs); its LAST line is the mount on top, the one a path lookup reaches.
  awk -v list="$1" '
    BEGIN { n = split(list, ms, "\n"); for (i = 1; i <= n; i++) want[ms[i]] = 1 }
    $5 in want { for (i = 7; i <= NF; i++) if ($i == "-") { v[$5] = $(i+1) " " $(i+2) " " $3; break } }
    END { for (m in v) print m "\t" v[m] }' "$HOST/proc/1/mountinfo" 2>/dev/null
}

```

2. Replace

```bash

disks_json() {
  local lines="" m p info fstype src majmin link dev base parent model rota
  local bs blocks bfree bavail size used avail pct t="${STAT_TIMEOUT:-5}"
  [[ $t =~ ^[0-9]+$ ]] && [ "$t" -ge 1 ] || t=5
  local list=$DISKS
  if [ "$list" = auto ]; then list=$(auto_disks); fi
  IFS=',' read -ra MS <<< "$list"
  for m in "${MS[@]}"; do
    m=$(echo "$m" | xargs)
    [ -n "$m" ] || continue
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    info=$(mount_info "$m")
    if [ -z "$info" ]; then
      # not a mountpoint: say so instead of reporting the parent filesystem
```

   with

```bash

disks_json() {
  local lines="" m p info fstype src majmin link dev base parent model rota k v
  local bs blocks bfree bavail size used avail pct t="${STAT_TIMEOUT:-5}"
  [[ $t =~ ^[0-9]+$ ]] && [ "$t" -ge 1 ] || t=5
  local list=$DISKS
  if [ "$list" = auto ]; then list=$(auto_disks); fi
  # each entry trimmed in bash (no fork per disk), then one mountinfo pass for all
  local -a MS=() words=()
  local -A info_of=()
  IFS=',' read -ra words <<< "$list"
  for m in "${words[@]}"; do
    m="${m#"${m%%[![:space:]]*}"}"; m="${m%"${m##*[![:space:]]}"}"
    [ -n "$m" ] && MS+=("$m")
  done
  while IFS=$'\t' read -r k v; do info_of[$k]=$v; done < <(mount_infos "$(printf '%s\n' "${MS[@]}")")
  for m in "${MS[@]}"; do
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    info=${info_of[$m]-}
    if [ -z "$info" ]; then
      # not a mountpoint: say so instead of reporting the parent filesystem
```

3. Replace

```bash
      base=${src#/dev/}
      if [ -e "$HOST/sys/class/block/$base/partition" ]; then
        parent=$(basename "$(readlink -f "$HOST/sys/class/block/$base/.." 2>/dev/null)")
      else
        parent=$base
      fi
      model=$(cat "$HOST/sys/class/block/$parent/device/model" 2>/dev/null | xargs || true)
      rota=$(cat "$HOST/sys/class/block/$parent/queue/rotational" 2>/dev/null || echo "")
    fi
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\t'"$dev"$'\n'
```

   with

```bash
      base=${src#/dev/}
      if [ -e "$HOST/sys/class/block/$base/partition" ]; then
        link=$(readlink -f "$HOST/sys/class/block/$base/.." 2>/dev/null); parent=${link##*/}
      else
        parent=$base
      fi
      # read, not cat: no fork; the words joined with one space, as xargs did
      words=(); { read -ra words < "$HOST/sys/class/block/$parent/device/model"; } 2>/dev/null; model="${words[*]}"
      { read -r rota < "$HOST/sys/class/block/$parent/queue/rotational"; } 2>/dev/null || rota=""
    fi
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\t'"$dev"$'\n'
```

- [ ] **Step 4: Run the tests, compare with main on this host, measure**

Run: `node --test test/*.test.js`
Expected: PASS, 327 tests.

Run: `diff <(HOST=/ DISKS=auto bash -c 'for f in agent/lib/*.sh; do . "$f"; done; disks_json' | jq -S 'map(del(.used,.avail,.pct))') <(git show 3414cd7:agent/lib/disks.sh > /tmp/disks-main.sh; HOST=/ DISKS=auto bash -c 'for f in agent/lib/*.sh; do . "$f"; done; . /tmp/disks-main.sh; disks_json' | jq -S 'map(del(.used,.avail,.pct))') && echo SAME`
Expected: `SAME`. The used, avail and pct fields can move between the two runs, so they are left out.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/disks.sh test/agent-groups.test.js
git commit -m "perf(agent): disks without a fork per entry: one mountinfo pass, sysfs read by read"
```

---

### Task 2: temperatures without a process per sensor

**Files:**
- Modify: `agent/lib/temp.sh`, `test/agent-groups.test.js`

**Interfaces:**
- Produces: `line_of FILE` and `deg_of FILE` (both set REPLY) in `agent/lib/temp.sh`. `temp_json` output is unchanged.

- [ ] **Step 1: Pin the rounding and the labels**

In `test/agent-groups.test.js`:

1. Replace

```js
  assert.deepStrictEqual([d[0].model, d[0].rotational], ["WD Red Plus", true]);
});

```

   with

```js
  assert.deepStrictEqual([d[0].model, d[0].rotational], ["WD Red Plus", true]);
});

test("temp_json rounds millidegrees as printf %.0f does (half to even), and keeps a label's inner spaces", () => {
  const host = fakeHost({ ...BASE,
    "sys/class/hwmon/hwmon0/temp1_input": "46500\n", "sys/class/hwmon/hwmon0/temp1_label": "Package id 0\n",
    "sys/class/hwmon/hwmon0/temp2_input": "47500\n", "sys/class/hwmon/hwmon0/temp2_label": "Core 0\n",
    "sys/class/hwmon/hwmon0/temp3_input": "-5500\n", "sys/class/hwmon/hwmon0/temp3_label": "Core 1\n",
    "sys/class/hwmon/hwmon0/temp4_input": "51499\n" });
  const d = json(runGroup(host, "temp_json"));
  assert.deepStrictEqual(d.sensors.map((s) => [s.label, s.value]),
    [["Package id 0", 46], ["Core 0", 48], ["Core 1", -6], ["coretemp", 51]], "no label: the chip's name");
});

```

- [ ] **Step 2: Run it before the change**

Run: `node --test test/agent-groups.test.js`
Expected: PASS (awk's `printf "%.0f"` rounds half to even: 46.5 → 46, 47.5 → 48, -5.5 → -6).

- [ ] **Step 3: Builtins instead of cat and awk**

In `agent/lib/temp.sh`:

1. Replace

```bash
in_range() { [[ $1 =~ ^-?[0-9]+$ ]] && [ "$1" -ge -50 ] && [ "$1" -le 150 ]; }

temp_json() {
  # every sensor chip the kernel exposes, as "chip<TAB>label<TAB>value" lines
```

   with

```bash
in_range() { [[ $1 =~ ^-?[0-9]+$ ]] && [ "$1" -ge -50 ] && [ "$1" -le 150 ]; }

# the first line of a file into REPLY, as it is (no fork: no cat per sensor)
line_of() { REPLY=""; { IFS= read -r REPLY < "$1"; } 2>/dev/null; }

# millidegrees in file $1 -> whole degrees in REPLY, rounded as printf "%.0f" does
# (half to even); empty when the file holds no integer. No awk per sensor.
deg_of() {
  local v s=1 q r
  line_of "$1"; v=$REPLY; REPLY=""
  [[ $v =~ ^-?[0-9]+$ ]] || return 0
  if [ "${v:0:1}" = - ]; then s=-1; v=${v#-}; fi
  v=$((10#$v)); q=$((v / 1000)); r=$((v % 1000))
  if [ "$r" -gt 500 ] || { [ "$r" -eq 500 ] && [ $((q % 2)) -eq 1 ]; }; then q=$((q + 1)); fi
  REPLY=$((s * q))
}

temp_json() {
  # every sensor chip the kernel exposes, as "chip<TAB>label<TAB>value" lines
```

2. Replace

```bash
  for hw in "$HOST"/sys/class/hwmon/hwmon*; do
    [ -r "$hw/name" ] || continue
    nm=$(cat "$hw/name" 2>/dev/null)
    for f in "$hw"/temp*_input; do
      [ -r "$f" ] || continue
      base=${f%_input}
      lbl=$(cat "${base}_label" 2>/dev/null || echo "$nm")
      val=$(awk '{printf "%.0f", $1/1000}' "$f" 2>/dev/null)
      in_range "$val" && lines+="$nm"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
```

   with

```bash
  for hw in "$HOST"/sys/class/hwmon/hwmon*; do
    [ -r "$hw/name" ] || continue
    line_of "$hw/name"; nm=$REPLY
    for f in "$hw"/temp*_input; do
      [ -r "$f" ] || continue
      base=${f%_input}
      if [ -r "${base}_label" ]; then line_of "${base}_label"; lbl=$REPLY; else lbl=$nm; fi
      deg_of "$f"; val=$REPLY
      in_range "$val" && lines+="$nm"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
```

3. Replace

```bash
    for z in "$HOST"/sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      lbl=$(cat "$z/type" 2>/dev/null || echo zone)
      val=$(awk '{printf "%.0f", $1/1000}' "$z/temp" 2>/dev/null)
      in_range "$val" && lines+="thermal"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
```

   with

```bash
    for z in "$HOST"/sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      if [ -r "$z/type" ]; then line_of "$z/type"; lbl=$REPLY; else lbl=zone; fi
      deg_of "$z/temp"; val=$REPLY
      in_range "$val" && lines+="thermal"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh && bash test/budget.sh`
Expected:
- PASS, 328 tests;
- shellcheck prints nothing;
- `ok    agent tick CPU (user+sys)` about 70 ms below its value on `main` (214-219 ms on the host where this plan was written).

Then `bash test/screens.sh` prints `screenshots in /out: no page errors`.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/temp.sh test/agent-groups.test.js
git commit -m "perf(agent): temperatures without a fork per sensor"
```
