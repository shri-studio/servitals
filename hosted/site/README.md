# servitals.prabzo.com landing page

`index.html` is the public landing page of the hosted service. The hosted
app (sub-project 7) serves it at `/` to visitors who are not logged in. It is
not part of the Ubuntu packages.

The current file is a **preview**: a single self-contained page with sample
data in the dashboard and the linking demo. Open it directly in a browser.

## Before it goes live

1. **Self-host the fonts.** Replace the Google Fonts `<link>` with WOFF2 files
   under `hosted/site/fonts/` (VT323, IBM Plex Sans, JetBrains Mono,
   Press Start 2P; all OFL, license texts alongside). Loading them from
   Google would send every visitor's IP address to Google, which contradicts
   the page's "no trackers" line.
2. **Move CSS and JS into files** (`site.css`, `site.js`). The hosted service
   sends a strict Content-Security-Policy without inline scripts or styles
   (spec section 14.6). Replace the remaining `style="…"` attributes with
   classes.
3. **Wire the real flows.** "Create a free account" goes to signup, "Get
   started" to signup or login, and the preview banner is removed. The
   linking demo stays a demo, labelled as sample data.
4. **Check every command shown on the page** against the released agent and
   packages (`servitals-agent link`, the PPA name, `apt install` lines).
