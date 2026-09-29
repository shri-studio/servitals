# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Backups and rotation (spec 17): `servitals-ctl backup [--encrypt]`,
  `restore [--etc]` (stops and starts the hub, keeps the state it replaces),
  daily backups on a timer (`backup enable`, 7 kept), `node rotate <id|--all>`
  (the old secret works for 24 hours), `rotate session-key`; `docs/backup.md`.
- Config as code (spec 12): `/etc/servitals/conf.d/*.json` sets dashboard
  defaults and server tags or names; file values win and show as "managed by
  file"; a bad file is skipped whole and logged; `servitals-ctl config check`.
- Customize (spec 10.4): units (°C/°F, 1024/1000 sizes, bits or bytes per
  second, 12/24 hour clock); rename, tag, pin, hide and revoke servers from
  settings; sort and group the fleet and choose the numbers on its cards;
  panels and sizes per server; up and down buttons for the panel order;
  import settings from an exported file.
- Link a server by code on HTTPS hubs: `servitals-agent link https://hub`
  prints a short code, a person approves it on the hub's `/link` page, and the
  agent joins with a secret it made itself (RFC 8628 pattern).
  `servitals-agent unlink` forgets the hub again.
- Styles: phosphor, e-ink, high contrast, nord, gruvbox, dracula,
  catppuccin and solarized join classic and 8bit. Each loads only when chosen
  (at most 3 KB); text contrast is checked for every style and mode.
- Mode switch with a system setting (the default), density (compact,
  comfortable, large), a hub-wide default look, and kiosk mode (`/?kiosk`).
- CI takes screenshots of every style and mode and fails on page errors.
- Watch several servers: `servitals-ctl node add|list|rename|revoke` and
  `servitals-agent join|status`. The dashboard shows a fleet grid and node
  tabs once there is a second server; container controls stay on the hub's
  own host.
- `HUB_HEADERS` (for example a Cloudflare Access service token) and
  `HUB_CA_FILE` for agents; `docs/networking.md`.

### Changed
- The page follows the system's light or dark setting until someone picks a
  mode (it used to start dark). The 8bit style moved out of the page into
  `styles/8bit.css`; its light colours are darker so text stays readable.
- Agent protocol: snapshots are fully validated (schema 1); agents send
  counters and the hub derives network rates, container CPU and the trend.
  Snapshot `ts` is in milliseconds. Upgrade the hub and its agents together:
  the hub refuses snapshots from older agents (`invalid_snapshot`). With
  Docker, rebuild both images (`docker compose up -d --build`).
- The agent stops asking a hub that no longer knows it (`unknown_node`) and
  resends a too-large snapshot without its lists.

### Fixed
- The settings panel is tidier: sections are separated, fields have captions
  and line up, every button and checkbox matches the page (also in dark
  mode), and nothing is squeezed on a phone. CI checks it at 390 and 1280 px.
- Password fields in settings look like the other fields.
- Long values (load, sensors, network totals) wrap instead of spilling out of
  narrow panels on phones and tablets.
- Browsers check for a newer page and style files on every load
  (`cache-control: no-cache`), so an upgrade shows at once.
- Without vnStat and `NET_IFACE`, the network panel disappeared; the agent
  now takes the interface of the default route, and the panel shows the live
  rate with a hint to install vnStat for history.
- Temperatures came only from a fixed list of chips (no `acpitz`, NVMe,
  `drivetemp`, `amdgpu`); every chip is read now and the CPU stays the
  headline. `servitals-agent` suggests `lm-sensors`.

### Security
- The dashboard runs under a strict Content-Security-Policy (spec 10.5): no
  inline script, no inline styles, only the hub itself and the weather service
  (`api.open-meteo.com`, `geocoding-api.open-meteo.com`). The page is now
  `index.html` (markup), `app.css`, `boot.js` and `js/app.js`; the settings
  panel (`js/settings.js`) loads when first opened. Login, ban and `/link`
  pages run no script at all. Docker's nginx sends the same policy.
- An address that keeps failing agent authentication gets `429` for a
  minute. The last accepted request time per node survives a hub restart,
  so captured requests cannot be replayed after it.

## [0.1.0] - 2026-09-26

