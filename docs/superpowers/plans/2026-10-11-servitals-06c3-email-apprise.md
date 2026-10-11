# servitals Email and Apprise Channels (sub-project 6c-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alerts by email (SMTP with STARTTLS or TLS, from a client of the hub's own) and through Apprise (an Apprise API or the `apprise` command), the last two channel kinds spec 8.4 lists before Web Push.

**Why:** email is the one channel everybody already has, and the spec's default for critical alerts. Apprise covers the long tail of services servitals will never have its own adapter for.

**Architecture:**
- **`hub/lib/smtp.js` (new):** `sendMail({host, port, security, user, pass, from, to, subject, text, timeoutMs, ca, hostname})`.
  - `starttls`: connect, EHLO, STARTTLS (required when asked: no fallback), TLS with the certificate checked, EHLO again; `tls`: TLS from the start; `none`: only to a loopback host and never with a login.
  - AUTH PLAIN, or LOGIN when that is all the server offers, only over TLS.
  - The message: UTF-8 text in base64 (so no line starts with a dot), RFC 2047 subject when not ASCII, Date, Message-ID; addresses checked (no line breaks), a subject's line break becomes a space.
  - Errors: `SMTP_<code>`, `ETLSREQUIRED`, `EADDRESS`, `ETIMEDOUT`, or the socket's. SMTP never goes through HTTPS_PROXY.
- **`hub/lib/notify.js`:** an adapter may `send(config, message, ctx)` itself (ctx: `outbound`, `execFile`, `sendMail`) instead of building an HTTP request.
  - **email:** `host`, `port`, `security` (choices `starttls`/`tls`/`none`), optional `user` and `pass` (secret), `from`, `to` (up to 10, comma separated). The text ends with a signature line.
  - **apprise:** `urls` (secret), optional `api`. With `api`, a POST to `<api>/notify/` (`urls`, `title`, `body`, `type`); without, `apprise -n <type> -t <title> -b <body>` with the URLs in `APPRISE_URLS` and an environment of only PATH, HOME and LANG (no hub setting reaches it; the URLs never appear in `ps`).
  - Final failures: an SMTP 5xx, no TLS, a bad address, apprise not installed. An SMTP 4xx is tried again.
  - A field may have `choices` (checked, and listed in `view().types`); a field may be a `list` of addresses.
- **The page (`www/js/alerts.js`):** a field with choices is a select; a new email channel starts at critical (spec 8.3) on port 587 with STARTTLS. Words for the new fields.
- `CHANGELOG.md`, `docs/networking.md` (SMTP is not proxied). `debian/control` already `Suggests: apprise`.

**Tech Stack:** Node.js ≥ 18 built-ins (`net`, `tls`, `child_process`).

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md` 8.3 (email for critical), 8.4 (email with STARTTLS or implicit TLS; Apprise through the CLI with `execFile` and an argument list, or an Apprise API URL).

**Scope:** 6c-3. Later: Web Push (6d); the hosted service's email cap.

**Proven before writing:** every code block was built and run in a scratch copy of `main` (9f1362f) on 2026-10-11: node suite 444 tests; budget, screens, compose smoke, both packages and autopkgtest pass.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6c-2 still holds.
- Never a password in the clear: a login only over TLS. Never a secret on a command line or in a log.
- Work in a worktree `.claude/worktrees/servitals-email` on branch `feat/email` from `main` (9f1362f).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **TLS and the login:** a server that offers no STARTTLS, a certificate for another name, a downgrade, `none` to a remote host. Test: "never a login in the clear…".
2. **SMTP replies:** multi-line replies, a reply split over packets, a 4xx against a 5xx, a server that never answers. Tests: "implicit TLS and AUTH LOGIN…", "addresses and subjects…".
3. **Header and command injection:** CR/LF in addresses, subject, names; a recipient list with `>`. Test: "addresses and subjects cannot add headers…".
4. **Apprise:** the URLs never on the command line, the child's environment, a missing binary, a hanging one (timeout). Test: "Apprise: the CLI gets the URLs…".
5. **The form:** choices, defaults for a new email channel. Test: "channels: a field with choices…".

---

### Task 1: An SMTP client

**Files:**
- Create: `hub/lib/smtp.js`, `test/smtp.test.js`

**Interfaces:**
- Produces: `sendMail(options) → Promise`, `header(s)`, `message(o)`, `ADDRESS`. Task 2's email adapter calls `sendMail`.

- [ ] **Step 1: Write the failing tests**

Create `test/smtp.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Email alerts (spec 8.4): the SMTP client against a small SMTP server in this process,
 * with STARTTLS, implicit TLS, AUTH PLAIN and LOGIN, and the server's certificate checked.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const { sendMail, header } = require("../hub/lib/smtp");

