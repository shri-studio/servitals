// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* the history panel (spec 7, 10.1): a series, a range, and the chart of its average with
   its low-high band, gaps shaded. Loaded by showHistory() in app.js when a node view
   first shows the panel; the data comes from GET /__ctl/history. */
const HIST_ORDER = ["cpu", "mem", "temp", "load1", "iowait", "psi.cpu", "psi.mem", "psi.io", "swap", "net.rx", "net.tx"];
const histState = { node: null, series: lsGet("hist.series") || "cpu", range: lsGet("hist.range") || "24h", at: 0 };

// how a series' numbers read
function kindOf(name) {
  if (/^(cpu|mem|swap|iowait)$|^psi\.|^disk\..*\.used$|^ctr\..*\.cpu$/.test(name)) return "pct";
  if (name === "temp") return "temp";
  if (/^net\./.test(name)) return "net";
  if (/^io\./.test(name)) return "io";
  if (/^ctr\..*\.mem$/.test(name)) return "bytes";
  return "num";
}
function fmtKind(kind, v) {
  if (v == null) return "–";
  if (kind === "pct") return fmtShare(v);
  if (kind === "temp") return fmtTemp(v, true);
  if (kind === "net") return fmtRate(v);
  if (kind === "io") return fmtRate(v, true);
  if (kind === "bytes") return fmtBytes(v);
  return String(Math.round(v * 100) / 100);
}
// a series' name in words: the base ones from the dictionary, disks, devices and containers by name
function seriesLabel(name) {
  let m;
  if (STRINGS["hist.s." + name]) return tr("hist.s." + name);
  if ((m = /^disk\.(.*)\.used$/.exec(name))) return tr("hist.disk", { mount: m[1] });
  if ((m = /^io\.(.*)\.(read|write)$/.exec(name))) return tr("hist.io." + m[2], { device: m[1] });
  if ((m = /^ctr\.(.*)\.(cpu|mem)$/.exec(name))) return tr("hist.ctr." + m[2], { name: m[1] });
  return name;
}
// a point's time: the clock for a day or less, the date beyond
function fmtTimeOrDay(t, range) {
  const d = new Date(t * 1000);
  return range === "1h" || range === "24h" ? fmtTime(d) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// the chart: per run of points with data, the low-high band and the average line; a run
// without data is shaded. Drawn in a 1000 x 200 box that stretches; the words are HTML.
function historyChart(points, kind, range) {
  const data = points.filter(p => p[1] != null);
  if (!data.length) return `<div class="muted">${esc(tr("hist.empty"))}</div>`;
  const W = 1000, H = 200, n = points.length, step = n > 1 ? W / (n - 1) : W;
  let lo = kind === "pct" ? 0 : Math.min(0, ...data.map(p => p[2]));
  let hi = kind === "pct" ? 100 : Math.max(...data.map(p => p[3]));
  if (kind === "temp") { lo = Math.min(...data.map(p => p[2])) - 2; hi += 2; }
  if (!(hi > lo)) hi = lo + 1;
  const x = i => (n > 1 ? i * step : W / 2).toFixed(1);
  const y = v => (H - ((v - lo) / (hi - lo)) * H).toFixed(1);
  let gaps = "", bands = "", lines = "";
  for (let i = 0; i < n;) {
    const has = points[i][1] != null;
    let j = i;
    while (j < n && (points[j][1] != null) === has) j++;
    if (has) {
      const run = points.slice(i, j).map((p, k) => [i + k, p]);
      bands += `<polygon class="hband" points="${run.map(([k, p]) => x(k) + "," + y(p[3])).join(" ")} `
        + `${run.slice().reverse().map(([k, p]) => x(k) + "," + y(p[2])).join(" ")}"/>`;
      lines += `<polyline class="hline" vector-effect="non-scaling-stroke" points="${run.map(([k, p]) => x(k) + "," + y(p[1])).join(" ")}"/>`;
    } else {
      const x0 = Math.max(0, i * step - step / 2), x1 = Math.min(W, (j - 1) * step + step / 2);
      gaps += `<rect class="hgap" x="${x0.toFixed(1)}" y="0" width="${(x1 - x0).toFixed(1)}" height="${H}"/>`;
    }
    i = j;
  }
  return `<div class="hplot"><div class="hy"><span>${esc(fmtKind(kind, hi))}</span><span>${esc(fmtKind(kind, lo))}</span></div>`
    + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${gaps}${bands}${lines}</svg></div>`
    + `<div class="hx"><span>${esc(fmtTimeOrDay(points[0][0], range))}</span><span>${esc(fmtTimeOrDay(points[n - 1][0], range))}</span></div>`;
}

// wiring, once, when this file has loaded
function initHistory() {
  $("#hist-series").onchange = e => { histState.series = e.target.value; lsSet("hist.series", histState.series); loadHistory(true); };
  $$(".hrange").forEach(b => b.onclick = () => { histState.range = b.dataset.r; lsSet("hist.range", histState.range); loadHistory(true); });
}

// fetch and draw: on a new node, a new series or range, else at most once a minute
async function loadHistory(force) {
  const node = currentNode || localNode;
  if (!node) return;
  const fresh = node !== histState.node;
  if (!force && !fresh && Date.now() - histState.at < 60000) return;
  histState.at = Date.now();
  const q = s => fetch(`/__ctl/history?node=${encodeURIComponent(node)}&${s}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (fresh) {
    histState.node = node;
    const list = await q("series=list");
    const names = (list && Array.isArray(list.series) ? list.series : []).filter(s => typeof s === "string");
    names.sort((a, b) => ((HIST_ORDER.indexOf(a) + 1 || 99) - (HIST_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
    if (!names.includes(histState.series)) histState.series = names.includes("cpu") ? "cpu" : (names[0] || "cpu");
    $("#hist-series").innerHTML = names.map(s => `<option value="${esc(s)}">${esc(seriesLabel(s))}</option>`).join("");
    $("#hist-series").value = histState.series;
  }
  $$(".hrange").forEach(b => b.classList.toggle("on", b.dataset.r === histState.range));
  const d = await q(`series=${encodeURIComponent(histState.series)}&range=${histState.range}`);
  const kind = kindOf(histState.series);
  $("#hist-chart").innerHTML = historyChart(d && Array.isArray(d.points) ? d.points : [[0, null, null, null]], kind, histState.range);
  const vals = d && Array.isArray(d.points) ? d.points.filter(p => p[1] != null) : [];
  $("#hist-note").textContent = vals.length ? tr("hist.summary", {
    avg: fmtKind(kind, vals.reduce((a, p) => a + p[1], 0) / vals.length),
    lo: fmtKind(kind, Math.min(...vals.map(p => p[2]))), hi: fmtKind(kind, Math.max(...vals.map(p => p[3]))),
  }) : "";
}
