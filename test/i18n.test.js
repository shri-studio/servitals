// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Every string a person reads comes from one dictionary, hub/lib/i18n.js (spec 10.3).
 */
const test = require("node:test");
const assert = require("node:assert");
const { STRINGS, tr } = require("../hub/lib/i18n");
const { startHub, request, login, cookieFrom } = require("./helpers/hub");
const fs = require("node:fs");
const path = require("node:path");
const { WWW, MARKUP, JS } = require("./helpers/page");
const read = (f) => fs.readFileSync(path.join(WWW, f), "utf8");

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

/* the scripts: text reaches the page only through tr(). This finds words written straight
   into what a person reads: toast(), confirmDialog(), alert(), textContent, innerHTML,
   title and placeholder, and the text between tags in generated HTML. */
function wordsOutsideTr(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/ \/\/ .*$/gm, "")
    .replace(/\btr\((["'`])[^"'`]*\1/g, "tr(KEY");            // a key is not a word on the page
  const found = [];
  const lit = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\])*)`/g;
  const letters = (s) => /[A-Za-z]{2}/.test(s);
  // 1. arguments of the calls that show text, and assignments to text properties
  const sinks = /\b(toast|confirmDialog|alert|append|prepend|new Option)\(|\b(setAttribute)\("(?:title|aria-label|placeholder|alt)",|\.(textContent|innerHTML|innerText|title|placeholder|ariaLabel)\s*=(?!=)/g;
  for (let m; (m = sinks.exec(code));) {
    // the literals of the call's own arguments or the assigned value; those inside another
    // call (a selector, a date format, a map() callback) are not what the sink shows, but
    // a ternary's branches are, also inside parentheses
    let depth = 0, parens = 0, end = m.index + m[0].length;
    const open = [];
    for (; end < code.length; end++) {
      const c = code[end];
      if ("([{".includes(c)) { depth++; open.push(c); if (c === "(") parens++; }
      else if (")]}".includes(c)) { open.pop(); if (c === ")") parens--; if (--depth < 0) break; }
      else if (c === ";" && depth === 0) break;
      else if (c === '"' || c === "'" || c === "`") {
        lit.lastIndex = end;
        const l = lit.exec(code);
        if (!l || l.index !== end) continue;
        end = lit.lastIndex - 1;
        const before = code.slice(0, l.index).trimEnd().slice(-1);
        const branch = (before === "?" || before === ":") && open[open.length - 1] === "(";
        if (parens > 0 && !branch) continue;
        const s = l[2] !== undefined ? l[2] : l[3].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
        // HTML is checked below, tag by tag; a selector, the brand or an empty title is not a word
        if (letters(s) && !/<\/?[a-z]/.test(s) && !/^[#.[][\w\s#.[\]="-]*$/.test(s) && s !== "servitals") found.push(`${m[1] || m[2] || m[3]}: ${l[0].slice(0, 60)}`);
      }
    }
  }
  // 2. generated HTML: words between tags, and in title / aria-label / placeholder / label attributes
  lit.lastIndex = 0;
  for (const l of code.matchAll(lit)) {
    const s = l[2] !== undefined ? l[2] : l[3];
    if (!/<\/?[a-z]/.test(s)) continue;
    // a command in <code> and the brand are not words to translate
    const plain = s.replace(/<code>[^<]*<\/code>/g, "<code></code>").replace(/\bservitals\b/g, "").replace(/\$\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, "").replace(/&#?\w+;/g, " ");
    for (const [, between] of plain.matchAll(/>([^<]*)</g)) if (letters(between)) found.push(`between tags: ${between.trim().slice(0, 60)}`);
    // text before the first tag, unless it is the end of a tag split over two literals
    for (const [, between] of plain.matchAll(/^([^<]+)</g)) if (letters(between) && !/="/.test(between)) found.push(`before a tag: ${between.trim().slice(0, 60)}`);
    for (const [, between] of plain.matchAll(/>([^<>]+)$/g)) if (letters(between)) found.push(`after a tag: ${between.trim().slice(0, 60)}`);
    for (const [, a, v] of plain.matchAll(/ (title|aria-label|placeholder|label)="([^"]*)"/g)) if (letters(v)) found.push(`${a}="${v}"`);
  }
  return found;
}

test("app.js puts no words on the page except through tr()", () => {
  assert.deepStrictEqual(wordsOutsideTr(read("js/app.js")), []);
});

test("the check above catches words written straight into the page", () => {
  const bad = [
    'toast("saved");', 'toast(j.error || `${a} failed`, true);', 'el.textContent = x ? "off" : "on";',
    'h.innerHTML = `<span class="muted">none</span>`;', 'h.innerHTML = `<b title="drag me">x</b>`;',
    'confirmDialog("sure?", { title: "stop", yes: tr("dlg.confirm") });', "s.innerHTML = `peak${sep}`;",
    'toast(x + (ok ? " worked" : " failed"));', 'el.textContent = a + (b ? "words here" : "");',
    'el.setAttribute("title", "drag me");', 'el.append("hello world");', 'el.innerText = "hello";',
    'el.ariaLabel = "close";', 'sel.add(new Option("every server", "all"));',
  ];
  for (const b of bad) assert.notDeepStrictEqual(wordsOutsideTr(b), [], b);
  const good = [
    'toast(tr("set.saved"));', 'toast(j.error || tr("svc.failed", { action: verb }), true);',
    'x.textContent = new Date().toLocaleDateString(undefined, { weekday: "short" });', 'el.setAttribute("title", tr("set.managed"));', '$("#x").textContent = n + "%";',
    'h.innerHTML = `<span class="muted">${esc(tr("set.none"))}</span>`;', 'el.closest(".big").className = "big";',
    '$("#x").textContent = tr("mode." + m);', 'b.title = "";',
  ];
  for (const g of good) assert.deepStrictEqual(wordsOutsideTr(g), [], g);
});

test("settings.js puts no words on the page except through tr()", () => {
  assert.deepStrictEqual(wordsOutsideTr(read("js/settings.js")), []);
});

test("what the stylesheets add after a caption or a card name is set from the dictionary", () => {
  assert.match(JS, /if \(caption\) caption\.dataset\.managed = tr\("set\.managedShort"\);/);
  assert.match(JS, /<div class="nhead" data-state="\$\{esc\(tr\("fleet\.state\." \+ n\.status\)\)\}">/);
});

test("the stylesheets show no words of their own: what they add comes from the page (attr())", () => {
  const files = ["app.css", ...fs.readdirSync(path.join(WWW, "styles")).map((f) => "styles/" + f)];
  for (const f of files) {
    for (const [, v] of read(f).matchAll(/(?<![\w-])content:\s*([^;}]+)/g)) {
      assert.ok(!/[A-Za-z]{2}/.test(v.replace(/attr\([\w-]+\)/g, "")), `${f}: content: ${v}`);
    }
  }
});

