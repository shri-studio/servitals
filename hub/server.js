// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * servitals gateway — zero dependencies.
 *
 * - login form + HMAC-signed session cookie (sv_session)
 * - after MAX_FAILS failed logins an IP is banned (BAN_HOURS=0 => until unbanned)
 * - whitelisted IPs / CIDRs can never be banned and skip login-count tracking
 * - client IPs from proxy headers only when the peer is in TRUSTED_PROXIES
 * - state-changing requests need a same-origin Origin header
 * - state (bans, whitelist, config, nodes, snapshots) lives in STATE_DIR
 *
 * unban:      servitals-ctl unban <ip>
 * whitelist:  servitals-ctl whitelist <ip|cidr>
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createLogger } = require("./lib/log");
const { verifyPassword, describeHash, hashPassword } = require("./lib/password");
const { createClientResolver, parseCidrList, isWhitelisted } = require("./lib/clientip");
const { originAllowed, requestIsHttps } = require("./lib/origin");
const { VERSION } = require("./lib/version");
const { createStatic } = require("./lib/static");
const { tr } = require("./lib/i18n");
const { writeFileAtomic } = require("./lib/fsutil");
const os = require("os");
const { createNodeStore, localAgentEnv } = require("./lib/nodes");
const { createAgentApi } = require("./lib/agentapi");
const { view: snapshotView } = require("./lib/snapshot");
const { createHistory, seriesOf } = require("./lib/history");
const { createAlerts } = require("./lib/alerts");
const alertRules = require("./lib/alertrules");
const fleet = require("./lib/fleet");
const { createAdminStore, USER_RE } = require("./lib/admin");
const { createLinks } = require("./lib/link");
const { createConfd } = require("./lib/confd");

const UP        = process.env.UPSTREAM     || "";   // unset: serve WWW_DIR directly (native install)
const WWW_DIR   = path.resolve(process.env.WWW_DIR || path.join(__dirname, "..", "www"));
const BIND_ADDR = process.env.BIND_ADDR    || "";   // unset: all addresses
const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const CTL_LAN_ONLY = process.env.CTL_LAN_ONLY !== "0";   // control actions: whitelisted IPs only
const USER      = process.env.AUTH_USER    || "admin";
const PASS      = process.env.AUTH_PASS    || "";
const PASS_HASH = process.env.AUTH_PASS_HASH || "";           // scrypt:… (or legacy sha256 hex)
const MAX_FAILS = parseInt(process.env.MAX_FAILS || "3", 10);
const BAN_HOURS = parseFloat(process.env.BAN_HOURS || "0");   // 0 => permanent
const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS || "720");
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PROXY_HEADER = (process.env.PROXY_HEADER || "x-forwarded-for").toLowerCase();
const SITE   = process.env.SITE_NAME || "servitals";
const PORT   = parseInt(process.env.PORT || "8080", 10);
// STATE_DIRECTORY is set by systemd's StateDirectory=; DATA_DIR is the Docker name
const DATA   = process.env.STATE_DIR || process.env.STATE_DIRECTORY || process.env.DATA_DIR || "/data";
const SEED_WHITELIST = (process.env.WHITELIST ||
  "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16").split(",").map(s => s.trim());

fs.mkdirSync(DATA, { recursive: true });
const log = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: process.env.LOG_FORMAT === "json" ? "json" : "logfmt",
  journal: !!process.env.JOURNAL_STREAM,
  auditFile: path.join(DATA, "audit.log"),
});
let serveStatic = null;
if (!UP) {
  try { serveStatic = createStatic(WWW_DIR); }
  catch (e) {
    log.error("config.www_missing", { www_dir: WWW_DIR, error: e.code || String(e) });
    process.exit(1);
  }
}
// the dictionary (hub/lib/i18n.js), served to the page as /js/i18n.js in both modes
const serveI18n = createStatic(path.join(__dirname, "lib"));

// TRUST_PROXY from an old .env: "0" means trust nobody, anything else maps to
// the loopback default. TRUSTED_PROXIES wins when both are set.
let trustedProxies = process.env.TRUSTED_PROXIES;
if (trustedProxies === undefined && process.env.TRUST_PROXY !== undefined) {
  trustedProxies = process.env.TRUST_PROXY === "0" ? "" : "127.0.0.1,::1";
  log.warn("config.trust_proxy_deprecated", { hint: "set TRUSTED_PROXIES instead", trusted_proxies: trustedProxies });
}
if (trustedProxies === undefined) trustedProxies = "127.0.0.1,::1";
const resolveClient = createClientResolver({ trustedProxies, proxyHeader: PROXY_HEADER });

/* ---------- admin login: STATE_DIR/admin.json wins over the environment ---------- */
const admin = createAdminStore(path.join(DATA, "admin.json"));
if (admin.isBroken() && !admin.load()) {
  log.error("auth.admin_unreadable", { file: path.join(DATA, "admin.json"), hint: "fix it or run servitals-ctl passwd" });
  process.exit(1);
}
const ADMIN_FILE_LOGIN = !!admin.load();
if (!ADMIN_FILE_LOGIN && !PASS && !PASS_HASH) {
  log.error("auth.no_password", { hint: "run servitals-ctl passwd, or set AUTH_PASS_HASH (servitals-ctl hash-password)" });
  process.exit(1);
}
if (!ADMIN_FILE_LOGIN && PASS_HASH && describeHash(PASS_HASH) === "invalid") {
  log.error("auth.bad_hash", { hint: "AUTH_PASS_HASH is neither scrypt:… nor 64 hex characters" });
  process.exit(1);
}
if (!ADMIN_FILE_LOGIN && PASS_HASH && describeHash(PASS_HASH) === "sha256") {
  log.warn("auth.legacy_hash", { hint: "replace with servitals-ctl hash-password" });
}
if (!ADMIN_FILE_LOGIN && !PASS_HASH) {
  log.warn("auth.plain_password", { hint: "store a hash instead: servitals-ctl hash-password" });
}

const BANS_F  = path.join(DATA, "bans.json");
const WL_F    = path.join(DATA, "whitelist.txt");
const FAILS_F = path.join(DATA, "fails.json");
const SECRET_F = path.join(DATA, "secret");

