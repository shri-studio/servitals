// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { originAllowed, requestIsHttps } = require("../hub/lib/origin");

const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });

test("same host is allowed, others refused", () => {
  assert.ok(originAllowed(req({ host: "hub.lan:20002", origin: "http://hub.lan:20002" }), {}));
  assert.ok(originAllowed(req({ host: "HUB.lan:20002", origin: "http://hub.LAN:20002" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan:20002", origin: "http://evil.example" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan:20002", origin: "http://hub.lan:20003" }), {}));
});

test("missing, null or garbage Origin is refused", () => {
  assert.ok(!originAllowed(req({ host: "hub.lan" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan", origin: "null" }), {}));
  assert.ok(!originAllowed(req({ host: "hub.lan", origin: "::::" }), {}));
});

test("X-Forwarded-Host counts only from a trusted proxy", () => {
  const r = req({ host: "127.0.0.1:20002", origin: "https://dash.example.com", "x-forwarded-host": "dash.example.com" });
  assert.ok(originAllowed(r, { peerTrusted: true }));
  assert.ok(!originAllowed(r, { peerTrusted: false }));
});

test("PUBLIC_URL host is accepted", () => {
  const r = req({ host: "127.0.0.1:20002", origin: "https://dash.example.com" });
  assert.ok(originAllowed(r, { publicUrl: "https://dash.example.com/" }));
});

test("HTTPS detection", () => {
  assert.ok(requestIsHttps(req({}, true), {}));
  assert.ok(requestIsHttps(req({}), { publicUrl: "https://dash.example.com" }));
  assert.ok(requestIsHttps(req({ "x-forwarded-proto": "http, https" }), { peerTrusted: true }));
  assert.ok(!requestIsHttps(req({ "x-forwarded-proto": "https" }), { peerTrusted: false }));
  assert.ok(!requestIsHttps(req({}), {}));
});
