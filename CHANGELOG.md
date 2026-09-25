# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Renamed from systemdashboard to **servitals**. The session cookie is now
  `sv_session`, so everyone logs in once after upgrading.
- Source tree: `auth/` is now `hub/`, `collector/` is now `agent/`. Compose
  services are `gateway`, `web` and `agent`.
- Proxy headers are trusted only from `TRUSTED_PROXIES` peers, using the
  rightmost `X-Forwarded-For` entry. `TRUST_PROXY` is deprecated.
- Logs are structured (logfmt or JSON) with levels; security events also go
  to `data/audit.log`.

### Added
- scrypt password hashes (`bin/servitals-ctl hash-password`).
- `bin/servitals-ctl` for bans, unban, whitelist and password hashing.
- License: AGPL-3.0-or-later.

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
5. `docker compose up -d --build`. `data/` is kept.