function certFor(ip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-smtp-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", path.join(dir, "k"), "-out", path.join(dir, "c"),
    "-subj", `/CN=${ip}`, "-addext", `subjectAltName=IP:${ip}`], { stdio: "ignore" });
  const c = { key: fs.readFileSync(path.join(dir, "k")), cert: fs.readFileSync(path.join(dir, "c")) };
  fs.rmSync(dir, { recursive: true, force: true });
  return c;
}
const CERT = certFor("127.0.0.1");

// an SMTP server: offers STARTTLS (unless implicit), AUTH as asked; records what it saw
function smtpServer({ implicit = false, starttls = true, auth = "PLAIN LOGIN", login = ["u", "p"], rcptCode = 250 } = {}) {
  const seen = { lines: [], data: "", tls: false, auth: null };
  const serve = (sock, secure, greet = true) => {
    let buf = "", inData = false, step = null;
    const say = (s) => sock.write(s + "\r\n");
    const ehlo = () => say(["250-hi", ...(starttls && !secure ? ["250-STARTTLS"] : []), ...(auth && secure ? [`250-AUTH ${auth}`] : []), "250 OK"].join("\r\n"));
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; say("250 queued"); } else seen.data += line + "\n";
          continue;
        }
        seen.lines.push(line);
        if (step === "user") { step = "pass"; seen.authUser = Buffer.from(line, "base64").toString(); say("334 UGFzc3dvcmQ6"); continue; }
        if (step === "pass") { step = null; const ok = seen.authUser === login[0] && Buffer.from(line, "base64").toString() === login[1]; seen.auth = ok ? "LOGIN" : "bad"; say(ok ? "235 ok" : "535 no"); continue; }
        const [verb] = line.split(" ");
        if (verb === "EHLO") ehlo();
        else if (verb === "STARTTLS") {
          say("220 go");
          sock.removeAllListeners("data");
          const t = new tls.TLSSocket(sock, { isServer: true, key: CERT.key, cert: CERT.cert });
          seen.tls = true;
          serve(t, true, false);   // no second greeting after STARTTLS
          return;
        } else if (verb === "AUTH" && line.split(" ")[1] === "PLAIN") {
          const [, u, p] = Buffer.from(line.split(" ")[2], "base64").toString().split("\0");
          const ok = u === login[0] && p === login[1];
          seen.auth = ok ? "PLAIN" : "bad";
          say(ok ? "235 ok" : "535 no");
        } else if (verb === "AUTH") { step = "user"; say("334 VXNlcm5hbWU6"); }
        else if (verb === "MAIL") say("250 ok");
        else if (verb === "RCPT") say(`${rcptCode} rcpt`);
        else if (verb === "DATA") { inData = true; say("354 go"); }
        else if (verb === "QUIT") { say("221 bye"); sock.end(); }
        else say("502 what");
      }
    });
    sock.on("error", () => {});
    if (greet) say("220 smtp.test ready");
  };
  const srv = implicit ? tls.createServer({ key: CERT.key, cert: CERT.cert }, (s) => { seen.tls = true; serve(s, true); })
    : net.createServer((s) => serve(s, false));
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port, seen })));
}
const base = { host: "127.0.0.1", from: "hub@example.org", to: ["me@example.org"], subject: "critical: disk full /srv on nas", text: "value 96%\n.since 03:10", ca: CERT.cert };

test("STARTTLS: the login only after TLS, the message as UTF-8 base64, the subject encoded when it is not ASCII", async () => {
  const s = await smtpServer();
  try {
    await sendMail({ ...base, port: s.port, security: "starttls", user: "u", pass: "p", subject: "critical: disque plein — nas" });
    assert.strictEqual(s.seen.tls, true);
    assert.strictEqual(s.seen.auth, "PLAIN");
    const before = s.seen.lines.indexOf("STARTTLS"), at = s.seen.lines.findIndex((l) => l.startsWith("AUTH"));
    assert.ok(before >= 0 && at > before, "AUTH only after STARTTLS");
    assert.deepStrictEqual(s.seen.lines.filter((l) => /^(MAIL|RCPT)/.test(l)), ["MAIL FROM:<hub@example.org>", "RCPT TO:<me@example.org>"]);
    const [head, body] = s.seen.data.split("\n\n");
    assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(head, /^Content-Transfer-Encoding: base64$/m);
    assert.strictEqual(Buffer.from(body.replace(/\n/g, ""), "base64").toString(), "value 96%\n.since 03:10", "a line starting with a dot arrives whole");
  } finally { s.srv.close(); }
});

test("implicit TLS and AUTH LOGIN; a wrong password, a refused recipient: an error with the server's code", async () => {
  const s = await smtpServer({ implicit: true, auth: "LOGIN" });
  try {
    await sendMail({ ...base, port: s.port, security: "tls", user: "u", pass: "p" });
    assert.strictEqual(s.seen.auth, "LOGIN");
    await assert.rejects(sendMail({ ...base, port: s.port, security: "tls", user: "u", pass: "nope" }), (e) => e.code === "SMTP_535");
  } finally { s.srv.close(); }
  const r = await smtpServer({ rcptCode: 550 });
  try { await assert.rejects(sendMail({ ...base, port: r.port, security: "starttls" }), (e) => e.code === "SMTP_550"); } finally { r.srv.close(); }
});

