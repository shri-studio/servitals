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
    s.mem.used = Math.round(s.mem.total * [0, 0.34, 0.62][i]);
    s.temp = { package: [0, 39, 58][i], max: [0, 41, 61][i], sensors: [{ label: "cpu", value: [0, 39, 58][i] }] };
    s.disks = [{ mount: "/", mounted: true, source: "/dev/sda1", fstype: "ext4", size: 500e9,
                 used: [0, 470e9, 20e9][i], avail: [0, 30e9, 480e9][i], pct: [0, 94, 4][i] }];
    s.docker = i === 1 ? (s.docker || []).slice(0, 3) : [];
  }
  if (s.net) { s.net.rxBytes += round * 5e6 * (i + 1); s.net.txBytes += round * 1e6; }
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
