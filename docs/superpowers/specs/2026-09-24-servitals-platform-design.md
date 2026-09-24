# servitals platform design

Date: 2026-09-24
Status: approved in brainstorming; adversarial review passed (5 rounds, 2026-09-24)
Supersedes: the single-host "systemdashboard" design in `README.md`

Companion documents:

- `docs/protocol.md`: agent-to-hub API contract, signature scheme, snapshot schema, test vectors
- `docs/threat-model.md`: assets, attackers, invariants, rotation and recovery

## 1. Summary

systemdashboard becomes **servitals**: a tiny, terminal-styled, self-hosted
server dashboard that installs as Ubuntu packages, watches one or many
servers, keeps history, and sends alerts. The same agent can report to a
self-hosted hub, to the hosted service at `servitals.prabzo.com`, or to a
self-hosted hub that relays chosen nodes to the hosted service.

### Goals

1. Install on Ubuntu with `apt` from a Launchpad PPA, later from the Debian
   and Ubuntu archives. No Docker required. The Docker install keeps working.
2. Watch several servers from one page, across NAT, without opening ports on
   the watched servers.
3. Keep the project light: zero runtime dependencies and a CI-enforced
   resource budget (section 18).
4. History graphs, alerts with routing, and phone notifications.
5. A free hosted service for people who do not want to run a hub.

### Non-goals (v1)

- Remote control of containers on nodes other than the hub's own host.
- A general time-series database or query language. Prometheus users get a
  `/metrics` endpoint later (roadmap).
- Agents for macOS, Windows or FreeBSD (roadmap: Go agent).
- Paid plans or billing.

## 2. Names, license, packages

| item | value |
| --- | --- |
| product | servitals |
| license | AGPL-3.0-or-later (bundled fonts stay OFL-1.1) |
| binary packages | `servitals` (hub), `servitals-agent` (collector) |
| CLIs | `servitals-ctl` (hub admin), `servitals-agent` (agent admin: `join`, `status`, `test`) |
| hosted service | `https://servitals.prabzo.com` |
| PPA | `ppa:prabzo/servitals` |
| system users | `_servitals` (hub), `_servitals-agent` (agent) |
| default port | 20002 |

The rename touches the repository name, README, page title, cookie name
(`sv_session`), log prefixes and the state directory. Docker users keep their
`./data` directory; section 13.6 covers migration.

A `LICENSE` file (AGPL-3.0 text) and SPDX headers are added before the first
release. Fonts ship with their OFL text; see section 22 for the Press Start 2P
reserved-font-name check.

## 3. Deployment modes

| mode | what runs where | who reaches what |
| --- | --- | --- |
| standalone | hub + agent on one host | browser to hub |
| self-hosted fleet | hub + agent on the main host, agent on each other host | agents to hub (outbound), browser to hub |
| hosted | agents on each host | agents to `servitals.prabzo.com`, browser to the same |
| hybrid | self-hosted fleet, plus the hub relays chosen nodes | agents to hub, hub to hosted |

Standalone is a fleet of one. The UI hides fleet features until a second node
exists.

How agents reach a self-hosted hub is the user's choice and is documented,
not built: same LAN, Tailscale or WireGuard (recommended across sites), an
existing Cloudflare tunnel, or a public address with TLS. Cloudflare's
free-plan Bot Fight Mode cannot be bypassed with WAF rules and blocks `curl`
POSTs, so the tunnel guide tells users to turn it off for the hub hostname or
use Tailscale. Agents send extra headers from `HUB_HEADERS` for Cloudflare
Access service tokens.

## 4. Architecture

```
            ┌────────────── hub host ──────────────┐
 browser ──▶│ servitals (Node.js gateway)           │◀── servitals-agent (remote)
            │  gateway: auth, static, /__ctl, /api  │      push + wait, HMAC
            │  history rings, alert engine, relay   │
            │            ▲ 127.0.0.1                │
            │  servitals-agent (local)              │
            └───────────────────────────────────────┘
                         │ relay (optional)
                         ▼
               servitals.prabzo.com (hosted/, Docker, SQLite)
```

Design decisions:

- **Every agent, including the one on the hub host, reports over the same
  HTTP API.** The local agent pushes to `http://127.0.0.1:<PORT>` with a node
  secret created at install time. One code path, one test suite.
- **Push, not pull.** Agents only make outbound connections, so they work
  behind NAT and CGNAT. Prior art agrees: Beszel added an agent-initiated
  mode for the same reason, and Netdata children stream to parents.
- **Long-poll wake.** Each agent keeps one signed `GET /api/v1/agent/wait`
  open. When a browser asks for fresh data, the hub answers the waiting
  request and the agent samples and pushes within about 2 seconds.
- **The hub owns all state.** Agents are stateless apart from their
  credentials and their cpu/network delta counters.
