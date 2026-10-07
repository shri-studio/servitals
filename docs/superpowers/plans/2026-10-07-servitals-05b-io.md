# servitals Disk Activity, and Groups That Degrade (sub-project 5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two changes.
- Each disk in the storage panel shows how fast it reads and writes. That shows which disk is behind the io pressure 5a made visible.
- Every agent group degrades as the spec now requires: a source that is missing or unreadable gives null for that group, never a failed tick. This is the first step towards a phone under Termux, where Android denies `/proc/stat`.

**Why:**
- With `/proc/stat` or `/proc/meminfo` missing or denied, `cpu_json` or `mem_json` failed. The empty value then broke `jq --argjson`, so no snapshot was written at all.
- On the live host the io pressure is 12-18 %. The counters show the root disk at 18 TB read and `/srv` at 12.9 TB, but the page could not tell which disk is busy.

**Architecture:**
- `collect.sh` runs each group through `group VAR FUNCTION [ARG]`. VAR gets the function's JSON, or null when it printed nothing or something that is not JSON. `printf -v` sets the value, so there is no extra fork.
- `cpu_json` and `mem_json` print null when their file is missing, denied or has no usable line.
- `mount_info` also returns the mount's device number (`maj:min`). `disks_json` resolves it through `/sys/dev/block/MAJ:MIN` to the kernel's block device name (`sdb1`, or `dm-0` for LVM and dm-crypt) and adds it as `disks[].device`.
- A new `io_json` makes one `awk` pass over mountinfo and `/proc/diskstats`. It gives `[{device, readBytes, writeBytes}]` for the devices behind the reported disks, each device once. Network shares, btrfs and zfs (major 0) have no block device, so they are not included.
- io follows `COLLECT_DISKS`, so `agent.env` does not change.
- The hub validates `disks[].device` and turns the io counters into `readRate` / `writeRate` per device. A counter that went back, or a new device, gives null.
- The page adds "· read X · write Y" to each disk's detail line, using `diskIo(dk, io)`.

**Tech Stack:** bash, `awk`, `jq` (agent); Node.js ≥ 18 (hub, tests); vanilla JS (page); Playwright (screenshots).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- section 9: disk I/O from `/proc/diskstats`; Linux-first; every group degrades to null when its source is missing or unreadable;
- 6.3: snapshot validation;
- 10.3: every word from the dictionary;
- 18: agent CPU per tick ≤ 400 ms.

**Scope:**
- 5b of sub-project 5. Top processes (5c), Ubuntu updates and failed units (5d), and fans, voltages and battery (5e) follow.
- The Termux run itself (no systemd, `termux-boot`, `host.os` "android") stays on the roadmap. This plan only makes the agent survive what Android denies.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (c1ddc98) on 2026-10-07:
- node suite 313 tests, shellcheck, the budget, and `test/screens.sh`;
- on the live host, `io_json` gives the three block devices and `disks_json` names them.

## Global Constraints

- Everything from sub-projects 1-5a still holds: zero runtime dependencies, the strict CSP, every word from `hub/lib/i18n.js`, Node 18 compatibility, SPDX headers, lintian clean.
- The lightness budget: agent CPU per tick ≤ 400 ms, peak RSS ≤ 10 MB. io adds one `awk` and one `jq`; `group` adds no fork.
- Schema version stays 1: `disks[].device` and `io` are optional.
- A group's stderr still reaches the journal; only its exit and output are guarded.
- No new switch in `agent.env` (a conffile): io follows `COLLECT_DISKS`.
- Work in a worktree `.claude/worktrees/servitals-io` on branch `feat/io` from `main` (c1ddc98).
- Never run `git stash`; use a WIP commit. Never change files in a tree while a background run reads it. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **A host that denies or lacks sources** (Android, containers, odd kernels): the tick still writes a snapshot with what it can read. Tests: Task 1 "a source that is missing or denied gives null…", "a host that denies the cpu and memory files still reports what it can (a phone under Termux)".
2. **Devices that are not plain partitions**:
   - LVM or dm-crypt (`dm-N`);
   - a device mounted twice (bind or subvolume);
   - network shares (major 0);
   - a disk without a `/sys/dev/block` link.

   The right device, each once, and never a guessed name. Tests: Task 2 "disks_json names each disk's block device…", "io_json: bytes read and written by the devices behind the reported disks, each once".
3. **Counters that reset or devices that come and go** (a reboot, a disk plugged in): no negative or huge rate. Test: Task 3 "the view turns each disk device's byte counters into read and write rates".
4. **An older agent behind a newer hub** (no `device`, no `io`): no rates shown, no error. Test: Task 4 "each disk shows its device's read and write rates…" ("an older agent sends no io").
5. **A narrow panel**: the rates stay on one line. Test: `test/screens.sh` in Task 4.

