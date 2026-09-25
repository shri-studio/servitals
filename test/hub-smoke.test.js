// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { startHub, request } = require("./helpers/hub");

test("gateway starts and answers the health check", async () => {
  const hub = await startHub();
  try {
    const r = await request(hub.port, { path: "/__auth/health" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, "ok");
  } finally {
    await hub.stop();
  }
});
