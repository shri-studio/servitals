// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");

// pull one top-level function out of the page's script and run it here
function pageFunction(name) {
  const m = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(HTML);
  assert.ok(m, `function ${name} not found in www/index.html`);
  return new Function(`${m[0]}; return ${name};`)();
}

test("disks without a configured label get a readable default", () => {
  const diskLabel = pageFunction("diskLabel");
  assert.strictEqual(diskLabel("/"), "system");
  assert.strictEqual(diskLabel("/srv"), "srv");
  assert.strictEqual(diskLabel("/mnt/elements"), "elements");
  assert.strictEqual(diskLabel("/mnt/router-usb/"), "router-usb");
});

test("a configured label still wins", () => {
  assert.match(HTML, /meta\.label \|\| diskLabel\(dk\.mount\)/);
});

test("the settings panel has the login section wired up", () => {
  for (const id of ["acct-user", "acct-new", "acct-new2", "acct-current", "acct-save", "acct-msg"]) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /\$\("#acct-save"\)\.onclick = saveAccount;/);
  assert.match(HTML, /fetch\("\/__ctl\/account"/);
});

test("the fleet grid and node tabs are wired up", () => {
  for (const id of ["tabs", "fleet"]) assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /fetch\("\/__ctl\/nodes\?t="/);
  assert.match(HTML, /`\/__ctl\/node\/\$\{currentNode\}`/);
  assert.match(HTML, /"\/__ctl\/refresh\?node=all"/);
  assert.match(HTML, /window\.addEventListener\("hashchange"/);
  // container buttons only for the hub's own host
  assert.match(HTML, /if \(!ctlAllowed \|\| !isLocalView\(\)\) return "";/);
  assert.match(HTML, /\/logs\$\{nodeQuery\(\)\}/);
  // node names, statuses and mounts come from remote machines: always escaped
  for (const expr of ["esc(n.name)", "esc(n.status)", "esc(disk.mount)", "esc(n.id)"]) {
    assert.ok(HTML.includes("${" + expr + "}"), `renderFleet must use \${${expr}}`);
  }
});

test("snapshot times are milliseconds", () => {
  assert.match(HTML, /const age = \(Date\.now\(\) - \(ts \|\| 0\)\) \/ 1000;/);
  assert.match(HTML, /fmtTime\(new Date\(ts \|\| 0\)\)/);
});

test("fleet numbers show a dash when unknown", () => {
  const fmtVal = pageFunction("fmtVal");
  assert.strictEqual(fmtVal(null, "%"), "–");
  assert.strictEqual(fmtVal(12.6, "%"), "13%");
  assert.strictEqual(fmtVal(0, "°C"), "0°C");
});

test("vnStat bar titles from remote nodes are escaped, also in the tooltip", () => {
  assert.doesNotMatch(HTML, /data-t="\$\{x\.title\}"/);
  assert.match(HTML, /data-t="\$\{esc\(x\.title\)\}"/);
  assert.doesNotMatch(HTML, /\$\{d\.dataset\.t\}/);
  assert.match(HTML, /\$\{esc\(d\.dataset\.t\)\}/);
});

test("a panel whose group the node does not send is hidden, never left from the previous node", () => {
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| cfg\.panels\[panel\] === false\)/);
});

test("without vnStat the network panel shows the live rate and says how to get history", () => {
  assert.match(HTML, /install vnstat for today, month and 30-day history/);
});

test("the node tabs sit at the top, above the header", () => {
  const tabs = HTML.indexOf('<nav class="tabs hidden" id="tabs"');
  const head = HTML.indexOf('<div class="head">');
  assert.ok(tabs > 0 && head > 0 && tabs < head, "tabs before the header bar");
});

test("style, mode, density and kiosk are applied before the first paint", () => {
  const head = HTML.slice(0, HTML.indexOf("<style>"));
  assert.match(head, /localStorage\.getItem\("servitals\." \+ k\)/);
  assert.match(head, /\/\^\[a-z0-9-\]\{1,32\}\$\/\.test\(style\)/, "only a plain style name reaches the link");
  assert.match(head, /d\.setAttribute\("data-kiosk", ""\)/);
  assert.doesNotMatch(HTML.slice(0, 200), /data-theme="dark"/, "no forced dark mode: the default is the system's");
});

