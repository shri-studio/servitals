// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * CSRF defence for state-changing browser requests: the Origin header's host
 * must be one of ours (Host, X-Forwarded-Host from a trusted proxy, or
 * PUBLIC_URL). Also answers "did the browser use HTTPS?" for Secure cookies.
 */
function lastHeaderValue(v) {
  if (!v) return "";
  const parts = String(v).split(",");
  return parts[parts.length - 1].trim().toLowerCase();
}

function expectedHosts(req, { publicUrl, peerTrusted }) {
  const hosts = new Set();
  if (req.headers.host) hosts.add(String(req.headers.host).toLowerCase());
  if (peerTrusted && req.headers["x-forwarded-host"]) hosts.add(lastHeaderValue(req.headers["x-forwarded-host"]));
  if (publicUrl) {
    try { hosts.add(new URL(publicUrl).host.toLowerCase()); } catch (_) { /* ignore bad PUBLIC_URL */ }
  }
  return hosts;
}

function originAllowed(req, opts = {}) {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return false;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch (_) { return false; }
  return host !== "" && expectedHosts(req, opts).has(host);
}

function requestIsHttps(req, { publicUrl, peerTrusted } = {}) {
  if (req.socket && req.socket.encrypted) return true;
  if (publicUrl && /^https:/i.test(publicUrl)) return true;
  return !!peerTrusted && lastHeaderValue(req.headers["x-forwarded-proto"]) === "https";
}

module.exports = { originAllowed, requestIsHttps };
