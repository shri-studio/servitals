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