test("8bit lives in its own file, not in the first page load", () => {
  assert.doesNotMatch(HTML, /data-style="8bit"\]/);
  assert.doesNotMatch(HTML, /press-start-2p-400\.woff2/);
});

test("the settings panel sets style, mode, density and kiosk", () => {
  for (const id of ["cfg-style", "cfg-mode", "cfg-density", "cfg-kiosk", "cfg-kiosksec"]) {
    assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /cfg\.style = currentStyle\(\);/);
  assert.match(HTML, /applyStyle\(lsGet\("style"\) \|\| cfg\.style \|\| "classic"\)/);
  assert.match(HTML, /\.modal input\[type=password\]/, "password fields look like the other fields");
});

// runs the early <head> script against a fake document, as a browser would
function early({ search = "", stored = {} } = {}) {
  const src = HTML.slice(HTML.indexOf("<script>") + 8, HTML.indexOf("</script>"));
  const attrs = {}; const written = [];
  const document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
    write: (s) => written.push(s),
  };
  const localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = String(v); } };
  new Function("document", "localStorage", "location", src)(document, localStorage, { search });
  return { attrs, written, stored };
}

test("the early script applies a stored look and refuses odd style names", () => {
  const r = early({ stored: { "servitals.style": "nord", "servitals.theme": "light", "servitals.density": "large" } });
  assert.deepStrictEqual(r.attrs, { "data-theme": "light", "data-density": "large", "data-style": "nord" });
  assert.deepStrictEqual(r.written, ['<link rel="stylesheet" id="style-css" href="styles/nord.css">']);
  for (const bad of ['x"><script>alert(1)</script>', "../../etc", "Nord"]) {
    assert.deepStrictEqual(early({ stored: { "servitals.style": bad } }).written, [], bad);
  }
  assert.deepStrictEqual(early({ stored: { "servitals.theme": "system", "servitals.density": "huge" } }).attrs, {});
});

test("the hub's default look from the last visit paints at once; this browser's own choice wins", () => {
  const hub = { "servitals.hub.style": "phosphor", "servitals.hub.mode": "dark", "servitals.hub.density": "compact" };
  const r = early({ stored: { ...hub } });
  assert.deepStrictEqual(r.attrs, { "data-theme": "dark", "data-density": "compact", "data-style": "phosphor" });
  const own = early({ stored: { ...hub, "servitals.style": "nord", "servitals.theme": "light" } });
  assert.strictEqual(own.attrs["data-style"], "nord");
  assert.strictEqual(own.attrs["data-theme"], "light");
  assert.match(HTML, /lsSet\("hub\." \+ k, cfg\[k\] \|\| ""\)/, "the page remembers the hub's defaults");
});

test("?kiosk turns kiosk on and is remembered; ?kiosk=0 turns it off, even when the hub turns it on for everyone", () => {
  const on = early({ search: "?kiosk" });
  assert.strictEqual(on.attrs["data-kiosk"], "");
  assert.strictEqual(on.stored["servitals.kiosk"], "1");
  assert.strictEqual(early({ search: "?a=1&kiosk=1" }).attrs["data-kiosk"], "");
  assert.strictEqual(early({ stored: { "servitals.kiosk": "1" } }).attrs["data-kiosk"], "", "back after the session ran out");
  const off = early({ search: "?kiosk=0", stored: { "servitals.kiosk": "1" } });
  assert.strictEqual(off.attrs["data-kiosk"], undefined);
  assert.strictEqual(off.stored["servitals.kiosk"], "0");
  assert.strictEqual(early({ stored: { "servitals.hub.kiosk": "1" } }).attrs["data-kiosk"], "");
  assert.strictEqual(early({ stored: { "servitals.hub.kiosk": "1", "servitals.kiosk": "0" } }).attrs["data-kiosk"], undefined);
  assert.strictEqual(early({ search: "?kioskx" }).attrs["data-kiosk"], undefined);
});

// runs one page function from the source with the stubs it needs
function pageFn(name, stubs) {
  const i = HTML.indexOf(`function ${name}(`);
  let depth = 0, j = HTML.indexOf("{", i);
  for (let k = j; k < HTML.length; k++) {
    if (HTML[k] === "{") depth++;
    if (HTML[k] === "}" && --depth === 0) { j = k + 1; break; }
  }
  const src = HTML.slice(i, j);
  return new Function(...Object.keys(stubs), `${src}; return ${name};`)(...Object.values(stubs));
}

