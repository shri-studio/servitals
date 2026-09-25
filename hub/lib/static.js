// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * Static files from WWW_DIR for native installs (the Docker install keeps
 * nginx through UPSTREAM). GET and HEAD only, no directory listing, dotfiles
 * refused, every path kept inside the root after symlinks are resolved.
 * Validators like nginx's defaults: Last-Modified and an mtime-size ETag.
 */
const fs = require("fs");
const path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function createStatic(root) {
  const base = fs.realpathSync(root);   // throws when the directory is missing
  return function serveStatic(req, res) {
    const send = (code, text, extra = {}) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...extra });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, "method not allowed", { allow: "GET, HEAD" });
    }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); }
    catch { return send(400, "bad path"); }
    if (rel.includes("\0")) return send(400, "bad path");
    // "." and ".." are dotfile segments too, so this also stops traversal
    if (rel.split("/").some((seg) => seg.startsWith("."))) return send(404, "not found");
    if (rel.endsWith("/")) rel += "index.html";
    let real, st;
    try {
      real = fs.realpathSync(path.join(base, rel));
      st = fs.statSync(real);
    } catch { return send(404, "not found"); }
    if (real !== base && !real.startsWith(base + path.sep)) return send(404, "not found");
    if (!st.isFile()) return send(404, "not found");   // directories: no listing
    const mtime = Math.floor(st.mtimeMs / 1000);
    const etag = `"${mtime.toString(16)}-${st.size.toString(16)}"`;
    const inm = req.headers["if-none-match"];
    const ims = Date.parse(req.headers["if-modified-since"] || "");
    if (inm ? inm === etag : (Number.isFinite(ims) && mtime * 1000 <= ims)) {
      res.writeHead(304, { etag, "last-modified": st.mtime.toUTCString() });
      return res.end();
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(real).toLowerCase()] || "application/octet-stream",
      "content-length": st.size,
      "last-modified": st.mtime.toUTCString(),
      etag,
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(real).on("error", () => res.destroy()).pipe(res);
  };
}

module.exports = { createStatic, TYPES };
