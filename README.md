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
| `gateway` | `node:22-alpine` | login gateway on `PORT`; the only exposed port. Session cookie, per-IP lockout, whitelist. Proxies authed traffic to `web`; answers `/data.json` and `/config.json` itself and takes the agent's signed pushes on `/api/v1/agent/*`. Serves `/__ctl/*` (refresh + LAN-only container start/stop/restart/logs via the docker socket). |
| `web`   | `nginx:alpine` | serve `www/` (the static page and fonts); internal only |
| `agent` | `alpine` + bash | reads host metrics and pushes a snapshot to the gateway over the signed agent API every `INTERVAL` seconds (default 60), and at once when the dashboard asks for fresh data |

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
git clone https://github.com/shri-studio/servitals.git
cd servitals

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
(all of this is also editable live in the settings panel later). On its first start the gateway copies this file to `data/config.json`; from then on the settings panel writes `data/config.json`, and later edits to `www/config.json` are ignored.

```sh
docker compose up -d --build
```

Open `http://<host>:<PORT>` (default `20002`) and log in. The first snapshot
takes a few seconds — the panels show "connecting…" until then.

**Upgrading an existing Docker install:** replace the whole `services:`
section of your `docker-compose.yml` with the one from
`docker-compose.example.yml` (then re-apply your own edits), and add its
`volumes:` block. The gateway needs its new `LOCAL_HUB_URL` and `WWW_DIR`
lines and the `./www:/www:ro` mount; without `LOCAL_HUB_URL` the agent
container tries to reach the gateway on its own loopback and the dashboard
stays empty. Then `docker compose up -d --build`. The gateway moves
`www/config.json` into `data/` on its first start.

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

## Native install (systemd, no Docker)

Until the Ubuntu packages exist, install from a checkout. The layout,
users and units are the ones the packages will use.

```bash
sudo apt install nodejs jq curl vnstat
git clone https://github.com/shri-studio/servitals && cd servitals
sudo packaging/install-local.sh          # asks for the admin password
```

| what | where |
| --- | --- |
| hub settings | `/etc/servitals/hub.env` (then `sudo systemctl restart servitals`) |
| agent settings | `/etc/servitals/agent.env` (then `sudo systemctl restart servitals-agent`) |
| hub state | `/var/lib/servitals` |
| logs | `journalctl -u servitals -u servitals-agent` |
| one sample, printed | `servitals-agent test` |

Containers: the agent needs the Docker socket to list them and the hub
needs it for the restart/stop/logs buttons. **The `docker` group can take
over the host as root**, so both are off until you turn them on:
`sudo servitals-agent docker enable`, `sudo servitals-ctl docker enable`.

Upgrade: `git pull && sudo packaging/install-local.sh`.
Remove: `sudo packaging/install-local.sh --uninstall` (keeps settings and state).

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

**Save** writes `data/config.json` (native install: `/var/lib/servitals/config.json`) via the gateway
(`POST /__ctl/config`), so every viewer sees the same layout and icon. If
that endpoint isn't reachable it falls back to this browser's
`localStorage`, and "export json" prints the config to paste in by hand.

`data/` is git-ignored; example settings live in
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

**Refresh — demand-driven.** The agent keeps one signed long-poll request
open to the gateway (`GET /api/v1/agent/wait`). When the dashboard asks for
fresh data (on load, every `refreshSec` while the tab is visible, or `r`),
the gateway answers that request and the agent samples and pushes within
about two seconds. A refresh within 5 s of the last push is answered from
the latest snapshot. With no viewer the agent pushes every `INTERVAL`
seconds (default 60). The live network rate is an average over whichever
gap produced the latest snapshot.

## Layout

```
servitals/
├── docker-compose.example.yml   # → docker-compose.yml (gitignored)
├── .env.example                 # → .env (gitignored)
├── nginx.conf
├── hub/
│   ├── Dockerfile
│   ├── server.js           # the login gateway (zero deps)
│   └── lib/                # log, password, clientip, origin, static, fsutil, agentsig, nodes, agentapi
├── agent/
│   ├── Dockerfile
│   ├── collect.sh          # the agent loop
│   └── lib/                # one file per metric group, plus log, hmac, api
├── bin/
│   ├── servitals-ctl       # bans · unban · whitelist · hash-password · docker
│   └── servitals-agent     # run · test · docker enable|disable
├── packaging/              # systemd units, sysusers, default env files, install-local.sh
├── data/                   # bans, whitelist, secret, audit.log, config.json, nodes.json, local-agent.env, snapshots/ (gitignored)
├── test/                   # node --test suites, budget and smoke scripts
└── www/
    ├── index.html          # the whole UI
    ├── config.example.json # copy to config.json (gitignored) and edit
    └── fonts/              # self-hosted JetBrains Mono and Press Start 2P (OFL)
```
