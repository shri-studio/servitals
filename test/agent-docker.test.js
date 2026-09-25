// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const LIB = path.join(__dirname, "..", "agent", "lib");
const ID1 = "a".repeat(64);
const ID2 = "b".repeat(64);

function dockerJson(host, state, sock) {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-c", 'for f in "$AGENT_LIB"/*.sh; do . "$f"; done; docker_json'], {
      env: { PATH: process.env.PATH, AGENT_LIB: LIB, HOST: host, STATE: state, NCPU: "2", DOCKER_SOCK: sock },
      timeout: 30000,
    }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(JSON.parse(stdout))));
  });
}

async function fakeDocker(dir) {
  const sock = path.join(dir, "docker.sock");
  const srv = http.createServer((req, res) => {
    if (req.url !== "/containers/json?all=1") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { Id: ID2, Names: ["/old"], State: "exited", Status: "Exited (0) 3 days ago" },
      { Id: ID1, Names: ["/web"], State: "running", Status: "Up 2 hours (healthy)" },
    ]));
  });
  await new Promise((r) => srv.listen(sock, r));
  return { sock, close: () => new Promise((r) => srv.close(r)) };
}

test("containers from the API socket, memory and CPU from the cgroup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dk-"));
  const host = path.join(dir, "host");
  const state = path.join(dir, "state");
  const cg = path.join(host, `sys/fs/cgroup/system.slice/docker-${ID1}.scope`);
  fs.mkdirSync(cg, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(cg, "cpu.stat"), "usage_usec 1000000\nuser_usec 600000\n");
  fs.writeFileSync(path.join(cg, "memory.stat"), "anon 5242880\nfile 999\n");
  const api = await fakeDocker(dir);
  try {
    const first = await dockerJson(host, state, api.sock);
    assert.deepStrictEqual(first.map((c) => c.name), ["web", "old"], "running first");
    assert.deepStrictEqual(first[0], {
      name: "web", id: ID1, state: "running", status: "Up 2 hours (healthy)",
      health: "healthy", cpu: null, mem: 5242880,
    });
    assert.strictEqual(first[1].mem, null);
    assert.strictEqual(first[1].health, null);
    // +0.1 s of CPU: a clear non-zero percentage even on a slow runner
    fs.writeFileSync(path.join(cg, "cpu.stat"), "usage_usec 1100000\nuser_usec 600000\n");
    const second = await dockerJson(host, state, api.sock);
    assert.strictEqual(typeof second[0].cpu, "number");
    assert.ok(second[0].cpu > 0 && second[0].cpu <= 100, String(second[0].cpu));
    assert.match(fs.readFileSync(path.join(state, "docker-cpu"), "utf8"), new RegExp(`^${ID1} 1100000 \\d+$`, "m"));
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no Docker socket means an empty list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dk-"));
  assert.deepStrictEqual(await dockerJson(dir, dir, path.join(dir, "missing.sock")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
