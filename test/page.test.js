// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// the page's markup, stylesheet, boot script and scripts, in load order
const { PAGE: HTML, BOOT, JS } = require("./helpers/page");

const { tr } = require("../hub/lib/i18n");

// pull one top-level function out of the page's script and run it here (with the dictionary)
function pageFunction(name) {
  const m = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(HTML);
  assert.ok(m, `function ${name} not found in the page`);
  return new Function("tr", `${m[0]}; return ${name};`)(tr);
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
  for (const expr of ["esc(n.name)", "esc(n.status)", "esc(tr(\"fleet.disk\", { mount: disk.mount }))", "esc(n.id)"]) {
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
  assert.match(HTML, /for \(const \[panel, group\] of \[\["mem", "mem"\], \["cpu", "cpu"\], \["temp", "temp"\], \["storage", "disks"\], \["docker", "docker"\], \["procs", "processes"\], \["system", "ubuntu"\]\]\)/);
  assert.match(HTML, /\.classList\.toggle\("hidden", !d\[group\] \|\| shown\[panel\] === false\)/);
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
  const head = BOOT;   // runs in <head>, before the stylesheet and the scripts
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
  const src = BOOT;
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
  let i = HTML.indexOf(`function ${name}(`);
  if (HTML.slice(i - 6, i) === "async ") i -= 6;   // keep "async" for async page functions
  let depth = 0, j = HTML.indexOf("{", i);
  for (let k = j; k < HTML.length; k++) {
    if (HTML[k] === "{") depth++;
    if (HTML[k] === "}" && --depth === 0) { j = k + 1; break; }
  }
  const src = HTML.slice(i, j);
  stubs = { tr, ...stubs };
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
  assert.match(HTML, /a screen opts out at<\/span> <code>\/\?kiosk=0<\/code>/, "the way out is in the settings panel");
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
  const script = JS.replace(/function (tempUnit|fmtTemp)\([\s\S]*?\n}\n/g, "");
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
  assert.match(fn("renderServers"), /value="\$\{esc\(typed\(n, "name", n\.name\)\)\}"/);
  assert.match(fn("renderServers"), /value="\$\{esc\(typed\(n, "tags", \(n\.tags \|\| \[\]\)\.join\(", "\)\)\)\}"/);
  assert.match(fn("renderFleet"), /<div class="fgroup">\$\{esc\(g\.title\)\}<\/div>/);
  assert.doesNotMatch(fn("renderServers") + fn("renderFleet"), /\$\{(n\.name|g\.title|n\.tags)/, "nothing unescaped");
});

test("the cpu panel shows iowait and steal, and pressure, coloured when high; the rows hide when an agent sends neither", () => {
  const HL = { ok: "", warn: "hl-amber", crit: "hl-red" };
  const health = pageFunction("health");
  const fmtShare = pageFunction("fmtShare");
  assert.deepStrictEqual([fmtShare(34), fmtShare(0), fmtShare(0.43), fmtShare(14.85), fmtShare(null), fmtShare(NaN)],
    ["34%", "0%", "0.4%", "15%", "–", "–"]);
  const waitHtml = pageFn("waitHtml", { HL, health, fmtShare });
  assert.strictEqual(waitHtml({ iowait: 34, steal: 0 }), '<span class="hl-red">34%</span> / <span class="">0%</span>');
  assert.strictEqual(waitHtml({ iowait: 12 }), '<span class="hl-amber">12%</span> / <span class="">0%</span>', "no steal: 0");
  const pressureHtml = pageFn("pressureHtml", { HL, health, fmtShare });
  assert.strictEqual(pressureHtml({ cpu: { some: 0.43, full: null }, mem: { some: 0, full: 0 }, io: { some: 14.85, full: 13.29 } }),
    '<span class="">0.4%</span> / <span class="">0%</span> / <span class="hl-amber">15%</span>');
  assert.strictEqual(pressureHtml({ cpu: null, mem: null, io: { some: 41 } }), '– / – / <span class="hl-red">41%</span>');
  for (const id of ["cpu-wait-row", "cpu-wait", "cpu-psi-row", "cpu-psi"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /\$\("#cpu-wait-row"\)\.classList\.toggle\("hidden", typeof c\.iowait !== "number"\);/);
  assert.match(HTML, /\$\("#cpu-psi-row"\)\.classList\.toggle\("hidden", !d\.pressure\);/);
});

test("each disk shows its device's read and write rates, once the hub can compare two samples", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const diskIo = pageFn("diskIo", { esc, fmtRate: (v) => v + " B/s" });
  const io = [{ device: "sdb1", readRate: 4000, writeRate: 0 }, { device: "sda2", readRate: null, writeRate: null }];
  assert.strictEqual(diskIo({ device: "sdb1" }, io), ' <span class="dio">· read 4000 B/s · write 0 B/s</span>');
  assert.strictEqual(diskIo({ device: "sda2" }, io), "", "no rate yet");
  assert.strictEqual(diskIo({ mount: "/mnt/nas" }, io), "", "a network share has no device");
  assert.strictEqual(diskIo({ device: "sdb1" }, undefined), "", "an older agent sends no io");
  // the network setting may say bits per second; a disk's throughput is always in bytes
  const UNIT_CHOICES = { temp: ["c", "f"], size: ["binary", "decimal"], rate: ["bytes", "bits"], clock: ["auto", "24h", "12h"] };
  const units = pageFn("units", { cfg: { units: { rate: "bits" } }, UNIT_CHOICES });
  const fmtRate = pageFn("fmtRate", { units });
  assert.strictEqual(fmtRate(4e6), "32 Mbit/s", "the network keeps its setting");
  const real = pageFn("diskIo", { esc, fmtRate });
  assert.strictEqual(real({ device: "sdb1" }, [{ device: "sdb1", readRate: 4194304, writeRate: 0 }]),
    ' <span class="dio">· read 4.0 MB/s · write 0 B/s</span>');
  assert.match(HTML, /<span class="\$\{freeCls\}">· \$\{esc\(tr\("disk\.free", \{ size: fmtBytes\(dk\.avail\) \}\)\)\}<\/span>\$\{diskIo\(dk, d\.io\)\}\$\{warn\}/);
});

test("the processes panel lists the busiest and the largest, names escaped, the pid in the title", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const procRows = pageFn("procRows", { esc });
  const rows = procRows([{ pid: 812, name: "<rsync>", cpuPct: 38.5, rss: 5 }], (p) => p.cpuPct + "%");
  assert.strictEqual(rows, '<div class="row" title="pid 812"><span class="k pname">&#60;rsync&#62;</span><span class="v">38.5%</span></div>');
  assert.strictEqual(procRows([], (p) => p), '<span class="muted">none yet</span>', "the first tick has no cpu figures");
  assert.strictEqual(procRows(undefined, (p) => p), '<span class="muted">none yet</span>');
  for (const id of ["procs-cpu", "procs-mem"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /data-panel="procs"/);
  assert.match(HTML, /procRows\(d\.processes\.cpu, p => fmtShare\(p\.cpuPct\)\)/);
  assert.match(HTML, /procRows\(d\.processes\.mem, p => fmtBytes\(p\.rss\)\)/);
});

test("the system panel: updates and security updates, a reboot and its packages, failed units by name", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const systemHtml = pageFn("systemHtml", { esc });
  assert.deepStrictEqual(systemHtml({ updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-base"],
    failedUnits: ["a<b>.service", "c.service"] }), {
    updates: '12 · <span class="hl-amber">5 security</span>',
    reboot: '<span class="hl-amber">required</span>', rebootTitle: "linux-base",
    failed: '<span class="hl-red">2</span>', units: "a&#60;b&#62;.service, c.service",
  });
  assert.deepStrictEqual(systemHtml({ updates: 0, security: 0, rebootRequired: false, rebootPkgs: [], failedUnits: [] }),
    { updates: "up to date", reboot: "not needed", rebootTitle: "", failed: "none", units: "" });
  assert.deepStrictEqual(systemHtml({ rebootRequired: false, rebootPkgs: [] }),
    { updates: "–", reboot: "not needed", rebootTitle: "", failed: "–", units: "" }, "unknown counts and a container agent: a dash");
  assert.deepStrictEqual(systemHtml({ failedUnits: [] }),
    { updates: "–", reboot: "–", rebootTitle: "", failed: "none", units: "" }, "a host that never writes the reboot flag: a dash");
  for (const id of ["sys-updates", "sys-reboot", "sys-failed", "sys-units"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /data-panel="system"/);
});

test("the hardware panel: the battery, fans (a named one stopped is red) and voltages; names escaped", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const { STRINGS } = require("../hub/lib/i18n");
  const hardwareHtml = pageFn("hardwareHtml", { esc, STRINGS });
  const html = hardwareHtml({ battery: { capacity: 15, status: "Discharging" },
    fans: [{ label: "CPU <fan>", rpm: 1200 }, { label: "Pump", rpm: 0 }], voltages: [{ label: "Vcore", value: 1.216 }] });
  assert.strictEqual(html,
    '<div class="row"><span class="k">battery</span><span class="v"><span class="hl-red">15%</span> · discharging</span></div>'
    + '<div class="plbl">fans</div>'
    + '<div class="row"><span class="k">CPU &#60;fan&#62;</span><span class="v">1200 rpm</span></div>'
    + '<div class="row"><span class="k">Pump</span><span class="v"><span class="hl-red">0 rpm</span></span></div>'
    + '<div class="plbl">voltages</div>'
    + '<div class="row"><span class="k">Vcore</span><span class="v">1.22 V</span></div>');
  assert.match(hardwareHtml({ battery: { capacity: 30, status: "Charging" } }), /<span class="">30%<\/span> · charging/, "charging: never red");
  assert.match(hardwareHtml({ battery: { capacity: 80, status: "<Odd>" } }), /80%<\/span> · &#60;Odd&#62;/, "a status the dictionary lacks: as sent, escaped");
  assert.strictEqual(hardwareHtml({}), "");
  // what a third-party agent may send, which the hub accepts: nothing to show, so no panel
  for (const d of [{ fans: [] }, { voltages: [] }, { battery: {} }]) assert.strictEqual(hardwareHtml(d), "", JSON.stringify(d));
  assert.match(hardwareHtml({ battery: { status: "Full" } }), /<span class="">–<\/span> · full/, "no capacity: a dash, never undefined%");
  assert.match(HTML, /data-panel="hw"/);
  assert.match(HTML, /\$\("\[data-panel=hw\]"\)\.classList\.toggle\("hidden", !hw \|\| shown\.hw === false\);/, "hidden when there is nothing to show");
});

test("history: each series reads in its unit, and has a name in words", () => {
  const kindOf = pageFunction("kindOf");
  assert.deepStrictEqual(["cpu", "mem", "swap", "iowait", "psi.io", "disk./srv.used", "ctr.web.cpu", "temp", "net.rx", "io.sda1.read",
    "ctr.web.mem", "load1"].map(kindOf), ["pct", "pct", "pct", "pct", "pct", "pct", "pct", "temp", "net", "io", "bytes", "num"]);
  const { STRINGS } = require("../hub/lib/i18n");
  const seriesLabel = pageFn("seriesLabel", { STRINGS });
  assert.deepStrictEqual(["cpu", "net.rx", "disk./srv.used", "io.sda1.write", "ctr.web.mem", "weird"].map(seriesLabel),
    ["cpu", "network in", "disk /srv", "sda1 write", "web memory", "weird"]);
});

test("history chart: the average line and the low-high band per run of data; a gap is shaded; no data says so", () => {
  const esc = (x) => String(x).replace(/[&<>"']/g, (m) => "&#" + m.charCodeAt(0) + ";");
  const historyChart = pageFn("historyChart", { esc, fmtKind: (k, v) => (v == null ? "–" : v + "%"),
    fmtTime: () => "12:00", fmtTimeOrDay: () => "12:00" });
  const pts = [[0, 10, 5, 20], [60, 20, 10, 30], [120, null, null, null], [180, null, null, null], [240, 40, 30, 50]];
  const svg = historyChart(pts, "pct", "1h");
  assert.strictEqual((svg.match(/<polyline class="hline"/g) || []).length, 2, "two runs of data: two lines");
  assert.strictEqual((svg.match(/<polygon class="hband"/g) || []).length, 2);
  assert.strictEqual((svg.match(/<rect class="hgap"/g) || []).length, 1, "the gap between them is shaded");
  assert.match(svg, /<span>100%<\/span><span>0%<\/span>/, "a share reads on 0 to 100");
  assert.match(svg, /points="0\.0,180\.0 250\.0,160\.0"/, "the line: x across the range, y from the average");
  assert.strictEqual(historyChart([[0, null, null, null]], "pct", "1h"), '<div class="muted">no history yet</div>');
  assert.doesNotMatch(svg, /style=/, "the strict CSP: no style attributes");
});

test("the history panel is in the node view and loads its script when shown", () => {
  for (const id of ["hist-series", "hist-chart", "hist-note"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /data-panel="hist"/);
  assert.match(HTML, /class="hrange" data-r="24h"/);
  assert.match(JS, /s\.src = "js\/history\.js";/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "www", "sw.js"), "utf8"), /"\/js\/history\.js"/, "kept for the offline copy");
});

test("fleet cards show the numbers chosen in settings", () => {
  const CARD_KEYS = ["cpu", "mem", "temp", "disk", "containers", "iowait", "updates", "battery"];
  assert.match(HTML, new RegExp(`const CARD_KEYS = ${JSON.stringify(CARD_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  const cardNumbers = pageFn("cardNumbers", { CARD_KEYS, cfg: { fleet: { card: ["disk", "containers", "bogus"] } } });
  assert.deepStrictEqual(cardNumbers(), ["disk", "containers"]);
  assert.deepStrictEqual(pageFn("cardNumbers", { CARD_KEYS, cfg: {} })(), ["cpu", "mem", "temp"]);
  const cardValue = pageFn("cardValue", { fmtVal: pageFunction("fmtVal"), fmtTemp: () => "" });
  assert.deepStrictEqual([cardValue("iowait", { iowait: 31 }), cardValue("iowait", { iowait: null })], ["31%", "–"]);
  assert.deepStrictEqual([cardValue("updates", { updates: 12, reboot: true }), cardValue("updates", { updates: 0, reboot: false }),
    cardValue("updates", { updates: null, reboot: true }), cardValue("updates", {})], ["12 ↻", "0", "↻", "–"]);
  assert.deepStrictEqual([cardValue("battery", { battery: 87 }), cardValue("battery", { battery: null })], ["87%", "–"]);
  for (const id of ["cfg-f-sort", "cfg-f-group", "cfg-servers"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(HTML, /for \(const g of arrangeFleet\(fleetNodes, cfg\.fleet \|\| \{\}\)\)/, "renderFleet uses it");
});

test("a server can have its own panel set and sizes; every other server uses the shared one", () => {
  const cfg = { panels: { mem: true, cpu: true, docker: true }, panelSize: { mem: "normal", docker: "full" },
                nodePanels: { nasnasnasnas: { panels: { mem: true, cpu: true, docker: false }, panelSize: { mem: "wide", docker: "full" } } } };
  const panelSet = pageFn("panelSet", { cfg });
  assert.deepStrictEqual(panelSet("nasnasnasnas"), cfg.nodePanels.nasnasnasnas);
  assert.deepStrictEqual(panelSet("othernode234"), { panels: cfg.panels, panelSize: cfg.panelSize });
  assert.deepStrictEqual(panelSet(null), { panels: cfg.panels, panelSize: cfg.panelSize });
  assert.match(HTML, /const set = panelSet\(currentNode \|\| localNode\);/, "the layout uses the shown server's set");
  assert.doesNotMatch(HTML.slice(HTML.indexOf("function applyLayout")), /cfg\.panels\[(p|panel)\] === false|cfg\.panels\.network === false/);
  assert.ok(HTML.includes('id="cfg-p-for"'));
  assert.match(HTML, /data-up/, "order also with buttons, not only drag (touch screens)");
});

test("settings import takes an exported file, keeps only known settings and refuses anything else", () => {
  const importSettings = pageFn("importSettings", {});
  const ok = importSettings(JSON.stringify({ title: "home", units: { temp: "f" }, fleet: { sort: "cpu" }, nodes: "x", __proto__x: 1 }));
  assert.deepStrictEqual(ok, { ok: true, cfg: { title: "home", units: { temp: "f" }, fleet: { sort: "cpu" } }, skipped: ["nodes", "__proto__x"] });
  for (const bad of ["", "nope", "[1,2]", "null", "42", JSON.stringify({ title: 5 }), JSON.stringify({ units: [] })]) {
    const r = importSettings(bad);
    assert.strictEqual(r.ok, false, bad);
    assert.match(r.error, /./);
  }
  assert.strictEqual(importSettings("x".repeat(600 * 1024)).ok, false, "too big");
  assert.ok(HTML.includes('id="cfg-import"'));
});

test("the panel order always lists every panel once, also after an import", () => {
  const cfg = { panelOrder: ["cpu", "cpu", "bogus", "mem"] };
  pageFn("fixPanelOrder", { cfg, DEFAULTS: { panels: { mem: 1, cpu: 1, temp: 1 } } })();
  assert.deepStrictEqual(cfg.panelOrder, ["cpu", "mem", "temp"]);
  assert.match(HTML, /cfg = deepMerge\(structuredClone\(DEFAULTS\), r\.cfg\);\n    fixPanelOrder\(\);/);
});

test("review: an imported file cannot reach Object.prototype, and nested junk is dropped", () => {
  const deepMerge = pageFn("deepMerge", {});
  deepMerge({}, JSON.parse('{"panels":{"__proto__":{"polluted":"yes"}},"constructor":{"prototype":{"p2":1}}}'));
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(({}).p2, undefined);
  const importSettings = pageFn("importSettings", {});
  const r = importSettings('{"fleet":{"hidden":5,"pinned":["a",3],"card":["cpu"],"sort":"cpu"},"panels":{"__proto__":{"x":1},"mem":true},'
    + '"nodePanels":{"abcdefghijkm":{},"bcdefghijkmn":{"panels":{"mem":false},"panelSize":{"mem":"wide"}}},"portainerEndpoint":2}');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.cfg.fleet, { pinned: ["a"], card: ["cpu"], sort: "cpu" }, "hidden: 5 goes, a number in pinned goes");
  assert.deepStrictEqual(Object.keys(r.cfg.panels), ["mem"]);
  assert.deepStrictEqual(Object.keys(r.cfg.nodePanels), ["bcdefghijkmn"], "a panel set without panels goes");
  assert.strictEqual(r.cfg.portainerEndpoint, 2, "export, then import, keeps every setting");
});

test("review: odd nested settings in config.json fall back instead of breaking the page", () => {
  const arrange = pageFn("arrangeFleet", {});
  const n = [{ id: "a", name: "a", status: "online", tags: [], summary: null }];
  assert.strictEqual(arrange(n, { hidden: 5, pinned: {} })[0].nodes.length, 1);
  const cfg = { panels: { mem: true }, panelSize: {}, nodePanels: { aaaaaaaaaaaa: {}, bbbbbbbbbbbb: { panels: null } } };
  const panelSet = pageFn("panelSet", { cfg });
  assert.strictEqual(panelSet("aaaaaaaaaaaa").panels, cfg.panels);
  assert.strictEqual(panelSet("bbbbbbbbbbbb").panels, cfg.panels);
  assert.deepStrictEqual([...pageFn("hiddenIds", { cfg: { fleet: { hidden: "x" } } })()], []);
});

test("review: hidden servers leave the status dot, the node count and kiosk rotation", () => {
  assert.deepStrictEqual([...pageFn("hiddenIds", { cfg: { fleet: { hidden: ["a", 3] } } })()], ["a"]);
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("fleetStatus"), /const shown = fleetNodes\.filter\(n => !hidden\.has\(n\.id\)\);/);
  assert.match(fn("startKiosk"), /!hiddenIds\(\)\.has\(n\.id\)/);
});

test("review: revoking the shown server moves the page on; settings rows keep what was not saved yet", () => {
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("revokeServer"), /route\(\);/);
  assert.match(fn("revokeServer"), /drawPanelCfg\(\);/);
  // what the rows show now, read back from the form
  const row = (id, pin, hide, name, tags) => ({ dataset: { id }, q: { ".srv-pin": { checked: pin }, ".srv-hide": { checked: hide },
    ".srv-name": { value: name }, ".srv-tags": { value: tags } } });
  const form = { "#cfg-f-sort": { value: "cpu" }, "#cfg-f-group": { checked: true } };
  const $ = (sel, root) => (root ? root.q[sel] : form[sel]);
  const $$ = (sel) => sel === "#cfg-servers .srv" ? [row("aaaaaaaaaaaa", true, false, "nas2", "x"), row("bbbbbbbbbbbb", false, true, "b", "")]
    : sel === "#cfg-f-card input:checked" ? [{ value: "disk" }] : [];
  const state = pageFn("readServersForm", { $, $$ })();
  assert.deepStrictEqual(state, { sort: "cpu", group: true, card: ["disk"], pinned: ["aaaaaaaaaaaa"], hidden: ["bbbbbbbbbbbb"],
    names: { aaaaaaaaaaaa: { name: "nas2", tags: "x" }, bbbbbbbbbbbb: { name: "b", tags: "" } } });
  assert.match(fn("showSettings"), /loadNodes\(\)\.then\(\(\) => renderServers\(\{ keep: true \}\)\)/);
});

test("review: a cancelled import changes nothing; zone clocks stay 24 hour unless asked", () => {
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("closeSettings"), /if \(beforeImport\) \{ cfg = beforeImport; beforeImport = null; \}/);
  assert.match(fn("saveSettings"), /beforeImport = null;/);
  const seen = [];
  const D = class { toLocaleTimeString(loc, o) { seen.push([loc, o.hour12]); return ""; } };
  const u = (clock) => () => ({ clock });
  pageFn("fmtTime", { units: u("auto") })(new D(), "Asia/Kolkata");
  pageFn("fmtTime", { units: u("auto") })(new D());
  pageFn("fmtTime", { units: u("12h") })(new D(), "Asia/Kolkata");
  assert.deepStrictEqual(seen, [["en-GB", undefined], [undefined, undefined], [undefined, true]]);
});

test("conf.d values win over a copy saved in this browser, and their fields are marked managed", () => {
  const DEFAULTS = { title: "file", units: { temp: "f", clock: "12h" }, panels: { mem: false }, _managed: ["title", "units.temp", "panels.mem", 5] };
  const cfg = { title: "browser", units: { temp: "c", clock: "24h" }, panels: { mem: true, cpu: true } };
  pageFn("applyManaged", { cfg, DEFAULTS, managedPaths: pageFn("managedPaths", { DEFAULTS }) })();
  assert.deepStrictEqual(cfg, { title: "file", units: { temp: "f", clock: "24h" }, panels: { mem: false, cpu: true } });
  DEFAULTS.units.temp = "c";
  assert.strictEqual(cfg.units.temp, "f", "a copy, not the same object");
  const sel = pageFn("managedSelector", {});
  assert.strictEqual(sel("title"), "#cfg-name");
  assert.strictEqual(sel("units.temp"), "#cfg-u-temp");
  assert.strictEqual(sel("fleet.card"), "#cfg-f-card input");
  assert.strictEqual(sel("panels.mem"), '#cfg-panels [data-p="mem"] [data-vis]');
  assert.strictEqual(sel("panelSize.docker"), '#cfg-panels [data-p="docker"] [data-sz]');
  assert.strictEqual(sel("style"), "#cfg-lookdefault");
  assert.strictEqual(sel("nonsense"), null);
  assert.match(HTML, /cfg = saved \? deepMerge\(structuredClone\(DEFAULTS\), saved\) : structuredClone\(DEFAULTS\);\n  applyManaged\(\);/);
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /const byFile = ` disabled title=/);
  assert.match(fn("renderServers"), /\(n\.managed \|\| \[\]\)\.includes\("tags"\) \? byFile/, "file-managed tags cannot be edited");
  assert.match(fn("showSettings"), /markManaged\(\);/);
});

test("conf.d review: a file with a few panels keeps the built-in panel list and sizes (fresh hub)", async () => {
  const src = HTML.slice(HTML.indexOf("async function loadConfig("), HTML.indexOf("\n}\n", HTML.indexOf("async function loadConfig(")) + 2);
  const helpers = ["deepMerge", "fixPanelOrder", "managedPaths", "applyManaged"].map((n) =>
    HTML.slice(HTML.indexOf(`function ${n}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${n}(`)) + 2)).join("\n");
  const fromHub = { panels: { weather: false }, panelSize: { docker: "full" }, _managed: ["panelSize.docker", "panels.weather"] };
  const run = new Function("fetch", "lsGet", `let DEFAULTS = {}, cfg = {}; ${helpers}\n${src}\nreturn loadConfig().then(() => ({ DEFAULTS, cfg }));`);
  const { cfg } = await run(async () => ({ json: async () => structuredClone(fromHub) }), () => null);
  assert.deepStrictEqual(cfg.panelOrder, ["mem", "cpu", "temp", "hist", "storage", "network", "docker", "procs", "system", "hw", "clocks", "weather"]);
  assert.strictEqual(cfg.panels.weather, false);
  assert.strictEqual(cfg.panels.mem, 1, "built-in panels stay");
  assert.deepStrictEqual([cfg.panelSize.storage, cfg.panelSize.docker], ["wide", "full"]);
});

test("conf.d review: the page never sends a managed field, never drags a managed order, and managed panels are the shared set", async () => {
  const sent = [];
  const row = { dataset: { id: "abcdefghijkm", managed: "tags" }, q: { ".srv-name": { value: "nas2" }, ".srv-tags": { value: "storage" } } };
  const saveServer = pageFn("saveServer", {
    $: (sel, root) => root.q[sel], toast: () => {}, loadNodes: async () => {},
    fetch: async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; },
  });
  await saveServer(row);
  assert.deepStrictEqual(sent, [{ name: "nas2" }]);
  const fn = (name) => HTML.slice(HTML.indexOf(`function ${name}(`), HTML.indexOf("\n}\n", HTML.indexOf(`function ${name}(`)));
  assert.match(fn("renderServers"), /data-managed="\$\{esc\(\(n\.managed \|\| \[\]\)\.join\(" "\)\)\}"/);
  assert.match(fn("drawPanelCfg"), /draggable="\$\{orderManaged \? "false" : "true"\}"/);
  assert.match(fn("drawPanelCfg"), /if \(orderManaged\) return;/);
  const disabled = [];
  const markManaged = pageFn("markManaged", { panelFor: "abcdefghijkm", managedPaths: () => ["panels.mem", "title"],
    managedSelector: (p) => p, $$: (sel) => { disabled.push(sel); return []; } });
  markManaged();
  assert.deepStrictEqual(disabled, ["title"], "a server's own panel set is not what files set");
});


test("strict CSP (spec 10.5): no inline script, no event-handler attributes, no style attributes", () => {
  const { MARKUP } = require("./helpers/page");
  for (const tag of MARKUP.match(/<script\b[^>]*>/g)) assert.match(tag, /\ssrc="[^"]+"/, `inline script: ${tag}`);
  assert.doesNotMatch(MARKUP, /<style\b/, "no inline stylesheet");
  assert.doesNotMatch(MARKUP, /\son[a-z]+="/, "no event-handler attributes");
  assert.doesNotMatch(MARKUP, /\sstyle="/, "no style attributes in the markup");
  assert.doesNotMatch(JS, /\sstyle="|\sstyle=\\"/, "none in generated markup either: sizes go through data-w / data-h");
  assert.doesNotMatch(JS + BOOT, /\beval\(|new Function\(|setTimeout\("/, "no string evaluation");
  // the settings panel and the login form load when opened, not with the page
  assert.doesNotMatch(MARKUP, /js\/settings\.js/);
  assert.match(JS, /s\.src = "js\/settings\.js";/);
});

test("review: a settings.js that does not load or run tells the person to reload, and is not appended twice", async () => {
  const appended = [];
  const toasts = [];
  const document = { createElement: () => ({}), head: { appendChild: (s) => appended.push(s) } };
  // settings.js "loaded" but defines nothing: the hub sent its login page instead (session over)
  const openSettings = pageFn("openSettings", { document, toast: (m) => toasts.push(m), showSettings: () => { throw new Error("never"); },
    settingsReady: null });
  const first = openSettings();
  appended[0].onload();
  await first;
  assert.match(toasts[0], /reload the page/);
  await openSettings();
  assert.strictEqual(appended.length, 1, "a half-run settings.js is never appended again (its declarations would clash)");
});

test("review: boot.js runs in <head> before the stylesheet, synchronously; app.js is deferred", () => {
  const { MARKUP } = require("./helpers/page");
  const head = MARKUP.slice(0, MARKUP.indexOf("</head>"));
  const boot = head.indexOf('<script src="boot.js"></script>');
  assert.ok(boot > 0, "boot.js in <head>, with no defer or async");
  assert.ok(boot < head.indexOf('<link rel="stylesheet" href="app.css">'), "before the stylesheet: the look is set before the first paint");
  assert.match(head, /<script src="js\/app\.js" defer><\/script>/);
});

test("history chart: a busy container above 100 % stays on the chart, a lone point shows, a missed heartbeat minute is not a gap", () => {
  const esc = (x) => String(x);
  const historyChart = pageFn("historyChart", { esc, fmtKind: (k, v) => (v == null ? "–" : v + "%"), fmtTimeOrDay: () => "" });
  assert.match(historyChart([[0, 250, 200, 300], [60, 100, 90, 110]], "pct", "1h"), /<span>300%<\/span><span>0%<\/span>/, "scale reaches the highest");
  const lone = historyChart([[0, null, null, null], [60, 50, 50, 50], [120, null, null, null]], "pct", "1h");
  assert.match(lone, /<polyline class="hline" vector-effect="non-scaling-stroke" points="250\.0,100\.0 750\.0,100\.0"\/>/, "a lone point: a short segment");
  const jitter = [[0, 10, 10, 10], [60, 20, 20, 20], [120, null, null, null], [180, 30, 30, 30], [240, 40, 40, 40]];
  const bridged = historyChart(jitter, "pct", "1h", 1);
  assert.strictEqual((bridged.match(/<polyline/g) || []).length, 1, "one missed minute: one line");
  assert.doesNotMatch(bridged, /hgap/);
  assert.strictEqual((historyChart(jitter, "pct", "1h", 0).match(/<polyline/g) || []).length, 2, "no bridge: two runs");
  const outage = [[0, 10, 10, 10], [60, null, null, null], [120, null, null, null], [180, 30, 30, 30]];
  assert.match(historyChart(outage, "pct", "1h", 1), /hgap/, "longer than a heartbeat: a gap");
});

// history.js run with stubbed DOM and fetch: answers arrive when the test says so
function historyHarness(fetchImpl, store = {}) {
  const els = {};
  const el = (sel) => (els[sel] = els[sel] || { innerHTML: "", textContent: "", value: "", classList: { toggle() {} } });
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "js", "history.js"), "utf8");
  const env = { lsGet: (k) => store[k] ?? null, lsSet: (k, v) => { store[k] = v; }, $: el, $$: () => [], fetch: fetchImpl,
    esc: (x) => String(x), tr: (k, v) => k + (v ? ":" + JSON.stringify(v) : ""), STRINGS: {}, fmtShare: (v) => v + "%", fmtTemp: String, fmtRate: String, fmtBytes: String,
    fmtTime: () => "", currentNode: "nodeaaaaaaaa", localNode: "nodeaaaaaaaa", lastData: { interval: 60 } };
  const api = new Function(...Object.keys(env), `${src}; return { loadHistory, histState };`)(...Object.values(env));
  return { ...api, els };
}
const later = () => { let done; const p = new Promise((r) => { done = r; }); return { p, done }; };
const answer = (body) => ({ ok: true, json: async () => body });

test("history: a late answer never draws over a newer one", async () => {
  const pending = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const h = historyHarness((url) => { const l = later(); pending.push({ url, l }); return l.p; }, { "hist.range": "7d" });
  const first = h.loadHistory(true);
  pending[0].l.done(answer({ series: ["cpu"] }));          // the list
  await tick();
  assert.match(pending[1].url, /range=7d/);
  h.histState.range = "24h";                                 // the user picks 24h while 7d is on its way
  const second = h.loadHistory(true);
  await tick();
  pending[2].l.done(answer({ series: ["cpu"] }));          // the second load's list (asked every time)
  await tick();
  const newer = pending.find((x) => /range=24h/.test(x.url));
  newer.l.done(answer({ step: 60, points: [[0, 2, 2, 2]] }));
  await second;
  pending[1].l.done(answer({ step: 600, points: [[0, 9, 9, 9]] }));   // the stale 7d answer, last
  await first;
  assert.match(h.els["#hist-note"].textContent, /"avg":"2%"/);
  assert.doesNotMatch(h.els["#hist-note"].textContent + h.els["#hist-chart"].innerHTML, /9%/, "the stale answer is never drawn");
});

test("history: a series list that failed is asked again; a container past 24 h shows its 24 h", async () => {
  const urls = [];
  let listOk = false;
  const h = historyHarness(async (url) => {
    urls.push(url);
    if (/series=list/.test(url)) return listOk ? answer({ series: ["cpu", "ctr.web.cpu"] }) : { ok: false, json: async () => ({}) };
    return answer({ step: 60, points: [[0, 1, 1, 1]] });
  }, { "hist.range": "7d", "hist.series": "ctr.web.cpu" });
  await h.loadHistory(true);
  assert.strictEqual((h.els["#hist-series"] || { innerHTML: "" }).innerHTML, "", "no list: an empty picker");
  listOk = true;
  await h.loadHistory(false);                               // the next tick: the list again
  assert.match(h.els["#hist-series"].innerHTML, /ctr\.web\.cpu/);
  assert.match(urls.at(-1), /series=ctr\.web\.cpu&range=24h/, "containers keep 24 h");
  assert.match(h.els["#hist-note"].textContent, /hist\.ctr24/);
  const bad = historyHarness(async () => answer({ series: [] }), { "hist.range": "2h" });
  assert.strictEqual(bad.histState.range, "24h", "a stored range it does not know: 24h");
});