test("the hub's login, blocked and link pages take every word from the dictionary", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8");
  const pages = src.slice(src.indexOf("const loginPage = "), src.indexOf("\n}\n", src.indexOf("async function linkRoute(")));
  assert.deepStrictEqual(wordsOutsideTr(pages.replace(/\btrHtml\(/g, "tr(")), []);
  // the login message is built where the login is checked
  const login = src.slice(src.indexOf('if (req.method === "POST" && req.url === "/__auth/login")'), src.indexOf("return res.end(loginPage(msg, kiosk, next));"));
  assert.ok(login.length > 200, "the login handler was found");
  assert.deepStrictEqual([...login.matchAll(/\bmsg = \{[^}]*\}/g)].map((m) => m[0]).filter((m) => !/html: (r\.remaining === 1 \? )?trHtml\(/.test(m)), []);
});

test("a container action is named in the dictionary's words, not by its id", () => {
  for (const a of ["start", "stop", "restart"]) assert.ok(STRINGS["svc.act." + a], a);
  const js = read("js/app.js");
  assert.match(js, /const verb = tr\("svc\.act\." \+ action\);/);
  assert.doesNotMatch(js, /tr\("svc\.(done|failed|failedCode)", \{[^}]*\baction\b(?!:)/, "never the raw id");
});

// an element whose text the dictionary sets must hold nothing else: textContent would remove it
function taggedWithChildren(html) {
  return [...html.matchAll(/<([a-z0-9]+)[^>]* data-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)].filter((m) => m[3].includes("<")).map((m) => m[2]);
}
test("an element tagged data-i18n holds only its text", () => {
  assert.deepStrictEqual(taggedWithChildren(MARKUP), []);
  assert.deepStrictEqual(taggedWithChildren('<h2 data-i18n="panel.mem">memory <span id="mem-note"></span></h2>'), ["panel.mem"]);
});

test("every key the code asks for is in the dictionary, and every key in it is used", () => {
  const src = [MARKUP, read("js/app.js"), read("js/settings.js"), read("js/history.js"), read("js/alerts.js"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "server.js"), "utf8"),
               fs.readFileSync(path.join(__dirname, "..", "hub", "lib", "notify.js"), "utf8")].join("\n");
  const asked = new Set([...src.matchAll(/\btr(?:Html)?\("([^"]+)"/g), ...src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  const prefixes = [...asked].filter((k) => k.endsWith("."));
  for (const k of asked) if (!k.endsWith(".")) assert.ok(Object.prototype.hasOwnProperty.call(STRINGS, k), `missing from the dictionary: ${k}`);
  for (const k of Object.keys(STRINGS)) {
    assert.ok(asked.has(k) || prefixes.some((p) => k.startsWith(p)), `never used: ${k}`);
  }
});

test("history.js puts no words on the page except through tr()", () => {
  assert.deepStrictEqual(wordsOutsideTr(read("js/history.js")), []);
});

test("alerts.js puts no words on the page except through tr()", () => {
  assert.deepStrictEqual(wordsOutsideTr(read("js/alerts.js")), []);
});
