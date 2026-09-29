// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* The installable app's service worker (spec 10.3): an offline shell. The page and its
   files come from the network first, and from the cache only when the hub cannot be
   reached; data, settings and every API answer always come from the network. The
   cache name carries the version, so an upgrade replaces the old shell. */
const VERSION = "0.1.0";   // keep equal to the VERSION file (test/pwa.test.js checks)
const CACHE = "servitals-" + VERSION;
const SHELL = ["/", "/app.css", "/boot.js", "/js/app.js", "/js/settings.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// "shell": network first, the cache when offline; "network": as if there were no worker
function route(request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return "network";
  const p = url.pathname;
  if (p === "/data.json" || p === "/config.json" || p === "/link" || p.startsWith("/__") || p.startsWith("/api/")) return "network";
  return "shell";
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("servitals-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// keep an answer only if it is the file asked for: never one marked no-store (the login
// page) and never HTML for a script, a style or a font
function keep(request, res) {
  if (!res.ok || res.type !== "basic") return false;
  if (/no-store/.test(res.headers.get("cache-control") || "")) return false;
  return request.mode === "navigate" || !/text\/html/.test(res.headers.get("content-type") || "");
}

// the last copy: a page load falls back to the page; a file never cached stays missing
function lastCopy(request) {
  return caches.match(request).then((hit) => hit || (request.mode === "navigate" ? caches.match("/") : undefined));
}

self.addEventListener("fetch", (e) => {
  if (route(e.request) !== "shell") return;
  e.respondWith(fetch(e.request).then((res) => {
    // a proxy in front of the hub answers 502/503/504 when the hub is down: as good as offline
    if (res.status >= 500) return lastCopy(e.request).then((hit) => hit || res);
    if (keep(e.request, res)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }, () => lastCopy(e.request).then((hit) => hit || Response.error())));
});
