# Backups and rotation

## What a backup holds

`servitals-ctl backup <file>` writes one tar of:

- the hub's state (`/var/lib/servitals`): the login (`admin.json`, a scrypt
  hash), the session key, the servers and their secrets (`nodes.json`),
  dashboard settings, bans, the whitelist, the latest snapshots and the audit
  log; not earlier backups;
- `/etc/servitals/hub.env` and `/etc/servitals/conf.d`;
- a `manifest.json` with the servitals version that made it.

The file is created mode 0600: whoever reads it can pose as any of your
servers and try to crack the admin password. Keep it like a key.

```bash
sudo servitals-ctl backup /root/servitals-$(date +%F).tar.gz
sudo servitals-ctl backup --encrypt /mnt/usb/servitals.tar.gz.enc   # asks for a passphrase
```

`--encrypt` uses `openssl enc -aes-256-cbc -pbkdf2 -iter 600000` (install
`openssl` if it is missing). For scripts, put the passphrase in
`SERVITALS_BACKUP_PASSPHRASE`; it never appears on a command line.

## Daily backups

```bash
sudo servitals-ctl backup enable    # a systemd timer, once a day
sudo servitals-ctl backup disable
```

They go to `/var/lib/servitals/backups/` (0700), and the 7 newest are kept.
They are not encrypted and live on the same disk: copy them elsewhere, for
example with `rsync` from another machine, if the disk itself matters.

## Restore

```bash
sudo servitals-ctl restore /root/servitals-2026-09-28.tar.gz
sudo servitals-ctl restore --etc /root/servitals-2026-09-28.tar.gz   # also hub.env and conf.d
```

`restore` reads the whole file first (and asks for the passphrase of an
encrypted one); a wrong passphrase, a damaged file, or a backup made by a
newer servitals stops it before anything changes. Then it stops the hub,
moves the current state to `/var/lib/servitals.before-restore-…`, puts the
backup in place, gives the files to the hub's user and starts the hub.
Earlier daily backups stay. Every browser logs in again only if the backup
holds another session key.

Agents keep their own credentials, so a restore that brings back the same
servers needs nothing on them. Servers paired after the backup was made are
gone from the hub: pair them again.

## Rotation

| secret | command | effect |
| --- | --- | --- |
| a server's secret | `sudo servitals-ctl node rotate <id>` | prints a new join line; the old secret keeps working for 24 hours |
| every server's secret | `sudo servitals-ctl node rotate --all` | the same for each; the hub's own agent is updated at once |
| session key | `sudo servitals-ctl rotate session-key` | the hub restarts; every browser logs in again |
| admin password | `sudo servitals-ctl passwd` | every session ends |

After `node rotate`, run the printed `servitals-agent join` line on each
server within 24 hours; after that the old secret is refused. On a Docker
install, restart the agent container after rotating the hub's own node.
