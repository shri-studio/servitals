// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The style registry (spec 10.2): every style is a light and a dark token set
 * plus optional CSS, at most 3 KB gzipped, loaded only when chosen. Text must
 * stay readable: WCAG AA (4.5:1) for text and 3:1 for status colours in every
 * style and mode; the high-contrast style meets AAA (7:1).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const WWW = path.join(__dirname, "..", "www");
// classic's tokens are in app.css, the registry in js/app.js
const { PAGE: HTML } = require("./helpers/page");
const TOKENS = ["bg", "bg-panel", "border", "dim", "fg", "fg-bright", "green", "cyan", "amber", "red",
                "magenta", "blue", "track", "spark", "shadow", "glow"];
const STATUS = ["green", "amber", "red", "blue", "cyan", "magenta"];

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
function blockAfter(css, selector) {
  const i = css.indexOf(selector + " {");
  assert.ok(i >= 0, `missing ${selector}`);
  return tokens(css.slice(i, css.indexOf("}", i)));
}
function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// every style, both modes: [style, mode, tokens]
function allSets() {
  const sets = [];
  const classicLight = tokens(HTML.slice(HTML.indexOf(":root {"), HTML.indexOf("}", HTML.indexOf(":root {"))));
  const classicDark = blockAfter(HTML, ':root[data-theme="dark"]');
  sets.push(["classic", "light", classicLight], ["classic", "dark", classicDark]);
  for (const f of fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css"))) {
    const id = f.replace(/\.css$/, "");
    const css = fs.readFileSync(path.join(WWW, "styles", f), "utf8");
    sets.push([id, "light", blockAfter(css, `:root[data-style="${id}"]`)],
              [id, "dark", blockAfter(css, `:root[data-theme="dark"][data-style="${id}"]`)]);
  }
  return sets;
}

test("every style file is small, and its system-dark block matches its dark block", () => {
  for (const f of fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css"))) {
    const id = f.replace(/\.css$/, "");
    const css = fs.readFileSync(path.join(WWW, "styles", f), "utf8");
    assert.ok(zlib.gzipSync(css, { level: 9 }).length <= 3072, `${f} is over 3 KB gzipped`);
    assert.match(css, /SPDX-License-Identifier: AGPL-3.0-or-later/);
    assert.deepStrictEqual(blockAfter(css, `:root:not([data-theme="light"])[data-style="${id}"]`),
                           blockAfter(css, `:root[data-theme="dark"][data-style="${id}"]`), f);
  }
});

test("every style defines every colour token in light and dark", () => {
  for (const [id, mode, t] of allSets()) {
    for (const k of TOKENS) assert.ok(t[k] !== undefined, `${id} ${mode}: --${k} missing`);
  }
});

test("text is readable in every style and mode (AA; AAA for high contrast)", () => {
  const problems = [];
  for (const [id, mode, t] of allSets()) {
    const text = id === "contrast" ? 7 : 4.5;
    const status = id === "contrast" ? 4.5 : 3;
    for (const [a, b, min] of [["fg", "bg", text], ["fg", "bg-panel", text], ["dim", "bg-panel", text], ["dim", "bg", text], ["fg-bright", "bg-panel", text],
                               ...STATUS.map((s) => [s, "bg-panel", status])]) {
      const c = contrast(t[a], t[b]);
      if (c < min) problems.push(`${id} ${mode}: --${a} on --${b} is ${c.toFixed(2)} (needs ${min})`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test("every font a style file asks for is shipped", () => {
  for (const f of fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css"))) {
    const css = fs.readFileSync(path.join(WWW, "styles", f), "utf8");
    for (const m of css.matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)) {
      assert.ok(fs.existsSync(path.join(WWW, "fonts", m[1])), `${f}: fonts/${m[1]} is missing`);
    }
  }
});

test("the registry in the page lists exactly the style files, plus classic", () => {
  const listed = [...HTML.matchAll(/\{ id: "([a-z0-9-]+)", label: "[^"]+", group: "[a-z0-9]+" \}/g)].map((m) => m[1]).sort();
  const files = fs.readdirSync(path.join(WWW, "styles")).filter((x) => x.endsWith(".css")).map((x) => x.replace(/\.css$/, ""));
  assert.deepStrictEqual(listed, ["classic", ...files].sort());
  assert.deepStrictEqual(listed.sort(), ["8bit", "catppuccin", "classic", "contrast", "dracula", "eink", "gruvbox", "nord", "phosphor", "solarized"]);
});