test("never a login in the clear; the certificate is checked; plain SMTP only to this host", async () => {
  const s = await smtpServer({ starttls: false });
  try {
    await assert.rejects(sendMail({ ...base, port: s.port, security: "starttls", user: "u", pass: "p" }), (e) => e.code === "ETLSREQUIRED",
      "no STARTTLS offered: stop, do not fall back");
    assert.ok(!s.seen.lines.some((l) => l.startsWith("AUTH")));
    await assert.rejects(sendMail({ ...base, port: s.port, security: "none", user: "u", pass: "p" }), (e) => e.code === "ETLSREQUIRED");
    await assert.rejects(sendMail({ ...base, host: "mail.example.org", port: s.port, security: "none" }), (e) => e.code === "ETLSREQUIRED");
    await sendMail({ ...base, port: s.port, security: "none" });
    assert.match(s.seen.data, /^To: me@example.org$/m, "a local relay without a login: fine");
  } finally { s.srv.close(); }
  const t = await smtpServer();
  try {
    await assert.rejects(sendMail({ ...base, port: t.port, security: "starttls", ca: undefined }), (e) => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code));
  } finally { t.srv.close(); }
});

test("addresses and subjects cannot add headers; a silent server times out", async () => {
  await assert.rejects(sendMail({ ...base, port: 1, from: "a@b.org\r\nBcc: x@y.org" }), (e) => e.code === "EADDRESS");
  await assert.rejects(sendMail({ ...base, port: 1, to: ["me@example.org>\r\nRCPT TO:<x@y.org"] }), (e) => e.code === "EADDRESS");
  assert.strictEqual(header("a\r\nBcc: x@y.org"), "a Bcc: x@y.org", "a subject's line break is a space");
  const mute = net.createServer(() => {});
  await new Promise((r) => mute.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(sendMail({ ...base, port: mute.address().port, security: "starttls", timeoutMs: 300 }), (e) => e.code === "ETIMEDOUT");
  } finally { mute.close(); }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/smtp.test.js`
Expected: FAIL, the file as a whole (`Cannot find module '../hub/lib/smtp'`).

- [ ] **Step 3: The client**

Create `hub/lib/smtp.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Email alerts (spec 8.4): a small SMTP client on Node's net and tls, no dependencies.
 *   security "starttls" (port 587): plain connect, EHLO, STARTTLS, then TLS with the
 *     server's certificate checked; "tls" (port 465): TLS from the start; "none": only
 *     to this host (a local mail relay), never with a login.
 *   A login (AUTH PLAIN, or LOGIN when that is all the server offers) is sent only over
 *   TLS. The message is UTF-8 text, base64; the subject is RFC 2047 encoded when it is
 *   not plain ASCII; addresses and the subject cannot carry a line break.
 *   SMTP is not HTTP: it never goes through HTTPS_PROXY.
 *   sendMail({ host, port, security, user, pass, from, to: [..], subject, text, timeoutMs, ca, hostname })
 *   resolves when the server accepted the message, or rejects with an Error whose code is
 *   SMTP_<reply code>, ETIMEDOUT, ETLSREQUIRED, EADDRESS or the socket's.
 */
const crypto = require("crypto");
const net = require("net");
const os = require("os");
const tls = require("tls");

const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const coded = (msg, code) => { const e = new Error(msg); e.code = code; return e; };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
// a header value: plain ASCII as it is, else one RFC 2047 encoded word per 30 characters
function header(s) {
  s = String(s).replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const parts = [];
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i += 30) parts.push(`=?UTF-8?B?${b64(chars.slice(i, i + 30).join(""))}?=`);
  return parts.join("\r\n ");
}

// the whole message, CRLF lines, with the body in base64 (no line can start with a dot)
function message({ from, to, subject, text, hostname }) {
  const body = b64(text).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${from}`, `To: ${to.join(", ")}`, `Subject: ${header(subject)}`, `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${hostname}>`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body,
  ].join("\r\n");
}

function sendMail({ host, port, security = "starttls", user, pass, from, to, subject, text, timeoutMs = 20000, ca, hostname = os.hostname() || "servitals" }) {
  return new Promise((resolve, reject) => {
    const list = Array.isArray(to) ? to : [to];
    if (!ADDRESS.test(from) || !list.length || !list.every((a) => ADDRESS.test(a))) { reject(coded("not an email address", "EADDRESS")); return; }
    if (security === "none" && (!LOOPBACK.has(host) || user)) { reject(coded("plain SMTP only to this host, without a login", "ETLSREQUIRED")); return; }
    const helo = /^[A-Za-z0-9.-]{1,253}$/.test(hostname) ? hostname : "servitals";
    let sock, buf = "", waiting = null, done = false, secure = security === "tls";
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sock) sock.destroy();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(coded("timed out", "ETIMEDOUT")), timeoutMs);
    // one reply: its lines up to "NNN text"; resolves { code, lines }
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 65536) { finish(coded("reply too long", "ESMTP")); return; }
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const reply = { code: Number(lines[i].slice(0, 3)), lines: lines.slice(0, i + 1).map((l) => l.slice(4)) };
          buf = lines.slice(i + 1).join("\r\n");
          const w = waiting;
          waiting = null;
          if (w) w(reply);
          return;
        }
      }
    };
    const read = () => new Promise((r) => { waiting = r; });
    const attach = (s) => {
      sock = s;
      s.on("data", onData);
      s.on("error", (e) => finish(e));
      s.on("close", () => finish(coded("connection closed", "ECONNRESET")));
    };
    // a command and its reply, which must have the expected code
    async function cmd(line, want) {
      const r = read();
      sock.write(line + "\r\n");
      const reply = await r;
      if (!(Array.isArray(want) ? want : [want]).includes(reply.code)) throw coded(`SMTP ${reply.code}`, "SMTP_" + reply.code);
      return reply;
    }
    async function talk() {
      const greet = await read();
      if (greet.code !== 220) throw coded(`SMTP ${greet.code}`, "SMTP_" + greet.code);
      let ehlo = await cmd(`EHLO ${helo}`, 250);
      if (security === "starttls") {
        if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw coded("the server offers no STARTTLS", "ETLSREQUIRED");
        await cmd("STARTTLS", 220);
        const plain = sock;
        plain.removeListener("data", onData);
        plain.removeAllListeners("close");
        await new Promise((ok, fail) => {
          const t = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, host, ca }, ok);
          t.once("error", fail);
          attach(t);
        });
        secure = true;
        ehlo = await cmd(`EHLO ${helo}`, 250);
      }
      if (user) {
        if (!secure) throw coded("a login needs TLS", "ETLSREQUIRED");
        const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || "";
        if (/\bPLAIN\b/i.test(auth)) await cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass || ""}`)}`, 235);
        else if (/\bLOGIN\b/i.test(auth)) { await cmd("AUTH LOGIN", 334); await cmd(b64(user), 334); await cmd(b64(pass || ""), 235); }
        else throw coded("the server offers no login this client knows", "SMTP_AUTH");
      }
      await cmd(`MAIL FROM:<${from}>`, 250);
      for (const a of list) await cmd(`RCPT TO:<${a}>`, [250, 251]);
      await cmd("DATA", 354);
      await cmd(message({ from, to: list, subject, text, hostname: helo }) + "\r\n.", 250);
      sock.write("QUIT\r\n");
    }
    const run = () => talk().then(() => finish(), (e) => finish(e));
    if (secure) {
      const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ca });
      attach(s);
      s.once("secureConnect", run);
    } else {
      const s = net.connect({ host, port });
      attach(s);
      s.once("connect", run);
    }
  });
}

module.exports = { sendMail, header, message, ADDRESS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 441 tests (4 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/smtp.js test/smtp.test.js
git commit -m "feat(hub): a small SMTP client: STARTTLS or TLS, a login only over TLS"
```