---

### Task 1: Every group degrades instead of failing the tick

**Files:**
- Modify: `agent/collect.sh`, `agent/lib/cpu.sh`, `agent/lib/mem.sh`, `test/agent-groups.test.js`, `test/agent.test.js`

**Interfaces:**
- Produces: `group VAR FUNCTION [ARG]` in `agent/collect.sh` (Task 2 adds `group io io_json`); `cpu_json` and `mem_json` print `null` without a usable source.

- [ ] **Step 1: Write the failing tests**

In `test/agent-groups.test.js`:

1. Replace

```js
    cache: 225280, swapTotal: 204800, swapUsed: 51200,
  });
});

```

   with

```js
    cache: 225280, swapTotal: 204800, swapUsed: 51200,
  });
});

test("a source that is missing or denied gives null for its group, never an error (Android denies /proc/stat)", () => {
  const bare = { ...BASE };
  delete bare["proc/stat"]; delete bare["proc/meminfo"];
  const host = fakeHost(bare);
  for (const g of ["cpu_json", "mem_json"]) {
    const r = runGroup(host, g);
    assert.strictEqual(r.status, 0, `${g}: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), "null", g);
  }
  // a file that exists but cannot be read (permission denied); root reads everything
  if (process.getuid && process.getuid() !== 0) {
    const denied = fakeHost(BASE);
    for (const f of ["proc/stat", "proc/meminfo"]) fs.chmodSync(path.join(denied, f), 0);
    for (const g of ["cpu_json", "mem_json"]) {
      const r = runGroup(denied, g);
      assert.strictEqual(r.status, 0, `${g}: ${r.stderr}`);
      assert.strictEqual(r.stdout.trim(), "null", g);
    }
  }
  const odd = fakeHost({ ...BASE, "proc/stat": "intr 1\n", "proc/meminfo": "Nothing: 1 kB\n" });
  for (const g of ["cpu_json", "mem_json"]) assert.strictEqual(runGroup(odd, g).stdout.trim(), "null", `${g}: no usable line`);
});

```

In `test/agent.test.js`:

1. Replace

```js
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

