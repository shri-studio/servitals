// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Fleet view helpers (spec 6.2, 10.1).
 *   status(lastPushMs, intervalS, now) → "waiting" | "online" | "stale" | "offline"
 *     online while pushes arrive; stale after 3 × interval without one;
 *     offline after max(10 min, 5 × interval).
 *   summary(view) → the numbers a fleet card shows.
 */
function status(at, interval, now = Date.now()) {
  if (!at) return "waiting";
  const iv = Math.max(5, interval || 60) * 1000;
  const age = now - at;
  if (age <= 3 * iv) return "online";
  if (age <= Math.max(600000, 5 * iv)) return "stale";
  return "offline";
}

function summary(v) {
  if (!v) return null;
  const mem = v.mem && v.mem.total > 0 ? Math.round((v.mem.used * 100) / v.mem.total) : null;
  const disks = (v.disks || []).filter((d) => d.mounted !== false && typeof d.pct === "number");
  const fullest = disks.reduce((a, d) => (!a || d.pct > a.pct ? d : a), null);
  const docker = Array.isArray(v.docker) ? v.docker : null;
  return {
    host: v.host ? { name: v.host.name, distro: v.host.distro } : null,
    cpu: v.cpu && typeof v.cpu.usage === "number" ? v.cpu.usage : null,
    iowait: v.cpu && typeof v.cpu.iowait === "number" ? v.cpu.iowait : null,
    updates: v.ubuntu && typeof v.ubuntu.updates === "number" ? v.ubuntu.updates : null,
    reboot: !!(v.ubuntu && v.ubuntu.rebootRequired),
    battery: v.battery && typeof v.battery.capacity === "number" ? v.battery.capacity : null,
    mem,
    temp: v.temp && typeof v.temp.package === "number" ? v.temp.package : null,
    disk: fullest ? { mount: fullest.mount, pct: fullest.pct } : null,
    containers: docker ? docker.length : null,
    running: docker ? docker.filter((c) => c.state === "running").length : null,
    trend: (v.trend || []).slice(-20).map((p) => p.cpu),
  };
}

module.exports = { status, summary };
