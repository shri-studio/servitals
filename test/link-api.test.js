// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { startHub, request, login, cookieFrom, formBody } = require("./helpers/hub");

const SECRET = "cd".repeat(32);
const startBody = (over = {}) => JSON.stringify({ secret: SECRET, host: "nas", os: "linux", agent: "bash/0.1.0", ...over });
const post = (port, p, body, headers = {}) => request(port, {
  method: "POST", path: p, body,
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
});
const form = (port, fields, cookie, origin = `http://127.0.0.1:${port}`) => {
  const body = formBody(fields);
  const headers = { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), cookie };
  if (origin) headers.origin = origin;
  return request(port, { method: "POST", path: "/link", headers, body });
};

test("link needs HTTPS: a direct loopback connection or a trusted proxy that says https", async () => {
  const hub = await startHub({ PUBLIC_URL: "https://hub.example" });
  try {
    const direct = await post(hub.port, "/api/v1/link/start", startBody());
    assert.strictEqual(direct.status, 200, direct.body);
    assert.strictEqual(JSON.parse(direct.body).verify_url, "https://hub.example/link");
    const viaTls = await post(hub.port, "/api/v1/link/start", startBody(),
      { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    assert.strictEqual(viaTls.status, 200, "a tunnel or proxy that terminated TLS");
    for (const h of [{ "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "http" }, { "x-forwarded-for": "203.0.113.9" }]) {
      const r = await post(hub.port, "/api/v1/link/start", startBody(), h);
      assert.strictEqual(r.status, 403, JSON.stringify(h));
      assert.deepStrictEqual(JSON.parse(r.body), { error: "https_required" }, "an https PUBLIC_URL is not enough: this request was plain HTTP");
      const p = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: "x" }), h);
      assert.strictEqual(p.status, 403);
    }
    const get = await request(hub.port, { path: "/api/v1/link/start" });
    assert.strictEqual(get.status, 405);
    const junk = await post(hub.port, "/api/v1/link/start", "{nope");
    assert.deepStrictEqual([junk.status, JSON.parse(junk.body)], [400, { error: "invalid_request" }]);
  } finally { await hub.stop(); }
});

test("a proxy the hub does not trust cannot vouch for https", async () => {
  const hub = await startHub({ TRUSTED_PROXIES: "" });
  try {
    const r = await post(hub.port, "/api/v1/link/start", startBody(), { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    assert.deepStrictEqual([r.status, JSON.parse(r.body)], [403, { error: "https_required" }]);
  } finally { await hub.stop(); }
});

test("a person approves on /link: login first, see what asks, name it, and the agent gets its node id", async () => {
  const hub = await startHub();
  try {
    const s = JSON.parse((await post(hub.port, "/api/v1/link/start", startBody({ host: "<b>nas</b>" }))).body);
    assert.strictEqual(s.verify_url, `http://127.0.0.1:${hub.port}/link`);

    const anon = await request(hub.port, { path: "/link" });
    assert.match(anon.body, /<input type="hidden" name="next" value="link">/, "the login page comes back to /link");
    const li = await login(hub.port, { form: { next: "link" } });
    assert.strictEqual(li.headers.location, "/link");
    assert.strictEqual((await login(hub.port, { form: { next: "https://evil.example" } })).headers.location, "/", "only /link");
    const cookie = cookieFrom(li);

    const page = await request(hub.port, { path: "/link", headers: { cookie } });
    assert.match(page.body, /name="code"/);
    assert.strictEqual(page.headers["x-frame-options"], "DENY", "no approving inside another site's frame");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(page.body, /servitals-agent link/, "the page says how to start");

    const seen = await form(hub.port, { step: "lookup", code: s.user_code.toLowerCase() }, cookie);
    assert.strictEqual(seen.status, 200);
    assert.match(seen.body, /&lt;b&gt;nas&lt;\/b&gt;/, "the host name is escaped");
    assert.doesNotMatch(seen.body, /<b>nas<\/b>/);
    assert.match(seen.body, /127\.0\.0\.1/, "the address the request came from");
    assert.match(seen.body, /linux/);
    assert.match(seen.body, /bash\/0\.1\.0/);
    assert.ok(!seen.body.includes(SECRET), "the secret never reaches the page");

    const pending = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: s.device_code }));
    assert.deepStrictEqual([pending.status, JSON.parse(pending.body)], [202, { status: "pending" }]);

    const done = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "nas", tags: "home, nas-box" }, cookie);
    assert.strictEqual(done.status, 200);
    assert.match(done.body, /linked/i);

    await new Promise((r) => setTimeout(r, 4100));   // the agent polls every 5 s at most
    const got = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: s.device_code }));
    assert.strictEqual(got.status, 200, got.body);
    const body = JSON.parse(got.body);
    assert.match(body.node_id, /^[a-z2-7]{12}$/);
    assert.strictEqual(body.name, "nas");
    assert.strictEqual(body.account, `a***n on 127.0.0.1:${hub.port}`);

    const stored = JSON.parse(fs.readFileSync(path.join(hub.dataDir, "nodes.json"), "utf8"))[body.node_id];
    assert.strictEqual(stored.secret, SECRET, "the node signs with the secret the agent made");
    assert.deepStrictEqual(stored.tags, ["home", "nas-box"]);
    const list = JSON.parse((await request(hub.port, { path: "/__ctl/nodes", headers: { cookie } })).body);
    assert.ok(list.some((n) => n.id === body.node_id && n.name === "nas"));

    const audit = fs.readFileSync(path.join(hub.dataDir, "audit.log"), "utf8");
    assert.match(audit, /link\.approved/);
    assert.ok(!audit.includes(SECRET) && !audit.includes(s.device_code) && !hub.logs().includes(SECRET), "no secrets in the logs");
  } finally { await hub.stop(); }
});

test("/link: deny, a wrong code, a bad tag, and no approval from another site", async () => {
  const hub = await startHub();
  try {
    const s = JSON.parse((await post(hub.port, "/api/v1/link/start", startBody())).body);
    const cookie = cookieFrom(await login(hub.port));
    const csrf = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "x" }, cookie, "http://evil.example");
    assert.strictEqual(csrf.status, 403);
    const noOrigin = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "x" }, cookie, null);
    assert.strictEqual(noOrigin.status, 403);
    const anon = await form(hub.port, { step: "lookup", code: s.user_code }, "");
    assert.strictEqual(anon.status, 401);

    const wrong = await form(hub.port, { step: "lookup", code: "ZZZZ-ZZZZ" }, cookie);
    assert.match(wrong.body, /unknown or expired code/);
    const badTag = await form(hub.port, { step: "decide", code: s.user_code, action: "approve", name: "nas", tags: "Bad Tag" }, cookie);
    assert.match(badTag.body, /tag/);
    const denied = await form(hub.port, { step: "decide", code: s.user_code, action: "deny" }, cookie);
    assert.match(denied.body, /denied/i);
    const p = await post(hub.port, "/api/v1/link/poll", JSON.stringify({ device_code: s.device_code }));
    assert.deepStrictEqual([p.status, JSON.parse(p.body)], [410, { error: "denied" }]);
  } finally { await hub.stop(); }
});