```

   with

```js
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a host that denies the cpu and memory files still reports what it can (a phone under Termux)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-root-"));
  for (const [f, text] of Object.entries({ "etc/hostname": "phone\n", "proc/uptime": "100.0 50.0\n",
    "proc/1/mountinfo": "25 1 8:2 / / rw - ext4 /dev/root rw\n" })) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  const out = path.join(dir, "data.json");
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: root, OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/", COLLECT_DOCKER: "0" },
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(d.host.name, "phone");
  assert.strictEqual(d.cpu, null);
  assert.strictEqual(d.mem, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL, 2 tests:
- "a source that is missing or denied gives null…" (`cpu_json: grep: …/proc/stat: No such file or directory`);
- "a host that denies the cpu and memory files still reports what it can…" (`awk: fatal: cannot open file …/proc/meminfo`).

- [ ] **Step 3: The groups and the guard**

In `agent/lib/cpu.sh`:

1. Replace

```bash
cpu_json() {
  local line idle total wait steal v pct=0 iowait=0 stolen=0 dt pt pi pw ps
  line=$(grep '^cpu ' "$HOST/proc/stat")
  # cpu user nice system idle iowait irq softirq steal guest guest_nice
  set -- $line
  idle=$(( $5 + $6 )); wait=$6; steal=${9:-0}
  total=0; shift
```

   with

```bash
cpu_json() {
  local line idle total wait steal v pct=0 iowait=0 stolen=0 dt pt pi pw ps
  # missing or denied (Android forbids /proc/stat to apps): null, like any group without its source
  line=$(grep '^cpu ' "$HOST/proc/stat" 2>/dev/null)
  # cpu user nice system idle iowait irq softirq steal guest guest_nice
  set -- $line
  [ "$#" -ge 5 ] || { echo null; return; }
  idle=$(( $5 + $6 )); wait=$6; steal=${9:-0}
  total=0; shift
```

In `agent/lib/mem.sh`:

1. Replace

```bash

mem_json() {
  # kB values * 1024 overflow busybox awk's 32-bit int printf("%d"); use %.0f
  # (awk math is double precision, exact well past terabytes).
```

   with

```bash

mem_json() {
  # missing or denied (Android): null, like any group without its source
  [ -r "$HOST/proc/meminfo" ] || { echo null; return; }
  # kB values * 1024 overflow busybox awk's 32-bit int printf("%d"); use %.0f
  # (awk math is double precision, exact well past terabytes).
```

2. Replace

```bash
    /^SwapFree:/     {sf=$2*1024.0}
    END {
      cache=c+b+sr; used=t-a; if (used<0) used=0
      printf "{\"total\":%.0f,\"used\":%.0f,\"available\":%.0f,\"free\":%.0f,\"cache\":%.0f,\"swapTotal\":%.0f,\"swapUsed\":%.0f}",
```

   with

```bash
    /^SwapFree:/     {sf=$2*1024.0}
    END {
      if (t <= 0) { print "null"; exit }
      cache=c+b+sr; used=t-a; if (used<0) used=0
      printf "{\"total\":%.0f,\"used\":%.0f,\"available\":%.0f,\"free\":%.0f,\"cache\":%.0f,\"swapTotal\":%.0f,\"swapUsed\":%.0f}",
```

In `agent/collect.sh`:

1. Replace

```bash

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null pressure=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_PRESSURE:-1}"; then pressure=$(pressure_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
    net=$(net_json "$IFACE")
  fi
  if on "${COLLECT_DOCKER:-1}"; then docker=$(docker_json); fi

  jq -cn \
```

   with

```bash

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null
# group VAR FUNCTION [ARG]: VAR gets FUNCTION's JSON, or null when it failed (no
# output, or an error message), so one unreadable source never costs the whole
# tick (spec 9: every group degrades)
group() {
  local out
  out=$("$2" "${@:3}")
  case $out in "{"*|"["*) printf -v "$1" '%s' "$out" ;; *) printf -v "$1" null ;; esac
}

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null pressure=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
  if on "${COLLECT_CPU:-1}"; then group cpu cpu_json; fi
  if on "${COLLECT_PRESSURE:-1}"; then group pressure pressure_json; fi
  if on "${COLLECT_TEMP:-1}"; then group temp temp_json; fi
  if on "${COLLECT_DISKS:-1}"; then group disks disks_json; fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
    group net net_json "$IFACE"
  fi
  if on "${COLLECT_DOCKER:-1}"; then group docker docker_json; fi

  jq -cn \
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js && pipx run --spec shellcheck-py shellcheck -S warning agent/collect.sh agent/lib/*.sh`
Expected: PASS, 309 tests; shellcheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add agent/collect.sh agent/lib/cpu.sh agent/lib/mem.sh test/agent-groups.test.js test/agent.test.js
git commit -m "fix(agent): a missing or denied source gives null for its group, never a failed tick"
```

---

### Task 2: The agent reports each disk's device and its byte counters

**Files:**
- Modify: `agent/lib/disks.sh`, `agent/collect.sh`, `test/agent-groups.test.js`, `test/agent.test.js`

**Interfaces:**
- Consumes: `group` (Task 1).
- Produces:
  - `mount_info` → `"fstype source maj:min"`;
  - `disks[].device` (kernel block device name; absent when not found);
  - `io_json` → `[{device, readBytes, writeBytes}]`, `[]` without mountinfo, `null` without `/proc/diskstats`;
  - the snapshot's top-level `io`, which follows `COLLECT_DISKS`.

  Task 3 validates these.

- [ ] **Step 1: Write the failing tests**

In `test/agent-groups.test.js`:

1. Replace

```js
});

test("net_json without an interface is null", () => {
  assert.strictEqual(runGroup(fakeHost(BASE), 'net_json ""').stdout.trim(), "null");
```

   with

```js
});

// /proc/diskstats: major minor name, then reads ... ($6 sectors read) ... ($10 sectors written)
const DISKSTATS = [
  "   8       0 sda 100 0 4000 0 50 0 2000 0 0 0 0 0 0 0 0 0 0",
  "   8       2 sda2 90 0 3000 0 40 0 1000 0 0 0 0 0 0 0 0 0 0",
  "   8      17 sdb1 10 0 200 0 5 0 100 0 0 0 0 0 0 0 0 0 0",
  " 253       0 dm-0 7 0 70 0 7 0 70 0 0 0 0 0 0 0 0 0 0", "",
].join("\n");
// the kernel's own link from a device number to its block device
function linkDevices(host, links) {
  for (const [majmin, target] of Object.entries(links)) {
    fs.mkdirSync(path.join(host, "sys/dev/block"), { recursive: true });
    fs.symlinkSync(target, path.join(host, "sys/dev/block", majmin));
  }
}

test("disks_json names each disk's block device, through its device number (LVM and dm too)", () => {
  const host = fakeHost({ ...BASE, "proc/1/mountinfo": BASE["proc/1/mountinfo"] + "37 25 253:0 / /data rw - xfs /dev/mapper/vg-data rw\n",
    "data/x": "x" });
  linkDevices(host, { "8:2": "../../block/sda/sda2", "8:17": "../../block/sdb/sdb1", "253:0": "../../block/dm-0" });
  const d = json(runGroup(host, "disks_json", { DISKS: "/,/srv,/data" }));
  assert.deepStrictEqual(d.map((x) => [x.mount, x.device]), [["/", "sda2"], ["/srv", "sdb1"], ["/data", "dm-0"]]);
  const plain = json(runGroup(fakeHost(BASE), "disks_json", { DISKS: "/" }));
  assert.strictEqual(plain[0].device, undefined, "no link, no device (and no guess)");
});