---

### Task 2: Email and Apprise channels

**Files:**
- Modify: `hub/lib/notify.js`, `www/js/alerts.js`, `hub/lib/i18n.js`, `test/notify.test.js`, `test/page.test.js`, `CHANGELOG.md`, `docs/networking.md`

**Interfaces:**
- Consumes: `sendMail`, `ADDRESS` (Task 1); the adapters and the channels tab (6c-1, 6c-2).
- Produces: `ADAPTERS.email`, `ADAPTERS.apprise`; adapters with `send(config, message, ctx)`; field `choices` and `list`; `createNotifier({…, execFile, sendMail})`.

- [ ] **Step 1: Write the failing tests**

In `test/notify.test.js`:

1. Replace

```js
const hook = (extra = {}) => ({ id: "ch_w", type: "webhook", name: "pager", min: "critical", on: true, config: { url: "https://hooks.test/T0K3N", secret: "s3" }, ...extra });

function setup(config, { fail = () => 0, sleep } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notify-"));
  const sent = [], logs = [], slept = [];
```

   with

```js
const hook = (extra = {}) => ({ id: "ch_w", type: "webhook", name: "pager", min: "critical", on: true, config: { url: "https://hooks.test/T0K3N", secret: "s3" }, ...extra });

function setup(config, { fail = () => 0, sleep, sendMail, execFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notify-"));
  const sent = [], logs = [], slept = [];
```

2. Replace

```js
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); const s = fail(url, sent.length); return { status: s || 200, headers: {}, body: "" }; } };
  const make = () => createNotifier({ dir, outbound, now: () => clock.t, env: { SERVITALS_NOTIFY_NTFY: "from_env", SERVITALS_NOTIFY_HOOK: "https://hooks.test/env", SERVITALS_NOTIFY_BAD: "ftp://x", AUTH_PASS: "pw" },
    log: { info() {}, warn: (event, f) => logs.push([event, f]) }, sleep: sleep || (async (ms) => { slept.push(ms); }) });
  const n = make();
  if (config) n.setConfig(config);
```

   with

```js
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); const s = fail(url, sent.length); return { status: s || 200, headers: {}, body: "" }; } };
  const make = () => createNotifier({ dir, outbound, now: () => clock.t, env: { SERVITALS_NOTIFY_NTFY: "from_env", SERVITALS_NOTIFY_HOOK: "https://hooks.test/env", SERVITALS_NOTIFY_BAD: "ftp://x", AUTH_PASS: "pw" },
    log: { info() {}, warn: (event, f) => logs.push([event, f]) }, sleep: sleep || (async (ms) => { slept.push(ms); }), sendMail, execFile });
  const n = make();
  if (config) n.setConfig(config);
```

3. Replace

```js
  assert.match(tm, /\\\[fix here\\\]\\\(/);
});
```

   with

```js
  assert.match(tm, /\\\[fix here\\\]\\\(/);
});

test("email: what the SMTP client is given; a refused login is final, a busy server is tried again", async () => {
  const mails = [];
  let answer = null;
  const ch = { id: "ch_e", type: "email", name: "mail", min: "critical", on: true,
    config: { host: "smtp.example.org", port: "587", security: "starttls", user: "hub", pass: "pw", from: "hub@example.org", to: "a@example.org, b@example.org" } };
  const s = setup({ channels: [ch] }, { sendMail: async (o) => { mails.push(o); if (answer) { const e = new Error("x"); e.code = answer; throw e; } } });
  s.n.onEvent(ev("firing", "critical"));
  await s.n.flush();
  assert.deepStrictEqual({ ...mails[0], text: undefined }, { host: "smtp.example.org", port: 587, security: "starttls", user: "hub", pass: "pw",
    from: "hub@example.org", to: ["a@example.org", "b@example.org"], subject: "critical: disk full /srv on nas", text: undefined });
  assert.match(mails[0].text, /^value 92%\nsince 11:55\n\n-- \nservitals$/);
  answer = "SMTP_535"; s.n.onEvent(ev("firing", "critical")); await s.n.flush();
  assert.strictEqual(mails.length, 2, "535: a wrong password stays wrong");
  answer = "SMTP_451"; s.n.onEvent(ev("firing", "critical")); await s.n.flush();
  assert.strictEqual(mails.length, 6, "451: try later, three more times");
  const bad = (config, re) => assert.throws(() => checkChannels({ channels: [{ ...ch, config: { ...ch.config, ...config } }] }), re);
  bad({ security: "ssl" }, /mail: security: one of starttls, tls, none/);
  bad({ to: "a@example.org, nope" }, /mail: to: not valid/);
  bad({ from: "hub" }, /mail: from: not valid/);
  bad({ port: "x" }, /mail: port: not valid/);
  assert.deepStrictEqual(s.n.view().types.email.find((f) => f.key === "security").choices, ["starttls", "tls", "none"]);
});

test("Apprise: the CLI gets the URLs in its environment, not its arguments, and none of the hub's settings; or an Apprise API", async () => {
  process.env.AUTH_PASS_TEST_LEAK = "should-not-leak";
  const runs = [];
  let fail = null;
  const ch = { id: "ch_a", type: "apprise", name: "apprise", min: "warning", on: true, config: { urls: "tgram://tok/chat mailto://u:p@x" } };
  const s = setup({ channels: [ch] }, { execFile: (cmd, args, opts, cb) => { runs.push({ cmd, args, opts }); setImmediate(() => cb(fail)); } });
  s.n.onEvent(ev("firing", "critical"));
  await s.n.flush();
  assert.deepStrictEqual([runs[0].cmd, runs[0].args.slice(0, 4)], ["apprise", ["-n", "failure", "-t", "critical: disk full /srv on nas"]]);
  assert.ok(!runs[0].args.join(" ").includes("tgram://"), "never on the command line");
  assert.strictEqual(runs[0].opts.env.APPRISE_URLS, "tgram://tok/chat mailto://u:p@x");
  assert.strictEqual(runs[0].opts.env.AUTH_PASS_TEST_LEAK, undefined, "only PATH, HOME, LANG and the URLs");
  fail = Object.assign(new Error("spawn apprise ENOENT"), { code: "ENOENT" });
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.strictEqual(runs.length, 2, "not installed: no retry");
  assert.strictEqual(s.n.view().status.ch_a.lastError, "APPRISE_MISSING");
  delete process.env.AUTH_PASS_TEST_LEAK;
  const api = setup({ channels: [{ ...ch, config: { urls: "tgram://tok/chat", api: "https://apprise.lan/" } }] });
  api.n.onEvent(ev("resolved", "warning"));
  await api.n.flush();
  assert.strictEqual(api.sent[0].url, "https://apprise.lan/notify/");
  assert.deepStrictEqual(JSON.parse(api.sent[0].body), { urls: "tgram://tok/chat", title: "resolved: disk full /srv on nas", body: "value 92%\nsince 11:55", type: "success" });
});
```

In `test/page.test.js`:

1. Replace

```js
  assert.deepStrictEqual([t.chState.rows[1].name, t.chState.dirty, t.chState.status.ch_n.lastOk], ["renamed", true, 99], "the status is new, the edit stays");
});
```

   with

```js
  assert.deepStrictEqual([t.chState.rows[1].name, t.chState.dirty, t.chState.status.ch_n.lastOk], ["renamed", true, 99], "the status is new, the edit stays");
});

test("channels: a field with choices is a select; a new email channel starts at critical on port 587 with STARTTLS", () => {
  const s = rulesScope({ $$: (sel) => (sel.includes("newtype") ? [{ value: "email" }] : []), $: () => ({ innerHTML: "" }) });
  const types = { email: [{ key: "host", secret: false, optional: false }, { key: "port", secret: false, optional: false },
    { key: "security", secret: false, optional: false, choices: ["starttls", "tls", "none"] }, { key: "pass", secret: true, optional: true }] };
  Object.assign(s.chState, { types, rows: [], status: {} });
  s.chAction("add", -1);
  const r = s.chState.rows[0];
  assert.deepStrictEqual([r.type, r.min, r.config], ["email", "critical", { port: "587", security: "starttls" }]);
  const html = s.chHtml();
  assert.match(html, /security <select class="cval" data-k="security"><option value="starttls" selected>starttls<\/option><option value="tls">tls<\/option>/);
  assert.match(html, /SMTP server <input type="text"/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/notify.test.js test/page.test.js`
Expected: FAIL, 3 tests: "email: what the SMTP client is given…", "Apprise: the CLI gets the URLs…" (`type: one of …`), "channels: a field with choices is a select…".

- [ ] **Step 3: The adapters, the form, the words**

In `hub/lib/notify.js`:

1. Replace

```js
const { writeFileAtomic } = require("./fsutil");
const { tr } = require("./i18n");

const SEV = ["critical", "warning", "info"];
```

   with

```js
const { writeFileAtomic } = require("./fsutil");
const { tr } = require("./i18n");
const childProcess = require("child_process");
const smtp = require("./smtp");

const SEV = ["critical", "warning", "info"];
```

2. Replace

```js
    },
  },
  // a room message: PUT with a transaction id, so a retry is not a second message
  matrix: {
```

   with

```js
    },
  },
  // email over SMTP (hub/lib/smtp.js): STARTTLS or TLS; plain only to a relay on this host
  email: {
    fields: { host: { re: /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:.]{2,45}\]?$/ }, port: { re: /^[0-9]{1,5}$/ }, security: { choices: ["starttls", "tls", "none"] },
              user: { optional: true }, pass: { optional: true, secret: true }, from: { re: smtp.ADDRESS },
              to: { re: /^[A-Za-z0-9._%+@-]+(\s*,\s*[A-Za-z0-9._%+@-]+){0,9}$/, list: smtp.ADDRESS } },
    send(c, m, ctx) {
      return ctx.sendMail({ host: c.host.replace(/^\[|\]$/g, ""), port: Number(c.port), security: c.security, user: c.user, pass: c.pass,
        from: c.from, to: c.to.split(",").map((a) => a.trim()), subject: cut(m.title, 200), text: fit(m.text, 20000) + "\n\n-- \nservitals" });
    },
  },
  // Apprise, the catch-all: an Apprise API (stateless /notify/), or the apprise CLI with
  // the URLs in its environment (never on its command line, where any user could read them)
  apprise: {
    fields: { urls: { secret: true }, api: { optional: true, url: true } },
    async send(c, m, ctx) {
      const type = m.resolved || m.kind === "test" ? "success" : m.severity === "critical" ? "failure" : m.severity === "warning" ? "warning" : "info";
      if (c.api) {
        const r = await ctx.outbound.request(base(c.api) + "/notify/", { method: "POST", headers: { "content-type": "application/json" }, timeoutMs: 30000,
          body: JSON.stringify({ urls: c.urls, title: cut(m.title, 250), body: fit(m.text, 3200), type }) });
        if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
        return;
      }
      await new Promise((ok, fail) => {
        const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp", LANG: "C.UTF-8", APPRISE_URLS: c.urls };
        ctx.execFile("apprise", ["-n", type, "-t", cut(m.title, 250), "-b", fit(m.text, 3200)], { env, timeout: 30000, maxBuffer: 65536 }, (err) => {
          if (!err) { ok(); return; }
          const e = new Error("apprise failed");
          e.code = err.code === "ENOENT" ? "APPRISE_MISSING" : err.killed ? "ETIMEDOUT" : "APPRISE_EXIT_" + (typeof err.code === "number" ? err.code : "x");
          fail(e);
        });
      });
    },
  },
  // a room message: PUT with a transaction id, so a retry is not a second message
  matrix: {
```

3. Replace

```js
// what is wrong with a field's value, or ""
function fieldError(f, v) {
  if (f.url && !httpUrl(v)) return "an http or https URL";
  if (f.re && !f.re.test(v)) return "not valid";
```

   with

```js
// what is wrong with a field's value, or ""
function fieldError(f, v) {
  if (f.choices && !f.choices.includes(v)) return "one of " + f.choices.join(", ");
  if (f.list && !v.split(",").every((x) => f.list.test(x.trim()))) return "not valid";
  if (f.url && !httpUrl(v)) return "an http or https URL";
  if (f.re && !f.re.test(v)) return "not valid";
```

4. Replace

```js

/* ------------------------------------------------------------------ the notifier */
function createNotifier({ dir, outbound, now = Date.now, log = { info() {}, warn() {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)).then(() => {}), env = process.env } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "channels.json"), stFile = path.join(dir, "notify-state.json");
```

   with

```js

/* ------------------------------------------------------------------ the notifier */
function createNotifier({ dir, outbound, now = Date.now, log = { info() {}, warn() {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)).then(() => {}), env = process.env,
                          execFile = childProcess.execFile, sendMail = smtp.sendMail } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "channels.json"), stFile = path.join(dir, "notify-state.json");
```

5. Replace

```js
  }
  async function sendOnce(ch, m) {
    const req = ADAPTERS[ch.type].build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: req.method || "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
```

   with

```js
  }
  async function sendOnce(ch, m) {
    const ad = ADAPTERS[ch.type];
    if (ad.send) { await ad.send(resolved(ch), m, { outbound, execFile, sendMail }); return; }
    const req = ad.build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: req.method || "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
```

6. Replace

```js
  const errText = (e) => (e && e.code ? String(e.code) : "failed");
  // a failure a second try cannot fix: a 4xx (other than 408 and 429), a bad value
  const final = (e) => /^HTTP_4\d\d$/.test(e.code) && !/^HTTP_(408|429)$/.test(e.code) || /^(ENV_UNSET|EBADVALUE|EURL)/.test(String(e.code));
  async function send(ch, m) {
    for (let i = 0; ; i++) {
```

   with

```js
  const errText = (e) => (e && e.code ? String(e.code) : "failed");
  // a failure a second try cannot fix: a 4xx (other than 408 and 429), a bad value
  // (SMTP: a 5xx is final, a 4xx is "try later"; no TLS, a bad address, no apprise: final)
  const final = (e) => /^HTTP_4\d\d$/.test(e.code) && !/^HTTP_(408|429)$/.test(e.code) || /^SMTP_5/.test(e.code)
    || /^(ENV_UNSET|EBADVALUE|EURL|ETLSREQUIRED|EADDRESS|APPRISE_MISSING)/.test(String(e.code));
  async function send(ch, m) {
    for (let i = 0; ; i++) {
```

7. Replace

```js
        [k, ADAPTERS[ch.type].fields[k].secret && !ENVREF.test(v) ? SECRET : v])) });
      return { channels: cfg.channels.map(mask), quiet: cfg.quiet, digestAt: cfg.digestAt, status: { ...status },
               types: Object.fromEntries(Object.entries(ADAPTERS).map(([t, a]) => [t, Object.entries(a.fields).map(([k, f]) => ({ key: k, secret: !!f.secret, optional: !!f.optional }))])) };
    },
    // for tests: wait for the sends under way
```

   with

```js
        [k, ADAPTERS[ch.type].fields[k].secret && !ENVREF.test(v) ? SECRET : v])) });
      return { channels: cfg.channels.map(mask), quiet: cfg.quiet, digestAt: cfg.digestAt, status: { ...status },
               types: Object.fromEntries(Object.entries(ADAPTERS).map(([t, a]) => [t, Object.entries(a.fields).map(([k, f]) => ({ key: k, secret: !!f.secret, optional: !!f.optional, ...(f.choices ? { choices: f.choices } : {}) }))])) };
    },
    // for tests: wait for the sends under way
```

In `www/js/alerts.js`:

1. Replace

```js
      + `<span class="grow"></span><button data-act="test">${esc(tr("ch.test"))}</button><button data-act="remove">${esc(tr("rules.remove"))}</button></div>`
      + `<div class="rov cfields">` + fields.map(f => `<label>${esc(tr("ch.field." + f.key))}${f.optional ? " " + esc(tr("ch.optional")) : ""} `
        + (f.secret && r.config[f.key] === "********"
          // a saved secret: an empty box (the page never holds it) that a password manager will not fill
          ? `<input type="password" class="cval" data-k="${esc(f.key)}" autocomplete="new-password" data-saved="1" value="" placeholder="${esc(tr("ch.saved"))}">`
```

   with