test("the hub turning kiosk off (or on) takes effect on the same load", () => {
  const run = (cfg, own) => {
    const attrs = { "data-kiosk": "" };   // painted from the remembered hub.kiosk
    const documentElement = {
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
      toggleAttribute: (k, on) => { if (on) attrs[k] = ""; else delete attrs[k]; return on; },
    };
    const store = own === undefined ? {} : { kiosk: own };
    pageFn("applyAppearanceDefaults", {
      cfg, document: { documentElement }, lsGet: (k) => (k in store ? store[k] : null), lsSet: () => {},
      applyStyle: () => {}, applyMode: () => {}, applyDensity: () => {},
    })();
    return "data-kiosk" in attrs;
  };
  assert.strictEqual(run({ kiosk: false }), false, "hub turned kiosk off");
  assert.strictEqual(run({ kiosk: true }), true);
  assert.strictEqual(run({ kiosk: true }, "0"), false, "this screen opted out");
  assert.strictEqual(run({ kiosk: false }, "1"), true, "this screen asked for kiosk");
});

test("turning kiosk on for everyone does not lock the admin's own browser", () => {
  assert.match(HTML, /:root\[data-kiosk\] \.overlay\.open \{ cursor: auto; \}/, "a pointer inside open dialogs");
  assert.match(HTML, /a screen opts out at <code>\/\?kiosk=0<\/code>/, "the way out is in the settings panel");
  assert.match(HTML, /if \(cfg\.kiosk && !was && lsGet\("kiosk"\) === null\) lsSet\("kiosk", "0"\);/);
});