test("io_json: bytes read and written by the devices behind the reported disks, each once", () => {
  const host = fakeHost({ ...BASE, "proc/diskstats": DISKSTATS,
    "proc/1/mountinfo": BASE["proc/1/mountinfo"] + "38 25 8:17 /sub /srv2 rw - ext4 /dev/sdb1 rw\n" +
      "39 25 0:50 / /mnt/nas rw - cifs //nas/share rw\n" });
  assert.deepStrictEqual(json(runGroup(host, "io_json", { DISKS: "/, /srv,/srv2,/mnt/nas" })), [
    { device: "sda2", readBytes: 3000 * 512, writeBytes: 1000 * 512 },
    { device: "sdb1", readBytes: 200 * 512, writeBytes: 100 * 512 },
  ], "a network share has no block device; a device mounted twice counts once");
  assert.strictEqual(runGroup(fakeHost(BASE), "io_json", { DISKS: "/" }).stdout.trim(), "null", "no /proc/diskstats: null");
  const noMounts = fakeHost({ ...BASE, "proc/diskstats": DISKSTATS });
  fs.rmSync(path.join(noMounts, "proc/1/mountinfo"));
  assert.deepStrictEqual(json(runGroup(noMounts, "io_json", { DISKS: "/" })), [], "no mountinfo (Android): nothing to match");
});

test("net_json without an interface is null", () => {
  assert.strictEqual(runGroup(fakeHost(BASE), 'net_json ""').stdout.trim(), "null");
```

In `test/agent.test.js`:

1. Replace

```js
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0" },
    timeout: 30000,
  });
```

   with

```js
  const r = spawnSync("bash", [path.join(__dirname, "..", "agent", "collect.sh")], {
    env: { ...process.env, HOST_ROOT: "/", OUT_FILE: out, STATE_DIR: dir, ONCE: "1", DISKS: "/",
           COLLECT_DOCKER: "0", COLLECT_TEMP: "0", COLLECT_NET: "0", COLLECT_PRESSURE: "0", COLLECT_DISKS: "0" },
    timeout: 30000,
  });
```

2. Replace

```js
  assert.strictEqual(d.net, null);
  assert.strictEqual(d.pressure, null);
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

   with

```js
  assert.strictEqual(d.net, null);
  assert.strictEqual(d.pressure, null);
  assert.strictEqual(d.disks, null);
  assert.strictEqual(d.io, null, "io follows COLLECT_DISKS");
  assert.ok(d.mem.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-groups.test.js test/agent.test.js`
Expected: FAIL, 3 tests:
- "disks_json names each disk's block device…" (no `device`);
- "io_json: bytes read and written…" (`bash: line 1: io_json: command not found`);
- "COLLECT_<GROUP>=0 turns a group off" (`io follows COLLECT_DISKS`).

- [ ] **Step 3: Device names and counters**

In `agent/lib/disks.sh`:

1. Replace

```bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# disks: usage per DISKS entry, source and model from mountinfo and sysfs

mount_info() {  # $1 = mountpoint -> "fstype source" of its LAST mountinfo line
  # A mountpoint can appear several times (cifs stacked on autofs); the last
  # line is the mount on top, the one a path lookup reaches.
  awk -v m="$1" '$5 == m { for (i = 7; i <= NF; i++) if ($i == "-") { v = $(i+1) " " $(i+2); break } }
    END { if (v != "") print v }' "$HOST/proc/1/mountinfo" 2>/dev/null
}
```

   with

```bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# disks: usage per DISKS entry, source and model from mountinfo and sysfs; io: bytes
# read and written by the block devices behind them, from /proc/diskstats

mount_info() {  # $1 = mountpoint -> "fstype source maj:min" of its LAST mountinfo line
  # A mountpoint can appear several times (cifs stacked on autofs); the last
  # line is the mount on top, the one a path lookup reaches.
  awk -v m="$1" '$5 == m { for (i = 7; i <= NF; i++) if ($i == "-") { v = $(i+1) " " $(i+2) " " $3; break } }
    END { if (v != "") print v }' "$HOST/proc/1/mountinfo" 2>/dev/null
}
```

2. Replace

```bash

disks_json() {
  local lines="" m p info fstype src base parent model rota
  local bs blocks bfree bavail size used avail pct t="${STAT_TIMEOUT:-5}"
  [[ $t =~ ^[0-9]+$ ]] && [ "$t" -ge 1 ] || t=5
```

   with

