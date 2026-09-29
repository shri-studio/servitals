// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Every string a person reads comes from one dictionary, hub/lib/i18n.js (spec 10.3).
 */
const test = require("node:test");
const assert = require("node:assert");
const { STRINGS, tr } = require("../hub/lib/i18n");
const { startHub, request, login, cookieFrom } = require("./helpers/hub");
const { MARKUP, JS } = require("./helpers/page");

const ENTITIES = { hellip: "…", nbsp: " ", darr: "↓", uarr: "↑", mdash: "—", deg: "°", amp: "&", lt: "<", gt: ">", quot: '"' };
const decode = (s) => s.replace(/&(#\d+|\w+);/g, (m, e) => (e[0] === "#" ? String.fromCodePoint(+e.slice(1)) : ENTITIES[e] ?? m));

test("tr() fills {names} and shows an unknown key as itself", () => {
  assert.strictEqual(tr("svc.up", { running: 3, total: 5 }), "3/5 up");
  assert.strictEqual(tr("svc.up", { running: 3 }), "3/{total} up", "a missing value stays visible");
  assert.strictEqual(tr("no.such.key"), "no.such.key");
  assert.strictEqual(tr("__proto__"), "__proto__", "never a property of Object.prototype");
  assert.strictEqual(tr("set.revokeQ", { name: "$& {name}" }), 'revoke "$& {name}"?', "values are inserted as they are");
});

test("the dictionary holds text only: no markup in a value, every key used once", () => {
  for (const [k, v] of Object.entries(STRINGS)) {
    assert.strictEqual(typeof v, "string", k);
    assert.ok(!/[<>]/.test(v), `${k}: callers escape; values carry no HTML`);
    assert.match(k, /^[a-z0-9]+(\.[A-Za-z0-9]+)+$/, k);
  }
});

// the text inside each element of the page body, with the element that holds it
function textNodes(html) {
  const body = html.slice(html.indexOf("<body")).replace(/<!--[\s\S]*?-->/g, "");
  const out = [], stack = [];
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g;
  const VOID = new Set(["input", "img", "br", "col", "meta", "link"]);
  for (let m; (m = re.exec(body));) {
    if (m[4] !== undefined) { if (m[4].trim()) out.push({ text: decode(m[4]).trim(), el: stack[stack.length - 1] }); continue; }
    if (m[1]) { stack.pop(); continue; }
    if (!VOID.has(m[2]) && !m[3].endsWith("/")) stack.push({ tag: m[2], attrs: m[3] });
  }
  return out;
}

test("every word in the page markup is tagged with its key, and matches the dictionary", () => {
  // not words: the brand, the licence, and text without letters (symbols, placeholders for numbers)
  const NOT_WORDS = /^(servitals|AGPL-3\.0|°C|°F|[^A-Za-z]*)$/;
  for (const { text, el } of textNodes(MARKUP)) {
    if (NOT_WORDS.test(text) || (el && el.tag === "code")) continue;
    const k = el && /data-i18n="([^"]+)"/.exec(el.attrs);
    assert.ok(k, `untagged text in the page: "${text}"`);
    assert.strictEqual(text, tr(k[1]), `the markup and the dictionary differ for ${k[1]}`);
  }
  for (const [, attr, k, v] of MARKUP.matchAll(/ (placeholder|aria-label|title)="([^"]*)" data-i18n-\1="([^"]+)"/g)) {
    assert.strictEqual(decode(k), tr(v), `${attr} of ${v}`);
  }
  for (const [, attr] of MARKUP.matchAll(/ (placeholder|aria-label|title)="[^"]*[a-z]{2}[^"]*"(?! data-i18n-)/g)) {
    assert.fail(`a ${attr} without its key`);
  }
});

test("the hub serves the dictionary to a logged-in page, as a script, and to no one else", async () => {
  const hub = await startHub({ UPSTREAM: "" });
  try {
    const anon = await request(hub.port, { path: "/js/i18n.js" });
    assert.ok(!/javascript/.test(anon.headers["content-type"] || ""), "not before login");
    const cookie = cookieFrom(await login(hub.port));
    const r = await request(hub.port, { path: "/js/i18n.js", headers: { cookie } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-type"], "text/javascript; charset=utf-8");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    assert.match(r.body, /const STRINGS = \{/);
    for (const p of ["/js/log.js", "/i18n.js", "/js/../lib/i18n.js", "/js/i18n.js/"]) {
      const o = await request(hub.port, { path: p, headers: { cookie } });
      assert.ok(!/const STRINGS/.test(o.body), p);
    }
  } finally { await hub.stop(); }
});

test("behind nginx (the Docker install) the hub still serves the dictionary itself", async () => {
  const hub = await startHub({ UPSTREAM: "http://127.0.0.1:9" });   // nothing listens there
  try {
    const cookie = cookieFrom(await login(hub.port));
    const r = await request(hub.port, { path: "/js/i18n.js", headers: { cookie } });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /const STRINGS = \{/);
  } finally { await hub.stop(); }
});

test("the page loads the dictionary before its scripts, and applies it to the markup", () => {
  assert.match(MARKUP, /<script src="js\/i18n\.js" defer><\/script>\n<script src="js\/app\.js" defer><\/script>/);
});

test("applyStrings() sets each tagged element's text and attributes from the dictionary", () => {
  const i = JS.indexOf("function applyStrings(");
  const src = JS.slice(i, JS.indexOf("\n}\n", i) + 3);
  const applyStrings = new Function("tr", `${src}; return applyStrings;`)((k) => "<" + k + ">");
  const text = { dataset: { i18n: "set.save" }, textContent: "save" };
  const input = { attrs: { "data-i18n-placeholder": "set.wxPh" }, getAttribute(a) { return this.attrs[a]; }, setAttribute(a, v) { this.attrs[a] = v; } };
  const root = { querySelectorAll: (sel) => (sel === "[data-i18n]" ? [text] : sel === "[data-i18n-placeholder]" ? [input] : []) };
  applyStrings(root);
  assert.strictEqual(text.textContent, "<set.save>", "textContent: never parsed as HTML");
  assert.strictEqual(input.attrs.placeholder, "<set.wxPh>");
  assert.match(JS, /\(async function \(\) \{\n  applyStrings\(document\);/, "first thing at boot");
});
