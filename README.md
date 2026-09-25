# servitals

Formerly **systemdashboard**. Licensed under AGPL-3.0-or-later. <!-- legacy-name -->

A tiny, self-hosted, terminal-styled status page for a home server:
live RAM, per-drive storage, CPU/load, temperature, vnstat network history,
Docker service status, weather and world clocks — in one HTML file.

![panels: memory · cpu · thermal · storage · network · services · clocks · weather](docs/preview.png)

## Design

Three small containers, one `docker compose up`, **no sudo, no host
packages**:

| service | image | job |
| --- | --- | --- |
| `gateway` | `node:22-alpine` | login gateway on `PORT`; the only exposed port. Session cookie, per-IP lockout, whitelist. Proxies authed traffic to `web`. Serves `/__ctl/*` (refresh trigger + LAN-only container start/stop/restart/logs via the docker socket). |
| `web`   | `nginx:alpine` | serve `www/` (the static page + `data.json`); internal only |
| `agent` | `alpine` + bash | reads host metrics and writes `www/data.json` on the `.refresh` trigger (the dashboard drops it while open) or, idle, every `INTERVAL` seconds |

Measured: **~11 MiB real memory** (anonymous RSS — agent ~1, auth ~9, web ~1;
`docker stats` reports several times that because it counts reclaimable page
cache). CPU idles at zero — the agent uses ~25 % of one core for the ~2 s a
tick takes, mostly the `docker stats` sample.

The agent bind-mounts the host root read-only at `/host` with **`rslave` mount
propagation** (the same trick `node_exporter` uses) so nested mounts such as
`/mnt/*` are visible for per-drive usage. It also mounts `docker.sock`
read-only for container status.

Data sources — all read-only, nothing installed on the host:

| metric | source |
| --- | --- |
| memory / swap | `/host/proc/meminfo` |
| cpu % + per-core + load | `/host/proc/stat` deltas (aggregate + `cpuN`), `/host/proc/loadavg` |
| trend sparklines | agent keeps the last 60 cpu/mem/temp samples (`www/.trend`), drawn on first load; the window is 60 samples wide (≈ 1 h of active viewing at `refreshSec` 60, longer if the page sat idle on the `INTERVAL` heartbeat) |
| temperature   | `/host/sys/class/hwmon/*` (coretemp/k10temp…), thermal-zone fallback |
| storage       | `statvfs` per mount + model/rotational from `/host/sys/class/block` |
| network       | `vnstat --json` (totals, 30-day / 24-hour history, today/month averages) + live MB/s from `/sys/class/net/*/statistics` deltas |
| docker        | `docker ps` + `docker stats` (per-container cpu %, memory) via the mounted socket |
| weather       | [Open-Meteo](https://open-meteo.com) — browser-side, no key |
| world clocks  | browser `Intl` — browser-side |

## Requirements

- **Docker** with the Compose plugin (`docker compose`)
- **`vnstat` running on the host** — it logs to `/var/lib/vnstat`, which the
  agent reads. Install with
  `sudo apt install vnstat && sudo systemctl enable --now vnstat`; give it a
  few minutes (ideally a day) to build history before the network panel fills
  in
- The host timezone set (`timedatectl set-timezone …`) — `TZ` in `.env` must
  match it, or the network panel's today/month boundaries drift

## Setup

```sh
git clone https://github.com/shri-studio/systemdashboard.git  # legacy-name: update after the GitHub rename
cd systemdashboard  # legacy-name: update after the GitHub rename

cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
cp www/config.example.json www/config.json
```

Edit **`.env`**:

- `AUTH_USER`, and either `AUTH_PASS_HASH` (recommended: run
  `bin/servitals-ctl hash-password` and paste the result in single quotes)
  or `AUTH_PASS`. The gateway refuses to start without one of them.
- `PORT`, `TZ`, `NET_IFACE` (blank = auto-detect), `DISKS` (comma-separated
  host mountpoints)

Edit **`www/config.json`**: title, weather locations, clocks, drive labels
(all of this is also editable live in the settings panel later).

```sh
docker compose up -d --build
```

Open `http://<host>:<PORT>` (default `20002`) and log in. The first snapshot
takes a few seconds — the panels show "connecting…" until then.

`docker-compose.yml`, `.env` and `www/config.json` are git-ignored — the
`*.example` files are the templates, so your edits stay local and never
land in a commit.

To expose it through an existing reverse proxy or Cloudflare tunnel, point a
hostname at `http://localhost:<PORT>`. A tunnel or proxy on the same host
connects from the Docker network's gateway, `172.31.250.1`, which is the
default `TRUSTED_PROXIES`; its `X-Forwarded-For` header then gives the real
client address, so lockout works for public visitors. Forwarding headers
from any other address are ignored, so nobody can fake a LAN address. If the
proxy runs in another container, set `TRUSTED_PROXIES` to that container's
address.

## Authentication & lockout

The `gateway` service is the only thing listening on `PORT`; `web` has no
published port.

| env | default | meaning |
| --- | --- | --- |
| `AUTH_USER` | `admin` | login name |
| `AUTH_PASS_HASH` | — | scrypt hash from `bin/servitals-ctl hash-password` (keep it in single quotes in `.env`); legacy sha256 hex still works |
| `AUTH_PASS` | — | plain password, if no hash is set (logs a warning) |
| `MAX_FAILS` | `3` | failed logins from one IP before it is blocked |
| `BAN_HOURS` | `0` | block duration; `0` = permanent until unbanned |
| `SESSION_HOURS` | `720` | login session lifetime (30 days) |
| `WHITELIST` | private ranges | IPv4 addresses and CIDRs, or exact IPv6 addresses, that are never blocked and skip fail tracking |
| `TRUSTED_PROXIES` | `172.31.250.1` in Docker | peers whose `X-Forwarded-For` is trusted; everyone else's forwarding headers are ignored |
| `PROXY_HEADER` | `x-forwarded-for` | set `cf-connecting-ip` only when nothing but Cloudflare can reach your proxy |
| `PUBLIC_URL` | — | public address, if a proxy rewrites `Host` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `logfmt` | `error`…`debug`; `json` for log shippers |
| `BIND_ADDR` | `0.0.0.0` | host address the port binds to; `127.0.0.1` to keep it off the LAN |

Private ranges (`10/8`, `172.16/12`, `192.168/16`, loopback) are whitelisted
by default, so **LAN access can never be locked out** — only public visitors
through the tunnel can trip the block.

State lives in `./data/` (git-ignored), re-read on every request:

```sh
bin/servitals-ctl bans                   # list blocked IPs + the whitelist
bin/servitals-ctl unban 203.0.113.7      # remove a block (takes effect immediately)
bin/servitals-ctl whitelist 203.0.113.7  # never block this IP/CIDR again (also unbans)
bin/servitals-ctl hash-password          # print an AUTH_PASS_HASH value
```

`data/whitelist.txt` can also be edited directly — one IP or CIDR per line.

## Configuration

The **settings panel** (press `s`) edits everything live:

- **name & icon** — the browser-tab title, and a favicon (upload a PNG/SVG,
  or type an emoji)
- **panels** — drag to reorder, per-panel size (`normal` / `wide` / `full`
  columns), show/hide
- weather locations, world clocks, refresh interval, per-drive labels

**Save** writes `www/config.json` via the auth gateway
(`POST /__ctl/config`), so every viewer sees the same layout and icon. If
that endpoint isn't reachable it falls back to this browser's
`localStorage`, and "export json" prints the config to paste in by hand.

`www/config.json` is git-ignored; ship-time defaults live in
`www/config.example.json`.

Per-drive labels and warnings, keyed by mountpoint:

```json
"disks": {
  "/mnt/media":  { "label": "media" },
  "/mnt/backup": { "label": "backup", "warn": "aging disk — check SMART" }
}
```

## Keys

| key | action |
| --- | --- |
| `r` | refresh now |
| `s` | open / close settings |
| `t` | toggle theme: dark ⇄ light |
| `esc` | close settings |

`[logout]` in the header ends the session (a POST, so other sites cannot log you out). The font (JetBrains Mono) is
self-hosted under `www/fonts/`, so it renders identically offline.
`prefers-reduced-motion` disables the blink/pulse animations.

**Colour** encodes health, not decoration: meters and the big numbers run
green → amber → red by threshold (memory, cpu, temp, load, swap, per drive,
per container). Download is cyan, upload is magenta, used consistently on
the network rate, totals, averages and the 30-day bars.

**Services** is a responsive multi-column list (CSS columns, fills
top-to-bottom), sorted by memory or cpu (`mem·cpu` toggle in the header).
It shows the top 10 with a "show N more" expander; stopped/created
containers are always shown regardless of the cap. Each row has
`⟳` restart · `◼`/`▶` stop/start · `↗` open in Portainer · `≡` logs —
**visible only to whitelisted (LAN) clients** (`CTL_LAN_ONLY`); tunnel
visitors get a read-only view. Stop asks for confirmation. The Portainer
link needs `portainerUrl` in `config.json`.

Storage and network sit side by side; network's today / month / all-time
figures are an aligned table (down · up · total · avg↓ · avg↑), with a
`30d` / `24h` bar history below it (hover a bar for its down/up).

**Refresh — demand-driven.** The agent samples only when asked: it watches
for a `.refresh` file and wakes on it. The open dashboard drops that trigger
on load and then every `refreshSec` (default 60) while its tab is visible;
when the tab is hidden nothing polls. `r` does the same thing on demand.
With no viewer at all, the agent falls back to a slow `INTERVAL` heartbeat
(default 300 s) so `data.json`, the trend history and the "session" temp
range don't drift too far. The live network rate is an average over
whichever gap produced the latest snapshot.

## Layout

```
servitals/
├── docker-compose.example.yml   # → docker-compose.yml (gitignored)
├── .env.example                 # → .env (gitignored)
├── nginx.conf
├── hub/
│   ├── Dockerfile
│   ├── server.js           # the login gateway (zero deps)
│   └── lib/                # log, password, clientip, origin
├── agent/
│   ├── Dockerfile
│   └── collect.sh          # the whole agent
├── bin/
│   └── servitals-ctl       # bans · unban · whitelist · hash-password
├── data/                   # bans.json, whitelist.txt, secret, audit.log (gitignored)
├── test/                   # node --test suites, budget and smoke scripts
└── www/
    ├── index.html          # the whole UI
    ├── config.example.json # copy to config.json (gitignored) and edit
    ├── fonts/              # self-hosted JetBrains Mono and Press Start 2P (OFL)
    └── data.json           # generated by the agent (gitignored)
```
