# Networking: how agents reach the hub

Agents only make outbound HTTPS (or HTTP) requests to the hub. A watched
server needs no public address and no open port; only the hub must be
reachable by its agents. Everything below is about making the hub
reachable, and about the proxies and tunnels in between.

## Pair a server

On the hub:

```bash
sudo servitals-ctl node add nas --tag home
# added "nas" as node k3j7q2m4x5ab. On that server, run once (the secret is shown only now):
#   sudo servitals-agent join http://hub.lan:20002 k3j7q2m4x5ab:9f0c…
```

On the server (after `apt install servitals-agent`), run the printed line.
`join` sends one test push and says `ok`, or what went wrong (see
[Troubleshooting](#troubleshooting)). Set `PUBLIC_URL` in
`/etc/servitals/hub.env` when agents should use another address than the
hub's host name, for example a tunnel hostname.

### Or link with a short code (HTTPS hubs)

When the hub is reachable over HTTPS (a tunnel, a reverse proxy with TLS, or
Tailscale with `tailscale cert`), skip the copying. On the server:

```bash
sudo servitals-agent link https://dash.example.org
#   Open https://dash.example.org/link and enter:  WXKP-4M7R
#   Only enter this code on that site, in your own account.
#   Waiting for approval... (expires in 10 min)
```

Open `/link` on the hub, log in, type the code, check the host name, system
and address shown, pick a name and tags, and approve. The agent then tests
a push, saves its credentials and starts:
`Linked as "nas" to a***n on dash.example.org.` If that is not your hub,
run `sudo servitals-agent unlink`.

The server makes its own secret and sends it to the hub once, inside TLS.
For that reason `link` refuses `http://` addresses (except this machine
itself), and the hub refuses link requests that did not arrive over HTTPS.
Plain-HTTP hubs on a LAN keep using `join`.

## Pick a setup

| situation | what to do |
| --- | --- |
| all servers on one LAN | agents use the hub's LAN address: `http://hub.lan:20002` |
| servers on different sites | Tailscale or WireGuard; agents use the hub's private overlay address (recommended) |
| hub behind a Cloudflare tunnel | agents use the tunnel hostname; turn off Bot Fight Mode for it; Cloudflare Access needs a service token in `HUB_HEADERS` |
| hub behind a reverse proxy | TLS at the proxy; set `TRUSTED_PROXIES` in `hub.env` to the proxy's address |
| server with no outbound internet except one allowed destination | allow outbound 443 to the hub hostname only |
| server that reaches the internet through an HTTP proxy | `HTTPS_PROXY` in `agent.env`; lower `WAIT_SECONDS` if the proxy drops idle connections |
| many private servers in a closed network | run a self-hosted hub inside it (relaying chosen nodes to the hosted service comes later) |
| phone notifications (Web Push, later) | the hub must be served over HTTPS (tunnel, Tailscale certificate, or reverse proxy) |

### Same LAN

Nothing to set up. Use the address `servitals-ctl node add` prints, or put
`PUBLIC_URL=http://<lan address>:20002` in `hub.env` first.

### Tailscale or WireGuard

Install Tailscale on the hub and the servers. Use the hub's Tailscale name
or address: `http://hub.tailnet-name.ts.net:20002`. With
`tailscale cert` and a reverse proxy the hub can also serve HTTPS; plain
HTTP inside the tailnet is already encrypted by WireGuard.

### Cloudflare tunnel

1. Point a public hostname of the tunnel at `http://localhost:20002` on the
   hub (loopback: the hub then trusts the tunnel's `X-Forwarded-For`).
2. **Turn off Bot Fight Mode** for that hostname. It cannot be bypassed with
   WAF rules and blocks the agent's requests.
3. With Cloudflare Access in front, create a service token and give it to
   each agent in `/etc/servitals/agent.env`:

   ```sh
   HUB_HEADERS=CF-Access-Client-Id: <id>.access; CF-Access-Client-Secret: <secret>
   ```

   Headers are separated by `;`. They are sent with every request and never
   written to the log.
4. Set `PUBLIC_URL=https://dash.example.org` in `hub.env`, so
   `servitals-ctl node add` prints the tunnel address.

### Reverse proxy

Terminate TLS at the proxy and forward to the hub. Put the proxy's address
in `TRUSTED_PROXIES` in `hub.env` (loopback is the default); forwarding
headers from any other address are ignored. A hub with a certificate from a
private CA: give agents that CA in `HUB_CA_FILE=/etc/servitals/hub-ca.pem`.

### Outbound HTTP proxy

In `/etc/servitals/agent.env`:

```sh
HTTPS_PROXY=http://user:password@proxy.example:3128
NO_PROXY=.internal.example
```

`curl` tunnels HTTPS through the proxy with `CONNECT`. The agent always adds
`localhost,127.0.0.1,::1` to `NO_PROXY`, so the hub's own agent never uses
the proxy. Proxies and firewalls often cut idle connections before the
55-second long poll ends: set `WAIT_SECONDS=25` (5 to 55) if waits keep
failing.

## Troubleshooting

`servitals-agent join` and `servitals-agent status` report one of these:

| result | likely cause | fix |
| --- | --- | --- |
| `ok` | | |
| `unreachable` | wrong address or port, a firewall, DNS, the proxy, or TLS (untrusted certificate) | `curl -v <hub-url>/__auth/health` from the server; check `HTTPS_PROXY` and `HUB_CA_FILE` |
| `bad secret: copy the whole join string again` | a typo, or a secret from an older `node add` | run `servitals-ctl node add` again, or copy the line exactly |
| `bad secret: the hub does not know this node id` | the node was revoked, or the join line is for another hub | `servitals-ctl node list` on the hub |
| `clock skew` | the server's clock is more than 2 minutes off | enable NTP: `timedatectl set-ntp true` |
| `unsupported protocol` | the agent and hub versions do not share a protocol | update both packages |
| `the hub only links over HTTPS` | `link` reached the hub over plain HTTP, or through a proxy that does not send `X-Forwarded-Proto: https` | use the `https://` address; check `TRUSTED_PROXIES`; or use `join` |
| `the code expired (or the hub restarted)` | not approved within 10 minutes, or the hub restarted meanwhile | run `servitals-agent link` again |

Protocol errors in the agent's log (`journalctl -u servitals-agent`):

| log line | meaning | what the agent does |
| --- | --- | --- |
| `status=401 error=unknown_node` | node revoked or unknown | stops asking for 10 minutes at a time until the credentials change |
| `status=401 error=bad_signature` | wrong secret | backs off |
| `status=401 error=clock_skew` | clock off by more than 2 minutes | backs off; fix NTP |
| `status=401 error=replay` | a request was sent twice | retries once with a new timestamp |
| `status=413 error=too_large` | snapshot over 256 KiB | resends without the container and process lists |
| `status=422 error=invalid_snapshot` | a value outside its range | report a bug with the log line |
| `status=426` | unsupported protocol | stops; update |
| `status=429` | pushing more often than every 5 s, or too many failed requests from this address | waits `Retry-After` |
| `status=000` | no answer (network, DNS, proxy, TLS) | backs off from 5 s up to the heartbeat |
| `status=bad_reply_signature` | a reply the hub did not sign: an impostor, or a proxy that rewrites bodies | treats it as a failure |
