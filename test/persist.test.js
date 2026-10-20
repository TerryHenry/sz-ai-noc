'use strict';
// Logins and settings must survive stopping and starting the app on the same data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, req, tmp } = require('./helpers');

test('RUCKUS AI and SmartZone logins survive a restart on the same data folder', async () => {
  const dir = tmp('persist');
  const a = await startServer({ NOC_DATA_DIR: dir });
  try {
    const r1 = await req(a.port, 'PUT', '/api/settings', { mode: 'single', tenantId: '', clientId: 'client-1', clientSecret: 'secret-1', apiBase: 'https://api.ruckus.cloud', oauthBase: 'https://api.ruckus.cloud', pollSeconds: '60', aiEnabled: true });
    assert.equal(r1.status, 200);
    const r2 = await req(a.port, 'PUT', '/api/settings', { smartzone: [{ id: '', name: 'Lab', host: 'sz.example.com', port: 8443, username: 'ro', password: 'sz-secret', verifyTls: false, enabled: true }] });
    assert.equal(r2.status, 200); assert.deepEqual(r2.json.enabledSources, ['rai', 'smartzone']);
    assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  } finally { await a.stop(); }
  const b = await startServer({ NOC_DATA_DIR: dir });
  try {
    const g = (await req(b.port, 'GET', '/api/settings')).json;
    assert.equal(g.clientId, 'client-1'); assert.equal(g.secretSet, true);
    assert.equal(g.smartzone.length, 1); assert.equal(g.smartzone[0].host, 'sz.example.com'); assert.equal(g.smartzone[0].passwordSet, true);
    assert.deepEqual(g.enabledSources, ['rai', 'smartzone']);
    assert.equal(g.dataDir, dir);
    assert.match(b.log(), /data: +/);   // the start-up banner names the data folder
  } finally { await b.stop(); }
});

test('the editor is told when the data folder is temporary', async () => {
  const s = await startServer({});   // helpers use a temp folder
  try { const g = (await req(s.port, 'GET', '/api/settings')).json; assert.equal(g.dataDirTemporary, true); } finally { await s.stop(); }
});