```bash

disks_json() {
  local lines="" m p info fstype src majmin link dev base parent model rota
  local bs blocks bfree bavail size used avail pct t="${STAT_TIMEOUT:-5}"
  [[ $t =~ ^[0-9]+$ ]] && [ "$t" -ge 1 ] || t=5
```

3. Replace

```bash
      continue
    fi
    read -r fstype src <<< "$info"
    [ -n "$src" ] || src="?"

    # statvfs: %S block size, %b total, %f free, %a avail. A dead network share
```

   with

```bash
      continue
    fi
    read -r fstype src majmin <<< "$info"
    [ -n "$src" ] || src="?"
    # the block device behind it, by device number (works for LVM and dm-crypt too);
    # network shares, btrfs and zfs have major 0 and no block device
    dev=""
    case $majmin in 0:*|"") ;; *) link=$(readlink "$HOST/sys/dev/block/$majmin" 2>/dev/null); dev=${link##*/} ;; esac

    # statvfs: %S block size, %b total, %f free, %a avail. A dead network share
```

4. Replace

```bash
      rota=$(cat "$HOST/sys/class/block/$parent/queue/rotational" 2>/dev/null || echo "")
    fi
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\n'
  done
  # one jq for all disks
```

   with

```bash
      rota=$(cat "$HOST/sys/class/block/$parent/queue/rotational" 2>/dev/null || echo "")
    fi
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\t'"$dev"$'\n'
  done
  # one jq for all disks
```

5. Replace

```bash
    else { mount: .[0], mounted: true, source: .[2], model: .[3], fstype: .[4],
           rotational: (.[5] == "1"), size: (.[6] | tonumber), used: (.[7] | tonumber),
           avail: (.[8] | tonumber), pct: (.[9] | tonumber) } end ]'
}

```

   with

```bash
    else { mount: .[0], mounted: true, source: .[2], model: .[3], fstype: .[4],
           rotational: (.[5] == "1"), size: (.[6] | tonumber), used: (.[7] | tonumber),
           avail: (.[8] | tonumber), pct: (.[9] | tonumber) }
         + (if (.[10] // "") != "" then { device: .[10] } else {} end) end ]'
}

io_json() {  # bytes read and written by the devices behind the DISKS entries, each device once
  [ -r "$HOST/proc/diskstats" ] || { echo null; return; }
  [ -r "$HOST/proc/1/mountinfo" ] || { echo "[]"; return; }
  local list=$DISKS
  if [ "$list" = auto ]; then list=$(auto_disks); fi
  # one pass: the device number of each wanted mountpoint (the last line wins, as in
  # mount_info), then the counters of those devices; diskstats counts 512-byte sectors
  awk -v list="$list" '
    BEGIN { n = split(list, ms, ","); for (i = 1; i <= n; i++) { gsub(/^[ \t]+|[ \t]+$/, "", ms[i]); want[ms[i]] = 1 } }
    FNR == NR { if ($5 in want) num[$5] = $3; next }
    FNR == 1 { for (m in num) if (num[m] !~ /^0:/) dev[num[m]] = 1 }
    ($1 ":" $2) in dev { printf "%s\t%.0f\t%.0f\n", $3, $6 * 512, $10 * 512 }
  ' "$HOST/proc/1/mountinfo" "$HOST/proc/diskstats" 2>/dev/null |
    jq -R -s -c '[split("\n")[] | select(length > 0) | split("\t")
      | {device: .[0], readBytes: (.[1] | tonumber), writeBytes: (.[2] | tonumber)}]'
}

```

In `agent/collect.sh`:

1. Replace

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null pressure=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

   with

```bash

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null io=null net=null docker=null pressure=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then group mem mem_json; fi
```

2. Replace

```bash
  if on "${COLLECT_PRESSURE:-1}"; then group pressure pressure_json; fi
  if on "${COLLECT_TEMP:-1}"; then group temp temp_json; fi
  if on "${COLLECT_DISKS:-1}"; then group disks disks_json; fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
```

   with

```bash
  if on "${COLLECT_PRESSURE:-1}"; then group pressure pressure_json; fi
  if on "${COLLECT_TEMP:-1}"; then group temp temp_json; fi
  if on "${COLLECT_DISKS:-1}"; then group disks disks_json; group io io_json; fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
```

3. Replace

```bash
  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --argjson pressure "$pressure" --argjson interval "$INTERVAL" --arg agent "$AGENT_NAME" \
    '{schema: 1, ts: (now * 1000 | floor), interval: $interval, agent: $agent,
      host: ($host + {os: "linux"}), mem: $mem, cpu: $cpu, pressure: $pressure, temp: $temp,
      disks: $disks, net: $net, docker: $docker}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}
```

   with