- **Hosted code is not in the `.deb`.** It lives in `hosted/`, needs
  `node:sqlite` (experimental in Node 22 and 24, absent in noble's Node 18),
  and ships only as a Docker image.

### 4.1 Source layout (target)

```
agent/        servitals-agent: collect.sh, lib/*.sh (one file per metric group), hmac.sh
hub/          gateway core: server.js and lib/*.js (http, auth, api, static, storage-files,
              history, alerts, channels/*, webpush, relay, log, config, i18n)
hosted/       hosted-only modules: accounts, oauth, totp, email, pow, storage-sqlite, Dockerfile
www/          index.html shell, app/*.js (ES modules, lazy), styles/*.css, fonts/, sw.js, manifest.json
debian/       packaging for servitals and servitals-agent
docs/         protocol.md, threat-model.md, backup.md, install guides
test/         node --test suites, shell tests, conformance vectors, budget checks
docker-compose.example.yml   stays at the repository root (users copy it next to .env)
```

The current `auth/` and `collector/` directories move to `hub/` and `agent/`.
Every module stays zero-dependency: Node built-ins only, and bash plus
coreutils, `jq`, `curl` and `vnstat` for the agent.

## 5. Native mode (first sub-project)

### 5.1 Gateway (`hub/server.js`)

- `UPSTREAM` becomes optional. When unset, the gateway serves `WWW_DIR`
  itself: `GET`/`HEAD` only, no directory listing, dotfiles refused, paths
  normalised and kept inside `WWW_DIR`, the same cache headers nginx sets
  today, correct content types for the file types in `www/`.
- The Docker install keeps nginx through `UPSTREAM=http://web:80`; native
  installs leave it unset.
- Password hashing moves to scrypt (N=2^15, r=8, p=1, 16-byte salt), stored as
  `scrypt:N:r:p:salt_b64:hash_b64` (colons, not `$`, so the value survives `.env` interpolation in Docker Compose). One hash needs 32 MiB, so calls pass
  `maxmem: 64 MiB` and at most 2 hashes run at once (further logins wait),
  which bounds the memory spike. The legacy sha256 `AUTH_PASS_HASH` and
  plain `AUTH_PASS` keep working with a warning in the log at startup.
- The admin credential lives in `STATE_DIR/admin.json`, not in env, when
  installed from the package (section 13.4).
- `/__ctl/config` writes `STATE_DIR/config.json` (was `www/config.json`).
  `GET /config.json` is served from `STATE_DIR` with a fallback to the
  shipped defaults in `www/config.default.json`.
- Logging moves to the scheme in section 11.
- **Proxy headers are trusted only from trusted peers.** The forwarding
  header is honoured only when the TCP peer address is in
  `TRUSTED_PROXIES` (default `127.0.0.1,::1`, which covers a local
  cloudflared or reverse proxy). This replaces the global `TRUST_PROXY`
  switch, under which anyone reaching the port directly could claim a LAN
  address and gain whitelist privileges, including container control.
- The client address is the **rightmost** `X-Forwarded-For` entry, the one
  the trusted proxy appended; entries to its left are client-controlled.
  Both cloudflared and common reverse proxies append to `X-Forwarded-For`.
  `PROXY_HEADER=cf-connecting-ip` switches to Cloudflare's single-value
  header for setups where only Cloudflare can reach the proxy; it is off by
  default because any other proxy would pass a client-sent value through.
  `TRUST_PROXY=1` from an old `.env` maps to the loopback default with a
  warning.
- A trusted proxy's own address is never treated as whitelisted. A request
  that comes from a trusted proxy without a forwarding header is handled as
  an ordinary, non-whitelisted client with the proxy's address. Otherwise a
  tunnel that runs next to the gateway (its address falls in the default
  private whitelist) would give every visitor LAN privileges.
- Every state-changing browser request (`POST` to `/__ctl/*`, login, logout)
  must carry an `Origin` header whose host and port match the request's
  `Host` header, or `PUBLIC_URL` when set, on self-hosted hubs as well as
  hosted. Requests without `Origin` (plain scripts) are refused for these
  routes; scripts use `GET` endpoints or, later, API tokens.
- The IP ban and failed-login tracking apply to browser routes only. The
  agent API (`/api/v1/*`) has its own rate limits (protocol section 4) and is
  never blocked by a browser ban.
- State files written by `servitals-ctl` (bans, whitelist, nodes, config) are
  written atomically as the service user; the hub reloads a file when its
  mtime changes, so no restart is needed.

### 5.2 Agent (`agent/collect.sh`)

- Split into one file per metric group under `agent/lib/`, sourced by
  `collect.sh`. Every group can be turned off (`COLLECT_DOCKER=0`, and so on).
- Native mode uses `HOST_ROOT=/`. `STATE` moves from the fixed `/tmp/state` to
  `$STATE_DIR` (`/var/lib/servitals-agent`), which survives restarts.
- Per-container CPU comes from cgroup `cpu.stat` `usage_usec` deltas, read
  from the same directories as `memory.stat`. `docker stats` is removed.
- The container list comes from the Docker API over the socket with
  `curl --unix-socket /var/run/docker.sock http://d/containers/json?all=1`,
  not the Docker CLI. The CLI is a Go binary that briefly takes about 29 MB
  per call (measured 2026-09-24), three times the agent's whole memory
  budget, and `curl` is already a dependency.
- Mount lookups use the **last** matching line of `mountinfo`, so a cifs mount
  stacked on an autofs mount reports `cifs`. Every `stat -f` call runs under
  `timeout 5`, so a dead network share cannot hang the tick.
- `DISKS` entries that are not mountpoints are reported with
  `"mounted": false` instead of repeating the parent filesystem.
- Default heartbeat `INTERVAL=60`. The agent pushes after every tick and
  immediately after a wake.
- The wait loop runs as a background subshell. When the hub answers
  `sample`, it touches the existing trigger file, which the main loop already
  watches, so the tick logic does not change.
- Before `join` there are no credentials; the unit's
  `ConditionPathExists=/etc/servitals/agent-credentials.env` keeps it from
  starting (no crash loop), and `join` starts it.
- Output goes to the hub over the API (section 6). Writing a file
  (`OUT_FILE`) stays available for debugging with `servitals-agent test`.

### 5.3 Measured baseline (2026-09-24, this host)

- One tick with `HOST_ROOT=/` as a normal user works: memory, cpu, temp,
  disks including `/srv`, `/mnt/elements` and `/mnt/router-usb`, vnstat on
  `eno1`, 17 containers.
- The same tick under `ProtectSystem=strict`, `ProtectHome=read-only`,
  `PrivateTmp`, `NoNewPrivileges` (user service manager) works. A system-unit
  run is still to be verified (section 22).
- Without Docker access the docker group degrades to `[]`.
- Snapshot size 5.1 KB, 1.9 KB gzipped.

## 6. Multi-node

The wire format is specified in `docs/protocol.md`. This section covers
behaviour.

### 6.1 Pairing

1. On the hub: `servitals-ctl node add nas [--tag home]`. The hub creates a
   node id (12 characters, base32) and a 32-byte secret, stores both in
   `nodes.json` (0600) and prints:
   `sudo servitals-agent join https://hub.example <node-id>:<secret-hex>`
2. On the node, `join` writes `/etc/servitals/agent-credentials.env` (0600,
   not a conffile, removed on purge), does one test push and reports `ok`,
   `bad secret`, `clock skew`, `unreachable` or `unsupported protocol`.
3. The secret is typed or pasted by the admin. It never crosses the network.

The hub's own agent is paired by the `servitals` package's `postinst`, which
writes the credentials file for the local agent only if no credentials file
exists yet (an agent already joined to another hub is left alone). That file
is state, not a conffile.

### 6.2 Liveness and wake

- A node is **online** while pushes arrive, **stale** after
  `3 × interval` without one (interval comes from the snapshot), and
  **offline** after `max(10 min, 5 × interval)`, which also fires the
  node-offline alert.
- The browser's refresh button and its `refreshSec` loop call
  `POST /__ctl/refresh?node=<id>` (or `all`). The hub answers pending waits
  for those nodes with `{"sample": true}`.
- `refreshNow()` in the page keeps its existing "wait for a newer `ts`" loop,
  now per node.

### 6.3 Snapshot validation

Snapshots from nodes are untrusted input. On every push the hub:

1. checks size (256 KiB self-hosted, 64 KiB hosted) before parsing;
2. parses JSON and validates it against the schema in `docs/protocol.md`:
   numbers must be finite numbers within range, strings are capped (hostname
   64, labels 128, container names 128), arrays are capped (disks 32,
   containers 200, processes 5 per list, sensors 64), unknown keys are
   dropped;
3. stores the validated copy only, enriched with values the hub derives:
   network and disk I/O rates and per-container CPU % from the counters of
   the previous snapshot. The page reads these derived values; agents never
   send rates.

The page also escapes every string it inserts. The spots that today insert
snapshot values unescaped (network bar `data-t`/`data-rx`, and number
formatting that throws on non-numbers) are fixed.

### 6.4 Local-only powers

Only the node flagged `local: true` (the hub's own host) has container
controls. The hub refuses `/__ctl/container/*` for every other node, whatever
the UI sends.

## 7. History

- The hub turns each snapshot into series: `cpu`, `mem`, `swap`, `temp`,
  `load1`, `net.rx`, `net.tx`, `disk.<mount>.used`, `io.<device>.read`,
  `io.<device>.write`, and per container `ctr.<name>.cpu`, `ctr.<name>.mem`.
- Counters (network bytes, disk I/O, container `cpuUsec`) arrive raw. The hub computes rates from
  consecutive values and treats a counter that goes down as a reset.
- Storage: fixed-size ring files, Float32, one file per series under
  `STATE_DIR/history/<node-id>/`.

| tier | resolution | length | stored per point |
| --- | --- | --- | --- |
| T1 | 1 min | 24 h (1,440) | avg, min, max |
| T2 | 10 min | 7 d (1,008) | avg, min, max |
| T3 | 1 h | 90 d self-hosted (2,160), 30 d hosted (720) | avg, min, max |

- Container series are kept in T1 only, avg only.
- About 2 MB per node at 20 base series plus 50 containers.
- Missing minutes stay `NaN` and are drawn as gaps.
- The hub keeps the current minute in memory, flushes once a minute, and
  flushes on `SIGTERM`, so a clean restart loses nothing.
- Series of removed disks or containers are deleted after 90 days without data.
- API: `GET /__ctl/history?node=<id>&series=cpu&range=24h` returns
  `{step, points:[[t, avg, min, max], …]}`. A range longer than the kept
  history returns what exists.

## 8. Alerts

### 8.1 Engine

- Rules are evaluated on each push, plus once a minute for node-offline.
- Alert state is kept in `STATE_DIR/alerts/` and survives restarts.
- A rule is: `metric`, `scope` (all nodes, a tag, a node, and optionally a
  mount or container), `op` (`>=`, `<=`, `==`), `threshold`, `for`,
  `clear` (hysteresis value), `severity` (`info`, `warning`, `critical`),
  `repeat` (default 24 h).
- States: ok → pending → firing → resolved. A notification goes out on firing
  and on resolved.
- Dedup: one firing notification per rule and scope, then only repeats.
- Inhibition: a node that is offline suppresses that node's other alerts.
- Mute: per rule or per node, until a time.
- Per-node overrides: a rule can have a different threshold or be disabled
  for one node or tag.

### 8.2 Default rules

| rule | condition | severity |
| --- | --- | --- |
| node offline | no push for `max(10 min, 5 × interval)` | critical |
| disk full | used ≥ 90% for 5 min, clears < 88% | warning |
| disk critical | used ≥ 95% for 5 min, clears < 93% | critical |
| memory | used ≥ 90% for 10 min | warning |
| cpu | ≥ 95% for 15 min | warning |
| temperature | package ≥ 85 °C for 5 min | warning |
| container down | was running, now exited or unhealthy for 2 min | warning |
| failed units | `systemctl --failed` count > 0 for 5 min | warning |
| reboot required | `/run/reboot-required` present | info |
| security updates | security updates pending | info |

### 8.3 Routing, quiet hours, digest

- Each channel has a minimum severity. Defaults: Web Push and ntfy for
  warning and critical; email for critical; info goes to a daily digest.
- Quiet hours (for example 23:00 to 07:00 local) hold warning notifications
  until the window ends. Critical always goes through. At the end of the
  window, alerts still firing are sent as one summary; alerts that fired and
  resolved inside the window appear only in the alert log.
- The digest is one message a day at 07:00 local with all info events.
- "Local" is the hub's system time zone; on the hosted service it is the
  account's time zone setting.

### 8.4 Channels

Native: Web Push, ntfy, Gotify, Telegram, Discord, Slack, Microsoft Teams
(through a Teams Workflows webhook URL; the old Office 365 connector webhooks
are retired), Pushover, Matrix, email (SMTP with STARTTLS or implicit TLS),
generic webhook. Catch-all: Apprise, through the `apprise` CLI if installed
(run with `execFile` and an argument list, never a shell) or an Apprise API
URL (`Suggests: apprise`).

- All outbound calls use Node's `http`/`https` modules, not `fetch`, so the
  hub behaves the same on Node 18 (noble) and Node 22.

- Every channel has a "send test" button and reports its last error.
- Secrets in channel settings (tokens, SMTP password) are stored in state
  with mode 0600 and never logged. Config-as-code can reference them from env
  (`"token": "$NTFY_TOKEN"`).
- Failed sends retry 3 times with backoff, then log `alert.notify_failed`.
- Hosted: email alerts are capped at 20 per account per day, then one
  "email alerts muted until tomorrow" message. Other channels are not capped.

### 8.5 Web Push

- Zero-dependency implementation: VAPID (RFC 8292) JWT signed with ES256,
  payload encryption `aes128gcm` (RFC 8291) using ECDH P-256, HKDF and
  AES-128-GCM from Node's `crypto`. Tested against the RFC test vectors.
- VAPID keys are generated on first run and stored in `STATE_DIR/vapid.json`.
  `VAPID_SUBJECT` (a `mailto:` or `https:` URL) defaults to the hub's own
  origin and can be set in `hub.env`.
- Each browser subscribes from settings with an "Enable notifications" button
  (iOS requires a user action and a home-screen install, iOS 16.4 or later).
- Requires HTTPS. On plain HTTP the settings page explains why and links the
  HTTPS guide (Tailscale certificates, tunnel, reverse proxy).
- Expired subscriptions (HTTP 404 or 410 from the push service) are removed.

## 9. Metrics

New groups in v1 (all readable without root):

| group | source |
| --- | --- |
| Ubuntu | `/var/lib/update-notifier/updates-available` (updates, security updates), `/run/reboot-required` and `.pkgs`, `systemctl --failed --no-legend` count and names |
| processes | top 5 by cpu and top 5 by memory from `/proc/[pid]/stat` and `status` |
| disk I/O | `/proc/diskstats` read and write byte counters per device |
| fans and voltages | hwmon `fan*_input`, `in*_input` |
| battery | `/sys/class/power_supply/BAT*` capacity and status |

- Missing sources give `null` for that group, never an error.
- The schema is OS-neutral: `host.os` is required, every group is optional,
  so the future Go agent can fill what its OS offers.

## 10. User interface

### 10.1 Layout

- Layout B: a **fleet grid** of node cards (status lamp, chosen numbers,
  sparkline, fullest disk, alert badge). Clicking a card opens the **node
  view**, which is today's panel page, with node tabs above it.
- With one node the page opens straight on the node view, as today.
- Phone: one column of slim node rows; a bottom bar with fleet, alerts and
  settings.
- Node view panels, new: history graph with a range picker (1h, 24h, 7d, 30d,
  90d; average line and min–max band, gaps shaded as offline), Ubuntu panel,
  processes, disk I/O. The alerts view lists firing and recent alerts.
- Mockups: https://claude.ai/artifact/LQXn94LJmMbE9iKyYhxtJb (private).

### 10.2 Styles and modes

- Two independent switches, as today: **style** and **mode** (light, dark,
  system). Stored per browser; the hub stores a default.
- A style registry: each style is a token set for light and dark plus an
  optional CSS file of at most 3 KB, loaded only when selected.
- v1 styles: classic, 8bit, phosphor, e-ink, high contrast, nord, gruvbox,
  dracula, catppuccin, solarized.
- v1.1 styles: teletext, 3270, blueprint.
- High contrast: WCAG AAA text contrast, Okabe-Ito status colours, shape-coded
  status lamps, larger text, text labels on alerts.
- Palette licences (all MIT) are recorded in `debian/copyright`.

### 10.3 Other UI features in v1

- Kiosk mode (`/?kiosk` or a setting): large type, no controls, cycles
  through nodes every N seconds.
- Density and text size: compact, comfortable, large.
- Installable phone app (PWA): `manifest.json`, `sw.js` for push and an
  offline shell. Needs HTTPS (section 8.5).
- i18n-ready: every UI string comes from one dictionary. English only in v1.

### 10.4 Customization in v1

- Fleet: tags with grouping, choice of numbers on cards, pin, hide and sort
  nodes, rename a node without re-pairing.
- Panels: per-node panel sets and sizes (panel order stays in settings with
  up and down buttons).
- Units: °C or °F, MB or MiB, 12 h or 24 h clock, first day of the week,
  network in bits or bytes per second.
- Agent collection: metric groups and heartbeat per node, set in the agent's
  env file.
- Alerts: section 8.
- Settings export and import as one JSON file.

### 10.5 Page weight

The page is a small shell plus ES modules loaded on first use: fleet and
node view load first; settings, the alert editor, history charts, and each
style load when opened. No bundler, no framework.

The page contains no inline `<script>`, no inline event handlers and no
`style="…"` attributes in generated markup; dynamic sizes (bars, sparklines)
are set through `element.style` or CSS custom properties from script. That
lets the same page run under the hosted service's strict CSP, and
self-hosted hubs send the same CSP header. `connect-src` allows the hub
itself and `https://api.open-meteo.com` for the weather panel.

## 11. Logging

- Output to stdout and stderr. Under systemd each line starts with an
  sd-daemon priority prefix (`<3>` error, `<4>` warning, `<6>` info, `<7>`
  debug), so `journalctl -u servitals -p warning` filters by level. The
  prefix is left out when `JOURNAL_STREAM` is not set.
- Format logfmt by default, `LOG_FORMAT=json` for log shippers.
- `LOG_LEVEL`: error, warn, info (default), debug. Debug adds per-group tick
  timings in the agent.
- Event families: `auth.*`, `api.*` (logged on state changes, not per push),
  `alert.*`, `ctl.*`, `config.*`, `agent.*`, `relay.*`.
- Audit log: `auth.*`, `ctl.*`, `config.*` and node add, revoke and rotate
  events also go to `STATE_DIR/audit.log` as JSON lines, rotated at 5 MB with
  one old file kept. Settings has an Activity view of the last 200 entries.
- Never logged: passwords, cookies, secrets, signatures, tokens, push
  subscription keys, snapshot contents. A test greps log output for planted
  secrets.
- Hosted: JSON logs with request id and account id; client IPs kept 30 days.

## 12. Configuration

| file | kind | owner | contents |
| --- | --- | --- | --- |
| `/etc/servitals/hub.env` | conffile | package | port, bind address, `TRUSTED_PROXIES`, whitelist, lockout, session length, `CTL_LAN_ONLY`, `CTL_DOCKER`, log settings |
| `/etc/servitals/agent.env` | conffile | package | interval, metric group toggles, `DISKS`, `NET_IFACE`, `HUB_HEADERS`, log settings |
| `/etc/servitals/agent-credentials.env` | state, 0600 | `join` / postinst | `HUB_URL`, `NODE_ID`, `NODE_SECRET` |
| `/etc/servitals/conf.d/*.json` | admin files | admin | config as code: tags, rules, channels, units, defaults |
| `/var/lib/servitals/` | state | hub | `admin.json`, `secret`, `nodes.json`, `config.json`, `bans.json`, `fails.json`, `whitelist.txt`, `snapshots/`, `history/`, `alerts/`, `vapid.json`, `push-subscriptions.json`, `relay.json`, `audit.log`, `backups/` |
| `/var/lib/servitals-agent/` | state | agent | delta counters |

- Values from `conf.d` win over values edited in the UI. The UI shows them
  as "managed by file" and read-only.
- `conf.d` files are validated at startup and on `servitals-ctl config check`;
  an invalid file is logged and skipped, never half-applied.

## 13. Packaging

### 13.1 Packages

| | `servitals` | `servitals-agent` |
| --- | --- | --- |
| Architecture | all | all |
| Depends | `${misc:Depends}`, `nodejs (>= 18)`, `servitals-agent (= ${source:Version})` | `${misc:Depends}`, `bash`, `coreutils`, `jq`, `curl`, `mawk \| awk` |
| Recommends | | `vnstat` |
| Suggests | `apprise` | |
| Installs | `/usr/share/servitals/{hub,www}`, `/usr/bin/servitals-ctl`, unit, sysusers, man page | `/usr/lib/servitals-agent/`, `/usr/bin/servitals-agent`, unit, sysusers, man page |

- Built with debhelper compat 13, `dh-sequence-installsysusers`, `dh_installsystemd`.
- Fonts: JetBrains Mono, Press Start 2P and VT323 are bundled as WOFF2
  subsets with their OFL text, because browsers need WOFF2 and the archive's
  `fonts-jetbrains-mono` ships only TTF. IBM Plex Mono arrives with the v1.1
  3270 style. Section 22 lists the Debian font-policy checks.
- Without `vnstat` the network panel shows live rates only.
- Man pages: `servitals-ctl(1)`, `servitals-agent(1)`, `servitals(8)`.

### 13.2 systemd units

Both units: `NoNewPrivileges=yes`, `ProtectSystem=strict`,
`ProtectHome=read-only`, `PrivateTmp=yes`, `ProtectKernelTunables=yes`,
`ProtectControlGroups=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`,
`MemoryDenyWriteExecute=` left off for Node's JIT, `StateDirectory=`,
`Restart=on-failure`.

- `servitals.service`: user `_servitals`, `ReadWritePaths=/var/lib/servitals`.
  `SupplementaryGroups=docker` is added by a drop-in that
  `servitals-ctl docker enable` creates, only when the admin opts in.
- `servitals-agent.service`: user `_servitals-agent`, same pattern for
  Docker read access (`servitals-agent docker enable`), plus
  `ConditionPathExists=/etc/servitals/agent-credentials.env`.
- The Docker group grants root-equivalent control of the host. The README,
  man pages and the enable commands say so.

### 13.3 Conffiles and maintainer scripts

- `hub.env` and `agent.env` are conffiles and are never modified by
  maintainer scripts.
- `postinst configure` is idempotent. On first install of `servitals` it:
  creates state, generates a random admin password, stores its scrypt hash in
  `admin.json`, writes the password once to
  `/var/lib/servitals/initial-password` (0600) and prints where it is, pairs
  the local agent, then enables and starts the unit.
- No debconf prompts in v1.
- `postrm purge` of `servitals-agent` removes its state and the credentials
  file. `postrm purge` of `servitals` removes hub state, and also the agent
  credentials file when it points to the local hub, so a kept agent does not
  keep pushing to a hub that no longer exists.

### 13.4 Tests

- `debian/tests/control`: `Restrictions: needs-root, isolation-container`.
- Tests: install both packages, start both units, `curl /__auth/health`, log
  in with the initial password, see the local node online, pair a second
  agent instance against localhost, see its push land, trigger a test alert
  to a local webhook receiver.

### 13.5 Lintian and policy

- `lintian -EvIL +pedantic` must pass without errors or warnings; any
  override is documented in `debian/*.lintian-overrides` with a reason.
- No network access at package build time and no `npm install` in the
  package build or at runtime. CI test jobs may install development tools
  (Playwright, shellcheck); nothing from them is shipped.

### 13.6 Docker install and migration

- `docker-compose.example.yml` keeps the three-container Docker
  install (gateway, nginx, agent), renamed to servitals.
- The compose file pins its network to a fixed subnet
  (`172.31.250.0/24`) and sets `TRUSTED_PROXIES=172.31.250.1`, the gateway
  address a host-level tunnel or proxy connects from. Users with a tunnel in
  another container set `TRUSTED_PROXIES` to that container's address.
- Local pairing in Docker: on first start the gateway creates the local node
  and writes `./data/local-agent.env`; the agent container mounts `./data`
  read-only, reads that file and pushes to `http://gateway:8080`.
- The session cookie is renamed, so everyone logs in once after upgrading.
- On first start the gateway migrates old state: `./data` keeps its files,
  `www/config.json` moves to state, the old sha256 hash keeps working until
  the next password change.
- Docker users can move to the packages with `servitals-ctl import-docker
  <path-to-old-dir>`.

## 14. Hosted service

Lives in `hosted/`, ships as a Docker image, never in the `.deb`.

### 14.1 Accounts and login

- Email and password (scrypt), email verification required before adding
  nodes, reset links (hashed tokens, 30-minute expiry, single use), generic
  responses so account existence is not revealed.
- OAuth with GitHub and Google (authorization code flow with PKCE, plain
  `fetch`). An OAuth login links to an existing account only when the
  provider reports the email as verified.
- Optional TOTP 2FA (RFC 6238) with hashed recovery codes.
- Sessions: random id in an `HttpOnly; Secure; SameSite=Lax` cookie, stored
  server-side, revocable, with "log out everywhere".
- CSRF: `Origin` must match on every state-changing request.
- Rate limits per IP and per account for login, signup, reset and 2FA.
- Each account has a time zone setting used for quiet hours and digests.

### 14.2 Anti-bot on signup

No third-party scripts. The signup form carries a proof-of-work challenge
(server-issued random nonce, the browser finds a SHA-256 hash with the
required leading zero bits using WebCrypto, about 1 s on a phone), a honeypot
field, and a minimum 3 s form time. Plus email verification, IP rate limits
and a disposable-domain blocklist.

### 14.3 Tenancy and storage

- Storage adapter interface with two implementations: files (self-hosted) and
  `node:sqlite` in WAL mode (hosted). Every hosted query takes `account_id`
  inside the adapter.
- Node secrets and TOTP secrets are encrypted at rest with AES-256-GCM using
  a master key from the environment, never stored in the database or backups.
- History uses the same ring format, stored as one SQLite BLOB row per
  series; hosted keeps T3 for 30 days.

### 14.4 Limits (free tier)

5 nodes per account, 30-day history, 64 KiB snapshots, one push per 5 s per
node, one open wait per node, 20 alert emails per day. Limits are
per-account settings, so a paid tier would not need a redesign.

### 14.5 Lifecycle and privacy

- Accounts with no login and no pushes for 12 months get a warning email and
  are deleted 30 days later.
- Users can export their data as JSON and delete their account at any time;
  deletion removes all rows immediately and backups age out within 30 days.
- Privacy policy in plain language: what a snapshot contains, retention, no
  analytics or trackers, and that the weather panel's requests go from the
  browser straight to Open-Meteo with the configured coordinates.
- No remote control of any kind on the hosted service.
- **Outbound requests are SSRF-guarded.** Every user-supplied destination
  (webhook, ntfy, Gotify, Matrix, Apprise API, SMTP host) is resolved first;
  loopback, private, link-local, CGNAT, multicast and cloud metadata
  addresses are refused, and the connection is pinned to the checked IP so
  DNS cannot change between check and use. Redirects are not followed.
  Self-hosted hubs skip this guard, since LAN destinations are the point
  there.

### 14.6 Operations

- One VPS, Docker Compose with the hosted image and Caddy for TLS.
- Nightly encrypted SQLite backup to off-site S3-compatible storage; monthly
  restore test.
- Security headers: strict CSP (no inline script or style; the page shell is
  refactored to external files), HSTS, `frame-ancestors 'none'`.
- Service health reported to the operator through ntfy; public status page.
- Upgrades with `docker compose pull` after the manual approval step in CI.
- Funding: GitHub Sponsors link.

## 15. Hybrid relay

- In the hosted UI, "Add relay" gives a relay id and key.
- On the self-hosted hub: `servitals-ctl relay set https://servitals.prabzo.com
  <relay-id>:<key>` and `servitals-ctl relay add <node>` per node to mirror.
- The hub pushes each mirrored node's validated snapshot upstream, signed with
  the relay key, with `X-Servitals-Node: <relay-id>/<node-id>`. The hosted
  service creates child nodes within the account's node limit and answers
  `403 node_limit` beyond it.
- A snapshot larger than the hosted limit (64 KiB) is trimmed before sending:
  processes first, then containers beyond the 50 largest by memory.
- The hub holds one `GET /api/v1/relay/wait` upstream. Its answer lists the
  node ids to wake, and the hub forwards each wake to that node's own wait.
- If the hosted service is unreachable the relay backs off and drops, not
  queues, old snapshots. The local hub is unaffected.

## 16. Release and CI

- Versions: semver (`1.4.2`), tags `v1.4.2`, Debian `1.4.2-1`, PPA
  `1.4.2-1~ppa1~<series>1`. Protocol and schema versions are separate.
- Every push or PR: shellcheck, `node --check`, `node --test`, conformance
  vectors, a real collector tick validated against the schema, the budget
  checks (section 18), `dpkg-buildpackage`, lintian, autopkgtest in LXD on
  noble and resolute, screenshot tests of the page in every style and mode
  with approval for visual changes.
- Tag `v*`: signed source uploads to the PPA for noble, resolute and the
  current interim release; GitHub Release with the `.deb` files, the source
  tarball, `SHA256SUMS` and its signature; multi-arch images to GHCR; hosted
  deploy after manual approval.
- `SECURITY.md` with GitHub private advisories; critical fixes released
  within 7 days. `CONTRIBUTING.md`, issue templates, `CHANGELOG.md` (Keep a
  Changelog).
- Debian: after 1.0 has been stable for about 3 months, file an ITP, upload
  to mentors.debian.net and find a sponsor.

## 17. Backups and rotation

- `servitals-ctl backup <file> [--encrypt]` writes one tar of hub state
  (mode 0600: it contains the admin hash, node secrets and channel tokens);
  `restore <file>` checks versions, stops the unit, restores and starts it.
- Optional daily backup: `servitals-ctl backup enable` turns on a systemd
  timer that keeps 7 archives in `STATE_DIR/backups/`.
- Rotation: `node rotate <id|--all>` (24-hour overlap where both secrets are
  accepted), `passwd` (ends all sessions), `rotate session-key`,
  `rotate vapid` (browsers resubscribe).
- Details in `docs/threat-model.md` and `docs/backup.md`.

## 18. Lightness budget

Enforced in CI; a breach fails the build. Memory figures are steady state
(idle between requests), measured as `RssAnon` from `/proc/<pid>/status`.

| budget | limit | measured today |
| --- | --- | --- |
| runtime dependencies | 0 | 0 |
| first page load, gzipped, fonts excluded | ≤ 60 KB | 20 KB |
| CSS per optional style | ≤ 3 KB | – |
| hub anonymous memory (`RssAnon`) with 10 nodes | ≤ 40 MB | 6.5 MB with 1 node |
| agent anonymous memory, peak during a tick | ≤ 10 MB | to measure in CI |
| agent CPU per tick, Docker off (bash agent) | ≤ 400 ms | about 300 ms |
| agent average CPU at the 60 s heartbeat | ≤ 1% of one core | about 0.5% |
| each `.deb` | ≤ 500 KB | – |

## 19. Testing strategy

- Unit tests with `node --test` for every hub module; shell tests for agent
  groups against fixture `/proc` and `/sys` trees.
- Conformance: the vectors in `docs/protocol.md` run against the bash agent
  and the hub; the hosted service runs the same suite.
- Security tests: signature failure modes, replay, skew, oversize, schema
  rejection, XSS strings in every snapshot field rendered by the page
  (Playwright), secrets absent from logs, container control refused for
  remote nodes.
- Budget checks (section 18).
- autopkgtest (section 13.4).

## 20. Build order

Each sub-project gets its own implementation plan and ships something that
works on its own.

| # | sub-project | done when |
| --- | --- | --- |
| 1 | Foundation: rename, LICENSE, source layout, logging, scrypt, `TRUSTED_PROXIES` and `Origin` checks, CI skeleton, budget checks | CI green; Docker install still works renamed; forged proxy headers no longer grant LAN privileges |
| 2 | Native mode: gateway static serving, agent fixes and groups, local agent over the API, state paths | both run as system units on this host with the hardening in 13.2 |
| 3 | Debian packaging and PPA pipeline | `apt install servitals` from the PPA on a clean noble and resolute container; autopkgtest passes |
| 4 | Multi-node: protocol, pairing, wake, validation, fleet UI, styles registry with the v1 styles, customization, config as code, backup and rotation CLI | a second machine joins, shows in the fleet grid, survives hub restarts |
| 5 | Metrics: Ubuntu, processes, disk I/O, fans, battery | panels render in every style; budget holds |
| 6 | History and alerts with all channels, Web Push, routing | a disk rule fires, notifies ntfy and Web Push, resolves |
| 7 | Hosted service | signup to live node on a staging domain; security tests pass |
| 8 | Relay | a self-hosted node appears in a hosted account and wakes from it |

## 21. Roadmap (after v1)

- v1.1: teletext, 3270 and blueprint styles; theme editor with JSON
  import and export; dark-at-sunset schedule; accent colour per node.
- Go agent for Linux, macOS, Windows and FreeBSD (gopsutil is in the Ubuntu
  archive), replacing the bash agent.
- Uptime checks (HTTP, TCP, ping, certificate expiry) run by the hub.
- API tokens, read-only REST API, Prometheus `/metrics`.
- Multi-user roles on self-hosted hubs.
- CLI and TUI client.
- Service link tiles, translations, drag-to-reorder panels.
- Container control on remote nodes (would need a signed command channel and
  its own threat review).
- Home Assistant integration, SMART, RAID and ZFS, GPU.

## 22. Verify before release

- A system-unit run of the agent with the full hardening set (only the user
  manager was tested).
- Press Start 2P: its OFL **does** carry the Reserved Font Name "Press Start
  2P" (checked 2026-09-24). Before the Debian upload, decide whether the
  bundled WOFF2 subset counts as a modified version under Debian's font
  policy; if it does, rename the bundled face (for example "servitals 8bit")
  or build the WOFF2 from source in the package build.
- iOS Web Push availability in the EU, on a real device.
- Cloudflare Bot Fight Mode behaviour with the agent's requests, for the
  tunnel guide.
- Launchpad team name for the PPA (`prabzo` assumed) and the GitHub
  repository rename from `shri-studio/systemdashboard` to `servitals`.
- Debian review of the bundled WOFF2 fonts (Debian prefers packaged fonts;
  the archive has no WOFF2 builds of these faces).

## 23. Research sources

- Debian Policy, maintainer scripts: https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html
- dh_installsysusers: https://manpages.debian.org/testing/debhelper/dh_installsysusers.1.en.html
- autopkgtest: https://salsa.debian.org/ci-team/autopkgtest/raw/master/doc/README.package-tests.rst
- Debian font policy: https://wiki.debian.org/Fonts/PackagingPolicy
- Launchpad PPA: https://documentation.ubuntu.com/launchpad/en/latest/explanation/launchpad-ppa/
- Node.js SQLite: https://nodejs.org/api/sqlite.html
- Ubuntu nodejs versions: https://packages.ubuntu.com/search?keywords=nodejs&searchon=names&exact=1&suite=all&section=all
- Beszel security: https://beszel.dev/guide/security
- Netdata parent-child: https://learn.netdata.cloud/docs/netdata-parents/parent-child-configuration-reference
- Cloudflare Bot Fight Mode: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
- iOS web push requirements: https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications
