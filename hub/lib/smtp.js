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