```bash
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

- [ ] **Step 4: Run the tests and look at this host**

Run: `node --test test/*.test.js && HOST=/ DISKS=auto bash -c 'for f in agent/lib/*.sh; do . "$f"; done; io_json; disks_json | jq -c "[.[] | {mount, device}]"'`
Expected:
- PASS, 311 tests;
- one `io` entry per block device behind a reported disk;
- each local disk named by its device (network shares show `null` in this `jq` view, because the field is absent).

- [ ] **Step 5: Commit**

```bash
git add agent/lib/disks.sh agent/collect.sh test/agent-groups.test.js test/agent.test.js
git commit -m "feat(agent): bytes read and written per disk, from /proc/diskstats"
```

---

### Task 3: The hub turns the counters into rates

**Files:**
- Modify: `hub/lib/snapshot.js`, `docs/protocol.md`, `test/snapshot.test.js`

**Interfaces:**
- Consumes: `disks[].device`, `io` (Task 2).
- Produces: validated `disks[].device` (≤ 128); the view's `io` as `[{device, readRate, writeRate}]` (bytes per second, or null when there is nothing to compare). Task 4 shows it.

- [ ] **Step 1: Write the failing test**

In `test/snapshot.test.js`:

1. Replace

```js
});

test("a counter that went backwards (reboot, new interface) gives no rate", () => {
  const a = validate(base({ net: { iface: "eno1", rxBytes: 5000, txBytes: 0 } })).value;
```

   with

```js
});

test("the view turns each disk device's byte counters into read and write rates", () => {
  const a = validate(base({ disks: [{ mount: "/srv", device: "sdb1" }],
    io: [{ device: "sdb1", readBytes: 1000, writeBytes: 0 }, { device: "sda2", readBytes: 5, writeBytes: 5 }] })).value;
  assert.strictEqual(a.disks[0].device, "sdb1");
  const b = validate(base({ ts: a.ts + 2000, disks: [{ mount: "/srv", device: "sdb1" }],
    io: [{ device: "sdb1", readBytes: 9000, writeBytes: 4000 }, { device: "sda2", readBytes: 1, writeBytes: 5 },
         { device: "sdc1", readBytes: 7, writeBytes: 7 }] })).value;
  assert.deepStrictEqual(view(a, null, []).io, [{ device: "sdb1", readRate: null, writeRate: null },
    { device: "sda2", readRate: null, writeRate: null }], "nothing to compare yet");
  assert.deepStrictEqual(view(b, a, []).io, [
    { device: "sdb1", readRate: 4000, writeRate: 2000 },
    { device: "sda2", readRate: null, writeRate: 0 },   // a counter that went back (a reboot)
    { device: "sdc1", readRate: null, writeRate: null },   // new since the last snapshot
  ]);
  assert.deepStrictEqual(validate(base({ disks: [{ mount: "/", device: "x".repeat(200) }] })).value.disks[0].device.length, 128);
});

test("a counter that went backwards (reboot, new interface) gives no rate", () => {
  const a = validate(base({ net: { iface: "eno1", rxBytes: 5000, txBytes: 0 } })).value;
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/snapshot.test.js`
Expected: FAIL, 1 test: "the view turns each disk device's byte counters into read and write rates" (`device` is dropped: `undefined !== 'sdb1'`).

- [ ] **Step 3: The schema, the view and the protocol**

In `hub/lib/snapshot.js`:

1. Replace

```js
      fstype: str(d.fstype, 128, `${q}.fstype`), rotational: bool(d.rotational, `${q}.rotational`),
      size: counter(d.size, `${q}.size`), used: counter(d.used, `${q}.used`), avail: counter(d.avail, `${q}.avail`),
      pct: num(d.pct, 0, 100, `${q}.pct`),
    }), { optional: false })),
    io: list(s.io, 32, "$.io", (x, q) => obj(x, q, (d) => clean({
```

   with

```js
      fstype: str(d.fstype, 128, `${q}.fstype`), rotational: bool(d.rotational, `${q}.rotational`),
      size: counter(d.size, `${q}.size`), used: counter(d.used, `${q}.used`), avail: counter(d.avail, `${q}.avail`),
      pct: num(d.pct, 0, 100, `${q}.pct`), device: str(d.device, 128, `${q}.device`),
    }), { optional: false })),
    io: list(s.io, 32, "$.io", (x, q) => obj(x, q, (d) => clean({
```

2. Replace

```js
    };
  }
  if (cur.docker) {
    const before = new Map((prev && prev.docker || []).map((c) => [c.id || c.name, c]));
```

   with

```js
    };
  }
  if (cur.io) {
    // bytes per second per block device; the disks name their device in disks[].device
    const before = new Map((prev && prev.io || []).map((d) => [d.device, d]));
    out.io = cur.io.map((d) => {
      const p = before.get(d.device);
      return { device: d.device, readRate: p ? rate(d.readBytes, p.readBytes, dt) : null,
               writeRate: p ? rate(d.writeBytes, p.writeBytes, dt) : null };
    });
  }
  if (cur.docker) {
    const before = new Map((prev && prev.docker || []).map((c) => [c.id || c.name, c]));
```

In `docs/protocol.md`:

1. Replace

```markdown
  "disks": [ { "mount": "/srv", "mounted": true, "source": "/dev/sdb1",
               "model": "WD Red", "fstype": "ext4", "rotational": true,
               "size": 0, "used": 0, "avail": 0, "pct": 94 } ],     // ≤ 32, strings ≤ 128
  "io":   [ { "device": "sdb", "readBytes": 0, "writeBytes": 0 } ], // counters, ≤ 32
  "net":  { "iface": "eno1", "rxBytes": 0, "txBytes": 0,            // counters
            "vnstat": { "today": {}, "month": {}, "total": {}, "days": [], "hours": [] } },
```

   with

```markdown
  "disks": [ { "mount": "/srv", "mounted": true, "source": "/dev/sdb1",
               "model": "WD Red", "fstype": "ext4", "rotational": true,
               "size": 0, "used": 0, "avail": 0, "pct": 94,
               "device": "sdb1" } ],                                 // ≤ 32, strings ≤ 128
  "io":   [ { "device": "sdb1", "readBytes": 0, "writeBytes": 0 } ], // counters, ≤ 32
  "net":  { "iface": "eno1", "rxBytes": 0, "txBytes": 0,            // counters
            "vnstat": { "today": {}, "month": {}, "total": {}, "days": [], "hours": [] } },
```

2. Replace

```markdown
  and `pressure` is the kernel's 10-second average: both are shares of time,
  not rates of a counter the hub holds.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

   with

```markdown
  and `pressure` is the kernel's 10-second average: both are shares of time,
  not rates of a counter the hub holds.
- `disks[].device` is the kernel's block device behind the mount (from its
  device number, so LVM and dm show as `dm-N`); it is absent for network
  shares, btrfs and zfs. `io` holds the counters of those devices, each once,
  in bytes (`/proc/diskstats` sectors × 512); the hub derives the rates.
- `cpu.usage` is time neither idle nor waiting on I/O; `cpu.iowait` is idle
  time with I/O outstanding. A server stuck on its disk shows a low `usage`
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 312 tests.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/snapshot.js docs/protocol.md test/snapshot.test.js
git commit -m "feat(hub): read and write rates per disk device"
```

---

### Task 4: Each disk shows how fast it reads and writes

**Files:**
- Modify: `www/js/app.js`, `www/app.css`, `hub/lib/i18n.js`, `test/page.test.js`, `test/screens/demo-hub.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the view's `io` (Task 3).
- Produces: `diskIo(dk, io)` in `www/js/app.js` (HTML, or `""`); dictionary key `disk.io`; class `.dio`.

- [ ] **Step 1: Write the failing test**

In `test/page.test.js`:

1. Replace

```js
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
```

   with

```js
});

test("each disk shows its device's read and write rates, once the hub can compare two samples", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const diskIo = pageFn("diskIo", { esc, fmtRate: (v) => v + " B/s" });
  const io = [{ device: "sdb1", readRate: 4000, writeRate: 0 }, { device: "sda2", readRate: null, writeRate: null }];
  assert.strictEqual(diskIo({ device: "sdb1" }, io), ' <span class="dio">· read 4000 B/s · write 0 B/s</span>');
  assert.strictEqual(diskIo({ device: "sda2" }, io), "", "no rate yet");
  assert.strictEqual(diskIo({ mount: "/mnt/nas" }, io), "", "a network share has no device");
  assert.strictEqual(diskIo({ device: "sdb1" }, undefined), "", "an older agent sends no io");
  assert.match(HTML, /<span class="\$\{freeCls\}">· \$\{esc\(tr\("disk\.free", \{ size: fmtBytes\(dk\.avail\) \}\)\)\}<\/span>\$\{diskIo\(dk, d\.io\)\}\$\{warn\}/);
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait"];
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 1 test: "each disk shows its device's read and write rates…" (`ReferenceError: diskIo is not defined`).

- [ ] **Step 3: The line, its word and its style**

In `www/js/app.js`:

1. Replace

```js
    return v == null ? "–" : `<span class="${HL[health(v, 10, 30)]}">${fmtShare(v)}</span>`;
  }).join(" / ");
}

```

   with

```js
    return v == null ? "–" : `<span class="${HL[health(v, 10, 30)]}">${fmtShare(v)}</span>`;
  }).join(" / ");
}

// a disk's read and write rates (its block device's), once the hub has two samples
function diskIo(dk, io) {
  const r = dk.device && (io || []).find(x => x.device === dk.device);
  if (!r || r.readRate == null || r.writeRate == null) return "";
  return ` <span class="dio">· ${esc(tr("disk.io", { read: fmtRate(r.readRate), write: fmtRate(r.writeRate) }))}</span>`;
}

```

2. Replace

```js
        </div>
        ${meter(dk.pct, cls)}
        <div class="dmodel">${kind} <span class="${freeCls}">· ${esc(tr("disk.free", { size: fmtBytes(dk.avail) }))}</span>${warn}</div>
      </div>`;
    }).join("");
```

   with

```js
        </div>
        ${meter(dk.pct, cls)}
        <div class="dmodel">${kind} <span class="${freeCls}">· ${esc(tr("disk.free", { size: fmtBytes(dk.avail) }))}</span>${diskIo(dk, d.io)}${warn}</div>
      </div>`;
    }).join("");
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "disk.notMounted": "not mounted",
  "disk.free": "{size} free",

  // network
```

   with

```js
  "disk.notMounted": "not mounted",
  "disk.free": "{size} free",
  "disk.io": "read {read} · write {write}",

  // network
```

In `www/app.css`:

1. Replace

```css
.disk .dmodel { color: var(--dim); font-size: 12px; }
.disk .dmodel .dfree { color: var(--fg); }
.disk .dwarn { color: var(--amber); }

```

   with

```css
.disk .dmodel { color: var(--dim); font-size: 12px; }
.disk .dmodel .dfree { color: var(--fg); }
.disk .dmodel .dio { white-space: nowrap; }   /* "read 7.3 MB/s · write 1.1 MB/s" stays on one line */
.disk .dwarn { color: var(--amber); }