### Added
- Ubuntu packages `servitals` and `servitals-agent` (noble, resolute) with a
  random first password in `/var/lib/servitals/initial-password`, the local
  agent paired on install, man pages, and autopkgtests.
- Change the admin name and password under settings → login or with
  `servitals-ctl passwd [--user NAME]`; both end every other session.
- Native install without Docker: hardened systemd units, `_servitals` and
  `_servitals-agent` system users, `/etc/servitals/*.env`, and
  `packaging/install-local.sh`.
- The gateway serves the page itself when `UPSTREAM` is unset.
- Agent protocol v1: the agent pushes signed snapshots to
  `/api/v1/agent/push` and waits on `/api/v1/agent/wait`; the dashboard's
  refresh wakes it.
- `servitals-agent` CLI (`run`, `test`, `docker enable|disable`) and
  `servitals-ctl docker enable|disable`.
- Metric groups can be turned off with `COLLECT_<GROUP>=0`.
- `DISKS=auto` (now the default) finds every real disk and network
  filesystem; disks without a label show a short default name.
- `servitals-ctl import-docker <dir>` and `install-local.sh --import-docker`
  bring a Docker install's login, settings, whitelist and disks to a native
  install. The installer asks for the admin name (default: the user who ran
  sudo) and prints it at the end.
- Product name, version and source link in the dashboard footer, and a
  one-time notice after an update. The version is shown only after login.
- scrypt password hashes (`bin/servitals-ctl hash-password`).
- `bin/servitals-ctl` for bans, unban, whitelist and password hashing.
- License: AGPL-3.0-or-later.

### Changed
- The admin login can live in `STATE_DIR/admin.json`, which wins over
  `AUTH_USER`/`AUTH_PASS_HASH`.
- The systemd units are hardened further: `systemd-analyze security` rates
  them 1.4 (hub) and 1.5 (agent), down from 7.8 and 7.9.
- State lives in `STATE_DIR` (`/var/lib/servitals` natively, `./data` in
  Docker); `config.json` moves there from `www/`.
- The agent lists containers through the Docker API with `curl` and reads
  their CPU from cgroup counters (no Docker CLI, no `docker stats`).
- Default agent heartbeat is 60 s (was 300 s).
- Renamed from systemdashboard to **servitals**. The session cookie is now
  `sv_session`, so everyone logs in once after upgrading.
- Source tree: `auth/` is now `hub/`, `collector/` is now `agent/`. Compose
  services are `gateway`, `web` and `agent`.
- Proxy headers are trusted only from `TRUSTED_PROXIES` peers, using the
  rightmost `X-Forwarded-For` entry. `TRUST_PROXY` is deprecated.
- Logs are structured (logfmt or JSON) with levels; security events also go
  to `data/audit.log`.

### Fixed
- A cifs share mounted over autofs was reported as autofs.
- A dead network share in `DISKS` could hang the agent.
- `DISKS` entries that are not mounted repeated the parent filesystem;
  they now show "not mounted".

### Security
- Fixed: a client that could reach the port directly could fake a LAN address
  with a forwarding header, skipping lockout and getting container controls.
- Fixed: an empty `AUTH_PASS` allowed logging in with an empty password. The
  gateway now refuses to start without a password.
- Fixed: logout and control requests could be triggered by other sites. They
  now require a same-origin `Origin` header, and logout is POST-only.

### Upgrading a Docker install
1. `docker compose down` in your install directory.
2. Pull the new version, then copy `docker-compose.example.yml` over your
   `docker-compose.yml` again and re-apply your own edits.
3. In `.env`, remove `TRUST_PROXY`. If a proxy in another container reaches
   the gateway, set `TRUSTED_PROXIES` to its address.
4. Optionally replace `AUTH_PASS` with `AUTH_PASS_HASH` from
   `bin/servitals-ctl hash-password`.
5. The gateway needs the new `LOCAL_HUB_URL` and `WWW_DIR` lines and the
   `./www:/www:ro` mount, and the agent service and `volumes:` block are new:
   take the whole `services:` section from the example.
6. `docker compose up -d --build`. `data/` is kept; `www/config.json` moves
   into it on the first start.
