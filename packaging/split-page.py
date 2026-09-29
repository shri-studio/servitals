#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# One-off move for sub-project 4f-1 (spec 10.5): the page's inline CSS and
# scripts become files, so the hub can send a strict Content-Security-Policy.
#   www/index.html  markup only, <link> app.css, <script src> boot.js and js/app.js
#   www/app.css     the former <style> block
#   www/boot.js     the former early <head> script (style, mode, density, kiosk)
#   www/js/app.js   everything the dashboard needs at once
#   www/js/settings.js  the settings panel and the login form, loaded when opened
# Nothing is rewritten except the seams listed below; run it once from the repo root.
import re
import sys

PAGE = "www/index.html"
html = open(PAGE).read()


def cut(text, start, end):
    """text between two unique markers (exclusive), and the text with that span removed"""
    assert text.count(start) == 1, start
    i = text.index(start) + len(start)
    j = text.index(end, i)
    return text[i:j], text[:i - len(start)] + text[j + len(end):]


def dedent(block, n=2):
    return "\n".join(l[n:] if l.startswith(" " * n) else l for l in block.strip("\n").split("\n")) + "\n"


# 1. the early head script and the style block (the first <script> and the <style> in <head>)
a = html.index("<script>\n")
b = html.index("</script>\n<style>\n", a)
c = html.index("</style>\n", b)
early = html[a + len("<script>\n"):b]
css = html[b + len("</script>\n<style>\n"):c]
html = (html[:a] + '<script src="boot.js"></script>\n<link rel="stylesheet" href="app.css">\n'
        + '<script src="js/app.js" defer></script>\n' + html[c + len("</style>\n"):])

# 2. the app script
app, html = cut(html, '<script>\n"use strict";\n', "</script>\n")
SECTION = "/* ------------------------------------------------------------------ "
sections = re.split(r"(?m)^(?=/\* -{66} )", app)
lazy_names = ("settings UI", "login")
eager, lazy = [], []
for s in sections:
    name = s[len(SECTION):].split("\n")[0].strip(" */") if s.startswith(SECTION) else ""
    (lazy if name.startswith(lazy_names) else eager).append(s)
core = "".join(eager)
settings = "".join(lazy)

# 3. seams between the two files
def move(text, block):
    assert text.count(block) == 1, block[:60]
    return text.replace(block, "")

# shared state and the always-there helpers live in app.js
for decl in ('let whoUser = "";\n', 'let panelFor = "all";   // "all" or a node id\n'):
    settings = move(settings, decl)
close_fn = re.search(r"// an import not saved is undone when settings close\nlet beforeImport = null;\nfunction closeSettings\(\) \{\n.*?\n\}\n", settings, re.S).group(0)
settings = move(settings, close_fn)
settings = settings.replace("function openSettings() {", "function showSettings() {", 1)

# the boot code's settings wiring runs once, when settings.js has loaded
wiring_a, core = cut(core, '  $("#acct-save").onclick = saveAccount;\n',
                     '  $("#btn-theme").onclick = toggleTheme;\n')
core = core.replace('  $("#settings-close").onclick = closeSettings;\n',
                    '  $("#settings-close").onclick = closeSettings;\n  $("#btn-theme").onclick = toggleTheme;\n', 1)
wiring_b, core = cut(core, '  $("#wx-add").onclick = wxSearch;\n', '\n  document.addEventListener("keydown", e => {\n')
core = core.replace('  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });\n',
                    '  $$(".nvtoggle").forEach(s => s.onclick = () => { netView = s.dataset.v; renderNetBars(); });\n\n'
                    '  document.addEventListener("keydown", e => {\n', 1)
wiring = ('  $("#acct-save").onclick = saveAccount;\n' + wiring_a
          + '  $("#wx-add").onclick = wxSearch;\n' + wiring_b.rstrip("\n") + "\n")

loader = '''/* ------------------------------------------------------------------ settings, loaded on first use (spec 10.5) */
let whoUser = "";
let panelFor = "all";   // "all" or a node id
''' + close_fn + '''let settingsReady = null;
function openSettings() {
  settingsReady = settingsReady || new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "js/settings.js";
    s.onload = () => { initSettings(); ok(); };
    s.onerror = () => { settingsReady = null; fail(new Error("settings.js")); };
    document.head.appendChild(s);
  });
  return settingsReady.then(() => showSettings(), () => toast("could not load the settings; reload the page", true));
}

'''
boot_at = core.index(SECTION + "boot */")
core = core[:boot_at] + loader + core[boot_at:]

open("www/boot.js", "w").write("// SPDX-License-Identifier: AGPL-3.0-or-later\n" + dedent(early))
open("www/app.css", "w").write("/* SPDX-License-Identifier: AGPL-3.0-or-later */\n" + dedent(css))
open("www/js/app.js", "w").write('// SPDX-License-Identifier: AGPL-3.0-or-later\n"use strict";\n' + core.strip("\n") + "\n")
open("www/js/settings.js", "w").write(
    '// SPDX-License-Identifier: AGPL-3.0-or-later\n"use strict";\n'
    "/* the settings panel and the login form: loaded by openSettings() in app.js */\n"
    + settings.strip("\n") + "\n\n"
    "// wiring for the settings controls, once, when this file has loaded\n"
    "function initSettings() {\n" + wiring + "}\n")
open(PAGE, "w").write(html)
print("split: www/index.html, www/app.css, www/boot.js, www/js/app.js, www/js/settings.js")
