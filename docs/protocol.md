# servitals agent protocol, version 1

This is the contract between an agent and a hub. The bash agent, the future
Go agent, the self-hosted hub, the hosted service and the relay all implement
it, and the conformance tests in `test/conformance/` check them against the
vectors at the end of this file.

## 1. Transport

- HTTP/1.1 over TCP. HTTPS whenever the hub is reached over the internet.
- JSON bodies, UTF-8, `Content-Type: application/json`.
- The agent only makes outbound requests. The hub never connects to agents.

## 2. Credentials

- **Node id:** 12 characters from the RFC 4648 base32 alphabet, lowercase
  (`a-z2-7`), random. For relayed nodes the id seen upstream is
  `<relay-id>/<node-id>`.
- **Node secret:** 32 random bytes, written as 64 lowercase hex characters.
- **Join string:** `<node-id>:<secret-hex>`, shown once by the hub.
- The secret never appears in a request. It is only used as the HMAC key.
- Agent API requests carry no query string; the hub rejects one that does.
- The hub stops reading a request body at the size limit and answers `413`
  without buffering the rest.

## 3. Request headers

Every request carries:

| header | value |
| --- | --- |
| `X-Servitals-Proto` | protocol version, `1` |
| `X-Servitals-Agent` | agent name and version, for example `bash/1.0.0` |
| `X-Servitals-Node` | node id |
| `X-Servitals-Ts` | Unix time in milliseconds, decimal |
| `X-Servitals-Sig` | signature, 64 lowercase hex characters |

## 4. Signature

```
body_hash = lowercase_hex(SHA-256(raw request body bytes))   # empty body: SHA-256 of ""
message   = METHOD + "\n" + PATH + "\n" + TS + "\n" + body_hash
signature = lowercase_hex(HMAC-SHA256(key = secret bytes, message))
```

- `METHOD` is upper case. `PATH` is the request path without query string,
  exactly as sent (`/api/v1/agent/push`). `TS` is the `X-Servitals-Ts`
  value as sent.
- The hub compares signatures in constant time.

### 4.1 Hub checks, in this order

1. `X-Servitals-Proto` is supported, else `426`.
2. The node id is known and not revoked, else `401 unknown_node`.
3. `|hub_now_ms − TS| ≤ 120000`, else `401 clock_skew` (the reply includes
   the hub's time so the agent can log the offset).
4. `TS` is greater than the last accepted `TS` for this node **on this
   endpoint** (push, wait and relay wait are tracked separately, because an
   agent's wait and push run concurrently), else `401 replay`.
5. The body is within the size limit, else `413`.
6. The signature matches, else `401 bad_signature`.
7. For push: the body validates against the snapshot schema, else
   `422 invalid_snapshot` with the first failing path.

Only after all checks pass does the hub store the new last `TS`.
During a secret rotation's overlap window, the hub accepts a signature made
with either the old or the new secret.

### 4.2 Reply signature

Every `2xx` reply from the hub carries `X-Servitals-Sig`:

```
reply_message = "reply" + "\n" + request TS + "\n" + lowercase_hex(SHA-256(reply body))
reply_sig     = lowercase_hex(HMAC-SHA256(secret, reply_message))
```

The agent ignores any `2xx` reply whose signature does not match, and treats
it like a network error. A `204` has an empty body.

## 5. Endpoints

### 5.1 `POST /api/v1/agent/push`

- Body: one snapshot (section 6).
- `200 {"ok": true}` when stored.
- `429` when the node pushes more often than once per 5 seconds;
  `Retry-After` gives seconds.

### 5.2 `GET /api/v1/agent/wait`

- Long poll. The hub holds the request up to 55 seconds.
- `200 {"sample": true}` when someone asked for fresh data.
- `204` when the time ran out.
- A new wait from a node that already has one open replaces it: the older
  request is answered with `204`. A reconnecting agent is never locked out.
- After `200` the agent samples, pushes, and opens a new wait. After `204` it
  opens a new wait at once. After an error it backs off 5 s, doubling to at
  most its heartbeat interval.

### 5.3 `GET /api/v1/relay/wait`

- Used by a self-hosted hub that relays nodes to the hosted service.
- Signed with the relay key; `X-Servitals-Node` carries the relay id alone.
- `200 {"sample": ["<node-id>", …]}` lists the relayed nodes to wake; `204`
  when the time ran out. Same 55-second hold and replacement rule as 5.2.
- Relayed pushes use `POST /api/v1/agent/push` with
  `X-Servitals-Node: <relay-id>/<node-id>`, signed with the relay key. The
  replay check tracks each relayed node separately.

### 5.4 Errors

Error replies are JSON: `{"error": "<code>", "message": "<text>"}` plus, for
`clock_skew`, `"hub_ms": <number>`. Error replies are not signed.

| status | code | agent action |
| --- | --- | --- |
| 401 | `unknown_node` | log, stop until the credentials change |
| 401 | `bad_signature` | log, back off |
| 401 | `clock_skew` | log the offset, back off |
| 401 | `replay` | use a fresh timestamp and retry once |
| 413 | `too_large` | log, drop optional groups (processes, containers) and retry once |
| 422 | `invalid_snapshot` | log the path, back off |
| 426 | `unsupported_protocol` | log, stop |
| 403 | `node_limit` | relay only: log, stop mirroring that node |
| 429 | `rate_limited` | wait `Retry-After` |

## 6. Snapshot, schema 1

Required: `schema`, `ts`, `interval`, `host`. Every other group is optional
and may be `null`. Unknown keys are dropped by the hub. Limits apply after
parsing; a value outside its range fails validation.

```jsonc
{
  "schema": 1,                         // integer
  "ts": 1790000000000,                 // ms, sample time
  "interval": 60,                      // s, agent heartbeat, 5..3600
  "agent": "bash/1.0.0",               // ≤ 32 chars
  "host": {
    "name": "nas",                     // ≤ 64 chars
    "os": "linux",                     // linux | darwin | windows | freebsd
    "distro": "Ubuntu 26.04.1 LTS",    // ≤ 64
    "kernel": "7.0.0-31-generic",      // ≤ 64
    "uptime": 1350466                  // s, ≥ 0
  },
  "mem":  { "total": 0, "used": 0, "available": 0, "free": 0, "cache": 0,
            "swapTotal": 0, "swapUsed": 0 },                        // bytes, ≥ 0
  "cpu":  { "usage": 12, "cores": 8, "per": [10, 14],               // % 0..100, per ≤ 1024 entries
            "load": [0.5, 0.4, 0.3] },
  "temp": { "package": 46, "max": 51,                               // °C, -50..150 or null
            "sensors": [ { "label": "Package id 0", "value": 46 } ] }, // ≤ 64
  "fans": [ { "label": "fan1", "rpm": 1200 } ],                     // ≤ 32
  "battery": { "capacity": 87, "status": "Discharging" },           // % 0..100, status ≤ 16
  "disks": [ { "mount": "/srv", "mounted": true, "source": "/dev/sdb1",
               "model": "WD Red", "fstype": "ext4", "rotational": true,
               "size": 0, "used": 0, "avail": 0, "pct": 94 } ],     // ≤ 32, strings ≤ 128
  "io":   [ { "device": "sdb", "readBytes": 0, "writeBytes": 0 } ], // counters, ≤ 32
  "net":  { "iface": "eno1", "rxBytes": 0, "txBytes": 0,            // counters
            "vnstat": { "today": {}, "month": {}, "total": {}, "days": [], "hours": [] } },
  "docker": [ { "name": "jellyfin", "id": "…", "state": "running",
                "status": "Up 3 days", "health": null,
                "cpuUsec": 0, "mem": 0 } ],                         // ≤ 200, cpuUsec is a counter
  "processes": { "cpu": [ { "pid": 1, "name": "…", "cpuPct": 1.2, "rss": 0 } ],
                 "mem": [ /* same shape */ ] },                     // ≤ 5 each, names ≤ 64
  "ubuntu": { "updates": 2, "security": 0, "rebootRequired": false,
              "rebootPkgs": ["linux-image-…"], "failedUnits": ["…"] } // lists ≤ 32
}
```

Rules that apply to every field:

- Numbers must be finite. Byte and counter fields are integers `0 ≤ n ≤ 2^53`.
- Strings are single-line after the hub strips control characters.
- `vnstat` sub-objects keep the shape the current collector produces; their
  numbers follow the rules above and `days`/`hours` hold at most 31 and 24
  entries with `label`/`title` strings ≤ 32.
- Rates are never sent. The hub derives them from counters.

Schema versioning: the hub accepts the current schema and the one before it.
A new optional field does not change the schema number; a changed meaning or a
new required field does.

## 7. Browser endpoints related to nodes

These require the browser session cookie (not HMAC), and are listed here so the
UI and hosted service agree on them.

| method and path | purpose |
| --- | --- |
| `GET /__ctl/nodes` | node list with status and summary numbers |
| `GET /__ctl/node/<id>` | latest validated snapshot of one node |
| `POST /__ctl/refresh?node=<id\|all>` | wake the node(s) |
| `GET /__ctl/history?node=<id>&series=<name>&range=<1h\|24h\|7d\|30d\|90d>` | history points |
| `GET /data.json` | latest snapshot of the local node, kept for old scripts |

## 8. Test vectors

Secret (hex): `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`

Push:

```
body        {"schema":1,"ts":1790000000000,"host":{"name":"nas","os":"linux"}}
body_sha256 0fa1448a21a0a6a62894effa6272130a82718c810984c5c7f8714b5d6e6e0ffb
TS          1790000000123
message     POST\n/api/v1/agent/push\n1790000000123\n0fa1448a…0ffb
signature   a2ca87da11ec97e2133ebdae553a888ae899fe9ea32fc4798a626b3eb3331f03
```

Wait (empty body, `body_sha256` of the empty string):

```
TS          1790000000456
message     GET\n/api/v1/agent/wait\n1790000000456\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
signature   194b6dc9c936d5c7b8c8802d22836053af2cc8ef63e93d497f09506bd3ba9293
```

Reply to the push above, body `{"ok":true}`:

```
reply_message  reply\n1790000000123\n<sha256 of {"ok":true}>
reply_sig      11e9e5a365260ee327629ca9ada7e6afeeb357ad09b9f7810f1052ba9da0dc57
```

The push body in the vector is shorter than a valid snapshot on purpose: it
tests the signature only, and a hub under conformance test runs the signature
check before schema validation.
