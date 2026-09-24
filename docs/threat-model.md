# servitals threat model

Scope: the `servitals` hub, the `servitals-agent` collector, the hosted
service at `servitals.prabzo.com`, the relay between them, and the release
pipeline. Protocol details are in `docs/protocol.md`.

## Invariants

These hold in every version. A change that breaks one needs its own review.

1. **The agent never executes anything a hub sends.** The only instruction a
   hub can give is "sample now". Replies are signed; unsigned or badly signed
   replies are ignored.
2. **A node's secret never crosses the network.** It is typed or pasted by an
   admin and used only as an HMAC key.
3. **Snapshots are untrusted input.** The hub validates them against the
   schema before storing, and the page escapes every string it renders.
4. **Container control exists only for the hub's own host**, only for
   whitelisted (LAN) clients by default, and only when the admin enabled
   Docker access. The hosted service has no control features at all.
5. **Secrets are never logged**: passwords, cookies, node secrets, relay keys,
   signatures, tokens, push subscription keys.
6. **Zero runtime dependencies.** No package registry is in the supply chain
   of an installed system.

## Assets, attackers, defences

| asset | attacker | impact | defence |
| --- | --- | --- | --- |
| client IP identity | anyone reaching the port directly | forge a LAN address, skip lockout, get container control | proxy headers honoured only from peers in `TRUSTED_PROXIES` (loopback by default); a proxy's own address is never whitelisted; compose pins its gateway address |
| hosted outbound requests | hosted user | SSRF into the hosting network or cloud metadata | destination resolved, private and special ranges refused, IP pinned, no redirects |
| backup files | anyone who copies one | admin hash, node secrets, channel tokens | written 0600; `--encrypt` option; hosted backups always encrypted |
| admin login | internet bots | dashboard access | scrypt; per-IP lockout after `MAX_FAILS`; LAN whitelist; 800 ms delay on failure; TOTP on hosted |
| browser session | XSS, CSRF | act as the admin | escaping plus schema validation; `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS; `Origin` check on state changes; strict CSP (no inline script or style) |
| node secret | LAN sniffer | forge that node's data | HMAC only; secret never sent; replay and skew checks |
| hub page | compromised node | script injection into the admin's browser | schema validation (types, ranges, lengths, unknown keys dropped); escaping; Playwright test with hostile strings in every field |
| hub availability | compromised node, bots | resource exhaustion | size limits before parsing; one push per 5 s; one wait per node; 10 bad signatures per minute per IP then `429` |
| agents | rogue or compromised hub, DNS hijack | control of nodes | invariant 1; reply signatures |
| hub host | anyone with container control | root on the hub host | Docker access off by default; LAN-only control; root equivalence stated in docs and in `docker enable` output |
| hosted database | breach, stolen backup | every account's data | scrypt passwords; node secrets and TOTP secrets AES-256-GCM encrypted with a master key held only in the environment; backups encrypted |
| relay key | leak | fake nodes in one hosted account | scoped to one account and its node limit; revocable in the hosted UI |
| push subscriptions | leak | spam notifications to one browser | stored 0600; VAPID key rotation invalidates them |
| release pipeline | supply chain | malicious package | GPG signing key only in CI secrets; signed `SHA256SUMS`; GitHub Actions pinned by commit; zero dependencies |
| user privacy (hosted) | operator, breach | exposure of infrastructure details | latest snapshot plus capped history only; no analytics; IPs kept 30 days; inactive accounts deleted |

## Known and accepted risks

- Metrics sent over plain HTTP on a LAN can be read by anyone on that LAN.
  They cannot be forged. Guides recommend Tailscale or TLS across networks.
- A local user on a node who can read `/etc/servitals/agent-credentials.env`
  is already root or the agent user, and can forge that node's data. The file
  is 0600.
- Delivery metadata of Web Push (that a notification went to a device, and
  when) is visible to the browser vendor's push service. The content is
  end-to-end encrypted.
- Cloudflare Bot Fight Mode can block agents that report through a tunnel.
  This is an availability issue documented in the tunnel guide.

## Compromise and recovery

**A node is compromised.** Revoke it (`servitals-ctl node rm <id>`) or rotate
its secret. The attacker could only have sent that node's data.

**A self-hosted hub is compromised.** The attacker has every node secret and
can forge data from any node, read all history, and, if Docker access was
enabled, control the hub host. They cannot run anything on other nodes. Clean
the host, restore from a backup taken before the compromise, then run
`servitals-ctl node rotate --all`, `servitals-ctl passwd`,
`servitals-ctl rotate session-key` and `servitals-ctl rotate vapid`, and
re-run `join` on each node.

**The hosted service is compromised.** Rotate the master key and re-encrypt,
force password resets, revoke all sessions and relay keys, notify users and
tell them to rotate node secrets. Snapshots and history already taken are
exposed.

**A release signing key leaks.** Revoke the key, publish the revocation,
publish a new key through the GitHub repository and the PPA, and rebuild the
latest release.

## Rotation

| secret | command | effect |
| --- | --- | --- |
| node secret | `servitals-ctl node rotate <id\|--all>` | old and new accepted for 24 h, then old rejected |
| admin password | `servitals-ctl passwd` | all sessions end |
| session signing key | `servitals-ctl rotate session-key` | all sessions end |
| VAPID keys | `servitals-ctl rotate vapid` | browsers must enable notifications again |
| relay key | hosted UI, then `servitals-ctl relay set` | old key rejected at once |
| hosted master key | operator runbook | re-encrypts stored secrets |