```js
      + `<span class="grow"></span><button data-act="test">${esc(tr("ch.test"))}</button><button data-act="remove">${esc(tr("rules.remove"))}</button></div>`
      + `<div class="rov cfields">` + fields.map(f => `<label>${esc(tr("ch.field." + f.key))}${f.optional ? " " + esc(tr("ch.optional")) : ""} `
        + (f.choices
          ? `<select class="cval" data-k="${esc(f.key)}">${opts(f.choices.map(c => [c, c]), r.config[f.key] || f.choices[0])}</select>`
          : f.secret && r.config[f.key] === "********"
          // a saved secret: an empty box (the page never holds it) that a password manager will not fill
          ? `<input type="password" class="cval" data-k="${esc(f.key)}" autocomplete="new-password" data-saved="1" value="" placeholder="${esc(tr("ch.saved"))}">`
```

2. Replace

```js
    const type = el && chState.types[el.value] ? el.value : Object.keys(chState.types)[0];
    if (!type) return;
    chState.rows.push({ id: "ch_" + Date.now().toString(36), type, name: type, min: "warning", on: true, digest: true, config: {} });
  }
  if (act === "remove") chState.rows.splice(i, 1);
```

   with

```js
    const type = el && chState.types[el.value] ? el.value : Object.keys(chState.types)[0];
    if (!type) return;
    // spec 8.3: email for critical, the rest for warning and up
    chState.rows.push({ id: "ch_" + Date.now().toString(36), type, name: type, min: type === "email" ? "critical" : "warning", on: true, digest: true,
      config: type === "email" ? { port: "587", security: "starttls" } : {} });
  }
  if (act === "remove") chState.rows.splice(i, 1);
```

In `hub/lib/i18n.js`:

1. Replace

```js
  "ch.field.user": "user key",
  "ch.field.room": "room id",
  "ch.lastOk": "last sent {time}",
  "ch.lastError": "last error {error} at {time}",
```

   with

```js
  "ch.field.user": "user key",
  "ch.field.room": "room id",
  "ch.field.host": "SMTP server",
  "ch.field.port": "port",
  "ch.field.security": "security",
  "ch.field.user": "user",
  "ch.field.pass": "password",
  "ch.field.from": "from address",
  "ch.field.to": "to (comma between addresses)",
  "ch.field.urls": "Apprise URLs",
  "ch.field.api": "Apprise API",
  "ch.lastOk": "last sent {time}",
  "ch.lastError": "last error {error} at {time}",
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- More alert channels and their settings (spec 8.4): Gotify, Telegram,
  Discord, Slack, Microsoft Teams (a Workflows webhook), Pushover and Matrix
```

   with

```markdown

### Added
- Email and Apprise channels (spec 8.4): email over SMTP with STARTTLS or
  TLS (the server's certificate checked, a login only over TLS; plain SMTP
  only to a relay on the hub's own host), from a small client of the hub's
  own (`hub/lib/smtp.js`). Apprise reaches everything else, through an
  Apprise API or the `apprise` command (`Suggests: apprise`), which gets the
  URLs in its environment, never on its command line. A new email channel
  starts at critical, as spec 8.3 suggests.
- More alert channels and their settings (spec 8.4): Gotify, Telegram,
  Discord, Slack, Microsoft Teams (a Workflows webhook), Pushover and Matrix
```

In `docs/networking.md`:

1. Replace

```markdown
`NO_PROXY` takes host names, domain suffixes (`.example.com`), IPv4 CIDRs
(`10.0.0.0/8`), IPv6 addresses and `*`; `localhost` is always direct. The
hub's log names the proxy host at start, never its credentials. Proxies and firewalls often cut idle connections before the
55-second long poll ends: set `WAIT_SECONDS=25` (5 to 55) if waits keep
failing.
```

   with

```markdown
`NO_PROXY` takes host names, domain suffixes (`.example.com`), IPv4 CIDRs
(`10.0.0.0/8`), IPv6 addresses and `*`; `localhost` is always direct. The
hub's log names the proxy host at start, never its credentials. Email goes
straight to the SMTP server: SMTP does not go through an HTTP proxy, so a
hub behind one needs a mail relay it can reach (on its own host, the
"none" security setting is allowed for that). Proxies and firewalls often cut idle connections before the
55-second long poll ends: set `WAIT_SECONDS=25` (5 to 55) if waits keep
failing.
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 444 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 5: Commit**

```bash
git add hub/lib/notify.js www/js/alerts.js hub/lib/i18n.js test/notify.test.js test/page.test.js CHANGELOG.md docs/networking.md
git commit -m "feat: email and Apprise alert channels"
```
