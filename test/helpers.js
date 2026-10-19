'use strict';
// Shared test helpers: a throw-away TLS certificate for the mock servers, free ports, a child-process server and tiny HTTP helpers.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `szai-${label}-`));

// A self-signed certificate for localhost (the mocks speak HTTPS like a real controller). Needs the openssl CLI; tests skip without it.
function makeCert() {
  const dir = tmp('cert');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch { return null; }
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(step); } }

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { const t = Buffer.concat(c).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// Start server.js as a child process on free ports with its own empty data folder.
async function startServer(env = {}) {
  const dir = tmp('data'); const port = await freePort(); const https = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, NOC_DATA_DIR: dir, PORT: String(port), HTTPS_PORT: String(https), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  await until(async () => { try { return (await req(port, 'GET', '/api/data')).status === 200; } catch { return false; } }, 15000);
  return { port, dir, log: () => log, stop: () => new Promise((r) => { child.on('exit', r); child.kill(); setTimeout(r, 3000); }) };
}
module.exports = { ROOT, tmp, makeCert, freePort, sleep, until, req, startServer };
