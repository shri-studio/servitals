# servitals More Channels and the Channels Tab (sub-project 6c-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven more alert channels (Gotify, Telegram, Discord, Slack, Microsoft Teams, Pushover, Matrix), and a "channels" tab in the alerts view where a person adds, edits and removes channels, sets quiet hours and the digest's time, sends a test, and sees each channel's last send or error.

**Why:** 6c-1 sends alerts to ntfy and webhooks, but only through the API. Most people already live in one of these apps, and none of them should need curl to set it up.

**Architecture:**
- **`hub/lib/notify.js`:** seven adapters next to ntfy and webhook, each `{fields, build(config, message)}`:
  - **gotify:** `server`, `token` (header `X-Gotify-Key`); JSON with priority 8/5/2.
  - **telegram:** bot `token` (its form is checked, since it is part of the URL path), `chat` (a number or `@name`), optional `server`; `sendMessage`.
  - **discord:** webhook `url` (a secret); an embed coloured by severity, `allowed_mentions: {parse: []}` so a name with `@everyone` pings nobody.
  - **slack:** webhook `url`; `&`, `<` and `>` escaped, so a name cannot make a link or a mention.
  - **teams:** a Workflows webhook `url`; an Adaptive Card 1.4 with the title in bold.
  - **pushover:** app `token` and `user` key (30 letters or digits each), optional `server`; priority 1/0/-1.
  - **matrix:** `server`, `room` (`!id:server`), `token`; `PUT …/send/m.room.message/<txn>` where the transaction id is fixed per message, so a retry is not a second message.
  - Texts are cut to what each service takes (3500 characters; Pushover 1000). A build may set `method` (Matrix: PUT).
- **`www/js/alerts.js`:** a third tab.
  - `chRows(view)` and `chFile(rows, quiet, digestAt)` turn the hub's view into rows and back (empty fields left out, masked secrets sent back as they came).
  - `chHtml()` draws the quiet hours, the digest's time and each channel: on, name, type, level, digest, its fields (secrets as password inputs), its last send or error, "send test" and "remove", plus "+ channel" of a chosen type.
  - `readChannels()` reads the form; `saveChannels()` posts it and shows what the hub refused, keeping what was typed; `testChannel(i)` sends a test of what is saved (unsaved changes: "save first").
  - `showTab(which)` replaces `showRulesTab(on)` for the three tabs.
- `www/index.html` (the tab), `www/app.css`, `hub/lib/i18n.js` (every word; brand names stay as they are), `test/screens/shoot.js` (`channels-1280.png`, `channels-390.png`).

**Tech Stack:** Node.js ≥ 18 built-ins; plain browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-24-servitals-platform-design.md`:
- 8.4: Gotify, Telegram, Discord, Slack, Teams (Workflows webhook), Pushover, Matrix; a "send test" button and the last error per channel;
- 10.4: alerts customised from the page; 10.5: loaded when opened.

**Scope:** 6c-2. Later: email over SMTP and Apprise (6c-3); Web Push (6d).

**Proven before writing:** every code block was built and run in a scratch copy of `main` (f1412b4) on 2026-10-09: node suite 434 tests; budget, screens, compose smoke, both packages and autopkgtest pass.

## Global Constraints

- Zero runtime dependencies, Node 18 compatibility, SPDX headers; everything from sub-projects 1-6c-1 still holds.
- No outbound call outside `hub/lib/proxy.js`; never log a token or a channel URL.
- The strict CSP; every word through `tr()`.
- Work in a worktree `.claude/worktrees/servitals-channels-ui` on branch `feat/channels-ui` from `main` (f1412b4).
- Never run `git stash`; use a WIP commit. Commits: Conventional Commits, no `Co-Authored-By` or `Claude-Session` trailers.

## Review Focus

1. **Injection through names:** a rule, server or disk name with Markdown, `@everyone`, `<!channel>`, `<http://x|y>`, or a token that would change a URL path. Tests: "Gotify, Telegram, …", "their settings are checked…".
2. **Each service's limits:** a long digest, Teams' card, Matrix retries. Tests: the same, and "Matrix: a retry…".
3. **Secrets in the form:** masked values sent back, a type changed after a secret was saved, a password field's autofill. Tests: "channels: rows and back…".
4. **The form across time:** unsaved edits and a test, a failed save, quiet hours toggled. Test: "channels: the form read back…".
5. **Phone width:** `bash test/screens.sh` shoots `channels-1280.png` and `channels-390.png`.

---

### Task 1: Seven more channels

**Files:**
- Modify: `hub/lib/notify.js`, `test/notify.test.js`

**Interfaces:**
- Consumes: `ADAPTERS`, `checkChannels`, the per-channel queue (6c-1).
- Produces: `ADAPTERS.gotify`, `.telegram`, `.discord`, `.slack`, `.teams`, `.pushover`, `.matrix`; a build may return `method`; each queued message carries `txn`. `view().types` lists their fields for Task 2's form.

- [ ] **Step 1: Write the failing tests**

In `test/notify.test.js`:

1. Replace

```js
  assert.strictEqual(fs.statSync(path.join(s.dir, "channels.json")).mode & 0o777, 0o600, "tightened at start");
});

```

   with

```js
  assert.strictEqual(fs.statSync(path.join(s.dir, "channels.json")).mode & 0o777, 0o600, "tightened at start");
});

// every adapter: what one message becomes
const { ADAPTERS } = require("../hub/lib/notify");
const MSG = { kind: "alert", severity: "critical", title: "critical: <b>disk</b> & @everyone on nas", text: "value 96%\nsince 03:10", txn: "svtx1" };
const TG = "123456:" + "A".repeat(35), PO = "a".repeat(30), PU = "u".repeat(30);

test("Gotify, Telegram, Discord, Slack, Teams, Pushover and Matrix: each gets the message in its own form, names cannot ping or link", () => {
  const b = (type, c) => { const r = ADAPTERS[type].build(c, MSG); return { ...r, json: JSON.parse(r.body) }; };
  const g = b("gotify", { server: "https://g.test/", token: "gtk" });
  assert.deepStrictEqual([g.url, g.headers["x-gotify-key"], g.json.priority, g.json.message], ["https://g.test/message", "gtk", 8, "value 96%\nsince 03:10"]);
  const t = b("telegram", { token: TG, chat: "-100123" });
  assert.deepStrictEqual([t.url, t.json.chat_id, t.json.text], [`https://api.telegram.org/bot${TG}/sendMessage`, "-100123", MSG.title + "\n" + MSG.text]);
  const d = b("discord", { url: "https://discord.test/api/webhooks/1/x" });
  assert.deepStrictEqual(d.json.allowed_mentions, { parse: [] }, "@everyone in a name pings nobody");
  assert.deepStrictEqual([d.json.embeds[0].title, d.json.embeds[0].color], [MSG.title, 0xd03030]);
  const s = b("slack", { url: "https://hooks.slack.test/x" });
  assert.strictEqual(s.json.text, "*critical: &lt;b&gt;disk&lt;/b&gt; &amp; @everyone on nas*\nvalue 96%\nsince 03:10");
  const m = b("teams", { url: "https://teams.test/x" });
  assert.strictEqual(m.json.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  assert.deepStrictEqual(m.json.attachments[0].content.body.map((x) => [x.text, x.weight]), [[MSG.title, "Bolder"], [MSG.text, undefined]]);
  const p = b("pushover", { token: PO, user: PU });
  assert.deepStrictEqual([p.url, p.json.token, p.json.user, p.json.priority], ["https://api.pushover.net/1/messages.json", PO, PU, 1]);
  const x = b("matrix", { server: "https://m.test", room: "!abc:m.test", token: "mtk" });
  assert.deepStrictEqual([x.method, x.url, x.headers.authorization, x.json.msgtype],
    ["PUT", "https://m.test/_matrix/client/v3/rooms/!abc%3Am.test/send/m.room.message/svtx1", "Bearer mtk", "m.text"]);
  const long = ADAPTERS.discord.build({ url: "https://d.test/x" }, { ...MSG, text: "x".repeat(5000) });
  assert.strictEqual(JSON.parse(long.body).embeds[0].description.length, 3500, "a long digest is cut to what the service takes");
});

test("their settings are checked: a token that would change the URL path, a chat, a room, Pushover's keys", () => {
  const one = (type, config, re) => assert.throws(() => checkChannels({ channels: [{ id: "ch_a", type, name: "x", min: "warning", on: true, config }] }), re);
  one("telegram", { token: "1:../../evil", chat: "1" }, /token: not valid/);
  one("telegram", { token: TG, chat: "me" }, /chat: not valid/);
  one("matrix", { server: "https://m.test", room: "#alias:m.test", token: "t" }, /room: not valid/);
  one("pushover", { token: "short", user: PU }, /token: not valid/);
  one("gotify", { server: "https://g.test", token: "té" }, /token: printable ASCII/);
  one("gotify", { token: "t" }, /server: needed/);
  const ok = checkChannels({ channels: [{ id: "ch_a", type: "telegram", name: "tg", min: "critical", on: true, config: { token: TG, chat: "@ops_room" } }] });
  assert.deepStrictEqual(ok.channels[0].config, { token: TG, chat: "@ops_room" });
});

test("Matrix: a retry sends the same transaction id, so the room gets one message", async () => {
  const s = setup({ channels: [{ id: "ch_m", type: "matrix", name: "room", min: "warning", on: true, config: { server: "https://m.test", room: "!r:m.test", token: "t" } }] },
    { fail: (url, n) => (n === 1 ? 502 : 0) });
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.strictEqual(s.sent.length, 2);
  assert.strictEqual(s.sent[0].url, s.sent[1].url);
  assert.deepStrictEqual(s.sent.map((r) => r.method), ["PUT", "PUT"]);
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/notify.test.js`
Expected: FAIL, 3 tests: "Gotify, Telegram, …" (`TypeError`: no such adapter), "their settings are checked…" and "Matrix: a retry…" (`type: one of ntfy, webhook`).

- [ ] **Step 3: The adapters**

In `hub/lib/notify.js`:

1. Replace

```js
const httpUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch (_) { return false; } };

/* ------------------------------------------------------------------ channels
   fields: { name: { secret?, optional?, url?, re? } }; build(config, message) → the request */
```

   with

```js
const httpUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch (_) { return false; } };

const base = (u) => String(u).replace(/\/+$/, "");
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const pri = (m, crit, warn, info) => (m.severity === "critical" ? crit : m.severity === "warning" ? warn : info);
const COLOR = { critical: 0xd03030, warning: 0xe0a020, info: 0x3070d0 };

/* ------------------------------------------------------------------ channels
   fields: { name: { secret?, optional?, url?, re? } }; build(config, message) → the request */
```

2. Replace

```js
      const sig = c.secret ? { "x-servitals-signature": "sha256=" + crypto.createHmac("sha256", c.secret).update(body).digest("hex") } : {};
      return { url: c.url, headers: { "content-type": "application/json", ...sig }, body };
    },
  },
```

   with

```js
      const sig = c.secret ? { "x-servitals-signature": "sha256=" + crypto.createHmac("sha256", c.secret).update(body).digest("hex") } : {};
      return { url: c.url, headers: { "content-type": "application/json", ...sig }, body };
    },
  },
  gotify: {
    fields: { server: { url: true }, token: { secret: true, header: true } },
    build(c, m) {
      return { url: base(c.server) + "/message", headers: { "content-type": "application/json", "x-gotify-key": c.token },
        body: JSON.stringify({ title: cut(m.title, 250), message: cut(m.text, 3500), priority: pri(m, 8, 5, 2) }) };
    },
  },
  // the bot token is part of the URL path: its form is checked, so it cannot change the path
  telegram: {
    fields: { token: { secret: true, re: /^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$/ }, chat: { re: /^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$/ }, server: { optional: true, url: true } },
    build(c, m) {
      return { url: base(c.server || "https://api.telegram.org") + "/bot" + c.token + "/sendMessage", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: c.chat, text: cut(m.title + "\n" + m.text, 3500), disable_web_page_preview: true }) };
    },
  },
  // an embed, and no mentions: a rule or server name with @everyone pings nobody
  discord: {
    fields: { url: { url: true, secret: true } },
    build(c, m) {
      return { url: c.url, headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_mentions: { parse: [] }, embeds: [{ title: cut(m.title, 250), description: cut(m.text, 3500), color: COLOR[m.severity] || COLOR.info }] }) };
    },
  },
  // Slack's markup: &, < and > escaped, so a name cannot make a link or a mention
  slack: {
    fields: { url: { url: true, secret: true } },
    build(c, m) {
      const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return { url: c.url, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: cut("*" + esc(m.title) + "*\n" + esc(m.text), 3500) }) };
    },
  },
  // a Teams Workflows webhook takes an Adaptive Card
  teams: {
    fields: { url: { url: true, secret: true } },
    build(c, m) {
      const block = (text, bold) => ({ type: "TextBlock", text: cut(text, 3500), wrap: true, ...(bold ? { weight: "Bolder" } : {}) });
      return { url: c.url, headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "message", attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body: [block(m.title, true), block(m.text)] } }] }) };
    },
  },
  pushover: {
    fields: { token: { secret: true, re: /^[A-Za-z0-9]{30}$/ }, user: { secret: true, re: /^[A-Za-z0-9]{30}$/ }, server: { optional: true, url: true } },
    build(c, m) {
      return { url: base(c.server || "https://api.pushover.net") + "/1/messages.json", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: c.token, user: c.user, title: cut(m.title, 250), message: cut(m.text, 1000), priority: pri(m, 1, 0, -1) }) };
    },
  },
  // a room message: PUT with a transaction id, so a retry is not a second message
  matrix: {
    fields: { server: { url: true }, room: { re: /^![A-Za-z0-9._=-]{1,255}:[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/ }, token: { secret: true, header: true } },
    build(c, m) {
      return { method: "PUT", url: `${base(c.server)}/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/send/m.room.message/${m.txn}`,
        headers: { "content-type": "application/json", authorization: "Bearer " + c.token },
        body: JSON.stringify({ msgtype: "m.text", body: cut(m.title + "\n" + m.text, 3500) }) };
    },
  },
```

3. Replace

```js
  async function sendOnce(ch, m) {
    const req = ADAPTERS[ch.type].build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
  }
```

   with

```js
  async function sendOnce(ch, m) {
    const req = ADAPTERS[ch.type].build(resolved(ch), m);
    const r = await outbound.request(req.url, { method: req.method || "POST", headers: req.headers, body: req.body, timeoutMs: 15000 });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.code = "HTTP_" + r.status; throw e; }
  }
```

4. Replace

```js
    for (const ch of cfg.channels.filter((c) => c.on && to(c))) {
      const q = queues[ch.id] = queues[ch.id] || { items: [], running: null };
      q.items.push(m);
      if (q.items.length > MAX_QUEUE) { q.items.shift(); log.warn("alert.notify_dropped", { channel: ch.id }); }
      if (!q.running) {
```

   with

```js
    for (const ch of cfg.channels.filter((c) => c.on && to(c))) {
      const q = queues[ch.id] = queues[ch.id] || { items: [], running: null };
      q.items.push({ txn: "sv" + now().toString(36) + crypto.randomBytes(4).toString("hex"), ...m });
      if (q.items.length > MAX_QUEUE) { q.items.shift(); log.warn("alert.notify_dropped", { channel: ch.id }); }
      if (!q.running) {
```

5. Replace

```js
      if (!ch) return { ok: false, error: "no such channel" };
      try {
        await sendOnce(ch, { kind: "test", severity: "info", title: tr("notify.testTitle"), text: tr("notify.testText") });
        status[id] = { ...status[id], lastOk: now() };
        return { ok: true };
```

   with

```js
      if (!ch) return { ok: false, error: "no such channel" };
      try {
        await sendOnce(ch, { kind: "test", severity: "info", title: tr("notify.testTitle"), text: tr("notify.testText"), txn: "svt" + crypto.randomBytes(6).toString("hex") });
        status[id] = { ...status[id], lastOk: now() };
        return { ok: true };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/*.test.js`
Expected: PASS, 431 tests (3 new).

- [ ] **Step 5: Commit**

```bash
git add hub/lib/notify.js test/notify.test.js
git commit -m "feat(hub): Gotify, Telegram, Discord, Slack, Teams, Pushover and Matrix channels"
```

---

### Task 2: The channels tab

**Files:**
- Modify: `www/js/alerts.js`, `www/index.html`, `www/app.css`, `hub/lib/i18n.js`, `test/page.test.js`, `test/screens/shoot.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `GET`/`POST /__ctl/alerts/channels`, `POST /__ctl/alerts/channels/test` (6c-1), `view().types` (Task 1).
- Produces (alerts.js globals): `chState`, `chRows`, `chFile`, `chStatus`, `chHtml`, `drawChannels`, `readChannels`, `loadChannels`, `saveChannels`, `testChannel`, `chAction`, `showTab`.

- [ ] **Step 1: Write the failing tests**

In `test/page.test.js`:

1. Replace

```js
    loadNodes: async () => {}, renderFleetIfShown() {}, ...extra };
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "js", "alerts.js"), "utf8");
  const api = new Function(...Object.keys(env), "tr", `${src}; return { rulesRows, rulesFile, rulesHtml, readRules, saveRules, rulesAction, rulesState, shown, typed, initAlerts,
    alertsHtmlWith: (info, d) => { alertRuleInfo = info; return alertsHtml(d, {}); } };`)(...Object.values(env), tr);
  api.rulesState.defaults = JSON.parse(JSON.stringify(defaultsForPage()));
  api.rulesState.metrics = require("../hub/lib/alertrules").METRICS;
```

   with

```js
    loadNodes: async () => {}, renderFleetIfShown() {}, ...extra };
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "js", "alerts.js"), "utf8");
  const api = new Function(...Object.keys(env), "tr", `${src}; return { rulesRows, rulesFile, rulesHtml, readRules, saveRules, rulesAction, rulesState, shown, typed, initAlerts,
    chState, chRows, chFile, chHtml, readChannels, testChannel, saveChannels, chAction,
    alertsHtmlWith: (info, d) => { alertRuleInfo = info; return alertsHtml(d, {}); } };`)(...Object.values(env), tr);
  api.rulesState.defaults = JSON.parse(JSON.stringify(defaultsForPage()));
  api.rulesState.metrics = require("../hub/lib/alertrules").METRICS;
```

2. Replace

```js

test("the alerts view has a rules tab", () => {
  for (const id of ["alerts-tab-list", "alerts-tab-rules", "alerts-list", "rules-body"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(JS, /\$\("#alerts-tab-rules"\)\.onclick = \(\) => showRulesTab\(true\);/);
});

test("alerts view: a rule of one's own shows by its name and its metric's unit; an alert ended by a rule change says so", () => {
```

   with

```js

test("the alerts view has a rules tab", () => {
  for (const id of ["alerts-tab-list", "alerts-tab-rules", "alerts-list", "rules-body"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(JS, /\$\("#alerts-tab-rules"\)\.onclick = \(\) => showTab\("rules"\);/);
});

test("alerts view: a rule of one's own shows by its name and its metric's unit; an alert ended by a rule change says so", () => {
```

3. Replace

```js
  assert.doesNotMatch(s.rulesHtml(s.rulesState.rows).split('<div class="rule')[rb + 1], /data-of="threshold"/);
});

```

   with

```js
  assert.doesNotMatch(s.rulesHtml(s.rulesState.rows).split('<div class="rule')[rb + 1], /data-of="threshold"/);
});

// the channels tab (spec 8.3, 8.4)
const CH_VIEW = {
  channels: [{ id: "ch_n", type: "ntfy", name: "phone <1>", min: "warning", on: true, config: { topic: "sv", token: "********" } },
             { id: "ch_w", type: "webhook", name: "pager", min: "critical", on: false, digest: false, config: { url: "********" } }],
  quiet: { from: "23:00", to: "07:00" }, digestAt: "07:00",
  status: { ch_n: { lastOk: 5, lastError: "HTTP_500", at: 9 }, ch_w: { lastOk: 9 } },
  types: { ntfy: [{ key: "server", secret: false, optional: true }, { key: "topic", secret: false, optional: false }, { key: "token", secret: true, optional: true }],
           webhook: [{ key: "url", secret: true, optional: false }, { key: "secret", secret: true, optional: true }] },
};

test("channels: rows and back; secrets stay masked, empty fields go; the form escapes names and hides secrets", () => {
  const s = rulesScope({ alertWhen: () => "12:00" });
  const rows = s.chRows(CH_VIEW);
  assert.deepStrictEqual(rows[1], { id: "ch_w", type: "webhook", name: "pager", min: "critical", on: false, digest: false, config: { url: "********" } });
  rows[0].config.server = "";
  assert.deepStrictEqual(s.chFile(rows, CH_VIEW.quiet, "07:30"), { channels: [
    { id: "ch_n", type: "ntfy", name: "phone <1>", min: "warning", on: true, config: { topic: "sv", token: "********" } },
    { id: "ch_w", type: "webhook", name: "pager", min: "critical", on: false, digest: false, config: { url: "********" } }],
    quiet: { from: "23:00", to: "07:00" }, digestAt: "07:30" });
  Object.assign(s.chState, { types: CH_VIEW.types, status: CH_VIEW.status, rows, quiet: null, digestAt: "07:00" });
  const html = s.chHtml();
  assert.doesNotMatch(html, /phone <1>|style=/);
  assert.match(html, /value="phone &#60;1&#62;"/);
  assert.match(html, /token \(optional\) <input type="password" class="cval" data-k="token" autocomplete="off" value="\*\*\*\*\*\*\*\*">/);
  assert.match(html, /webhook URL <input type="password"[^>]*data-k="url"/, "a webhook URL is a secret");
  assert.match(html, /last error HTTP_500 at \S/, "an error newer than the last success shows");
  assert.match(html, /last sent \S/);
  assert.match(html, /data-q="from" value="23:00" disabled/, "no quiet hours: their times wait");
  assert.match(html, /<option value="webhook">webhook<\/option>/, "a channel of each type can be added");
});

// a fake channels form
function fakeChan(i, fields, config) {
  const f = (attr, k, v) => ({ dataset: { [attr]: k }, type: typeof v === "boolean" ? "checkbox" : "text", value: typeof v === "boolean" ? "" : v, checked: v === true });
  return { dataset: { i: String(i) }, querySelectorAll: (sel) => (sel === "[data-f]" ? Object.entries(fields).map(([k, v]) => f("f", k, v))
    : Object.entries(config).map(([k, v]) => f("k", k, v))) };
}

test("channels: the form read back, quiet hours on and off; a test waits for a save, then sends the channel's id", async () => {
  let form = [], quiet = {};
  const sent = [], toasts = [];
  const qel = (k) => (quiet[k] === undefined ? [] : [{ type: typeof quiet[k] === "boolean" ? "checkbox" : "time", checked: quiet[k] === true, value: quiet[k] }]);
  const s = rulesScope({ $$: (sel) => (sel === "#channels-body .chan" ? form : /data-q=(\w+)/.test(sel) ? qel(/data-q=(\w+)/.exec(sel)[1]) : []),
    $: () => ({ innerHTML: "" }), alertWhen: () => "",
    toast: (m, err) => toasts.push([m, !!err]),
    fetch: async (url, opt) => { if (opt) { sent.push([url, JSON.parse(opt.body)]); return { ok: url.endsWith("/test"), json: async () => (url.endsWith("/test") ? { ok: false, error: "HTTP_404" } : { error: "phone: topic: not valid" }) }; }
      return answer(CH_VIEW); } });
  Object.assign(s.chState, { types: CH_VIEW.types, rows: s.chRows(CH_VIEW) });
  form = [fakeChan(0, { on: false, name: "phone", min: "critical", digest: false }, { server: "https://n.test", topic: "a b", token: "********" })];
  quiet = { on: true, from: "22:00", to: "06:30", digestAt: "08:00" };
  s.readChannels();
  assert.deepStrictEqual(s.chState.rows[0], { id: "ch_n", type: "ntfy", name: "phone", min: "critical", on: false, digest: false,
    config: { server: "https://n.test", topic: "a b", token: "********" } });
  assert.deepStrictEqual([s.chState.quiet, s.chState.digestAt], [{ from: "22:00", to: "06:30" }, "08:00"]);
  quiet = { on: false, from: "22:00", to: "06:30", digestAt: "08:00" };
  s.readChannels();
  assert.strictEqual(s.chState.quiet, null);
  s.chState.dirty = true;
  await s.testChannel(0);
  assert.deepStrictEqual([sent, toasts], [[], [["save first, then send a test", true]]]);
  await s.saveChannels();
  assert.deepStrictEqual(toasts[1], ["not saved: phone: topic: not valid", true]);
  assert.strictEqual(sent[0][0], "/__ctl/alerts/channels");
  assert.strictEqual(s.chState.dirty, true, "what was typed stays");
  s.chState.dirty = false;
  await s.testChannel(0);
  assert.deepStrictEqual(sent[1], ["/__ctl/alerts/channels/test", { id: "ch_n" }]);
  assert.deepStrictEqual(toasts[2], ["test failed: HTTP_404", true]);
  form = [];
  s.chAction("remove", 0);
  assert.deepStrictEqual(s.chState.rows.map((r) => r.id), ["ch_w"]);
  assert.strictEqual(s.chState.dirty, true);
});

test("the alerts view has a channels tab", () => {
  for (const id of ["alerts-tab-channels", "channels-body"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(JS, /\$\("#alerts-tab-channels"\)\.onclick = \(\) => showTab\("channels"\);/);
});

```

In `test/screens/shoot.js`:

1. Replace

```js
    await page.click("#rules-body button[data-act=add]");
    await page.screenshot({ path: `${out}/rules-${width}.png`, fullPage: true });
  }

```

   with

```js
    await page.click("#rules-body button[data-act=add]");
    await page.screenshot({ path: `${out}/rules-${width}.png`, fullPage: true });
  }
  // the channels, with quiet hours on and two new channels, on a desktop and a phone
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/?shot=channels-${width}#fleet`);
    await page.waitForTimeout(1200);
    await page.keyboard.press("a");
    await page.click("#alerts-tab-channels");
    await page.waitForSelector("#channels-body [data-act=add]");
    await page.click("#channels-body [data-q=on]");
    await page.click("#channels-body [data-act=add]");
    await page.selectOption("#channels-body [data-f=newtype]", "webhook");
    await page.click("#channels-body [data-act=add]");
    await page.screenshot({ path: `${out}/channels-${width}.png`, fullPage: true });
  }

```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/page.test.js`
Expected: FAIL, 10 tests: the three new ones, "the alerts view has a rules tab" (it now expects `showTab("rules")`), and the six other tests built on `rulesScope`, whose harness now also asks alerts.js for the channel functions (`ReferenceError: chState is not defined`).

- [ ] **Step 3: The tab**

In `www/js/alerts.js`:

1. Replace

```js
   /__ctl/alerts/mute. Its second tab edits the rules (spec 8.1): the defaults' thresholds,
   times and severities, rules of one's own, and per-server or per-tag overrides, from GET
   and POST /__ctl/alerts/rules. Loaded by openAlerts() in app.js on first use. */
const ALERT_SEV = ["critical", "warning", "info"];
let alertsSeq = 0;
```

   with

```js
   /__ctl/alerts/mute. Its second tab edits the rules (spec 8.1): the defaults' thresholds,
   times and severities, rules of one's own, and per-server or per-tag overrides, from GET
   and POST /__ctl/alerts/rules. Its third tab sets where alerts go (spec 8.3, 8.4): the
   channels, quiet hours and the digest's time, from GET and POST /__ctl/alerts/channels,
   with a test per channel. Loaded by openAlerts() in app.js on first use. */
const ALERT_SEV = ["critical", "warning", "info"];
let alertsSeq = 0;
```

2. Replace

```js
}

function showRulesTab(on) {
  $("#alerts-tab-list").classList.toggle("on", !on);
  $("#alerts-tab-rules").classList.toggle("on", on);
  $("#alerts-list").classList.toggle("hidden", on);
  $("#rules-body").classList.toggle("hidden", !on);
  if (on) loadRules();
}

// wiring, once, when this file has loaded
function initAlerts() {
  $("#alerts-tab-list").onclick = () => showRulesTab(false);
  $("#alerts-tab-rules").onclick = () => showRulesTab(true);
  $("#rules-body").onclick = e => {
    const b = e.target.closest("button[data-act]");
```

   with

```js
}

/* ------------------------------------------------------------------ the channels */
// rows: { id, type, name, min, on, digest, config: { key: value } }; secrets come as ********
const chState = { types: {}, status: {}, rows: [], quiet: null, digestAt: "07:00", dirty: false };

function chRows(v) {
  return (Array.isArray(v.channels) ? v.channels : []).map(c => ({ id: c.id, type: c.type, name: c.name, min: c.min, on: c.on !== false,
    digest: c.digest !== false, config: { ...(c.config || {}) } }));
}
// rows back to what the hub keeps: empty fields left out
function chFile(rows, quiet, digestAt) {
  return { channels: rows.map(r => ({ id: r.id, type: r.type, name: r.name, min: r.min, on: r.on, ...(r.digest ? {} : { digest: false }),
    config: Object.fromEntries(Object.entries(r.config).filter(([, v]) => v !== "" && v != null)) })), quiet, digestAt };
}
// a channel's last send, in words
function chStatus(s) {
  const t = x => alertWhen(x);
  if (s && s.lastError && (!s.lastOk || s.at > s.lastOk)) return tr("ch.lastError", { error: s.lastError, time: t(s.at) });
  return s && s.lastOk ? tr("ch.lastOk", { time: t(s.lastOk) }) : tr("ch.never");
}

function chHtml() {
  const sevs = ["critical", "warning", "info"].map(s => [s, tr("alert.sev." + s)]);
  const q = chState.quiet;
  let h = `<p class="hint">${esc(tr("ch.intro"))}</p><div class="rline cglobal">`
    + `<label><input type="checkbox" data-q="on"${q ? " checked" : ""}> ${esc(tr("ch.quiet"))}</label>`
    + `<label>${esc(tr("ch.quietFrom"))} <input type="time" data-q="from" value="${esc(q ? q.from : "23:00")}"${q ? "" : " disabled"}></label>`
    + `<label>${esc(tr("ch.quietTo"))} <input type="time" data-q="to" value="${esc(q ? q.to : "07:00")}"${q ? "" : " disabled"}></label>`
    + `<label>${esc(tr("ch.digestAt"))} <input type="time" data-q="digestAt" value="${esc(chState.digestAt)}"></label></div>`;
  h += chState.rows.map((r, i) => {
    const fields = chState.types[r.type] || [];
    return `<div class="chan rule${r.on ? "" : " roff"}" data-i="${i}"><div class="rline">`
      + `<input type="checkbox" data-f="on" aria-label="${esc(tr("rules.on"))}"${r.on ? " checked" : ""}>`
      + `<input type="text" class="rname" data-f="name" maxlength="60" value="${esc(r.name)}" aria-label="${esc(tr("ch.name"))}">`
      + `<span class="ctype">${esc(r.type)}</span>`
      + `<label>${esc(tr("ch.min"))} <select data-f="min">${opts(sevs, r.min)}</select></label>`
      + `<label><input type="checkbox" data-f="digest"${r.digest ? " checked" : ""}> ${esc(tr("ch.digest"))}</label>`
      + `<span class="grow"></span><button data-act="test">${esc(tr("ch.test"))}</button><button data-act="remove">${esc(tr("rules.remove"))}</button></div>`
      + `<div class="rov cfields">` + fields.map(f => `<label>${esc(tr("ch.field." + f.key))}${f.optional ? " " + esc(tr("ch.optional")) : ""} `
        + `<input type="${f.secret ? "password" : "text"}" class="cval" data-k="${esc(f.key)}" autocomplete="off" value="${esc(r.config[f.key] || "")}"></label>`).join("")
      + `</div><div class="rov cstat">${esc(chStatus(chState.status[r.id]))}</div></div>`;
  }).join("");
  h += `<div class="rbtns"><select data-f="newtype" aria-label="${esc(tr("ch.type"))}">${opts(Object.keys(chState.types).map(t => [t, t]), "ntfy")}</select>`
    + `<button data-act="add">${esc(tr("ch.add"))}</button><span class="grow"></span>`
    + `<button data-act="revert">${esc(tr("rules.revert"))}</button><button data-act="save" class="primary">${esc(tr("rules.save"))}</button></div>`;
  return h;
}
function drawChannels() { $("#channels-body").innerHTML = chHtml(); }

// what the form says now, into the rows and the quiet hours
function readChannels() {
  for (const el of $$("#channels-body .chan")) {
    const r = chState.rows[Number(el.dataset.i)];
    if (!r) continue;
    for (const f of el.querySelectorAll("[data-f]")) r[f.dataset.f] = f.type === "checkbox" ? f.checked : f.value;
    for (const f of el.querySelectorAll("[data-k]")) r.config[f.dataset.k] = f.value;
  }
  const qv = k => { const el = $$("#channels-body [data-q=" + k + "]")[0]; return el ? (el.type === "checkbox" ? el.checked : el.value) : null; };
  if (qv("on") !== null) {
    chState.quiet = qv("on") ? { from: qv("from"), to: qv("to") } : null;
    chState.digestAt = qv("digestAt") || "07:00";
  }
}

async function loadChannels(force) {
  if (chState.dirty && !force) { drawChannels(); return; }
  let d = null;
  try {
    const r = await fetch("/__ctl/alerts/channels?t=" + Date.now());
    d = r.ok ? await r.json() : null;
  } catch (e) { d = null; }
  if (!d || !Array.isArray(d.channels)) { $("#channels-body").innerHTML = `<div class="muted">${esc(tr("ch.loadFailed"))}</div>`; return; }
  Object.assign(chState, { types: d.types || {}, status: d.status || {}, rows: chRows(d), quiet: d.quiet || null, digestAt: d.digestAt || "07:00", dirty: false });
  drawChannels();
}

async function saveChannels() {
  readChannels();
  try {
    const r = await fetch("/__ctl/alerts/channels", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(chFile(chState.rows, chState.quiet, chState.digestAt)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || String(r.status));
    chState.dirty = false;
    toast(tr("ch.saved"));
    await loadChannels(true);
  } catch (e) { toast(tr("ch.saveFailed", { error: e.message }), true); }
}

// a test goes out with what is saved: changes first
async function testChannel(i) {
  readChannels();
  const r = chState.rows[i];
  if (!r) return;
  if (chState.dirty) { toast(tr("ch.saveFirst"), true); return; }
  let j = null;
  try {
    const res = await fetch("/__ctl/alerts/channels/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: r.id }) });
    j = res.ok ? await res.json() : null;
  } catch (e) { j = null; }
  if (j && j.ok) toast(tr("ch.testOk"));
  else toast(tr("ch.testFailed", { error: j && j.error ? j.error : "–" }), true);
  await loadChannels(true);
}

function chAction(act, i) {
  readChannels();
  if (act === "test") { testChannel(i); return; }
  if (act === "save") { saveChannels(); return; }
  if (act === "revert") { chState.dirty = false; loadChannels(true); return; }
  if (act === "add") {
    const el = $$("#channels-body [data-f=newtype]")[0];
    const type = el && chState.types[el.value] ? el.value : Object.keys(chState.types)[0];
    if (!type) return;
    chState.rows.push({ id: "ch_" + Date.now().toString(36), type, name: type, min: "warning", on: true, digest: true, config: {} });
  }
  if (act === "remove") chState.rows.splice(i, 1);
  chState.dirty = true;
  drawChannels();
}

function showTab(which) {
  for (const [t, body] of [["list", "#alerts-list"], ["rules", "#rules-body"], ["channels", "#channels-body"]]) {
    $("#alerts-tab-" + t).classList.toggle("on", which === t);
    $(body).classList.toggle("hidden", which !== t);
  }
  if (which === "rules") loadRules();
  if (which === "channels") loadChannels();
}

// wiring, once, when this file has loaded
function initAlerts() {
  $("#alerts-tab-list").onclick = () => showTab("list");
  $("#alerts-tab-rules").onclick = () => showTab("rules");
  $("#alerts-tab-channels").onclick = () => showTab("channels");
  $("#channels-body").onclick = e => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const row = b.closest(".chan");
    chAction(b.dataset.act, row ? Number(row.dataset.i) : -1);
  };
  // every change is read at once; quiet hours on or off draws the form again
  $("#channels-body").onchange = e => {
    if (e.target.matches("[data-f=newtype]")) return;
    chState.dirty = true;
    readChannels();
    if (e.target.matches("[data-q=on], [data-f=on]")) drawChannels();
  };
  $("#rules-body").onclick = e => {
    const b = e.target.closest("button[data-act]");
```

In `www/index.html`:

1. Replace

```html
    <h3><span data-i18n="alerts.title">alerts</span> <span class="x" id="alerts-close" data-i18n="dlg.close">[esc]</span></h3>
    <div class="body">
      <div class="atabs"><button id="alerts-tab-list" class="on" data-i18n="alerts.tabList">alerts</button><button id="alerts-tab-rules" data-i18n="alerts.tabRules">rules</button></div>
      <div id="alerts-list">
      <div class="amutefor"><span data-i18n="alerts.muteFor">mute for</span>
```

   with

```html
    <h3><span data-i18n="alerts.title">alerts</span> <span class="x" id="alerts-close" data-i18n="dlg.close">[esc]</span></h3>
    <div class="body">
      <div class="atabs"><button id="alerts-tab-list" class="on" data-i18n="alerts.tabList">alerts</button><button id="alerts-tab-rules" data-i18n="alerts.tabRules">rules</button><button id="alerts-tab-channels" data-i18n="alerts.tabChannels">channels</button></div>
      <div id="alerts-list">
      <div class="amutefor"><span data-i18n="alerts.muteFor">mute for</span>
```

2. Replace

```html
      </div>
      <div id="rules-body" class="hidden"></div>
    </div>
  </div>
```

   with

```html
      </div>
      <div id="rules-body" class="hidden"></div>
      <div id="channels-body" class="hidden"></div>
    </div>
  </div>
```

In `www/app.css`:

1. Replace

```css
.rbtns .grow { flex: 1; }

```

   with

```css
.rbtns .grow { flex: 1; }

/* the channels, the alerts view's third tab */
.cglobal { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.chan .ctype { color: var(--dim); min-width: 60px; }
.chan .grow { flex: 1; }
.cfields label { display: flex; align-items: center; gap: 6px; }
#alerts-overlay #channels-body input.cval { width: 220px; }
#alerts-overlay #channels-body input.rname { width: 150px; }
#alerts-overlay #channels-body select, #alerts-overlay #channels-body input[type=time] { width: auto; }
#channels-body button { background: var(--bg); border: var(--border-w, 1px) solid var(--border); color: var(--cyan);
  font-family: inherit; font-size: 12px; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
#channels-body button.primary { border-color: var(--cyan); }
#channels-body .hint { color: var(--dim); font-size: 11.5px; margin: 0 0 10px; }
.cstat { font-size: 11.5px; }
@media (max-width: 640px) { #alerts-overlay #channels-body input.cval { width: 100%; } .cfields label { flex-wrap: wrap; } }

```

In `hub/lib/i18n.js`:

1. Replace

```js
  "alerts.tabList": "alerts",
  "alerts.tabRules": "rules",
  "alert.metric.diskUsed": "disk used", "alert.metric.mem": "memory", "alert.metric.cpu": "cpu", "alert.metric.temp": "temperature",
  "alert.metric.containerDown": "container down", "alert.metric.failedUnits": "failed units",
```

   with

```js
  "alerts.tabList": "alerts",
  "alerts.tabRules": "rules",
  "alerts.tabChannels": "channels",
  "ch.intro": "Each channel gets the alerts at or above its level; info goes to the daily digest. Quiet hours hold warnings and send one summary when they end; critical always goes through.",
  "ch.quiet": "quiet hours",
  "ch.quietFrom": "from",
  "ch.quietTo": "to",
  "ch.digestAt": "daily digest at",
  "ch.name": "name",
  "ch.type": "type",
  "ch.min": "from",
  "ch.digest": "digest",
  "ch.test": "send test",
  "ch.add": "+ channel",
  "ch.optional": "(optional)",
  "ch.field.server": "server",
  "ch.field.topic": "topic",
  "ch.field.token": "token",
  "ch.field.url": "webhook URL",
  "ch.field.secret": "signing secret",
  "ch.field.chat": "chat id",
  "ch.field.user": "user key",
  "ch.field.room": "room id",
  "ch.lastOk": "last sent {time}",
  "ch.lastError": "last error {error} at {time}",
  "ch.never": "nothing sent yet",
  "ch.saved": "channels saved",
  "ch.saveFailed": "not saved: {error}",
  "ch.loadFailed": "could not load the channels",
  "ch.saveFirst": "save first, then send a test",
  "ch.testOk": "test sent",
  "ch.testFailed": "test failed: {error}",
  "alert.metric.diskUsed": "disk used", "alert.metric.mem": "memory", "alert.metric.cpu": "cpu", "alert.metric.temp": "temperature",
  "alert.metric.containerDown": "container down", "alert.metric.failedUnits": "failed units",
```

In `CHANGELOG.md`:

1. Replace

```markdown

### Added
- Alert channels (spec 8.3, 8.4): ntfy and webhooks (JSON, signed with
  `X-Servitals-Signature` when a secret is set) get each alert at or above
```

   with

```markdown

### Added
- More alert channels and their settings (spec 8.4): Gotify, Telegram,
  Discord, Slack, Microsoft Teams (a Workflows webhook), Pushover and Matrix
  join ntfy and webhooks. The alerts view's "channels" tab adds, edits and
  removes them, sets each one's level and whether it gets the digest, quiet
  hours and the digest's time, sends a test, and shows each channel's last
  send or error. Secrets stay masked; a name in a message cannot ping
  (Discord) or link (Slack); a Matrix retry is never a second message.
- Alert channels (spec 8.3, 8.4): ntfy and webhooks (JSON, signed with
  `X-Servitals-Signature` when a secret is set) get each alert at or above
```

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.js && bash test/budget.sh`
Expected: PASS, 434 tests; the budget passes.

Then the packaging checks:
- `IMAGE_PREFIX=mirror.gcr.io/library/ bash test/compose-smoke.sh` prints `compose smoke test passed`;
- `bash test/screens.sh` prints `screenshots in /out: no page errors`; look at `build/screens/channels-1280.png` and `channels-390.png`;
- `bash packaging/build-deb.sh` builds both packages `ok`;
- `bash packaging/autopkgtest.sh` passes smoke and purge.

- [ ] **Step 5: Commit**

```bash
git add www hub/lib/i18n.js test CHANGELOG.md
git commit -m "feat(ui): the channels tab: channels, quiet hours, the digest's time, a test per channel"
```
