# servitals

Formerly **systemdashboard**. Licensed under AGPL-3.0-or-later. <!-- legacy-name -->

A small, self-hosted, terminal-styled dashboard and monitor for your servers.
One **hub** shows every server live (memory, CPU, temperature, disks, network,
containers, processes, updates, hardware), keeps 90 days of history, and
sends alerts to your phone, chat or inbox. A tiny **agent** on each server
pushes its numbers to the hub. Zero runtime dependencies: Node.js for the hub,
bash, curl and jq for the agent.

![panels: memory · cpu · thermal · storage · network · services · clocks · weather](docs/preview.png)

## What you get

- **A fleet view** of every server (status lamp, the numbers you choose, a
  sparkline, the fullest disk, an alert badge) and a **view per server** with
  its panels: memory, CPU (iowait, steal, pressure), thermal, storage (with
  read/write rates), network (vnStat history), containers (with start, stop,
  restart and logs on the hub's own host), processes, Ubuntu updates and
  failed units, fans, voltages and battery, weather and world clocks.
- **History** of any series over 1 hour to 90 days, with averages, low-high
  bands and gaps.
- **Alerts** for offline servers, full disks, memory, CPU, temperature,
  stopped containers, failed units, needed reboots and security updates; rules
  you can change, add to and override per server or tag; mutes.
- **Notifications** through ntfy, Gotify, Telegram, Discord, Slack, Microsoft
  Teams, Pushover, Matrix, email, webhooks, Apprise and Web Push to the
  installed phone app, with quiet hours and a daily digest.
- **Agents only call out**: watched servers need no open port, and work over
  a LAN, Tailscale, a Cloudflare tunnel, a reverse proxy or an HTTP proxy.
- Ten styles (classic, 8bit, phosphor, e-ink, high contrast, nord, gruvbox,
  dracula, catppuccin, solarized), light and dark, three densities, a kiosk
  mode for wall screens, and an installable phone app.

## Install

### Ubuntu 24.04 and 26.04

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

### Docker (one host)

Needs Docker with the Compose plugin, and `vnstat` running on the host for
network history (`sudo apt install vnstat`).

```sh
git clone https://github.com/shri-studio/servitals.git
cd servitals
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
cp www/config.example.json www/config.json
```

In `.env` set `AUTH_USER` and `AUTH_PASS_HASH` (run
`bin/servitals-ctl hash-password` and paste the result in single quotes), and
`PORT`, `TZ` (the host's time zone), `NET_IFACE` and `DISKS` if the defaults
do not fit. Then `docker compose up -d --build` and open `http://<host>:<PORT>`.
Three containers run: `gateway` (the hub, the only published port), `web`
(nginx serving the page) and `agent` (reads the host through a read-only
bind mount with `rslave` propagation, and the Docker socket read-only).

**Upgrading an existing Docker install:** replace the whole `services:`
section of your `docker-compose.yml` with the one from
`docker-compose.example.yml` (then re-apply your own edits), and add its
`volumes:` block. The gateway needs its new `LOCAL_HUB_URL` and `WWW_DIR`
lines and the `./www:/www:ro` mount; without `LOCAL_HUB_URL` the agent
container tries to reach the gateway on its own loopback and the dashboard
stays empty. Then `docker compose up -d --build`. The gateway moves
`www/config.json` into `data/` on its first start.

A tunnel or reverse proxy on the same host connects from the Docker network's
gateway, `172.31.250.1`, the default `TRUSTED_PROXIES`, so its
`X-Forwarded-For` gives the real client address. Forwarding headers from any
other address are ignored, so nobody can fake a LAN address.

### Native install (systemd, no Docker)

To run a checkout without the packages (development), install it in the
same layout, with the users and units the packages use:

```bash
sudo apt install nodejs jq curl vnstat
git clone https://github.com/shri-studio/servitals && cd servitals
sudo packaging/install-local.sh          # asks for the admin name and password
```

Moving from the Docker install? `sudo packaging/install-local.sh
--import-docker /path/to/old/servitals` copies your login, dashboard
settings, whitelist and `DISKS`/`NET_IFACE` from it.
`servitals-ctl import-docker <dir>` does the same on an installed hub.

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

## Watch more servers

```bash
sudo servitals-ctl node add nas --tag home        # on the hub: prints a join command
sudo servitals-agent join http://hub.lan:20002 <node-id>:<secret>   # on the server
```

On an HTTPS hub there is nothing to copy: run
`sudo servitals-agent link https://dash.example.org` on the server, then open
`/link` on the hub and type the short code it shows.

With a second server the dashboard opens on the fleet grid. Click a card or a
tab for that server's view; `f` goes back to the fleet. Settings → servers
renames, tags, pins, hides or revokes servers. See
[docs/networking.md](docs/networking.md) for LANs, Tailscale, Cloudflare
tunnels, reverse proxies and HTTP proxies.

## History, alerts and notifications

- **History:** each server's view has a history panel: any series (cpu,
  memory, temperature, load, pressure, disks, network, containers) over 1 hour
  to 90 days, with its average, low-high band and gaps.
- **Alerts:** `a` opens the alerts view: what is firing, running mutes and the
  last events; mute a rule or a server for an hour, a day or a week. Its
  "rules" tab changes thresholds, adds rules of your own and sets per-server
  or per-tag overrides (turn "offline" off for a laptop).
- **Where alerts go:** the "channels" tab: ntfy, Gotify, Telegram, Discord,
  Slack, Microsoft Teams, Pushover, Matrix, email (SMTP with STARTTLS or TLS),
  webhooks and Apprise, each from a chosen severity; quiet hours hold
  warnings; info goes to a daily digest; every channel has "send test" and
  shows its last error. Tokens can come from `$SERVITALS_NOTIFY_<NAME>`
  variables in `hub.env` instead of the page.
- **Phone notifications:** over HTTPS, settings has "enable notifications" on
  each phone or computer (on iPhone and iPad, from the home-screen app). See
  [docs/networking.md](docs/networking.md#https-for-phone-notifications).

## Customize

Settings (`s`) has everything in one place: the dashboard's name and icon,
units (°C or °F, 1024 or 1000, bytes or bits, 12 or 24 hour clock), which
panels show and how wide (for every server or one), the fleet's sort, groups
and card numbers, weather locations, world clocks, disk labels, styles and
modes, kiosk, the login, phone notifications, and export and import of the
settings as one JSON file.

`y` cycles the style and `t` the mode for this browser; with "make this look
everyone's default" ticked, saving makes it the default for every browser.
Open `/?kiosk` for a wall screen: big type, no controls, the next server every
20 seconds; `/?kiosk=0` turns it off again.

| key | action |
| --- | --- |
| `r` | refresh now |
| `s` | settings |
| `a` | alerts |
| `f` | the fleet |
| `t` | mode: system, light, dark |
| `y` | style |
| `esc` | close a dialog |

**Config as code:** every `*.json` in `/etc/servitals/conf.d` (read in name
order, later files win) can set the dashboard's defaults and servers' tags
or names; values from files win over the page, which shows them as "managed
by file". `sudo servitals-ctl config check` checks them, and
`/etc/servitals/conf.d/README` lists every allowed value.

## On your phone

Over HTTPS, open the dashboard in the phone's browser and choose "Install" or
"Add to Home Screen": servitals opens full screen like an app. When the hub
cannot be reached it still opens from its last copy and says so. Logging out
removes the copy.

## Backups and rotation

```bash
sudo servitals-ctl backup /root/servitals.tar.gz         # --encrypt asks for a passphrase (AES-256-GCM)
sudo servitals-ctl backup enable                         # daily, the 7 newest kept
sudo servitals-ctl restore /root/servitals.tar.gz        # --etc also restores hub.env and conf.d
sudo servitals-ctl node rotate <id|--all>                # new secrets; old ones work for 24 hours
sudo servitals-ctl rotate session-key                    # every browser logs in again
sudo servitals-ctl rotate vapid                          # new Web Push keys; devices enable notifications again
```

See [docs/backup.md](docs/backup.md).

## Sensors and network history

Temperatures come from the kernel's sensor drivers (every chip it exposes;
the CPU is the headline). If a motherboard shows none, `sudo apt install
lm-sensors && sudo sensors-detect` loads the right driver. The network
panel's live rate needs nothing; today, month, all-time and the 30-day /
24-hour bars come from vnStat, which the package recommends. Without it the
panel says so. Weather comes from [Open-Meteo](https://open-meteo.com) in the
browser, without a key.

## Configuration

`/etc/servitals/hub.env` (Docker: `.env`):

| setting | default | meaning |
| --- | --- | --- |
| `PORT` | `20002` | the dashboard's port |
| `BIND_ADDR` | all | `127.0.0.1` when only a local tunnel or proxy should connect |
| `AUTH_USER`, `AUTH_PASS_HASH` | `admin`, — | the login (`servitals-ctl passwd` sets both); `AUTH_PASS` is a plain fallback |
| `MAX_FAILS`, `BAN_HOURS` | `3`, `0` | failed logins before an address is blocked, and for how long (0: until `servitals-ctl unban`) |
| `SESSION_HOURS` | `720` | how long a login lasts |
| `WHITELIST` | private ranges | addresses never blocked; LAN access can never be locked out |
| `TRUSTED_PROXIES`, `PROXY_HEADER` | loopback, `x-forwarded-for` | the only peers whose forwarding headers count |
| `PUBLIC_URL` | — | the dashboard's public address behind a proxy |
| `CTL_LAN_ONLY` | `1` | container controls for whitelisted (LAN) clients only |
| `CONFD_DIR` | `/etc/servitals/conf.d` | config as code |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | — | the proxy for alert channels and Web Push |
| `VAPID_SUBJECT` | `PUBLIC_URL` | who runs this hub, for Web Push |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `logfmt` | `error`…`debug`; `json` for log shippers |

`/etc/servitals/agent.env`:

| setting | default | meaning |
| --- | --- | --- |
| `INTERVAL` | `60` | heartbeat in seconds; the hub wakes the agent sooner when someone looks |
| `DISKS` | `auto` | every real disk and network filesystem, or a list such as `/,/srv,/mnt/backup` |
| `NET_IFACE` | the first vnStat knows | the network panel's interface |
| `COLLECT_*` | `1` | `0` turns a metric group off (MEM, CPU, PRESSURE, TEMP, DISKS, NET, DOCKER) |
| `STAT_TIMEOUT` | `5` | seconds before a dead network share is given up |
| `WAIT_SECONDS` | `55` | long-poll hold; lower it when a proxy cuts idle connections |
| `HTTPS_PROXY`, `NO_PROXY` | — | a proxy to a remote hub |
| `HUB_HEADERS`, `HUB_CA_FILE` | — | extra headers (Cloudflare Access) and a private CA for an HTTPS hub |

## Security

The hub is the only thing listening; agents sign every push with a per-server
secret (HMAC) that never crosses the network, and never run anything a hub
sends. The page has a strict CSP, every value from an agent is validated and
escaped, logins are scrypt-hashed with per-address lockout, and secrets
(tokens, keys, passwords) are kept 0600 and never logged. Container control
is off until you turn it on, and LAN-only after that.
[docs/threat-model.md](docs/threat-model.md) has the whole picture;
[SECURITY.md](SECURITY.md) says how to report a problem.

## How it works

The agent keeps one signed long-poll request open to the hub
(`GET /api/v1/agent/wait`). When someone looks at the dashboard (on load,
every `refreshSec` while the tab is visible, or `r`), the hub answers it and
the agent samples and pushes within about two seconds. With nobody looking it
pushes every `INTERVAL` seconds. The hub validates each snapshot, keeps it,
adds it to the history (`/var/lib/servitals/history`), and judges the alert
rules. [docs/protocol.md](docs/protocol.md) describes the protocol.

| metric | source on the server |
| --- | --- |
| memory, swap | `/proc/meminfo` |
| CPU, per core, iowait, steal, load | `/proc/stat` deltas, `/proc/loadavg` |
| pressure | `/proc/pressure/*` |
| temperature, fans, voltages | `/sys/class/hwmon/*`, thermal zones |
| battery | `/sys/class/power_supply/*` |
| disks | `statvfs` per mount; model, rotational and I/O from `/sys/class/block`, `/proc/diskstats` |
| network | vnStat, and rates from `/sys/class/net/*/statistics` |
| containers | the Docker socket (when enabled) |
| processes | `/proc/<pid>/stat` |
| updates, reboot, failed units | update-notifier's files, `/run/reboot-required`, `systemctl --failed` |

## Docs

- [docs/networking.md](docs/networking.md): pairing servers, every network setup, HTTPS
- [docs/backup.md](docs/backup.md): backups, restore and rotating secrets
- [docs/protocol.md](docs/protocol.md): the agent protocol and the snapshot
- [docs/threat-model.md](docs/threat-model.md): what is defended, and how
- [docs/release.md](docs/release.md): how releases are made
- [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md)

## Layout

```
servitals/
├── hub/
│   ├── server.js           # the hub: login, page, agent API, history, alerts (zero deps)
│   └── lib/                # one module per concern: nodes, snapshot, history, alerts, notify, proxy, smtp, webpush…
├── agent/
│   ├── collect.sh          # the agent loop
│   └── lib/                # one file per metric group, plus log, hmac, api
├── bin/
│   ├── servitals-ctl       # the hub's admin command
│   └── servitals-agent     # join, link, test, docker enable|disable
├── www/                    # the page: index.html, app.css, js/ (app, settings, history, alerts), styles/, sw.js
├── packaging/              # env files, conf.d README, build, autopkgtest, install-local.sh
├── debian/                 # the Ubuntu packages
├── docs/                   # the guides above, and the design spec and plans
├── test/                   # node --test suites, budget, screens and smoke scripts
├── docker-compose.example.yml, .env.example
└── man/                    # man pages
```
