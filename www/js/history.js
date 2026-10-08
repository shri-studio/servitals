// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/* the history panel (spec 7, 10.1): a series, a range, and the chart of its average with
   its low-high band, gaps shaded. Loaded by showHistory() in app.js when a node view
   first shows the panel; the data comes from GET /__ctl/history. */
const HIST_ORDER = ["cpu", "mem", "temp", "load1", "iowait", "psi.cpu", "psi.mem", "psi.io", "swap", "net.rx", "net.tx"];
const HIST_RANGES = ["1h", "24h", "7d", "30d", "90d"];
const storedRange = lsGet("hist.range");
// seq: each load's number; an answer for an older one is dropped (never drawn over a newer one)
const histState = { node: null, series: lsGet("hist.series") || "cpu",
                    range: HIST_RANGES.includes(storedRange) ? storedRange : "24h", at: 0, seq: 0 };

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
// without data is shaded. A run of missing points no longer than bridge (a heartbeat that
// fell just past a minute) is drawn through, not shaded as offline. Drawn in a 1000 x 200
// box that stretches; the words are HTML.
function historyChart(points, kind, range, bridge = 0) {
  const data = points.filter(p => p[1] != null);
  if (!data.length) return `<div class="muted">${esc(tr("hist.empty"))}</div>`;
  const W = 1000, H = 200, n = points.length, step = n > 1 ? W / (n - 1) : W;
  // a share runs 0 to 100, or higher for a container using several cores
  let lo = kind === "pct" ? 0 : Math.min(0, ...data.map(p => p[2]));
  let hi = Math.max(kind === "pct" ? 100 : -Infinity, ...data.map(p => p[3]));
  if (kind === "temp") { lo = Math.min(...data.map(p => p[2])) - 2; hi += 2; }
  if (!(hi > lo)) hi = lo + 1;
  const x = i => (n > 1 ? i * step : W / 2).toFixed(1);
  const y = v => (H - ((v - lo) / (hi - lo)) * H).toFixed(1);
  const has = i => points[i][1] != null;
  // a short run of missing points between two with data counts as data (drawn through)
  const filled = points.map((p, i) => has(i));
  for (let i = 0; i < n;) {
    if (filled[i]) { i++; continue; }
    let j = i;
    while (j < n && !filled[j]) j++;
    if (i > 0 && j < n && j - i <= bridge) for (let k = i; k < j; k++) filled[k] = true;
    i = j;
  }
  let gaps = "", bands = "", lines = "";
  for (let i = 0; i < n;) {
    const on = filled[i];
    let j = i;
    while (j < n && filled[j] === on) j++;
    if (on) {
      let run = [];
      for (let k = i; k < j; k++) if (has(k)) run.push([x(k), points[k]]);
      // a lone point: a short segment across its own slot, so it shows
      if (run.length === 1) {
        const c = +run[0][0];
        run = [[Math.max(0, c - step / 2).toFixed(1), run[0][1]], [Math.min(W, c + step / 2).toFixed(1), run[0][1]]];
      }
      bands += `<polygon class="hband" points="${run.map(([px, p]) => px + "," + y(p[3])).join(" ")} `
        + `${run.slice().reverse().map(([px, p]) => px + "," + y(p[2])).join(" ")}"/>`;
      lines += `<polyline class="hline" vector-effect="non-scaling-stroke" points="${run.map(([px, p]) => px + "," + y(p[1])).join(" ")}"/>`;
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

// fetch and draw: on a new node, a new series or range, else at most once a minute. Each load
// takes a number; after every wait, a load that is no longer the newest stops (a late answer
// never draws over a newer one). The series list is asked every time, so a failed one is
// asked again and new disks or containers appear.
async function loadHistory(force) {
  const node = currentNode || localNode;
  if (!node) return;
  const fresh = node !== histState.node;
  if (!force && !fresh && Date.now() - histState.at < 60000) return;
  histState.at = Date.now();
  const seq = ++histState.seq;
  const stale = () => seq !== histState.seq || node !== (currentNode || localNode);
  const q = s => fetch(`/__ctl/history?node=${encodeURIComponent(node)}&${s}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (fresh) { $("#hist-chart").innerHTML = ""; $("#hist-note").textContent = ""; }
  const list = await q("series=list");
  if (stale()) return;
  if (list && Array.isArray(list.series)) {
    histState.node = node;
    const names = list.series.filter(s => typeof s === "string");
    names.sort((a, b) => ((HIST_ORDER.indexOf(a) + 1 || 99) - (HIST_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
    if (!names.includes(histState.series)) histState.series = names.includes("cpu") ? "cpu" : (names[0] || "cpu");
    $("#hist-series").innerHTML = names.map(s => `<option value="${esc(s)}">${esc(seriesLabel(s))}</option>`).join("");
    $("#hist-series").value = histState.series;
  }
  $$(".hrange").forEach(b => b.classList.toggle("on", b.dataset.r === histState.range));
  // containers keep 24 h (spec 7): a longer range shows those
  const short = /^ctr\./.test(histState.series) && !["1h", "24h"].includes(histState.range);
  const d = await q(`series=${encodeURIComponent(histState.series)}&range=${short ? "24h" : histState.range}`);
  if (stale()) return;
  const kind = kindOf(histState.series), range = short ? "24h" : histState.range;
  // a heartbeat a little over a minute misses a minute now and then: not a gap (1-minute points only)
  const bridge = range === "1h" || range === "24h" ? Math.max(1, Math.ceil(((lastData && lastData.interval) || 60) / 60)) : 0;
  $("#hist-chart").innerHTML = historyChart(d && Array.isArray(d.points) ? d.points : [[0, null, null, null]], kind, range, bridge);
  const vals = d && Array.isArray(d.points) ? d.points.filter(p => p[1] != null) : [];
  $("#hist-note").textContent = (vals.length ? tr("hist.summary", {
    avg: fmtKind(kind, vals.reduce((a, p) => a + p[1], 0) / vals.length),
    lo: fmtKind(kind, Math.min(...vals.map(p => p[2]))), hi: fmtKind(kind, Math.max(...vals.map(p => p[3]))),
  }) : "") + (short ? (vals.length ? " · " : "") + tr("hist.ctr24") : "");
}
