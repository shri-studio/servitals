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

## Install on Ubuntu (24.04 and 26.04)

```bash
sudo add-apt-repository ppa:prabzo/servitals
sudo apt install servitals
sudo cat /var/lib/servitals/initial-password
```

Open `http://<host>:20002`, log in as `admin` with that password, then
change the name and password under settings → login (or
`sudo servitals-ctl passwd --user <name>`). The package pairs the local
agent and starts both services. `man servitals`, `man servitals-ctl` and
`man servitals-agent` describe the rest; settings live in
`/etc/servitals/hub.env` and `/etc/servitals/agent.env`.

Coming from `packaging/install-local.sh`: run
`sudo packaging/install-local.sh --uninstall`, then install the package
with `sudo apt install -o Dpkg::Options::=--force-confold servitals` to
keep your `hub.env`. Login, node and agent credentials are kept. Turn
Docker access back on afterwards (`sudo servitals-agent docker enable`).

## Customize

Settings (`s`) has everything in one place:

- **Units**: °C or °F, sizes in powers of 1024 (like `df -h`) or 1000 (like
  drive labels), network in bytes or bits per second, a 12 or 24 hour clock.
- **Servers**: rename a server or change its tags (saved at once), pin it to
  the front of the fleet, hide it from the fleet, or revoke it (LAN only;
  its agent is refused from then on). Sort the fleet by name, trouble first,
  CPU, memory, temperature or fullest disk, group it by each server's first
  tag, and pick up to four numbers for the cards.
- **Panels**: which panels show and how wide, for every server or only one;
  the order is shared (drag, or the arrow buttons on touch screens).
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

## On your phone

Over HTTPS (a tunnel, a reverse proxy with TLS, or Tailscale with a
certificate; browsers allow it on nothing else but the machine itself), open the dashboard in the phone's browser and choose "Install"
or "Add to Home Screen": servitals opens full screen like an app. When the hub
cannot be reached it still opens, from its last copy, and shows that it is
offline. Settings and data always come live from the hub; logging out removes
the copy.

## Backups and rotation

```bash
sudo servitals-ctl backup /root/servitals.tar.gz         # --encrypt asks for a passphrase
sudo servitals-ctl backup enable                         # daily, the 7 newest kept
sudo servitals-ctl restore /root/servitals.tar.gz        # --etc also restores hub.env and conf.d
sudo servitals-ctl node rotate <id|--all>                # new secrets; old ones work for 24 hours
sudo servitals-ctl rotate session-key                    # every browser logs in again
```

See [docs/backup.md](docs/backup.md).

## Styles, modes and kiosk

Ten styles: classic, 8bit, phosphor (green CRT in dark mode, amber in
light), e-ink (pure black and white for e-ink wall displays), high contrast
(WCAG AAA, colour-blind-safe status colours, shaped status lamps), and the
nord, gruvbox, dracula, catppuccin and solarized palettes. `y` cycles the
style and `t` the mode (system, light, dark) for this browser; settings →
appearance also sets the density (compact, comfortable, large; large needs a
screen at least 720 px wide), and with "make this look everyone's default"
ticked, saving makes it the default for every browser that has not picked
its own. Open `/?kiosk` for a wall screen: big type, no controls, and it
moves to the next server every 20 seconds. The screen remembers it, also
across a new login; `/?kiosk=0` turns it off again, even when settings →
appearance turns kiosk on for every screen.

## Sensors and network history

Temperatures come from the kernel's sensor drivers (every chip it exposes;
the CPU is the headline). If a motherboard shows none, `sudo apt install
lm-sensors && sudo sensors-detect` loads the right driver. The network
panel's live rate needs nothing; today, month, all-time and the 30-day /
24-hour bars come from vnStat, which the package recommends (`apt install
vnstat` if you skipped recommends). Without it the panel says so.

## Watch more servers

```bash
sudo servitals-ctl node add nas --tag home        # on the hub: prints a join command
sudo servitals-agent join http://hub.lan:20002 <node-id>:<secret>   # on the server
```

On an HTTPS hub (a tunnel or a reverse proxy with TLS) there is nothing to
copy: run `sudo servitals-agent link https://dash.example.org` on the server,
then open `/link` on the hub and type the short code it shows.

With a second server the dashboard opens on the fleet grid: one card per
server with its status lamp, CPU, memory, temperature, a CPU sparkline and
the fullest disk. Click a card, or a tab, for that server's panels; `f`
goes back to the fleet. Container buttons are only offered for the hub's
own host. Agents only make outbound requests, so watched servers need no
open port: see [docs/networking.md](docs/networking.md) for LANs,
Tailscale, Cloudflare tunnels, reverse proxies and HTTP proxies.

## Native install (systemd, no Docker)

To run a checkout without the packages (development), install it in the same layout: The layout,
users and units are the ones the packages will use.

```bash
sudo apt install nodejs jq curl vnstat
git clone https://github.com/shri-studio/servitals && cd servitals
sudo packaging/install-local.sh          # asks for the admin name and password
```

Moving from the Docker install? `sudo packaging/install-local.sh
--import-docker /path/to/old/servitals` copies your login, dashboard
settings (`config.json`: title, disk labels, clocks, weather), whitelist
and `DISKS`/`NET_IFACE` from it, so the native dashboard looks the same.
`servitals-ctl import-docker <dir>` does the same on an installed hub.
Container controls stay LAN-only (`CTL_LAN_ONLY=1`) even if the Docker
install allowed them for everyone.

Disks: `DISKS=auto` (the default) shows every real disk and network
filesystem; list mountpoints instead to choose. Disks without a label in
the settings show a short name (`/` is "system", `/mnt/backup` is "backup").

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
