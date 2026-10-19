'use strict';
const { tmp, makeCert } = require('./helpers');
process.env.NOC_DATA_DIR = tmp('sz');
const test = require('node:test');
const assert = require('node:assert/strict');
const sz = require('../lib/sz');
const { startMockSz } = require('./mocks/sz');

const tls = makeCert();
const skip = tls ? false : 'openssl is not available';
const conf = (port, over = {}) => ({ name: 'mock', host: '127.0.0.1', port, username: 'ro', password: 'pw', verifyTls: false, ...over });
const by = (a, f) => a.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});

test('sign-in, version detection and the connection summary', { skip }, async () => {
  const m = await startMockSz(tls);
  try {
    const r = await sz.createClient(conf(m.port)).test();
    assert.equal(r.version, 'v14_0'); assert.equal(r.venues, 2); assert.match(r.summary, /v14_0.*signed in.*2 zones/);
  } finally { await m.close(); }
});

test('wrong password is reported clearly; a self-signed certificate is refused when verification is on', { skip }, async () => {
  const m = await startMockSz(tls);
  try {
    await assert.rejects(() => sz.createClient(conf(m.port, { password: 'nope' })).test(), /sign-in refused/);
    await assert.rejects(() => sz.createClient(conf(m.port, { verifyTls: true })).test(), /certificate not trusted/);
  } finally { await m.close(); }
});

test('an expired service ticket is replaced once, transparently', { skip }, async () => {
  const m = await startMockSz(tls);
  try {
    const c = sz.createClient(conf(m.port)); await c.get('/rkszones'); assert.equal(m.stats.logins, 1);
    m.expireTickets(); const r = await c.get('/rkszones'); assert.equal(r.totalCount, 2); assert.equal(m.stats.logins, 2);
  } finally { await m.close(); }
});

test('inventory: zones, APs, radios, WLANs, clients, alarms', { skip }, async () => {
  const m = await startMockSz(tls);
  try {
    const inv = await sz.fetchInventory([{ id: 'lab', client: sz.createClient(conf(m.port)) }]);
    assert.deepEqual(inv.errors, {});
    assert.equal(inv.venues.filter((v) => v.kind === 'zone').length, 2);
    assert.equal(inv.clientTotal, 2);
    assert.deepEqual(by(inv.aps, (a) => a.status), { Operational: 1, Degraded: 1, Disconnected: 1, Initializing: 1 });   // Pending registration = Initializing
    const ap1 = inv.aps.find((a) => a.name === 'AP-1');
    assert.deepEqual(ap1.radios.map((r) => [r.band, r.channel, r.width, r.txPower, r.noise, r.airtime]), [['2.4 GHz', 6, '20 MHz', 18, -92, 12], ['5 GHz', 36, '80 MHz', 20, -95, 3]]);
    const ap2 = inv.aps.find((a) => a.name === 'AP-2'); assert.deepEqual(ap2.radios.map((r) => r.band), ['2.4 GHz']);   // a disabled radio (channel 0) is left out
    assert.equal(ap2.health, 'POOR');
    assert.equal(inv.networks.length, 2); assert.equal(inv.networks.find((n) => n.name === 'Guest').captive, 'GuestAccess');
    assert.equal(inv.clients.length, 2);
    const laptop = inv.clients.find((c) => c.name === 'laptop'); assert.equal(laptop.band, '5 GHz'); assert.equal(laptop.rssi, -60); assert.equal(laptop.bytesDown, 8000000); assert.equal(laptop.security, 'WPA2-AES'); assert.equal(laptop.venueId, 'z:lab/z1');
    assert.equal(inv.clients.find((c) => c.name === 'phone').band, '2.4 GHz');
    assert.equal(inv.alarms.length, 1); const al = inv.alarms[0]; assert.equal(al.severity, 'Major'); assert.equal(al.device, 'AP-1'); assert.equal(al.venueId, 'z:lab/z1');   // the AP is only named inside the text
    assert.deepEqual({ ...inv.alarmCounts }, { Critical: 0, Major: 1, Minor: 0, Warning: 0, any: true });
  } finally { await m.close(); }
});

