// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
/*
 * A throwaway hub with three demo servers, for screenshots:
 *   node test/screens/demo-hub.js <port>
 * The local node's snapshot is this machine's (servitals-agent test); "nas"
 * and "pi-garage" are variations of it. Prints READY when all three pushed
 * three times (so rates and sparklines exist). Login: demo / demo-pass-1.
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..", "..");
const PORT = Number(process.argv[2] || 20090);
const { signRequest } = require(path.join(REPO, "hub/lib/agentsig"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "sv-demo-"));
// config as code: one setting and one node's tags come from a file (shown as managed)
fs.mkdirSync(path.join(state, "conf.d"));
fs.writeFileSync(path.join(state, "conf.d", "10-demo.json"),
  JSON.stringify({ settings: { refreshSec: 60 }, nodes: { nas: { tags: ["home", "storage"] } } }));
const hub = spawn(process.execPath, [path.join(REPO, "hub/server.js")], {
  env: { PATH: process.env.PATH, PORT: String(PORT), STATE_DIR: state, UPSTREAM: "", AUTH_USER: "demo",
         AUTH_PASS: "demo-pass-1", LOG_LEVEL: "error", CONFD_DIR: path.join(state, "conf.d") },
  stdio: "inherit",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function push(c, body) {
  const ts = String(Date.now());
  const buf = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/v1/agent/push", headers: {
      "content-type": "application/json", "content-length": buf.length, "x-servitals-proto": "1", "x-servitals-node": c.id,
      "x-servitals-ts": ts, "x-servitals-sig": signRequest(c.secret, "POST", "/api/v1/agent/push", ts, buf) } },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject);
    r.end(buf);
  });
}

function variant(base, c, i, round) {
  const s = JSON.parse(JSON.stringify(base));
  s.ts = Date.now();
  if (c.name) {
    s.host.name = c.name;
    s.cpu.usage = [0, 4, 23][i] + round;
    // the nas waits on its disks: low cpu, high iowait and io pressure
    Object.assign(s.cpu, { iowait: [0, 34, 1][i], steal: 0 });
    s.pressure = { cpu: { some: [0, 0.4, 2.1][i], full: 0 }, mem: { some: 0, full: 0 },
                   io: { some: [0, 41.2, 0.3][i], full: [0, 37.5, 0.1][i] } };
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
    s.disks = [{ mount: "/", mounted: true, source: "/dev/sda1", fstype: "ext4", size: 500e9, device: "sda1",
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.io = [{ device: "sda1", readBytes: 0, writeBytes: 0 }];
    // the nas: what keeps its disk busy; the pi runs an older agent without processes
    const proc = (pid, name, cpuPct, mb) => ({ pid, name, cpuPct, rss: mb * 1048576 });
    s.processes = i === 1 ? {
      cpu: [proc(812, "rsync", 38.5, 52), proc(1290, "smbd", 12.1, 96), proc(640, "jellyfin", 6.4, 1410),
            proc(77, "kworker/u8:2-events_unbound", 2.2, 0), proc(1, "systemd", 0.3, 14)],
      mem: [proc(640, "jellyfin", 6.4, 1410), proc(911, "postgres", 0.1, 820), proc(1290, "smbd", 12.1, 96),
            proc(812, "rsync", 38.5, 52), proc(1, "systemd", 0.3, 14)],
    } : undefined;
    // the nas waits for a reboot and has a failed unit; the pi's older agent sends neither
    s.ubuntu = i === 1 ? { updates: 12, security: 5, rebootRequired: true, rebootPkgs: ["linux-image-7.0.0-38-generic"],
                           failedUnits: ["smartd.service"] } : undefined;
    // the nas: its board's fans (the pump has stopped) and voltages; the pi runs on a battery
    s.fans = i === 1 ? [{ label: "CPU fan", rpm: 1180 }, { label: "Case fan 1", rpm: 820 }, { label: "Pump", rpm: 0 }] : undefined;
    s.voltages = i === 1 ? [{ label: "Vcore", value: 1.216 }, { label: "+12V", value: 12.096 }, { label: "+5V", value: 5.04 }] : undefined;
    s.battery = i === 2 ? { capacity: 64, status: "Discharging" } : undefined;
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
  if (s.net) { s.net.rxBytes += round * 5e6 * (i + 1); s.net.txBytes += round * 1e6; }
  // the disks read and write between pushes, so the storage panel has rates to show
  for (const d of s.io || []) { d.readBytes += round * 4e7 * (i + 1); d.writeBytes += round * 6e6; }
  for (const d of s.docker || []) if (d.cpuUsec != null) d.cpuUsec += round * 2e6;
  return JSON.stringify(s);
}

(async () => {
  await sleep(800);
  const base = JSON.parse(execFileSync("bash", [path.join(REPO, "bin/servitals-agent"), "test"],
    { env: { ...process.env, AGENT_ENV: "/nonexistent", DOCKER_SOCK: process.env.DOCKER_SOCK || "/var/run/docker.sock" } }).toString());
  const local = fs.readFileSync(path.join(state, "local-agent.env"), "utf8");
  const creds = [{ id: /NODE_ID=(.*)/.exec(local)[1], secret: /NODE_SECRET=(.*)/.exec(local)[1], name: null }];
  for (const name of ["nas", "pi-garage"]) {
    const n = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "hub/lib/nodes.js"), path.join(state, "nodes.json"), "add", name, "home"]).toString());
    creds.push({ ...n, name });
  }
  for (let round = 0; round < 3; round++) {
    for (const [i, c] of creds.entries()) {
      const code = await push(c, variant(base, c, i, round));
      if (code !== 200) throw new Error(`push ${c.name || "local"}: HTTP ${code}`);
    }
    if (round < 2) await sleep(5200);
  }
  console.log("READY", PORT);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
process.on("SIGTERM", () => { hub.kill(); fs.rmSync(state, { recursive: true, force: true }); process.exit(0); });
