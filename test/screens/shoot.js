// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Screenshots of every style in dark and light, for the fleet and the node
 * view, plus kiosk and settings; contact sheets of them all. Exits 1 on any
 * page error or console error. Runs inside the Playwright image:
 *   node shoot.js <base-url> <out-dir>
 */
const { chromium } = require("playwright");
const fs = require("fs");

const errors = [];
const STYLES = ["classic", "8bit", "phosphor", "eink", "contrast", "nord", "gruvbox", "dracula", "catppuccin", "solarized"];

(async () => {
  const [base, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto(base + "/");
  await page.fill("input[name=username]", "demo");
  await page.fill("input[name=password]", "demo-pass-1");
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  await page.waitForTimeout(1500);
  const local = await page.evaluate(() => localNode);
  const shots = { fleet: [], node: [] };
  for (const style of STYLES) for (const mode of ["dark", "light"]) {
    await page.evaluate(([s, m]) => { localStorage.setItem("servitals.style", s); localStorage.setItem("servitals.theme", m); }, [style, mode]);
    for (const view of ["fleet", "node"]) {
      await page.goto(`${base}/?shot=${style}-${mode}-${view}${view === "node" ? "#node=" + local : "#fleet"}`);
      await page.waitForTimeout(1500);
      const f = `${out}/${view}-${style}-${mode}.png`;
      await page.screenshot({ path: f });
      shots[view].push([`${style} · ${mode}`, fs.readFileSync(f).toString("base64")]);
    }
  }
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/?kiosk#fleet`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/kiosk.png` });
  await page.evaluate(() => localStorage.clear());   // ?kiosk is remembered

  // a customized fleet: grouped by tag, °F, bits, other card numbers (spec 10.4)
  await page.evaluate(() => localStorage.setItem("servitals.cfg", JSON.stringify({
    units: { temp: "f", rate: "bits", size: "decimal", clock: "12h" },
    fleet: { group: true, sort: "disk", card: ["disk", "iowait", "temp"] } })));
  await page.goto(`${base}/?shot=custom#fleet`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/fleet-custom.png` });
  await page.goto(`${base}/?shot=custom-node#node=${local}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/node-custom.png` });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/#fleet`);
  await page.waitForTimeout(1200);
  await page.keyboard.press("s");
  await page.locator("#cfg-style").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/settings.png` });

  // the settings panel on a desktop and a phone: styled controls, none squeezed or sticking out
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 2600 });
    await page.goto(`${base}/?shot=settings-${width}#fleet`);
    await page.waitForTimeout(1200);
    await page.keyboard.press("s");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/settings-${width}.png` });
    const bad = await page.evaluate(() => {
      const out = [], modal = document.querySelector("#overlay .modal").getBoundingClientRect();
      const font = getComputedStyle(document.body).fontFamily;
      for (const el of document.querySelectorAll("#overlay .modal button, #overlay .modal input, #overlay .modal select")) {
        if (!el.offsetParent || el.type === "file") continue;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el), id = el.id || el.textContent.trim() || el.type;
        if (el.type !== "checkbox" && cs.fontFamily !== font) out.push(`${id}: browser default look`);
        if (el.type === "checkbox" && cs.accentColor === "auto") out.push(`${id}: browser default checkbox`);
        if (r.right > modal.right - 8 || r.left < modal.left + 8) out.push(`${id}: sticks out of the panel`);
        if (r.height > 40) out.push(`${id}: ${Math.round(r.height)}px tall`);
        const short = el.maxLength > 0 && el.maxLength <= 8;   // the emoji field
        const min = !short && (el.tagName === "SELECT" || ["text", "password"].includes(el.type)) ? 120 : 0;
        if (r.width < min && !el.closest(".pcf")) out.push(`${id}: only ${Math.round(r.width)}px wide`);
      }
      for (const el of document.querySelectorAll("#overlay .modal .check")) {
        if (getComputedStyle(el).textTransform !== "none") out.push(`"${el.textContent.trim().slice(0, 20)}": shouted like a heading`);
      }
      for (const row of document.querySelectorAll("#overlay .modal .fields")) {   // inputs side by side line up
        const tops = new Map();
        for (const f of row.querySelectorAll("input, select")) {
          const row = Math.round(f.closest(".field").getBoundingClientRect().top), t = tops.get(row);
          const bottom = f.getBoundingClientRect().bottom;
          if (t !== undefined && Math.abs(t - bottom) > 1) out.push(`${f.id}: not lined up with its neighbour`);
          tops.set(row, bottom);
        }
      }
      return out;
    });
    if (bad.length) errors.push(`settings-${width}: ${bad.join("; ")}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // a phone and a desktop in every density and in kiosk: nothing cut off
  for (const width of [390, 600, 768, 1024, 1280, 1920]) for (const [density, q] of [["compact", ""], ["comfortable", ""], ["large", ""], ["comfortable", "?kiosk"]]) {
    for (const hash of ["#fleet", "#node=" + local]) {
      await page.evaluate((d) => { localStorage.clear(); localStorage.setItem("servitals.density", d); }, density);
      await page.setViewportSize({ width, height: 844 });
      const name = `${width}-${q ? "kiosk" : density}-${hash === "#fleet" ? "fleet" : "node"}`;
      await page.goto(`${base}/?shot=${name}${q ? "&kiosk" : ""}${hash}`);   // a new query: a real reload
      await page.waitForTimeout(1200);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      // content cut off or overlapping inside a panel
      const clipped = await page.evaluate(() => [...document.querySelectorAll(".panel:not(.hidden), .ncard, .head, .nettab td, .nettab th")]
        .filter((p) => p.offsetParent && p.scrollWidth > p.clientWidth + 1)
        .map((p) => (p.dataset.panel || `${p.tagName.toLowerCase()}.${p.className} "${p.textContent.trim().slice(0, 16)}"`)
          + " +" + (p.scrollWidth - p.clientWidth) + "px"));
      if (clipped.length) errors.push(`${name}: wider than its box: ${clipped.join(", ")}`);
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
      if (wide > 0) errors.push(`${name}: ${wide}px wider than the screen`);
    }
  }
  await page.evaluate(() => localStorage.clear());

  // the installable app: the worker takes over, and the page opens from its copy with the network off
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/?shot=sw#fleet`);
  const active = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active));
  if (!active) errors.push("the service worker did not activate");
  const seen = errors.length;
  await ctx.setOffline(true);
  await page.goto(`${base}/?shot=offline#fleet`).catch((e) => errors.push(`offline: ${e.message}`));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/offline.png` });
  const shell = await page.evaluate(() => !!document.querySelector("#fleet") && document.title.length > 0);
  const says = await page.evaluate(() => document.querySelector("#hostmeta").textContent);
  errors.splice(seen);   // offline, the data requests fail by design
  if (!shell) errors.push("offline: the page did not open from the worker's copy");
  if (!/unreachable/.test(says)) errors.push(`offline: the page does not say the hub is unreachable (${says})`);
  await ctx.setOffline(false);

  const sheet = await ctx.newPage();
  await sheet.setViewportSize({ width: 1600, height: 1000 });
  for (const view of Object.keys(shots)) for (let i = 0; i < shots[view].length; i += 10) {
    await sheet.setContent(`<body style="margin:0;background:#888;font:14px sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px">`
      + shots[view].slice(i, i + 10).map(([t, b]) => `<figure style="margin:0"><img style="width:100%" src="data:image/png;base64,${b}">`
        + `<figcaption style="background:#fff">${t}</figcaption></figure>`).join("") + "</body>");
    await sheet.screenshot({ path: `${out}/sheet-${view}-${i / 10 + 1}.png`, fullPage: true });
  }
  await browser.close();
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`screenshots in ${out}: no page errors`);
})().catch((e) => {
  // a page error usually makes a later step time out: show it first
  console.error([...errors, String(e)].join("\n"));
  process.exit(1);
});