```

- [ ] **Step 4: The screenshots' disks read and write between pushes**

In `test/screens/demo-hub.js`:

1. Replace

```js
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
    s.disks = [{ mount: "/", mounted: true, source: "/dev/sda1", fstype: "ext4", size: 500e9,
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
  if (s.net) { s.net.rxBytes += round * 5e6 * (i + 1); s.net.txBytes += round * 1e6; }
  for (const d of s.docker || []) if (d.cpuUsec != null) d.cpuUsec += round * 2e6;
  return JSON.stringify(s);
```

   with

```js
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
    s.disks = [{ mount: "/", mounted: true, source: "/dev/sda1", fstype: "ext4", size: 500e9, device: "sda1",
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.io = [{ device: "sda1", readBytes: 0, writeBytes: 0 }];
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
  if (s.net) { s.net.rxBytes += round * 5e6 * (i + 1); s.net.txBytes += round * 1e6; }
  // the disks read and write between pushes, so the storage panel has rates to show
  for (const d of s.io || []) { d.readBytes += round * 4e7 * (i + 1); d.writeBytes += round * 6e6; }
  for (const d of s.docker || []) if (d.cpuUsec != null) d.cpuUsec += round * 2e6;
  return JSON.stringify(s);
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Waiting shows (spec 9): the cpu panel adds iowait and steal (time the cpu
  sat idle waiting on disk, and time a hypervisor took) and the kernel's
```

   with

```markdown

### Added
- Disk activity (spec 9): each disk in the storage panel shows how fast its
  device reads and writes, from `/proc/diskstats` (LVM and dm devices too;
  network shares, btrfs and zfs have no block device and show none).
- Waiting shows (spec 9): the cpu panel adds iowait and steal (time the cpu
  sat idle waiting on disk, and time a hypervisor took) and the kernel's
```

2. Replace

```markdown

### Fixed
- The settings panel is tidier: sections are separated, fields have captions
  and line up, every button and checkbox matches the page (also in dark
```

   with

```markdown

### Fixed
- A source the agent cannot read (missing, or denied as `/proc/stat` is on
  Android) now gives null for its group instead of failing the whole tick.
- The settings panel is tidier: sections are separated, fields have captions
  and line up, every button and checkbox matches the page (also in dark
```

- [ ] **Step 5: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh && bash test/screens.sh`
Expected:
- PASS, 313 tests;
- the budget passes (agent tick CPU and RSS within limits);
- `screenshots in /out: no page errors`;
- in `build/screens/390-comfortable-node.png` each local disk's detail line ends "· read … · write …" on one line.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge on both series.

- [ ] **Step 6: Commit**

```bash
git add www/js/app.js www/app.css hub/lib/i18n.js test/page.test.js test/screens/demo-hub.js CHANGELOG.md
git commit -m "feat(ui): each disk shows how fast it reads and writes"
```
