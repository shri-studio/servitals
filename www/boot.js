// SPDX-License-Identifier: AGPL-3.0-or-later
/* style, mode, density and kiosk before the first paint, so the page never
   flashes the default look (the hub's defaults apply once config.json loads) */
(function () {
  var d = document.documentElement, get = function (k) {
    try { return localStorage.getItem("servitals." + k); } catch (e) { return null; }
  };
  // this browser's choice, else the hub's default remembered from the last visit
  var style = get("style") || get("hub.style"), mode = get("theme") || get("hub.mode"),
      density = get("density") || get("hub.density");
  if (mode === "light" || mode === "dark") d.setAttribute("data-theme", mode);
  if (density === "compact" || density === "large") d.setAttribute("data-density", density);
  // ?kiosk and ?kiosk=0 are remembered, so kiosk survives a new login
  var q = /[?&]kiosk(?:=([^&]*))?(?:&|$)/.exec(location.search), kiosk = get("kiosk");
  if (q) {
    kiosk = q[1] === "0" ? "0" : "1";
    try { localStorage.setItem("servitals.kiosk", kiosk); } catch (e) { /* private mode */ }
  }
  if (kiosk === "1" || (kiosk !== "0" && get("hub.kiosk") === "1")) d.setAttribute("data-kiosk", "");
  if (style && style !== "classic" && /^[a-z0-9-]{1,32}$/.test(style)) {
    d.setAttribute("data-style", style);
    document.write('<link rel="stylesheet" id="style-css" href="styles/' + style + '.css">');
  }
})();
