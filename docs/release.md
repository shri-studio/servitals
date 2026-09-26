# Releasing servitals

1. Set `VERSION` (for example `0.2.0`), move the `## [Unreleased]` notes in
   `CHANGELOG.md` under `## [0.2.0] - <date>`, and add a `debian/changelog`
   entry `servitals (0.2.0-1) resolute; urgency=medium` (`dch -v 0.2.0-1`).
   `test/version.test.js` checks that `VERSION` and `debian/changelog` agree.
2. `packaging/build-deb.sh && packaging/autopkgtest.sh`: both series build,
   lintian is clean, the autopkgtests pass.
3. Commit, tag `v0.2.0`, push the branch and the tag.
4. Upload to the PPA from a clean checkout of the tag:

   ```bash
   UPLOAD=1 DEBSIGN_KEYID=<your key id> packaging/ppa-upload.sh ppa:prabzo/servitals
   ```

   It builds `0.2.0-1~ppa1~noble1` and `~resolute1` source packages, signs
   them with `debsign` and uploads them with `dput`. To rebuild the same
   version, raise `PPA_REV=2`.
5. When Launchpad has built both series, test the published packages:

   ```bash
   PPA_SETUP=ppa:prabzo/servitals packaging/autopkgtest.sh
   ```

## One-time setup for uploads

- A Launchpad account with the PPA `servitals` (under the team or user in
  the `ppa:` name).
- A GPG key: `gpg --full-generate-key`, then
  `gpg --keyserver keyserver.ubuntu.com --send-keys <fingerprint>`, and add
  the fingerprint on Launchpad (OpenPGP keys) and confirm the emailed token.
- `sudo apt install devscripts dput` on the upload host. The key stays on
  that host; CI only builds the source packages as a dry run.
