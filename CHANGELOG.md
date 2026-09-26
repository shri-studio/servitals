# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
