// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Where alerts go (spec 8.3, 8.4): the channels a person sets, each with a minimum
 * severity; quiet hours that hold warnings (critical always goes through) and send what
 * is still firing as one summary when they end; info events in one digest a day.
 *   <dir>/channels.json (mode 0600, it holds tokens):
 *     { channels: [{ id: "ch_…", type, name, min, on, digest?, config }],
 *       quiet: null | { from: "HH:MM", to: "HH:MM" }, digestAt: "HH:MM" }
 *   <dir>/notify-state.json: what quiet hours hold, the digest so far, the last digest day.
 * Times are the hub's local time. A config value "$SERVITALS_NOTIFY_<NAME>" is read from
 * the environment when sent (tokens out of the file); no other name, so a page session
 * cannot send the hub's own settings (AUTH_PASS…) anywhere. What it reads is checked as
 * a typed value would be. Each channel sends one message at a time, in order (at most
 * 100 waiting); a send that fails is tried again after 2, 10 and 30 s (a 4xx other than
 * 408 and 429 is not), then logged alert.notify_failed; a channel's last error is kept
 * for the page. Never logged: tokens, and URLs (a webhook URL is a secret).
 * Not kept across a restart: sends under way. The digest is emptied at its time even
 * when no channel is on (the events stay in the alert log).
 *   createNotifier({ dir, outbound, now, log, sleep, env }) → { onEvent(e), tick(), test(id),
 *     setConfig(input), view(), flush() }
 *   checkChannels(input, old) → the clean config, or throws an Error naming the channel
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./fsutil");
const { tr } = require("./i18n");

const SEV = ["critical", "warning", "info"];
const rank = (s) => (SEV.includes(s) ? SEV.indexOf(s) : 2);
const SECRET = "********";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENVREF = /^\$SERVITALS_NOTIFY_[A-Z0-9_]+$/;
const MAX_QUEUE = 100;
const RETRIES = [2000, 10000, 30000];
const MAX_HELD = 500, MAX_DIGEST = 500;

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const httpUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch (_) { return false; } };

/* ------------------------------------------------------------------ channels
   fields: { name: { secret?, optional?, url?, re? } }; build(config, message) → the request */
const ADAPTERS = {
  // ntfy's JSON publishing: no header has to carry the title's characters
  ntfy: {
    fields: { server: { optional: true, url: true }, topic: { re: /^[A-Za-z0-9_-]{1,64}$/ }, token: { optional: true, secret: true, header: true } },
    build(c, m) {
      const server = (c.server || "https://ntfy.sh").replace(/\/+$/, "");
      const tags = m.kind === "test" ? ["white_check_mark"] : m.resolved ? ["white_check_mark"] : m.severity === "critical" ? ["rotating_light"] : ["warning"];
      return { url: server + "/", headers: { "content-type": "application/json", ...(c.token ? { authorization: "Bearer " + c.token } : {}) },
        body: JSON.stringify({ topic: c.topic, title: m.title, message: m.text, priority: m.severity === "critical" ? 5 : m.severity === "warning" ? 4 : 3, tags }) };
    },
  },
  // a JSON POST to any URL; with a secret, X-Servitals-Signature: sha256=<HMAC of the body>
  webhook: {
    fields: { url: { url: true, secret: true }, secret: { optional: true, secret: true } },
    build(c, m) {
      const body = JSON.stringify({ kind: m.kind, severity: m.severity, title: m.title, text: m.text, ...(m.event ? { event: m.event } : {}) });
      const sig = c.secret ? { "x-servitals-signature": "sha256=" + crypto.createHmac("sha256", c.secret).update(body).digest("hex") } : {};
      return { url: c.url, headers: { "content-type": "application/json", ...sig }, body };
    },
  },
};

// what is wrong with a field's value, or ""
function fieldError(f, v) {
  if (f.url && !httpUrl(v)) return "an http or https URL";
  if (f.re && !f.re.test(v)) return "not valid";
  if (f.header && !/^[\x20-\x7e]+$/.test(v)) return "printable ASCII only";
  return "";
}

function checkChannels(input, old = { channels: [] }) {
  if (!isObj(input) || !Array.isArray(input.channels)) throw new Error("channels: a list");
  if (input.channels.length > 20) throw new Error("channels: at most 20");
  const ids = new Set();
  const channels = input.channels.map((ch, i) => {
    let at = `channel ${i + 1}`;
    if (!isObj(ch)) throw new Error(`${at}: not a channel`);
    if (typeof ch.name === "string" && ch.name.trim()) at = ch.name.trim().slice(0, 60);
    if (typeof ch.id !== "string" || !/^ch_[a-z0-9]{1,16}$/.test(ch.id)) throw new Error(`${at}: id: ch_ and up to 16 letters or digits`);
    if (ids.has(ch.id)) throw new Error(`${at}: listed twice`);
    ids.add(ch.id);
    const ad = ADAPTERS[ch.type];
    if (!ad) throw new Error(`${at}: type: one of ${Object.keys(ADAPTERS).join(", ")}`);
    if (typeof ch.name !== "string" || !ch.name.trim() || ch.name.length > 60 || /[\u0000-\u001f\u007f]/.test(ch.name)) throw new Error(`${at}: name: 1 to 60 characters`);
    if (!SEV.includes(ch.min)) throw new Error(`${at}: min: one of ${SEV.join(", ")}`);
    if (typeof ch.on !== "boolean") throw new Error(`${at}: on: true or false`);
    if (ch.digest !== undefined && typeof ch.digest !== "boolean") throw new Error(`${at}: digest: true or false`);
    const cfg = isObj(ch.config) ? ch.config : {};
    const was = (old.channels || []).find((x) => x.id === ch.id && x.type === ch.type);
    const config = {};
    for (const [k, f] of Object.entries(ad.fields)) {
      let v = cfg[k];
      if (v === SECRET && f.secret) {
        if (!was || was.config[k] === undefined) throw new Error(`${at}: ${k}: type it again`);
        v = was.config[k];
      }
      if (v === undefined || v === "") {
        if (!f.optional) throw new Error(`${at}: ${k}: needed`);
        continue;
      }
      if (typeof v !== "string" || v.length > 2048 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${at}: ${k}: text up to 2048 characters`);
      if (v.startsWith("$") && !ENVREF.test(v)) throw new Error(`${at}: ${k}: only $SERVITALS_NOTIFY_ names are read from the environment`);
      if (!ENVREF.test(v)) {
        const bad = fieldError(f, v);
        if (bad) throw new Error(`${at}: ${k}: ${bad}`);
      }
      config[k] = v;
    }
    return { id: ch.id, type: ch.type, name: ch.name.trim(), min: ch.min, on: ch.on, ...(ch.digest === false ? { digest: false } : {}), config };
  });
  let quiet = null;
  if (input.quiet !== undefined && input.quiet !== null) {
    const q = input.quiet;
    if (!isObj(q) || !TIME.test(q.from) || !TIME.test(q.to) || q.from === q.to) throw new Error("quiet hours: from and to as HH:MM, not the same");
    quiet = { from: q.from, to: q.to };
  }
  const digestAt = input.digestAt === undefined ? "07:00" : input.digestAt;
  if (!TIME.test(digestAt)) throw new Error("digest: a time as HH:MM");
  return { channels, quiet, digestAt };
}

/* ------------------------------------------------------------------ messages */
const UNIT = { "disk.used": "%", mem: "%", cpu: "%", temp: " °C" };
function what(e) {
  const k = String(e.rule).replace(/_([a-z])/g, (m, c) => c.toUpperCase());
  const label = e.name || (tr("alert.rule." + k) !== "alert.rule." + k ? tr("alert.rule." + k) : e.rule);
  return label + (e.sub ? " " + e.sub : "");
}
const valueOf = (e) => (typeof e.value === "number" && Number.isFinite(e.value) && !/^(reboot_required|container\.down|offline)$/.test(e.metric || e.rule)
  ? Math.round(e.value * 10) / 10 + (UNIT[e.metric] || "") : "");
const clock = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
// one line for an event: "fired: disk full /srv on nas · 92%"
function line(e) {
  const kind = e.ended ? "ended" : e.kind === "resolved" || e.kind === "repeat" ? e.kind : "firing";
  const v = valueOf(e);
  return tr("notify.line", { kind: tr("alert.kind." + kind), what: what(e), node: e.nodeName || e.node }) + (v ? " · " + v : "");
}
function alertMessage(e) {
  const kind = e.ended ? "ended" : e.kind === "resolved" || e.kind === "repeat" ? e.kind : "firing";
  const title = tr("notify.title", { head: kind === "firing" ? tr("alert.sev." + (SEV.includes(e.severity) ? e.severity : "info")) : tr("alert.kind." + kind),
                                     what: what(e), node: e.nodeName || e.node });
  const v = valueOf(e);
  const text = (v ? tr("notify.value", { value: v }) + "\n" : "") + tr("notify.since", { time: clock(e.since || e.at) });
  return { kind: "alert", severity: e.severity, resolved: e.kind === "resolved", title, text, event: e };
}

/* ------------------------------------------------------------------ the notifier */
function createNotifier({ dir, outbound, now = Date.now, log = { info() {}, warn() {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)).then(() => {}), env = process.env } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "channels.json"), stFile = path.join(dir, "notify-state.json");
  let cfg = { channels: [], quiet: null, digestAt: "07:00" };
  try { cfg = checkChannels(JSON.parse(fs.readFileSync(cfgFile, "utf8"))); }
  catch (e) { if (e.code !== "ENOENT") log.warn("alerts.channels_ignored", { error: e.message }); }
  // the files hold tokens: only the hub reads them, also when an older build or a hand made them
  for (const f of [cfgFile, stFile]) { try { fs.chmodSync(f, 0o600); } catch (_) { /* not there yet */ } }
  let st = { held: [], digest: [], digestDay: null };
  try {
    const f = JSON.parse(fs.readFileSync(stFile, "utf8"));
    if (Array.isArray(f.held)) st.held = f.held;
    if (Array.isArray(f.digest)) st.digest = f.digest;
    if (typeof f.digestDay === "string") st.digestDay = f.digestDay;
  } catch (_) { /* first start */ }
  let saved = JSON.stringify(st);
  const save = () => {
    const s = JSON.stringify(st);
    if (s === saved) return;
    try { writeFileAtomic(stFile, s, 0o600); saved = s; } catch (e) { log.warn("alerts.notify_state_failed", { error: e.code || String(e) }); }
  };
  const status = {};   // id → { lastOk, lastError, at }
  const pending = new Set();

  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  function inQuiet(t) {
    if (!cfg.quiet) return false;
    const d = new Date(t), m = d.getHours() * 60 + d.getMinutes(), a = mins(cfg.quiet.from), b = mins(cfg.quiet.to);
    return a < b ? m >= a && m < b : m >= a || m < b;
  }
  const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

  // a channel's config with $SERVITALS_NOTIFY_… read from the environment and checked
  const coded = (code) => { const e = new Error(code); e.code = code; return e; };
  function resolved(ch) {
    const out = {};
    for (const [k, f] of Object.entries(ADAPTERS[ch.type].fields)) {
      let v = ch.config[k];
      if (v !== undefined && ENVREF.test(v)) {
        const name = v.slice(1);
        v = env[name];
        if (v === undefined || v === "") { if (f.optional) continue; throw coded("ENV_UNSET:" + name); }
        if (fieldError(f, v) || /[\u0000-\u001f\u007f]/.test(v)) throw coded("EBADVALUE:" + k);
      }
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  async function sendOnce(ch, m) {
    const req = ADAPTERS[ch.type].build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
  }
  const errText = (e) => (e && e.code ? String(e.code) : "failed");
  // a failure a second try cannot fix: a 4xx (other than 408 and 429), a bad value
  const final = (e) => /^HTTP_4\d\d$/.test(e.code) && !/^HTTP_(408|429)$/.test(e.code) || /^(ENV_UNSET|EBADVALUE|EURL)/.test(String(e.code));
  async function send(ch, m) {
    for (let i = 0; ; i++) {
      try {
        await sendOnce(ch, m);
        status[ch.id] = { ...status[ch.id], lastOk: now() };
        return true;
      } catch (e) {
        status[ch.id] = { ...status[ch.id], lastError: errText(e), at: now() };
        if (i >= RETRIES.length || final(e)) { log.warn("alert.notify_failed", { channel: ch.id, type: ch.type, error: errText(e) }); return false; }
        await sleep(RETRIES[i]);
      }
    }
  }
  // per channel, one message at a time in order: an end never overtakes its start
  const queues = {};   // id → { items, running }
  function deliver(m, to) {
    for (const ch of cfg.channels.filter((c) => c.on && to(c))) {
      const q = queues[ch.id] = queues[ch.id] || { items: [], running: null };
      q.items.push(m);
      if (q.items.length > MAX_QUEUE) { q.items.shift(); log.warn("alert.notify_dropped", { channel: ch.id }); }
      if (!q.running) {
        const run = (async () => {
          await null;   // start after run is set
          while (q.items.length) {
            const next = q.items.shift();
            const cur = cfg.channels.find((c) => c.id === ch.id && c.on);   // changed or turned off meanwhile
            if (cur) await send(cur, next);
          }
          q.running = null;
          pending.delete(run);
        })();
        q.running = run;
        pending.add(run);
      }
    }
  }
  // quiet hours over: per alert, its last event; one summary of what still fires and of
  // ends told before the window (fired and ended inside: the alert log only)
  function releaseHeld() {
    const last = new Map(), firedInside = new Set();
    for (const e of st.held) {
      const k = `${e.rule}|${e.node}|${e.sub || ""}`;
      last.set(k, e);
      if (e.kind === "firing") firedInside.add(k);
    }
    const lines = [...last.entries()].filter(([k, e]) => e.kind !== "resolved" || !firedInside.has(k)).map(([, e]) => line(e));
    st.held = [];
    if (lines.length) {
      deliver({ kind: "summary", severity: "warning", title: tr("notify.summaryTitle", { n: lines.length }), text: lines.join("\n") },
        (c) => rank("warning") <= rank(c.min));
    }
  }
  const slim = (e) => ({ kind: e.kind, rule: e.rule, ...(e.name ? { name: e.name } : {}), ...(e.metric ? { metric: e.metric } : {}), severity: e.severity,
    node: e.node, nodeName: e.nodeName, ...(e.sub ? { sub: e.sub } : {}), value: e.value, at: e.at, since: e.since, ...(e.ended ? { ended: e.ended } : {}) });

  return {
    // an alert event from the engine
    onEvent(e) {
      const t = now();
      if (st.held.length && !inQuiet(t)) releaseHeld();   // the summary first, even before the minute's tick
      if (rank(e.severity) >= 2) {
        st.digest.push(slim(e));
        if (st.digest.length > MAX_DIGEST) st.digest.splice(0, st.digest.length - MAX_DIGEST);
        save();
        return;
      }
      if (e.severity !== "critical" && inQuiet(t)) {
        st.held.push(slim(e));
        if (st.held.length > MAX_HELD) st.held.splice(0, st.held.length - MAX_HELD);
        save();
        return;
      }
      deliver(alertMessage(e), (c) => rank(e.severity) <= rank(c.min));
    },
    // once a minute: the summary when quiet hours end, the digest at its time
    tick() {
      const t = now();
      if (st.held.length && !inQuiet(t)) releaseHeld();
      const d = new Date(t);
      if (d.getHours() * 60 + d.getMinutes() >= mins(cfg.digestAt) && st.digestDay !== day(t)) {
        st.digestDay = day(t);
        if (st.digest.length) {
          deliver({ kind: "digest", severity: "info", title: tr("notify.digestTitle", { n: st.digest.length }), text: st.digest.map(line).join("\n") },
            (c) => c.digest !== false);
        }
        st.digest = [];
      }
      save();
    },
    // the page's "send test": one try, the answer at once
    async test(id) {
      const ch = cfg.channels.find((c) => c.id === id);
      if (!ch) return { ok: false, error: "no such channel" };
      try {
        await sendOnce(ch, { kind: "test", severity: "info", title: tr("notify.testTitle"), text: tr("notify.testText") });
        status[id] = { ...status[id], lastOk: now() };
        return { ok: true };
      } catch (e) {
        status[id] = { ...status[id], lastError: errText(e), at: now() };
        return { ok: false, error: errText(e) };
      }
    },
    setConfig(input) {
      const clean = checkChannels(input, cfg);
      writeFileAtomic(cfgFile, JSON.stringify(clean, null, 2) + "\n", 0o600);
      cfg = clean;
      for (const id of Object.keys(status)) if (!cfg.channels.some((c) => c.id === id)) delete status[id];
    },
    // for the page: secrets shown as ******** (sent back unchanged, they keep their value)
    view() {
      const mask = (ch) => ({ ...ch, config: Object.fromEntries(Object.entries(ch.config).map(([k, v]) =>
        [k, ADAPTERS[ch.type].fields[k].secret && !ENVREF.test(v) ? SECRET : v])) });
      return { channels: cfg.channels.map(mask), quiet: cfg.quiet, digestAt: cfg.digestAt, status: { ...status },
               types: Object.fromEntries(Object.entries(ADAPTERS).map(([t, a]) => [t, Object.entries(a.fields).map(([k, f]) => ({ key: k, secret: !!f.secret, optional: !!f.optional }))])) };
    },
    // for tests: wait for the sends under way
    async flush() { while (pending.size) await Promise.all([...pending]); },
  };
}

module.exports = { createNotifier, checkChannels, ADAPTERS, SECRET, alertMessage };
