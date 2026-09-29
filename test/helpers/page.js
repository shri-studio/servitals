// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * The dashboard is several files since the strict CSP (spec 10.5): the markup,
 * the stylesheet, the early boot script and the scripts. Tests that read "the
 * page" read them together, in load order.
 */
const fs = require("fs");
const path = require("path");

const WWW = path.join(__dirname, "..", "..", "www");
const read = (f) => fs.readFileSync(path.join(WWW, f), "utf8");
const MARKUP = read("index.html");
const CSS = read("app.css");
const BOOT = read("boot.js");
const JS = read("js/app.js") + "\n" + read("js/settings.js");
const PAGE = [MARKUP, CSS, BOOT, JS].join("\n");

module.exports = { WWW, MARKUP, CSS, BOOT, JS, PAGE };
