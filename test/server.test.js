'use strict';
// End to end: the real server.js against a synthetic RUCKUS AI and a synthetic SmartZone, both on at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeCert, startServer, req, until } = require('./helpers');
const { startMockSz } = require('./mocks/sz');
const { startMockAi } = require('./mocks/ai');

const tls = makeCert();
const skip = tls ? false : 'openssl is not available';
let ai, szm, srv;
const controller = (port, over = {}) => ({ id: 'lab', name: 'Lab SZ', host: '127.0.0.1', port, username: 'ro', password: 'pw', verifyTls: false, enabled: true, ...over });
const put = (body) => req(srv.port, 'PUT', '/api/settings', body);
const data = async () => (await req(srv.port, 'GET', '/api/data')).json;
const config = async () => (await req(srv.port, 'GET', '/api/config')).json;
const widgetOf = (layout, d, screen, type) => { const sc = layout.screens.find((s) => s.name === screen); const w = sc.widgets.find((x) => x.type === type); return d.widgets[w.id]; };

test.before(async () => {
  if (skip) return;
  ai = await startMockAi(tls); szm = await startMockSz(tls);
  srv = await startServer({ R1_CLIENT_ID: 'id', R1_CLIENT_SECRET: 'secret', R1_API_BASE: `https://127.0.0.1:${ai.port}`, RAI_AUTH_BASE: `https://127.0.0.1:${ai.port}`, NODE_TLS_REJECT_UNAUTHORIZED: '0', POLL_SECONDS: '15' });
});
test.after(async () => { if (srv) await srv.stop(); if (ai) await ai.close(); if (szm) await szm.close(); });

test('RUCKUS AI alone: polled, stock screens for RUCKUS AI', { skip }, async () => {
  const d = await until(async () => { const x = await data(); return x.at && x; }, 30000);
  assert.deepEqual(d.sources, ['rai']); assert.deepEqual(d.errors, {});
  assert.deepEqual((await config()).layout.screens.map((s) => s.name), ['Overview', 'Zones', 'Switches', 'Intent AI']);
});

test('adding a SmartZone controller turns both on and splits the stock screens by source', { skip }, async () => {
  const r = await put({ smartzone: [controller(szm.port)] });
  assert.equal(r.status, 200); assert.deepEqual(r.json.enabledSources, ['rai', 'smartzone']);
  const cfg = await until(async () => { const c = await config(); return c.venues.some((v) => v.src === 'rai') && c.venues.some((v) => v.src === 'smartzone') && c; }, 30000);   // both sources have finished a poll
  const d = await data(); assert.deepEqual(d.sources, ['rai', 'smartzone']); assert.deepEqual(d.errors, {});
  const names0 = cfg.layout.screens.length; assert.ok(names0 >= 8);
  const cfgNames = cfg.layout.screens.map((s) => `${s.source}:${s.name}`); const names = cfg.layout.screens.map((s) => `${s.source}:${s.name}`);
  assert.ok(cfgNames.includes('rai:RUCKUS AI · Overview') && cfgNames.includes('smartzone:SmartZone · Overview'), cfgNames.join());
});

test('each screen shows its own source; they are never mixed', { skip }, async () => {
  const d = await until(async () => { const x = await data(); const c = await config(); const w = widgetOf(c.layout, x, 'SmartZone · Overview', 'kpi.aps'); return w && w.value != null && { x, c }; }, 30000);
  const aiAps = widgetOf(d.c.layout, d.x, 'RUCKUS AI · Overview', 'kpi.aps'), szAps = widgetOf(d.c.layout, d.x, 'SmartZone · Overview', 'kpi.aps');
  assert.equal(aiAps.value, 3); assert.match(aiAps.suffix, /4/);     // RUCKUS AI: 3 of 4 APs online
  assert.equal(szAps.value, 2); assert.match(szAps.suffix, /4/);     // SmartZone: 2 of 4 (online + flagged)
  const aiCtl = widgetOf(d.c.layout, d.x, 'RUCKUS AI · Overview', 'table.controllers'), szCtl = widgetOf(d.c.layout, d.x, 'SmartZone · Overview', 'table.controllers');
  assert.deepEqual(aiCtl.rows.map((r) => r.cells[0]), ['SZ-One']);   // the RUCKUS AI controller that has APs (the table hides empty ones by default)
  assert.match(widgetOf(d.c.layout, d.x, 'RUCKUS AI · Overview', 'kpi.controllers').suffix, /\/ 2/);   // ...out of the two RUCKUS AI knows about
  assert.deepEqual(szCtl.rows.map((r) => r.cells[0]), ['Lab SZ']);                    // the directly connected one
  const sw = widgetOf(d.c.layout, d.x, 'SmartZone · Switches', 'table.switches'); assert.equal(sw.rows.length, 2);
  const gu = widgetOf(d.c.layout, d.x, 'SmartZone · Guests', 'a.guests.recent'); assert.equal(gu.rows.length, 1);
});

test('the SmartZone password is never returned, the file is private, and the connection test works', { skip }, async () => {
  const g = await req(srv.port, 'GET', '/api/settings');
  assert.ok(!/"password"\s*:/.test(g.text), 'a password was returned'); assert.equal(g.json.smartzone[0].passwordSet, true);
  assert.equal(fs.statSync(path.join(srv.dir, 'settings.json')).mode & 0o777, 0o600);
  const t = await req(srv.port, 'POST', '/api/settings/test?source=smartzone');
  assert.equal(t.json.ok, true); assert.match(t.json.summary, /v14_0.*2 zones/);
  const bad = await put({ smartzone: [controller(szm.port, { password: 'wrong' })] }); assert.equal(bad.status, 200);
  const t2 = await req(srv.port, 'POST', '/api/settings/test?source=smartzone'); assert.equal(t2.json.ok, false); assert.match(t2.json.error, /sign-in refused/);
  await put({ smartzone: [controller(szm.port, { password: 'pw' })] });   // put the right one back
});

test('turning a source off or on swaps the untouched stock layout', { skip }, async () => {
  let r = await put({ aiEnabled: false }); assert.deepEqual(r.json.enabledSources, ['smartzone']);
  assert.deepEqual((await config()).layout.screens.map((s) => s.name).slice(0, 2), ['Overview', 'Zones']);
  assert.ok((await config()).layout.screens.some((s) => s.name === 'Switches'));
  r = await put({ aiEnabled: true, smartzone: [controller(szm.port, { enabled: false })] }); assert.deepEqual(r.json.enabledSources, ['rai']);
  assert.deepEqual((await config()).layout.screens.map((s) => s.name), ['Overview', 'Zones', 'Switches', 'Intent AI']);
  r = await put({ aiEnabled: false }); assert.deepEqual(r.json.enabledSources, []);
  const d = await until(async () => { const x = await data(); return x.setup && x; }, 20000); assert.match(d.setup, /No data source is set up/);
});

test('an edited layout is left alone when the sources change', { skip }, async () => {
  await put({ aiEnabled: true });
  const cfg = await config(); const edited = { ...cfg.layout, title: 'Mine', screens: cfg.layout.screens.slice(0, 2) };
  const sv = await req(srv.port, 'PUT', '/api/config', edited); assert.equal(sv.status, 200);
  await put({ smartzone: [controller(szm.port, { enabled: true })] });
  const after = await config(); assert.equal(after.layout.title, 'Mine'); assert.equal(after.layout.screens.length, 2);
});
