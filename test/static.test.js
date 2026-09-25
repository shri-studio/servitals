// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStatic } = require("../hub/lib/static");
const { request } = require("./helpers/hub");

const INDEX = "<title>servitals</title>";

async function withStatic(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sv-static-"));
  const root = path.join(tmp, "www");
  fs.mkdirSync(path.join(root, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), INDEX);
  fs.writeFileSync(path.join(root, "fonts", "a.woff2"), "woff");
  fs.writeFileSync(path.join(root, ".refresh"), "trigger");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "top secret");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(root, "leak.txt"));
  const srv = http.createServer(createStatic(root));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(srv.address().port); } finally {
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("serves index.html for / with type and validators", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { path: "/" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, INDEX);
    assert.strictEqual(r.headers["content-type"], "text/html; charset=utf-8");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    assert.ok(r.headers.etag);
    assert.ok(r.headers["last-modified"]);
    const again = await request(port, { path: "/", headers: { "if-none-match": r.headers.etag } });
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.body, "");
  });
});

test("fonts are served as font/woff2", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { path: "/fonts/a.woff2" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-type"], "font/woff2");
  });
});

test("HEAD sends the headers only", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { method: "HEAD", path: "/index.html" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-length"], String(Buffer.byteLength(INDEX)));
    assert.strictEqual(r.body, "");
  });
});

test("refuses methods other than GET and HEAD", async () => {
  await withStatic(async (port) => {
    const r = await request(port, { method: "POST", path: "/" });
    assert.strictEqual(r.status, 405);
    assert.strictEqual(r.headers.allow, "GET, HEAD");
  });
});

test("never serves dotfiles, traversal, symlinks out of root or directories", async () => {
  await withStatic(async (port) => {
    for (const p of ["/.refresh", "/%2e%2e/secret.txt", "/fonts/..%2f..%2fsecret.txt",
                     "/fonts/%2e%2e/%2e%2e/secret.txt", "/leak.txt", "/fonts", "/fonts/", "/missing.js"]) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.status, 404, p);
      assert.doesNotMatch(r.body, /top secret|trigger|a\.woff2/, p);
    }
    for (const p of ["/a%00b", "/%E0%A4%A"]) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.status, 400, p);
    }
  });
});

test("a missing root is an error at startup, not at request time", () => {
  assert.throws(() => createStatic(path.join(os.tmpdir(), "sv-no-such-dir-" + process.pid)));
});
