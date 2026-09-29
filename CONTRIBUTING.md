# Contributing

Thanks for helping. A few rules keep servitals small:

- **No runtime dependencies.** The gateway uses Node.js built-ins only; the
  agent uses bash, coreutils, `jq`, `curl` and `vnstat`. Pull requests that
  add a package dependency will not be merged.
- **Node 18 compatible.** Ubuntu 24.04 ships Node 18. Do not use `fetch` or
  newer APIs in `hub/`.
- **Tests first.** Run `node --test test/*.test.js`, `bash test/budget.sh`
  and, if you touched Docker files, `bash test/compose-smoke.sh`.
- **Budget.** `test/budget.sh` must pass: page size, gateway memory and agent
  CPU limits are enforced in CI.
- **License.** Contributions are accepted under AGPL-3.0-or-later. New source
  files start with `SPDX-License-Identifier: AGPL-3.0-or-later`.
- **Words on the page** come from the dictionary, `hub/lib/i18n.js`. Add a key
  there and show it with `tr("key", { name: value })` in the page's scripts,
  `data-i18n="key"` in `www/index.html` and `trHtml("key")` in the hub's
  pages; values are plain text and are escaped where they are used.
  `test/i18n.test.js` fails on a word written straight into the page.
- **Security issues** go through `SECURITY.md`, not public issues.
