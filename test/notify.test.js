// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Where alerts go (spec 8.3, 8.4): channels with a minimum severity, retries, quiet hours
 * with a summary at their end, the daily digest, secrets kept out of view and logs.
 * Local time is UTC here.
 */
process.env.TZ = "UTC";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNotifier, checkChannels, SECRET } = require("../hub/lib/notify");

const at = (hhmm, dayOffset = 0) => Date.UTC(2026, 9, 9 + dayOffset, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));
const ntfy = (extra = {}) => ({ id: "ch_n", type: "ntfy", name: "phone", min: "warning", on: true, config: { topic: "sv-home", token: "tk_secret" }, ...extra });
const hook = (extra = {}) => ({ id: "ch_w", type: "webhook", name: "pager", min: "critical", on: true, config: { url: "https://hooks.test/T0K3N", secret: "s3" }, ...extra });

function setup(config, { fail = () => 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notify-"));
  const sent = [], logs = [], slept = [];
  const clock = { t: at("12:00") };
  const outbound = { request: async (url, o) => { sent.push({ url, ...o }); const s = fail(url, sent.length); return { status: s || 200, headers: {}, body: "" }; } };
  const make = () => createNotifier({ dir, outbound, now: () => clock.t, env: { NTFY_TOKEN: "from_env", HOOK_URL: "https://hooks.test/env" },
    log: { info() {}, warn: (event, f) => logs.push([event, f]) }, sleep: async (ms) => { slept.push(ms); } });
  const n = make();
  if (config) n.setConfig(config);
  return { n, dir, sent, logs, slept, clock, make };
}
const ev = (kind, severity, extra = {}) => ({ kind, rule: "disk_full", metric: "disk.used", severity, node: "nodeaaaaaaaa", nodeName: "nas",
  sub: "/srv", value: 92, at: at("12:00"), since: at("11:55"), ...extra });

test("channels are checked: type, severity, topic, URL; a masked secret keeps its value; $NAME comes from the environment", () => {
  const ok = checkChannels({ channels: [ntfy(), hook({ config: { url: "$HOOK_URL" } })], quiet: { from: "23:00", to: "07:00" } });
  assert.deepStrictEqual(ok, { channels: [ntfy(), hook({ config: { url: "$HOOK_URL" } })], quiet: { from: "23:00", to: "07:00" }, digestAt: "07:00" });
  const bad = (chs, re, extra = {}) => assert.throws(() => checkChannels({ channels: chs, ...extra }, ok), re);
  bad([ntfy({ type: "fax" })], /phone: type/);
  bad([ntfy({ min: "page" })], /phone: min/);
  bad([ntfy({ config: { topic: "a b" } })], /phone: topic: not valid/);
  bad([ntfy({ config: {} })], /phone: topic: needed/);
  bad([hook({ config: { url: "ftp://x" } })], /pager: url: an http or https URL/);
  bad([hook({ config: { url: "https://x/\n" } })], /pager: url: text/);
  bad([ntfy(), ntfy()], /phone: listed twice/);
  bad([ntfy({ id: "x" })], /id: ch_/);
  bad([ntfy({ on: "yes" })], /on: true or false/);
  bad([], /quiet hours/, { quiet: { from: "23:00", to: "23:00" } });
  bad([], /digest: a time/, { digestAt: "7am" });
  bad(Array.from({ length: 21 }, (_, i) => ntfy({ id: "ch_" + i })), /at most 20/);
  const kept = checkChannels({ channels: [ntfy({ config: { topic: "sv-home", token: SECRET } })] }, { channels: [ntfy()] });
  assert.strictEqual(kept.channels[0].config.token, "tk_secret", "unchanged on the page: kept");
  assert.throws(() => checkChannels({ channels: [ntfy({ id: "ch_new", config: { topic: "t", token: SECRET } })] }, { channels: [ntfy()] }), /token: type it again/);
});

test("an alert goes to each channel whose minimum it meets: ntfy as JSON with a bearer token, a webhook signed", async () => {
  const s = setup({ channels: [ntfy({ config: { topic: "sv-home", token: "$NTFY_TOKEN" } }), hook()] });
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.deepStrictEqual(s.sent.map((r) => r.url), ["https://ntfy.sh/"], "warning: not to the critical-only pager");
  const body = JSON.parse(s.sent[0].body);
  assert.deepStrictEqual(body, { topic: "sv-home", title: "warning: disk full /srv on nas", message: "value 92%\nsince 11:55", priority: 4, tags: ["warning"] });
  assert.strictEqual(s.sent[0].headers.authorization, "Bearer from_env");
  s.n.onEvent(ev("firing", "critical", { rule: "c_x", name: "backup <disk>", metric: "temp", value: 71.26 }));
  s.n.onEvent(ev("resolved", "critical", { rule: "offline", metric: "offline", sub: undefined, value: 0 }));
  await s.n.flush();
  assert.deepStrictEqual(s.sent.map((r) => r.url).slice(1).sort(), ["https://hooks.test/T0K3N", "https://hooks.test/T0K3N", "https://ntfy.sh/", "https://ntfy.sh/"]);
  const hooks = s.sent.filter((r) => r.url.startsWith("https://hooks"));
  const first = JSON.parse(hooks[0].body);
  assert.deepStrictEqual([first.kind, first.severity, first.title, first.text.split("\n")[0], first.event.rule], ["alert", "critical", "critical: backup <disk> /srv on nas", "value 71.3 °C", "c_x"]);
  assert.strictEqual(hooks[0].headers["x-servitals-signature"], "sha256=" + crypto.createHmac("sha256", "s3").update(hooks[0].body).digest("hex"));
  assert.strictEqual(JSON.parse(hooks[1].body).title, "resolved: offline on nas", "an offline alert has no value to show");
  const off = setup({ channels: [ntfy({ on: false })] });
  off.n.onEvent(ev("firing", "critical"));
  await off.n.flush();
  assert.deepStrictEqual(off.sent, [], "a channel turned off sends nothing");
});

test("a failed send is tried again after 2, 10 and 30 s, then logged without the URL or the token; the page sees the last error", async () => {
  const s = setup({ channels: [hook({ min: "warning" })] }, { fail: (url, n) => (n < 3 ? 503 : 0) });
  s.n.onEvent(ev("firing", "warning"));
  await s.n.flush();
  assert.deepStrictEqual([s.sent.length, s.slept], [3, [2000, 10000]], "the third try worked");
  assert.strictEqual(typeof s.n.view().status.ch_w.lastOk, "number");
  const f = setup({ channels: [hook({ min: "warning" })] }, { fail: () => 500 });
  f.n.onEvent(ev("firing", "warning"));
  await f.n.flush();
  assert.deepStrictEqual([f.sent.length, f.slept], [4, [2000, 10000, 30000]]);
  assert.deepStrictEqual(f.logs, [["alert.notify_failed", { channel: "ch_w", type: "webhook", error: "HTTP_500" }]]);
  assert.doesNotMatch(JSON.stringify(f.logs), /T0K3N|s3/);
  assert.strictEqual(f.n.view().status.ch_w.lastError, "HTTP_500");
});

test("quiet hours hold warnings, not critical; at their end one summary of what still fires, and of ends told before", async () => {
  const s = setup({ channels: [ntfy()], quiet: { from: "23:00", to: "07:00" } });
  const told = { rule: "memory", metric: "mem", sub: undefined };
  s.clock.t = at("22:00"); s.n.onEvent(ev("firing", "warning", told)); s.n.tick();
  await s.n.flush();
  assert.strictEqual(s.sent.length, 1, "before the window: sent");
  s.clock.t = at("23:30"); s.n.tick();
  s.n.onEvent(ev("firing", "warning", { sub: "/a" }));
  s.n.onEvent(ev("firing", "critical", { rule: "offline", metric: "offline", sub: undefined }));
  await s.n.flush();
  assert.strictEqual(s.sent.length, 2, "critical goes through, the warning waits");
  s.clock.t = at("01:00", 1); s.n.onEvent(ev("resolved", "warning", { sub: "/a" }));   // fired and ended inside: log only
  s.n.onEvent(ev("firing", "warning", { sub: "/b" }));
  s.n.onEvent(ev("resolved", "warning", told));                                         // told before the window
  const again = s.make();                                                                // a restart in the night keeps what is held
  s.clock.t = at("06:59", 1); again.tick();
  await again.flush();
  assert.strictEqual(s.sent.length, 2);
  s.clock.t = at("07:00", 1); again.tick();
  await again.flush();
  assert.strictEqual(s.sent.length, 3);
  const sum = JSON.parse(s.sent[2].body);
  assert.strictEqual(sum.title, "2 alerts held during quiet hours");
  assert.deepStrictEqual(sum.message.split("\n").sort(), ["fired: disk full /b on nas · 92%", "resolved: memory on nas · 92%"]);
  s.clock.t = at("07:01", 1); again.tick();
  await again.flush();
  assert.strictEqual(s.sent.length, 3, "once");
});

test("info goes to one digest a day at 07:00, to every channel unless it opts out", async () => {
  const s = setup({ channels: [ntfy({ min: "critical" }), hook({ digest: false })] });
  s.clock.t = at("08:00"); s.n.tick();
  s.n.onEvent(ev("firing", "info", { rule: "security_updates", metric: "security_updates", sub: undefined, value: 3 }));
  s.n.onEvent(ev("firing", "info", { rule: "reboot_required", metric: "reboot_required", sub: undefined, value: 1 }));
  await s.n.flush();
  assert.strictEqual(s.sent.length, 0, "info is never sent on its own");
  s.clock.t = at("06:59", 1); s.n.tick();
  s.clock.t = at("07:00", 1); s.n.tick();
  await s.n.flush();
  assert.deepStrictEqual(s.sent.map((r) => r.url), ["https://ntfy.sh/"]);
  const d = JSON.parse(s.sent[0].body);
  assert.deepStrictEqual([d.title, d.message, d.priority], ["daily digest: 2 events", "fired: security updates on nas · 3\nfired: reboot required on nas", 3]);
  s.clock.t = at("09:00", 1); s.n.tick();
  s.clock.t = at("07:00", 2); s.n.tick();
  await s.n.flush();
  assert.strictEqual(s.sent.length, 1, "once a day, and nothing when there is nothing");
});

test("send test answers at once; the page sees secrets masked, names from the environment as they are; the file is 0600", async () => {
  const s = setup({ channels: [ntfy(), hook({ config: { url: "$HOOK_URL" } })] }, { fail: (url) => (url.includes("env") ? 404 : 0) });
  assert.deepStrictEqual(await s.n.test("ch_n"), { ok: true });
  assert.deepStrictEqual(await s.n.test("ch_w"), { ok: false, error: "HTTP_404" });
  assert.deepStrictEqual(await s.n.test("ch_zz"), { ok: false, error: "no such channel" });
  assert.strictEqual(JSON.parse(s.sent[0].body).title, "servitals test");
  assert.strictEqual(s.sent[1].url, "https://hooks.test/env");
  const v = s.n.view();
  assert.deepStrictEqual(v.channels.map((c) => c.config), [{ topic: "sv-home", token: SECRET }, { url: "$HOOK_URL" }]);
  assert.strictEqual(v.status.ch_w.lastError, "HTTP_404");
  assert.deepStrictEqual(v.types.ntfy.map((f) => f.key), ["server", "topic", "token"]);
  assert.strictEqual(fs.statSync(path.join(s.dir, "channels.json")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(s.dir, "channels.json"), "utf8"), /tk_secret/, "kept in the file, which only the hub reads");
});