test("saving settings changes everyone's look only when asked to", () => {
  assert.ok(HTML.includes('id="cfg-lookdefault"'));
  assert.match(HTML, /if \(\$\("#cfg-lookdefault"\)\.checked\) \{\n    cfg\.style = currentStyle\(\);/);
});

test("native controls (checkboxes, dropdown lists) follow the page's light or dark mode", () => {
  const block = (sel) => HTML.slice(HTML.indexOf(sel + " {"), HTML.indexOf("}", HTML.indexOf(sel + " {")));
  assert.match(block(":root"), /color-scheme: light;/);
  assert.match(block(':root[data-theme="dark"]'), /color-scheme: dark;/);
  assert.match(block(':root:not([data-theme="light"])'), /color-scheme: dark;/, "system dark");
});

test("units: temperature, sizes, network rates and the clock follow the settings", () => {
  const u = (over) => () => Object.assign({ temp: "c", size: "binary", rate: "bytes", clock: "auto" }, over);
  const fmtTemp = (over) => pageFn("fmtTemp", { units: u(over), tempUnit: pageFn("tempUnit", { units: u(over) }) });
  assert.strictEqual(fmtTemp()(48.4), "48°");
  assert.strictEqual(fmtTemp()(48.4, true), "48°C");
  assert.strictEqual(fmtTemp({ temp: "f" })(48.4, true), "119°F");
  assert.strictEqual(fmtTemp({ temp: "f" })(-40), "-40°");
  assert.strictEqual(fmtTemp()(null), "–");

  const fmtBytes = (over) => pageFn("fmtBytes", { units: u(over) });
  assert.strictEqual(fmtBytes()(1024 ** 3 * 4.7), "4.7G");
  assert.strictEqual(fmtBytes({ size: "decimal" })(1e12), "1.0T", "a 1 TB drive reads 1.0T");
  assert.strictEqual(fmtBytes()(1e12), "931G");

  const fmtRate = (over) => pageFn("fmtRate", { units: u(over) });
  assert.strictEqual(fmtRate()(1536), "1.5 KB/s");
  assert.strictEqual(fmtRate({ size: "decimal" })(1500), "1.5 KB/s");
  assert.strictEqual(fmtRate({ rate: "bits" })(1.25e6), "10 Mbit/s", "bits are always powers of 1000");
  assert.strictEqual(fmtRate({ rate: "bits" })(0), "0 bit/s");

  const seen = [];
  const Date_ = class { toLocaleTimeString(loc, o) { seen.push(o); return "t"; } };
  const fmtTime = (over) => pageFn("fmtTime", { units: u(over) });
  fmtTime()(new Date_()); fmtTime({ clock: "24h" })(new Date_()); fmtTime({ clock: "12h" })(new Date_(), "Asia/Kolkata");
  assert.deepStrictEqual(seen, [{ timeZone: undefined, hour12: undefined }, { timeZone: undefined, hour12: false },
                                { timeZone: "Asia/Kolkata", hour12: true }]);

  const UNIT_CHOICES = new Function(`${/const UNIT_CHOICES = [^\n]+/.exec(HTML)[0]}; return UNIT_CHOICES;`)();
  const units = pageFn("units", { cfg: { units: { temp: "k", clock: "12h" } }, UNIT_CHOICES });
  assert.deepStrictEqual(units(), { temp: "c", size: "binary", rate: "bytes", clock: "12h" }, "unknown values fall back");
});

test("every temperature and time on the page goes through the unit helpers", () => {
  const script = HTML.slice(HTML.indexOf('<script>\n"use strict"')).replace(/function (tempUnit|fmtTemp)\([\s\S]*?\n}\n/g, "");
  assert.doesNotMatch(script, /\+ "°"|\}°|°C"/, "no hand-made degree signs");
  assert.doesNotMatch(script.replace(/function fmtTime[\s\S]*?\n}\n/, ""), /toLocaleTimeString\(/, "times through fmtTime");
  for (const id of ["cfg-u-temp", "cfg-u-size", "cfg-u-rate", "cfg-u-clock"]) assert.ok(HTML.includes(`id="${id}"`), id);
});

test("the fleet: hidden nodes go, pinned ones lead, then the chosen order, optionally grouped by first tag", () => {
  const arrange = pageFn("arrangeFleet", {});
  const n = (id, name, over = {}) => ({ id, name, status: "online", tags: [], summary: { cpu: 10, mem: 10, temp: 40, disk: { pct: 50 } }, ...over });
  const nodes = [
    n("a", "alpha", { tags: ["home"], summary: { cpu: 5, mem: 80, temp: null, disk: { pct: 91 } } }),
    n("b", "bravo", { status: "offline", summary: null }),
    n("c", "charlie", { tags: ["lab", "home"], summary: { cpu: 70, mem: 20, temp: 60, disk: null } }),
    n("d", "delta", { tags: ["home"], status: "stale" }),
  ];
  const ids = (groups) => groups.map((g) => [g.title, g.nodes.map((x) => x.id).join("")]);
  assert.deepStrictEqual(ids(arrange(nodes, {})), [["", "abcd"]], "by name by default");
  assert.deepStrictEqual(ids(arrange(nodes, { sort: "cpu" })), [["", "cdab"]], "busiest first, unknown last");
  assert.deepStrictEqual(ids(arrange(nodes, { sort: "disk" })), [["", "adbc"]]);
  assert.deepStrictEqual(ids(arrange(nodes, { sort: "status" })), [["", "bdac"]], "trouble first");
  assert.deepStrictEqual(ids(arrange(nodes, { hidden: ["b"], pinned: ["d"] })), [["", "dac"]]);
  assert.deepStrictEqual(ids(arrange(nodes, { group: true })), [["home", "ad"], ["lab", "c"], ["untagged", "b"]]);
  assert.deepStrictEqual(ids(arrange(nodes, { group: true, pinned: ["c"] })), [["pinned", "c"], ["home", "ad"], ["untagged", "b"]]);
  assert.deepStrictEqual(ids(arrange([], {})), []);
  assert.deepStrictEqual(ids(arrange(nodes, { pinned: ["gone", "a"], hidden: ["gone"] })), [["", "abcd"]], "ids of revoked servers match nothing");
});

test("names and tags from servers are escaped in the servers section and the fleet's group titles", () => {
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /value="\$\{esc\(n\.name\)\}"/);
  assert.match(fn("renderServers"), /value="\$\{esc\(\(n\.tags \|\| \[\]\)\.join\(", "\)\)\}"/);
  assert.match(fn("renderFleet"), /<div class="fgroup">\$\{esc\(g\.title\)\}<\/div>/);
  assert.doesNotMatch(fn("renderServers") + fn("renderFleet"), /\$\{(n\.name|g\.title|n\.tags)/, "nothing unescaped");
});

test("fleet cards show the numbers chosen in settings", () => {
  const cardNumbers = pageFn("cardNumbers", { cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
  assert.deepStrictEqual(cardNumbers(), ["disk", "containers"]);
  assert.deepStrictEqual(pageFn("cardNumbers", { cfg: {} })(), ["cpu", "mem", "temp"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
});