/* ---------- state files ---------- */
if (!fs.existsSync(SECRET_F)) fs.writeFileSync(SECRET_F, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
if (!fs.existsSync(BANS_F))  fs.writeFileSync(BANS_F, "{}\n");
if (!fs.existsSync(FAILS_F)) fs.writeFileSync(FAILS_F, "{}\n");
if (!fs.existsSync(WL_F)) {
  fs.writeFileSync(WL_F,
    "# one IP or CIDR per line. edited live, no restart needed.\n" +
    SEED_WHITELIST.join("\n") + "\n");
}
const SECRET = fs.readFileSync(SECRET_F, "utf8").trim();

// config.json used to live in www/ (Docker install); copy it to the state dir once
const CONFIG_F = path.join(DATA, "config.json");
const LEGACY_CONFIG = path.join(WWW_DIR, "config.json");
if (!fs.existsSync(CONFIG_F) && fs.existsSync(LEGACY_CONFIG)) {
  try {
    fs.copyFileSync(LEGACY_CONFIG, CONFIG_F);
    log.info("config.migrated", { from: LEGACY_CONFIG, to: CONFIG_F });
  } catch (e) { log.warn("config.migrate_failed", { from: LEGACY_CONFIG, error: e.code || String(e) }); }
}

/* ---------- config as code (spec 12): conf.d files win over the page ---------- */
const CONFD_DIR = process.env.CONFD_DIR || "/etc/servitals/conf.d";
const confd = createConfd(CONFD_DIR, { log });
{
  const c = confd.get();
  log.info("config.confd", { dir: CONFD_DIR, files: c.files.length, skipped: c.files.filter((f) => !f.ok).length });
}
// a node as the page sees it: tags and name from conf.d win. Entries for its id and
// for its name merge (the id's win); an entry found by the name pins the name,
// because a rename would detach it.
function withFile(n) {
  const all = confd.get().nodes;
  const byName = Object.prototype.hasOwnProperty.call(all, n.name) ? all[n.name] : null;
  const byId = Object.prototype.hasOwnProperty.call(all, n.id) ? all[n.id] : null;
  if (!byName && !byId) return { ...n, managed: [] };
  const f = { ...(byName || {}), ...(byId || {}) };
  const managed = new Set(Object.keys(f));
  if (byName) managed.add("name");
  return { ...n, ...f, managed: [...managed].sort() };
}

/* ---------- nodes: the hub's own host is the local node ---------- */
const nodes = createNodeStore(path.join(DATA, "nodes.json"));
const LOCAL_HUB_URL = process.env.LOCAL_HUB_URL || `http://127.0.0.1:${PORT}`;
let localNode;
try { localNode = nodes.ensureLocal(os.hostname().slice(0, 64)); }
catch (e) {
  // never replace paired nodes because of a bad hand edit
  log.error("nodes.unreadable", { file: path.join(DATA, "nodes.json"), error: e.message });
  process.exit(1);
}
if (localNode.created) log.audit("node.added", { node: localNode.id, local: true });
// the local agent's credentials: Docker mounts this file, the installer copies it
writeFileAtomic(path.join(DATA, "local-agent.env"),
  localAgentEnv(LOCAL_HUB_URL, localNode.id, nodes.get(localNode.id).secret), 0o600);

/* ---------- agent API and the latest snapshot per node ---------- */
const SNAP_DIR = path.join(DATA, "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });
// node id -> { snap (validated, as pushed), view (what the page reads), at (hub ms) }
const latest = new Map();
for (const n of nodes.list()) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, n.id + ".json"), "utf8"));
    if (rec && rec.snap && rec.view && rec.at) latest.set(n.id, rec);   // older formats: wait for a push
  } catch (_) { /* no snapshot yet */ }
}
// history (spec 7): ring files per node and series; the current minute in memory
const history = createHistory(path.join(DATA, "history"), { log });   // logs a failing series or a full node once
const historyFlush = () => {
  try { history.flush(); } catch (e) { log.warn("history.flush_failed", { error: e.code || String(e) }); }
};
const historySweep = () => {
  try { history.sweep(new Set(nodes.list().map((n) => n.id))); } catch (e) { log.warn("history.sweep_failed", { error: e.code || String(e) }); }
};
setInterval(historyFlush, 60000).unref();
setInterval(historySweep, 86400000).unref();
historySweep();
// alerts (spec 8.1): judged on each push and once a minute; events go to the log (channels: 6c)
const HUB_START = Date.now();
// the alert rules the person set (spec 8.1); a file that cannot be read leaves the defaults
const RULES_F = path.join(DATA, "alerts", "rules.json");
let savedRules = { rules: [] };
try { savedRules = alertRules.checkRules(JSON.parse(fs.readFileSync(RULES_F, "utf8")), { nodeIds: null }); }
catch (e) { if (e.code !== "ENOENT") log.warn("alerts.rules_ignored", { error: e.message || String(e) }); }
const alerts = createAlerts(path.join(DATA, "alerts"), {
  rules: alertRules.buildRules(savedRules),
  warn: (event, fields) => log.warn(event, fields),
  onEvent: (e) => log.info("alert." + e.kind, { rule: e.rule, severity: e.severity, node: e.node, ...(e.sub ? { sub: e.sub } : {}), value: e.value }),
});
const nodeName = (id) => { const n = nodes.get(id); return (n && n.name) || id; };
setInterval(() => {
  try {
    alerts.check(nodes.list().map((n) => {
      const rec = latest.get(n.id);
      // a hub that was down is no reason to page: a node's time runs from the hub's start at the earliest
      return { id: n.id, name: n.name, tags: n.tags, lastPush: rec ? Math.max(rec.at, HUB_START) : null, interval: rec ? rec.snap.interval : null };
    }));
  } catch (e) { log.warn("alerts.check_failed", { error: e.code || String(e) }); }
}, 60000).unref();
const agentApi = createAgentApi({
  nodes, log,
  replayFile: path.join(DATA, "replay.json"),
  clientIp: (req) => resolveClient(req).ip,
  onSnapshot(id, snap) {
    const prev = latest.get(id);
    const rec = { snap, view: snapshotView(snap, prev && prev.snap, prev ? prev.view.trend : []), at: Date.now() };
    latest.set(id, rec);
    try { history.add(id, seriesOf(rec.view)); } catch (e) { log.warn("history.add_failed", { node: id, error: e.code || String(e) }); }
    try { alerts.evaluate({ id, name: nodeName(id), tags: (nodes.get(id) || {}).tags || [] }, rec.view); } catch (e) { log.warn("alerts.evaluate_failed", { node: id, error: e.code || String(e) }); }
    try { writeFileAtomic(path.join(SNAP_DIR, id + ".json"), JSON.stringify(rec)); }
    catch (e) { log.warn("api.snapshot_write_failed", { node: id, error: e.code || String(e) }); }
  },
});
const nodeStatus = (id) => {
  const rec = latest.get(id);
  return fleet.status(rec && rec.at, rec && rec.snap.interval);
};
// wake one node unless it pushed or was woken in the last 5 s
function wakeNode(id) {
  const now = Date.now();
  const fresh = now - agentApi.lastPushAt(id) < 5000;
  const pending = now - agentApi.lastWakeAt(id) < 5000;
  return { fresh, woke: !fresh && !pending && agentApi.wake(id) };
}

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
const readWL = () => { try {
  return fs.readFileSync(WL_F, "utf8").split("\n")
    .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
} catch { return []; } };

/* ---------- html escaping (for the few spots that echo external strings) ---------- */
const escHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// a command on a page, as code
const codeHtml = (s) => "<code>" + escHtml(s) + "</code>";
// a dictionary string as page text: the words escaped, each {name} replaced by ready HTML
const trHtml = (key, html = {}) => tr(key).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(html, k) ? html[k] : m));

/* ---------- client identity ---------- */
function whitelisted(client) { return isWhitelisted(client, parseCidrList(readWL())); }

/* ---------- ban / fail tracking ----------
   ip is null when the address didn't parse (only possible from a forged proxy
   header). Such a request has no trackable identity, so it is never banned and
   never recorded — otherwise every unparseable client would share one bucket
   and could lock each other out. */
function banInfo(ip) {
  if (!ip) return null;
  const bans = readJSON(BANS_F);
  const b = bans[ip];
  if (!b) return null;
  if (b.until && Date.now() > b.until) { delete bans[ip]; writeJSON(BANS_F, bans); return null; }
  return b;
}
function recordFail(ip) {
  if (!ip) return { banned: false, remaining: MAX_FAILS };
  const fails = readJSON(FAILS_F);
  const n = (fails[ip]?.n || 0) + 1;
  fails[ip] = { n, last: Date.now() };
  writeJSON(FAILS_F, fails);
  if (n >= MAX_FAILS) {
    const bans = readJSON(BANS_F);
    bans[ip] = { at: Date.now(), until: BAN_HOURS > 0 ? Date.now() + BAN_HOURS * 3600e3 : 0, fails: n };
    writeJSON(BANS_F, bans);
    delete fails[ip]; writeJSON(FAILS_F, fails);
    return { banned: true, remaining: 0 };
  }
  return { banned: false, remaining: MAX_FAILS - n };
}
function clearFails(ip) {
  if (!ip) return;
  const fails = readJSON(FAILS_F);
  if (fails[ip]) { delete fails[ip]; writeJSON(FAILS_F, fails); }
}

/* ---------- constant-time compare ---------- */
const sha256 = (s) => crypto.createHash("sha256").update(s || "").digest();
// compare via fixed-size digests: constant-time AND immune to the length-mismatch
// throw that would otherwise crash the process on a malformed input.
function eq(a, b) { return crypto.timingSafeEqual(sha256(a), sha256(b)); }

