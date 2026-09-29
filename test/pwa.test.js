// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The installable app (spec 10.3): a manifest, icons, and a service worker that
 * keeps an offline shell. Data and API answers are never cached.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { startHub, request } = require("./helpers/hub");
const { MARKUP } = require("./helpers/page");

const WWW = path.join(__dirname, "..", "www");
const pngSize = (f) => { const b = fs.readFileSync(f); assert.strictEqual(b.subarray(1, 4).toString(), "PNG", f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("the manifest describes an installable app, and every icon it names exists at its size", () => {
  const m = JSON.parse(fs.readFileSync(path.join(WWW, "manifest.webmanifest"), "utf8"));
  assert.deepStrictEqual([m.name, m.short_name, m.start_url, m.scope, m.display], ["servitals", "servitals", "/", "/", "standalone"]);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/);
  const purposes = new Set(m.icons.map((i) => i.purpose || "any"));
  assert.ok(purposes.has("any") && purposes.has("maskable"));
  for (const i of m.icons) {
    const [w, h] = pngSize(path.join(WWW, i.src));
    assert.strictEqual(i.sizes, `${w}x${h}`, i.src);
    assert.strictEqual(i.type, "image/png");
  }
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512"));
  assert.match(MARKUP, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(MARKUP, /<meta name="theme-color" content="#[0-9a-f]{6}">/);
  assert.match(MARKUP, /<link rel="apple-touch-icon" href="icons\/icon-192\.png">/);
});

test("the manifest and icons are public (browsers fetch them without cookies); nothing else is", async () => {
  const hub = await startHub({ UPSTREAM: "" });
  try {
    for (const [p, type] of [["/manifest.webmanifest", "application/manifest+json"], ["/icons/icon-192.png", "image/png"],
                             ["/icons/icon-maskable-512.png", "image/png"]]) {
      const r = await request(hub.port, { path: p });
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.headers["content-type"], type, p);
    }
    for (const p of ["/", "/js/app.js", "/sw.js", "/icons/", "/icons/../index.html", "/manifest.webmanifest.bak"]) {
      const r = await request(hub.port, { path: p });
      assert.match(r.body, /authentication required|not found|Not Found/i, p);
      assert.ok(!/application\/manifest|image\/png|javascript/.test(r.headers["content-type"] || ""), p);
    }
  } finally { await hub.stop(); }
});