test('inventory: DPSK, VLAN pools, Wi-Fi calling, controller load; secrets are never copied', { skip }, async () => {
  const m = await startMockSz(tls);
  try {
    const inv = await sz.fetchInventory([{ id: 'lab', client: sz.createClient(conf(m.port)) }]);
    assert.equal(inv.dpskPools.length, 1); assert.equal(inv.dpskPools[0].name, 'Corp');   // one pool per WLAN
    assert.equal(inv.dpsk.length, 1); assert.equal(inv.dpsk[0].vlan, 'VLAN 100'); assert.equal(inv.dpsk[0].status, 'Active');
    assert.equal(inv.vlanPools[0].members, '64'); assert.deepEqual(inv.wfcProfiles[0].epdgs, ['epdg.example.net']);
    const c = inv.controllers[0]; assert.equal(c.cpu, 40.1); assert.equal(c.memory, 82.3); assert.equal(c.disk, 40); assert.equal(c.version, '7.2.0.0.1');
    const all = JSON.stringify(inv); assert.ok(!all.includes('SECRET-DPSK-PASSPHRASE')); assert.ok(!all.includes('SECRET-PASS-CODE-123'));
  } finally { await m.close(); }
});

test('inventory: switches, groups, ports, switch events, guest passes', { skip }, async () => {
  const m = await startMockSz(tls);
  try {
    const inv = await sz.fetchInventory([{ id: 'lab', client: sz.createClient(conf(m.port)) }]);
    assert.deepEqual(inv.errors, {});
    assert.equal(inv.switches.length, 2); assert.equal(inv.venues.filter((v) => v.kind === 'switchGroup').length, 1);
    const core = inv.switches.find((s) => s.name === 'ICX8200-48PF Core'), edge = inv.switches.find((s) => s.name === 'ICX7150-Edge');
    assert.equal(core.status, 'Operational'); assert.equal(edge.status, 'Disconnected');
    assert.deepEqual([core.cpu, core.memory, core.poeTotalW, core.poeUtil, core.clients, core.family, core.switchType], [4, 44, 150, 20, 1, 'ICX8200', 'Router (Layer 3)']);
    assert.deepEqual([edge.family, edge.switchType, edge.poeTotalW, edge.cpu], ['ICX7150', 'Switch (Layer 2)', null, null]);   // family from the model, type from the firmware image
    assert.deepEqual(inv.ports.map((p) => p.state), ['Up', 'Down', 'Disabled']);
    const up = inv.ports[0]; assert.equal(up.errors, 3); assert.equal(up.neighbor, 'ap-uplink'); assert.equal(up.mbps, 7); assert.equal(up.poeUsedW, 6);
    assert.equal(inv.ports[2].lag, 'LAG member');
    assert.equal(inv.switchEvents.length, 1); assert.equal(inv.switchEvents[0].kind, 'online'); assert.equal(inv.switchEvents[0].switchName, 'ICX8200-48PF Core');
    assert.equal(inv.guests.length, 1); const g = inv.guests[0];
    assert.equal(g.status, 'Online'); assert.equal(g.devices, 1); assert.equal(g.network, 'Guest'); assert.equal(g.maxClients, 2);
    assert.ok(Math.abs(Date.now() - g.created) < 120e3, 'guest dates are read in the controller time zone'); assert.ok(Math.abs(g.expiry - Date.now() - 7 * 86400e3) < 120e3);
  } finally { await m.close(); }
});

test('a release without the Switch Manager API is not an error', { skip }, async () => {
  const m = await startMockSz(tls, 0, { noSwitchManager: true });
  try {
    const inv = await sz.fetchInventory([{ id: 'lab', client: sz.createClient(conf(m.port)) }]);
    assert.deepEqual(inv.errors, {}); assert.equal(inv.switches.length, 0); assert.equal(inv.ports.length, 0); assert.equal(inv.aps.length, 4);
  } finally { await m.close(); }
});

test('two controllers with the same zone names stay apart', { skip }, async () => {
  const a = await startMockSz(tls), b = await startMockSz(tls);
  try {
    const inv = await sz.fetchInventory([{ id: 'one', client: sz.createClient(conf(a.port, { name: 'One' })) }, { id: 'two', client: sz.createClient(conf(b.port, { name: 'Two' })) }]);
    assert.equal(inv.controllers.length, 2); assert.equal(inv.aps.length, 8);
    const names = inv.venues.filter((v) => v.kind === 'zone').map((v) => v.name).sort();
    assert.deepEqual(names, ['Alpha (One)', 'Alpha (Two)', 'Beta (One)', 'Beta (Two)']);
    assert.equal(new Set(inv.venues.map((v) => v.id)).size, inv.venues.length);
  } finally { await a.close(); await b.close(); }
});