/* ---------- session cookie ---------- */
function sign(data) { return crypto.createHmac("sha256", SECRET).update(data).digest("base64url"); }
// the current login: admin.json when present, else the environment (gen 0)
function creds() {
  return admin.load() || { user: USER, hash: PASS_HASH, plain: PASS, gen: 0 };
}
// sessions name the user and the login generation: a new name or password ends them
function makeCookie() {
  const c = creds();
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = Buffer.from(JSON.stringify({ u: c.user, g: c.gen, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function validCookie(c) {
  if (!c) return false;
  const [payload, mac] = c.split(".");
  if (!payload || !mac || !eq(mac, sign(payload))) return false;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    const now = creds();
    return s.exp > Date.now() && s.u === now.user && (s.g || 0) === now.gen;
  } catch { return false; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/* ---------- password check ---------- */
async function checkPass(u, p) {
  const c = creds();
  const userOk = eq(u, c.user);
  const passOk = c.hash ? await verifyPassword(p || "", c.hash) : eq(p, c.plain);
  return userOk && passOk;
}

/* ---------- pages ---------- */
// login, ban and /link pages are rendered here: no script at all, only their own inline styles
const FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";
const SHELL = (title, inner, wide = false) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#090c11;color:#c3cddb;font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;
  font-size:13.5px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  -webkit-font-smoothing:antialiased}
.box{border:1px solid #2b3440;background:#0e131b;max-width:${wide ? 520 : 380}px;width:100%}
.box h1{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:#8f9bad;
  padding:12px 16px;border-bottom:1px solid #2b3440}
.box .body{padding:18px 16px}
label{display:block;color:#8f9bad;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;margin:10px 0 4px}
input{width:100%;background:#090c11;border:1px solid #2b3440;color:#f2f5f9;font-family:inherit;
  font-size:13.5px;padding:8px 10px}
input:focus{outline:none;border-color:#7db2ff}
button{margin-top:16px;width:100%;background:#090c11;border:1px solid #3a6ea5;color:#7db2ff;
  font-family:inherit;font-size:13.5px;padding:9px;cursor:pointer}
button:hover{border-color:#7db2ff}
.msg{margin-top:12px;font-size:12.5px}
.err{color:#f57b72}.warn{color:#ecc05a}.ok{color:#74dd92}
.foot{color:#8f9bad;font-size:11.5px;padding:10px 16px;border-top:1px solid #2b3440}
code{color:#f2f5f9;word-break:break-all}
a{color:#7db2ff}
.kv{display:grid;grid-template-columns:90px 1fr;gap:6px 12px;margin:14px 0 4px}
.kv dt{color:#8f9bad}.kv dd{color:#f2f5f9;word-break:break-all}
.row2{display:flex;gap:10px}.row2 button{flex:1}
button.deny{border-color:#7a3b37;color:#f57b72}button.deny:hover{border-color:#f57b72}
</style></head><body><div class="box">${inner}</div></body></html>`;

// a wall screen opened at /?kiosk keeps kiosk through the login (spec 10.3);
// only "1" or "0" ever reaches the form and the redirect
const kioskValue = (v) => (v === null ? "" : v === "0" ? "0" : "1");
const kioskFromUrl = (url) => {
  const m = /[?&]kiosk(?:=([^&#]*))?(?:[&#]|$)/.exec(url || "");
  return m ? kioskValue(m[1] || "") : "";
};
// the login page can lead back to /link (and only there)
const nextValue = (v) => (v === "link" ? "link" : "");
const loginPage = (msg, kiosk = "", next = "") => SHELL(SITE + " · " + trHtml("hub.login"), `
  <h1>${SITE} · ${trHtml("hub.loginTitle")}</h1>
  <form class="body" method="POST" action="/__auth/login">
    ${kiosk ? `<input type="hidden" name="kiosk" value="${kiosk}">` : ""}
    ${next ? `<input type="hidden" name="next" value="${next}">` : ""}
    <label>${trHtml("hub.username")}</label><input name="username" autocomplete="username" autofocus>
    <label>${trHtml("hub.password")}</label><input name="password" type="password" autocomplete="current-password">
    <button type="submit">${trHtml("hub.loginButton")}</button>
    ${msg ? `<div class="msg ${msg.cls}">${msg.html}</div>` : ""}
  </form>
  <div class="foot">servitals · ${trHtml("hub.loginFoot", { n: MAX_FAILS })}</div>`);

const bannedPage = (ip, b) => SHELL(SITE + " · " + trHtml("hub.blocked"), `
  <h1>${SITE} · ${trHtml("hub.blockedTitle")}</h1>
  <div class="body">
    <div class="msg err">${trHtml("hub.blockedWhy", { ip: escHtml(ip) })}</div>
    <div class="msg" style="color:#5a6675;margin-top:10px">
      ${b.until ? trHtml("hub.blockedUntil", { when: new Date(b.until).toISOString().replace("T", " ").slice(0, 16) })
                : trHtml("hub.blockedForever")}
    </div>
  </div>
  <div class="foot">${trHtml("hub.blockedAdmin")} <code>servitals-ctl unban ${escHtml(ip)}</code></div>`);

/* ---------- code-based linking (spec 6.1.1, protocol 5.3) ---------- */
const links = createLinks();
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// plain HTTP straight from this host: tests and the package smoke test only. A local
// reverse proxy that adds no forwarding header looks exactly the same, so it is off by default.
const LINK_ALLOW_LOOPBACK = process.env.LINK_ALLOW_LOOPBACK === "1";
const FORWARDING = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded", "via"];
const lastValue = (v) => String(v || "").split(",").pop().trim().toLowerCase();
// Stricter than requestIsHttps: the node secret crosses the network here, so this
// connection itself must be TLS, or come from a trusted proxy that says https,
// or (LINK_ALLOW_LOOPBACK=1) come straight from this host. An https PUBLIC_URL alone is not enough.
function linkTransportOk(req, client) {
  if (req.socket && req.socket.encrypted) return true;
  if (client.peerTrusted && req.headers["x-forwarded-proto"]) return lastValue(req.headers["x-forwarded-proto"]) === "https";
  return LINK_ALLOW_LOOPBACK && LOOPBACK.has(req.socket && req.socket.remoteAddress) &&
    ![...FORWARDING, PROXY_HEADER].some((h) => req.headers[h] !== undefined);
}
// the address people type into a browser to reach this hub
function publicBase(req, client) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, "");
  const host = String(req.headers.host || "").toLowerCase();
  const https = (req.socket && req.socket.encrypted) || (client.peerTrusted && lastValue(req.headers["x-forwarded-proto"]) === "https");
  return /^[a-z0-9.:[\]-]{1,255}$/.test(host) ? `${https ? "https" : "http"}://${host}` : "";
}
// what the agent prints after linking: "a***n on hub.example"
function accountLabel(req, client) {
  const u = creds().user;
  const masked = u.length <= 2 ? u[0] + "***" : u[0] + "***" + u.slice(-1);
  let host = "";
  try { host = new URL(publicBase(req, client)).host; } catch (_) { /* no usable address */ }
  return host ? `${masked} on ${host}` : masked;
}

async function handleLinkApi(req, res, client) {
  const send = (code, o, extra = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(o));
  };
  const pathname = (req.url || "").split("?")[0];
  if (pathname !== "/api/v1/link/start" && pathname !== "/api/v1/link/poll") return send(404, { error: "not_found" });
  if (req.method !== "POST") return send(405, { error: "method_not_allowed" }, { allow: "POST" });
  if (!linkTransportOk(req, client)) return send(403, { error: "https_required" });
  let body = null;
  try { body = JSON.parse(await readBodyN(req, 2048)); } catch (_) { /* answered below */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "invalid_request" });
  if (pathname === "/api/v1/link/start") {
    const r = links.start({ secret: body.secret, host: body.host, os: body.os, agent: body.agent, ip: client.ip });
    if (r.status === 200) {
      r.body.verify_url = publicBase(req, client) + "/link";
      log.audit("link.started", { ip: client.ip, host: body.host });
    }
    return send(r.status, r.body, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
  }
  const r = links.poll(body.device_code);
  return send(r.status, r.body);
}

const linkPage = (inner) => SHELL(SITE + " · " + trHtml("link.title"), `<h1>${SITE} · ${trHtml("link.title")}</h1>${inner}`, true);
const linkCodeForm = (base, msg = "") => linkPage(`
  <form class="body" method="POST" action="/link">
    <input type="hidden" name="step" value="lookup">
    <div class="msg">${trHtml("link.run", { command: codeHtml("sudo servitals-agent link " + (base || "https://this-hub")) })}</div>
    <label>${trHtml("link.code")}</label><input name="code" autocomplete="off" autofocus placeholder="${escHtml(tr("link.codePh"))}" maxlength="16">
    <button type="submit">${trHtml("link.continue")}</button>
    ${msg ? `<div class="msg err">${escHtml(msg)}</div>` : ""}
  </form>
  <div class="foot">${trHtml("link.onlyYours")}</div>`);
const minutes = (ms) => Math.max(0, Math.round(ms / 60000));
const linkAskForm = (q, msg = "") => linkPage(`
  <form class="body" method="POST" action="/link">
    <input type="hidden" name="step" value="decide">
    <input type="hidden" name="code" value="${escHtml(q.code)}">
    <div class="msg warn">${trHtml("link.asks", { command: codeHtml("servitals-agent link") })}</div>
    <dl class="kv">
      <dt>${trHtml("link.host")}</dt><dd>${escHtml(q.host)}</dd>
      <dt>${trHtml("link.system")}</dt><dd>${trHtml("link.systemValue", { os: escHtml(q.os), agent: escHtml(q.agent) })}</dd>
      <dt>${trHtml("link.from")}</dt><dd>${q.ip ? escHtml(q.ip) : trHtml("link.unknownAddress")}</dd>
      <dt>${trHtml("link.asked")}</dt><dd>${trHtml("link.askedValue", { ago: minutes(Date.now() - q.started), left: minutes(q.expires - Date.now()) })}</dd>
      <dt>${trHtml("link.code")}</dt><dd>${escHtml(q.code)}</dd>
    </dl>
    <label>${trHtml("link.name")}</label><input name="name" value="${escHtml(q.host)}" maxlength="64">
    <label>${trHtml("link.tags")}</label><input name="tags" placeholder="${escHtml(tr("link.tagsPh"))}" maxlength="200">
    <div class="row2">
      <button type="submit" name="action" value="approve">${trHtml("link.approve")}</button>
      <button type="submit" name="action" value="deny" class="deny">${trHtml("link.deny")}</button>
    </div>
    ${msg ? `<div class="msg err">${escHtml(msg)}</div>` : ""}
  </form>`);
const LINK_ERRORS = { unknown: tr("link.unknown"), too_many: tr("link.tooMany") };

async function linkRoute(req, res, client) {
  // never inside another site's frame: approving is one click
  const html = (body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
                         "x-frame-options": "DENY", "content-security-policy": FORM_CSP, "x-content-type-options": "nosniff" });
    res.end(body);
  };
  const base = publicBase(req, client);
  if (req.method !== "POST") return html(linkCodeForm(base));
  const f = new URLSearchParams(await readBody(req));
  const who = { ip: client.ip, account: creds().user };
  const code = f.get("code") || "";
  if (f.get("step") !== "decide") {
    const q = links.lookup(code, who);
    return html(q.ok ? linkAskForm(q.request) : linkCodeForm(base, LINK_ERRORS[q.error]));
  }
  if (f.get("action") === "deny") {
    const d = links.decide(code, false, who);
    if (!d.ok) return html(linkCodeForm(base, LINK_ERRORS[d.error]));
    log.audit("link.denied", { ip: client.ip, host: d.host, from: d.from });
    return html(linkPage(`<div class="body"><div class="msg">${trHtml("link.denied")}</div>
      <div class="msg"><a href="/">${trHtml("link.back")}</a></div></div>`));
  }
  const tags = (f.get("tags") || "").split(/[\s,]+/).filter(Boolean);
  let name;
  try { name = nodes.check(f.get("name") || "", tags); }
  catch (e) {
    const q = links.lookup(code, who);
    return html(q.ok ? linkAskForm(q.request, e.message) : linkCodeForm(base, LINK_ERRORS[q.error]));
  }
  let d;
  try {
    d = links.decide(code, true, who, ({ secret }) => ({ node_id: nodes.add(name, tags, secret).id, account: accountLabel(req, client), name }));
  } catch (e) {
    log.error("link.save_failed", { error: e.message });
    return html(linkCodeForm(base, tr("link.saveFailed", { error: e.message })));
  }
  if (!d.ok) return html(linkCodeForm(base, LINK_ERRORS[d.error]));
  log.audit("link.approved", { ip: client.ip, node: d.result.node_id, name, from: d.from });
  return html(linkPage(`<div class="body"><div class="msg ok">${trHtml("link.linked", { name: escHtml(name) })}</div>
    <div class="msg">${trHtml("link.soon")}</div>
    <div class="msg"><a href="/#fleet">${trHtml("link.openFleet")}</a></div></div>`));
}

const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]);

/* ---------- proxy ---------- */
function proxy(req, res) {
  const u = new URL(req.url, UP);
  const opts = {
    protocol: u.protocol, hostname: u.hostname, port: u.port || 80,
    method: req.method, path: u.pathname + u.search,
    headers: { ...req.headers, host: u.host },
  };
  const p = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  p.on("error", () => { res.writeHead(502, { "content-type": "text/plain" }); res.end("upstream unavailable"); });
  req.pipe(p);
}

/* ---------- request handler ---------- */
function readBodyN(req, max) {
  return new Promise((resolve) => {
    let d = "";
    const done = () => resolve(d);   // resolve is idempotent; "close" covers destroy()/error
    req.on("data", c => { d += c; if (Buffer.byteLength(d) > max) req.destroy(); });
    req.on("end", done);
    req.on("close", done);
  });
}
const readBody = (req) => readBodyN(req, 1e4);

/* ---------- docker api (unix socket) ---------- */
function dockerApi(method, path) {
  return new Promise((resolve) => {
    const r = http.request({ socketPath: DOCKER_SOCK, method, path, timeout: 15000 }, (pr) => {
      const chunks = [];
      let n = 0;
      pr.on("data", c => { n += c.length; if (n <= 524288) chunks.push(c); });
      pr.on("end", () => resolve({ status: pr.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on("error", (e) => resolve({ status: 502, buf: Buffer.from(String(e)) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 504, buf: Buffer.from("timeout") }); });
    r.end();
  });
}
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/;

// docker log stream: 8-byte frame headers [stream,0,0,0,len32be] unless the
// container has a TTY (then it's raw). Detect and de-multiplex.
function demuxLogs(buf) {
  if (buf.length < 8) return buf.toString("utf8");
  const framed = buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!framed) return stripAnsi(buf.toString("utf8"));
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    if (buf[i] > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) break;
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + len).toString("utf8"));
    i += 8 + len;
  }
  return stripAnsi(out.join(""));
}
// strip CSI / OSC escape sequences so raw logs read cleanly
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[=>]/g, "");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log.error("http.error", { error: String(err && err.stack || err) });
    try {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    } catch (_) { /* response already gone */ }
  });
});

async function handle(req, res) {
  // agents authenticate with signatures, never cookies; browser bans do not apply
  if ((req.url || "").startsWith("/api/v1/link/")) return handleLinkApi(req, res, resolveClient(req));
  if ((req.url || "").startsWith("/api/v1/")) return agentApi.handle(req, res);

  const client = resolveClient(req);
  const ip = client.ip;
  const wl = whitelisted(client);

  if (!wl) {
    const b = banInfo(ip);
    if (b) { res.writeHead(403, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": FORM_CSP, "x-content-type-options": "nosniff" }); return res.end(bannedPage(ip, b)); }
  }

  // health check, no auth
  if (req.url === "/__auth/health") { res.writeHead(200); return res.end("ok"); }

  // CSRF: state-changing browser requests must come from our own origin
  const stateChange = req.method === "POST" && req.url && (
    req.url === "/__auth/login" || req.url === "/__auth/logout" || req.url.startsWith("/__ctl/") ||
    req.url.split("?")[0] === "/link");
  if (stateChange && !originAllowed(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted })) {
    log.warn("auth.origin_refused", { ip, url: req.url, origin: req.headers.origin || "" });
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("cross-origin request refused");
  }
  const secure = requestIsHttps(req, { publicUrl: PUBLIC_URL, peerTrusted: client.peerTrusted }) ? "; Secure" : "";

  if (req.method === "POST" && req.url === "/__auth/login") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get("username") || "";
    const ok = await checkPass(user, params.get("password") || "");
    const kiosk = kioskValue(params.get("kiosk"));
    const next = nextValue(params.get("next"));
    if (ok) {
      clearFails(ip);
      log.audit("auth.login_ok", { ip, user });
      res.writeHead(302, {
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
        location: next ? "/link" : kiosk ? `/?kiosk=${kiosk}` : "/",
      });
      return res.end();
    }
    await new Promise(r => setTimeout(r, 800)); // slow brute force
    let msg = { cls: "err", html: trHtml("hub.loginWrong") };
    if (!wl) {
      const r = recordFail(ip);
      log.audit("auth.login_fail", { ip, user, remaining: r.remaining });
      if (r.banned) {
        log.audit("auth.banned", { ip, hours: BAN_HOURS });
        res.writeHead(403, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": FORM_CSP, "x-content-type-options": "nosniff" });
        return res.end(bannedPage(ip, banInfo(ip) || {}));
      }
      msg = { cls: "warn", html: r.remaining === 1 ? trHtml("hub.loginLeft1") : trHtml("hub.loginLeftN", { n: r.remaining }) };
    } else {
      log.audit("auth.login_fail", { ip, user, whitelisted: true });
    }
    res.writeHead(401, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": FORM_CSP, "x-content-type-options": "nosniff" });
    return res.end(loginPage(msg, kiosk, next));
  }

  if (req.url === "/__auth/logout") {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end("POST only"); }
    log.audit("auth.logout", { ip });
    res.writeHead(302, { "set-cookie": `sv_session=; Path=/; Max-Age=0${secure}`, location: "/" });
    return res.end();
  }

  const authed = validCookie(getCookie(req, "sv_session"));
  const pathname = (req.url || "/").split("?")[0];

  // the app manifest and its icons: browsers fetch them without cookies (spec 10.3), and
  // nothing in them is private. Exact paths only.
  if (req.method === "GET" && PUBLIC_FILES.has(pathname)) return UP ? proxy(req, res) : serveStatic(req, res);

  // a person approves a linking server here (spec 6.1.1)
  if (pathname === "/link") {
    if (authed) return linkRoute(req, res, client);
    if (req.method === "POST") { res.writeHead(401, { "content-type": "text/plain" }); return res.end("login required"); }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": FORM_CSP, "x-content-type-options": "nosniff" });
    return res.end(loginPage(null, "", "link"));
  }

  // dashboard settings: from the state dir, not www/ (the page falls back to its defaults)
  // settings from the page, with conf.d values on top; _managed lists what the files set
  if (authed && req.method === "GET" && pathname === "/config.json") {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(CONFIG_F, "utf8")); } catch (_) { /* nothing saved yet */ }
    const out = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    const c = confd.get();
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    for (const [k, v] of Object.entries(c.settings)) out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
    out._managed = c.managed;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(out, null, 2) + "\n");
  }

  // the local node's latest snapshot, where the page and old scripts expect it
  if (authed && req.method === "GET" && pathname === "/data.json") {
    const rec = latest.get(nodes.localId());
    res.writeHead(rec ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(rec ? JSON.stringify(rec.view) : '{"error":"no snapshot yet"}');
  }

  // ---- control endpoints (require a session; restart also requires LAN) ----
  if (req.url && req.url.startsWith("/__ctl/")) {
    if (!authed) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("login required"); }
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

    // ask the local agent to sample now — harmless, any authed user. Within 5 s
    // of a push the data is fresh and a wake would only earn a 429.
    if (req.method === "POST" && pathname === "/__ctl/refresh") {
      const which = new URL(req.url, "http://x").searchParams.get("node");
      if (which === "all") {
        let woke = 0;
        for (const n of nodes.list()) if (wakeNode(n.id).woke) woke++;
        return json(200, { ok: true, woke });
      }
      const id = which || nodes.localId();
      if (!id || !nodes.get(id)) return json(404, { error: "no such node" });
      const r = wakeNode(id);
      return json(200, { ok: true, woke: r.woke, fresh: r.fresh });
    }

    // alerts (spec 8): what is firing, and the last events
    if (req.method === "GET" && pathname === "/__ctl/alerts") {
      return json(200, { firing: alerts.firing(), recent: alerts.recent(50), mutes: alerts.mutes(), rules: alerts.ruleInfo() });
    }
    // mute a rule or a node for a time (ms, counted from the hub's clock, at most a year), or
    // until a time (ms since 1970; at most a year ahead); now or earlier (0) unmutes
    if (req.method === "POST" && pathname === "/__ctl/alerts/mute") {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 1024)); } catch (_) { /* answered below */ }
      const b = body && typeof body === "object" ? body : {};
      // a rule there is; an unmute also for one removed since (its mute went with it)
      const unmute = b.for === undefined && Number(b.until) <= Date.now();
      const okRule = typeof b.rule === "string" && (alerts.ruleIds().includes(b.rule) || (unmute && /^[a-z0-9_]{1,32}$/.test(b.rule)));
      const okNode = typeof b.node === "string" && !!nodes.get(b.node);
      const YEAR = 366 * 86400000;
      const okFor = b.for === undefined || (typeof b.for === "number" && b.for > 0 && b.for <= YEAR);
      const until = b.for !== undefined ? Date.now() + b.for : Number(b.until);
      if ((!okRule && !okNode) || (b.rule !== undefined && !okRule) || (b.node !== undefined && !okNode)
          || !okFor || (b.for !== undefined && b.until !== undefined)
          || !Number.isFinite(until) || until > Date.now() + YEAR) {
        return json(400, { error: "mute needs a known rule or node, and for (ms, at most a year) or until (ms, at most a year ahead)" });
      }
      alerts.mute(okRule ? { rule: b.rule, until } : { node: b.node, until });
      log.audit("alert.muted", { ip, ...(okRule ? { rule: b.rule } : { node: b.node }), until });
      return json(200, { ok: true });
    }

    // the alert rules (spec 8.1): what is saved, the defaults and the metrics, for the editor
    if (req.method === "GET" && pathname === "/__ctl/alerts/rules") {
      return json(200, { saved: savedRules, defaults: alertRules.defaultsForPage(), metrics: alertRules.METRICS });
    }
    // save them whole: checked, kept, applied at once. A server named before it was revoked
    // may stay named; a new one must exist.
    if (req.method === "POST" && pathname === "/__ctl/alerts/rules") {
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 64 * 1024)); } catch (_) { return json(400, { error: "invalid json" }); }
      const named = savedRules.rules.flatMap((r) => [r.scope && r.scope.node, ...(r.overrides || []).map((o) => o.node)]).filter(Boolean);
      let clean;
      try { clean = alertRules.checkRules(body, { nodeIds: [...nodes.list().map((n) => n.id), ...named] }); }
      catch (e) { return json(400, { error: e.message }); }
      try { writeFileAtomic(RULES_F, JSON.stringify(clean, null, 2) + "\n"); }
      catch (e) { return json(500, { error: String(e.code || e) }); }
      savedRules = clean;
      alerts.setRules(alertRules.buildRules(clean));
      log.audit("alert.rules_saved", { ip, rules: clean.rules.length });
      return json(200, { ok: true });
    }

    // history (spec 7): ?node=<id>&series=<name>&range=1h|24h|7d|30d|90d, or series=list
    if (req.method === "GET" && pathname === "/__ctl/history") {
      const q = new URL(req.url, "http://x").searchParams;
      const id = q.get("node") || nodes.localId();
      if (!id || !nodes.get(id)) return json(404, { error: "no such node" });
      const series = q.get("series") || "";
      if (series === "list") return json(200, { series: history.series(id) });
      const range = q.get("range") || "24h";
      if (!/^(1h|24h|7d|30d|90d)$/.test(range)) return json(400, { error: "range is 1h, 24h, 7d, 30d or 90d" });
      const r = history.query(id, series, range);
      return r ? json(200, r) : json(404, { error: "no such series" });
    }

    // the fleet: every node with its status and the numbers a card shows
    if (req.method === "GET" && pathname === "/__ctl/nodes") {
      const badges = alerts.badges();
      const list = nodes.list().map(withFile).map((n) => {
        const rec = latest.get(n.id);
        return { ...n, status: nodeStatus(n.id), lastSeen: rec ? rec.at : null,
                 interval: rec ? rec.snap.interval : null, summary: rec ? fleet.summary(rec.view) : null,
                 alerts: badges[n.id] || null };
      }).sort((a, b) => (b.local - a.local) || a.name.localeCompare(b.name));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(list));
    }

    // one node's latest view
    const nm = /^\/__ctl\/node\/([a-z2-7]{12})$/.exec(pathname);
    if (req.method === "GET" && nm) {
      const n = nodes.list().map(withFile).find((x) => x.id === nm[1]);
      if (!n) return json(404, { error: "no such node" });
      const rec = latest.get(n.id);
      if (!rec) return json(503, { error: "no snapshot yet", node: { ...n, status: "waiting" } });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ ...rec.view, node: { ...n, status: nodeStatus(n.id), lastSeen: rec.at } }));
    }

    // rename or tag a node from the page (spec 10.4); revoke it: LAN only, never the hub's own
    const em = /^\/__ctl\/node\/([a-z2-7]{12})(\/revoke)?$/.exec(pathname);
    if (req.method === "POST" && em) {
      const id = em[1];
      if (!nodes.get(id)) return json(404, { error: "no such node" });
      if (em[2]) {
        if (CTL_LAN_ONLY && !wl) return json(403, { error: "revoking a node is LAN-only" });
        try { nodes.revoke(id); } catch (e) { return json(400, { error: e.message }); }
        latest.delete(id);
        try { fs.unlinkSync(path.join(SNAP_DIR, id + ".json")); } catch (_) { /* never pushed */ }
        try { history.remove(id); } catch (_) { /* swept later */ }
        try { alerts.forget(id); } catch (_) { /* nothing to forget */ }
        log.audit("node.revoked", { ip, node: id });
        return json(200, { ok: true });
      }
      let body = null;
      try { body = JSON.parse(await readBodyN(req, 4096)); } catch (_) { /* answered below */ }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid json" });
      const managed = withFile(nodes.list().find((x) => x.id === id)).managed;
      for (const k of ["tags", "name"]) {
        if (body[k] !== undefined && managed.includes(k)) return json(409, { error: `${k === "tags" ? "tags are" : "the name is"} managed by a file in conf.d` });
      }
      try {
        // check both before changing either
        const name = body.name !== undefined ? nodes.check(body.name) : nodes.get(id).name;
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) throw new Error("tags: a list of words");
          nodes.check(name, body.tags);
        }
        if (body.name !== undefined) nodes.rename(id, name);
        if (body.tags !== undefined) nodes.setTags(id, body.tags);
      } catch (e) { return json(400, { error: e.message }); }
      log.audit("node.changed", { ip, node: id });
      return json(200, { ok: true });
    }

    // does this client get container controls?
    if (req.url === "/__ctl/whoami") {
      return json(200, { ip, lan: wl, controls: (!CTL_LAN_ONLY || wl), version: VERSION, user: creds().user });
    }

    // change the admin name and/or password: the current password is required;
    // every other session ends (the login generation goes up)
    if (req.method === "POST" && req.url === "/__ctl/account") {
      let body;
      try { body = JSON.parse(await readBodyN(req, 4096)); } catch { return json(400, { error: "invalid json" }); }
      const current = creds();
      const user = body && typeof body.user === "string" && body.user !== "" ? body.user : current.user;
      const password = body && typeof body.password === "string" ? body.password : "";
      if (!USER_RE.test(user)) return json(400, { error: "name: 1-64 letters, digits, dot, dash or underscore" });
      if (password !== "" && password.length < 8) return json(400, { error: "password: at least 8 characters" });
      if (!(await checkPass(current.user, body && typeof body.current === "string" ? body.current : ""))) {
        await new Promise((r) => setTimeout(r, 800));
        if (!wl) recordFail(ip);
        log.audit("auth.account_denied", { ip });
        return json(403, { error: "current password is wrong" });
      }
      if (!password && current.hash && describeHash(current.hash) !== "scrypt") {
        return json(400, { error: "choose a new password: the current one is stored in an old format" });
      }
      const hash = password ? await hashPassword(password) : (current.hash || await hashPassword(current.plain));
      try { admin.save({ user, hash, gen: current.gen + 1 }); }
      catch (e) { return json(500, { error: "could not save the login: " + (e.code || e.message) }); }
      log.audit("auth.account_changed", { ip, user, password_changed: password !== "" });
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `sv_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
      });
      return res.end(JSON.stringify({ ok: true, user }));
    }

    // persist the dashboard config (title, favicon, panels, weather, clocks…)
    // any authed user; size-capped; favicon must be a data:image URI
    if (req.method === "POST" && req.url === "/__ctl/config") {
      const body = await readBodyN(req, 512 * 1024);
      let obj;
      try { obj = JSON.parse(body); } catch { return json(400, { error: "invalid json" }); }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return json(400, { error: "not an object" });
      delete obj._managed;   // what conf.d sets comes from the files, never from a save
      // managed values keep what was saved before, so removing the file brings the page's own value back
      let before = {};
      try { before = JSON.parse(fs.readFileSync(CONFIG_F, "utf8")) || {}; } catch (_) { /* nothing saved yet */ }
      for (const p of confd.get().managed) {
        const [k, sub] = p.split(".");
        if (sub === undefined) {
          if (before[k] !== undefined) obj[k] = before[k]; else delete obj[k];
        } else if (obj[k] && typeof obj[k] === "object") {
          const was = before[k] && typeof before[k] === "object" ? before[k][sub] : undefined;
          if (was !== undefined) obj[k][sub] = was; else delete obj[k][sub];
        }
      }
      if (obj.favicon && !/^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+$/.test(obj.favicon))
        return json(400, { error: "favicon must be a base64 data:image URI" });
      if (obj.portainerUrl && !/^https?:\/\/[^\s"'<>]+$/i.test(obj.portainerUrl))
        return json(400, { error: "portainerUrl must be an http(s) URL" });
      try {
        writeFileAtomic(CONFIG_F, JSON.stringify(obj, null, 2) + "\n");
        log.audit("config.saved", { ip });
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: String(e) }); }
    }

    // container lifecycle — whitelisted (LAN) only by default
    const m = pathname.match(/^\/__ctl\/container\/([^/]+)\/(restart|start|stop|logs)$/);
    if (m) {
      // only the hub's own host: never a remote node, whatever the page sends (spec 6.4)
      const target = new URL(req.url, "http://x").searchParams.get("node");
      if (target && target !== nodes.localId()) {
        return json(403, { error: "container controls work only on the hub's own host" });
      }
      if (CTL_LAN_ONLY && !wl) return json(403, { error: "container controls are LAN-only" });
      const name = decodeURIComponent(m[1]), action = m[2];
      if (!SAFE_NAME.test(name)) return json(400, { error: "bad name" });
      if (action === "logs") {
        const r = await dockerApi("GET",
          `/containers/${name}/logs?stdout=1&stderr=1&tail=200&timestamps=0`);
        res.writeHead(r.status === 200 ? 200 : r.status, {
          "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
        });
        return res.end(r.status === 200 ? (demuxLogs(r.buf) || "(no output)")
                                        : r.buf.toString("utf8"));
      }
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const r = await dockerApi("POST", `/containers/${name}/${action}?t=10`);
      log.audit("ctl.container", { ip, action, name, status: r.status });
      return json(r.status < 300 ? 200 : r.status,
        r.status < 300 ? { ok: true, action, name }
                       : { error: r.buf.toString("utf8") || `docker ${r.status}` });
    }
    return json(404, { error: "unknown control" });
  }

  // the dictionary lives with the hub (it words the login page too); the page loads it from here
  if (authed && pathname === "/js/i18n.js") { req.url = "/i18n.js"; return serveI18n(req, res); }
  if (authed) return UP ? proxy(req, res) : serveStatic(req, res);

  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": FORM_CSP, "x-content-type-options": "nosniff" });
  res.end(loginPage(null, kioskFromUrl(req.url)));
}

// a gateway should stay up: log and keep serving rather than exit on a stray throw
process.on("unhandledRejection", (e) => log.error("process.unhandled_rejection", { error: String(e && e.stack || e) }));
process.on("uncaughtException",  (e) => log.error("process.uncaught_exception", { error: String(e && e.stack || e) }));
process.on("SIGTERM", () => {
  historyFlush();     // a clean restart loses no minute (spec 7)
  agentApi.close();   // answer open long polls so close() is not held up by them
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

server.listen(PORT, BIND_ADDR || undefined, () => {
  log.info("server.start", {
    version: VERSION, port: PORT, bind: BIND_ADDR || "*", upstream: UP || `static:${WWW_DIR}`,
    user: creds().user, login: ADMIN_FILE_LOGIN ? "admin.json" : "env", max_fails: MAX_FAILS,
    ban: BAN_HOURS > 0 ? BAN_HOURS + "h" : "permanent",
    trusted_proxies: trustedProxies, proxy_header: PROXY_HEADER,
    container_controls: CTL_LAN_ONLY ? "LAN only" : "any authed",
  });
});
