'use strict';
const { tmp } = require('./helpers');
process.env.NOC_DATA_DIR = tmp('backup');   // before any lib/ module reads the config
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../lib/config');
const settings = require('../lib/settings');
const backup = require('../lib/backup');

const SECRETS = ['RAI-CLIENT-SECRET', 'MSP-CLIENT-SECRET', 'CUSTOMER-SECRET', 'SZ-PASSWORD-ONE', 'SZ-PASSWORD-TWO'];
function seed() {
  settings.save({
    clientId: 'client-id-1', clientSecret: 'RAI-CLIENT-SECRET', tenantId: '',
    msp: { enabled: false, tenantId: 'msp-tenant', clientId: 'msp-client', clientSecret: 'MSP-CLIENT-SECRET' },
    customers: [{ id: 'cust1', name: 'Customer', tenantId: 't1', clientId: 'c1', clientSecret: 'CUSTOMER-SECRET' }],
    smartzone: [{ id: 'lab', name: 'Lab SZ', host: 'sz-lab.example.com', port: 8443, username: 'readonly', password: 'SZ-PASSWORD-ONE' }, { id: 'annex', name: 'Annex', host: '10.20.0.5', username: 'ro2', password: 'SZ-PASSWORD-TWO', enabled: false }]
  });
}
test.before(seed);

test('the settings file keeps the SmartZone passwords, mode 600', () => {
  const f = path.join(cfg.DATA_DIR, 'settings.json');
  assert.match(fs.readFileSync(f, 'utf8'), /SZ-PASSWORD-ONE/);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('settings.get never returns a password (only whether one is saved)', () => {
  const g = settings.get(); const text = JSON.stringify(g);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${s} leaked by settings.get`);
  assert.equal(g.smartzone[0].passwordSet, true);
  assert.equal(g.smartzone[0].password, undefined);
});

test('a configuration-only backup carries no credentials but keeps the connection details', () => {
  const b = backup.create({ full: false });
  for (const s of SECRETS) assert.ok(!b.text.includes(s), `${s} is in the configuration-only backup`);
  assert.match(b.text, /sz-lab\.example\.com/);
  assert.match(b.text, /readonly/);
});

test('the automatic daily backup is credential-free too', () => {
  backup.auto();
  const dir = path.join(cfg.DATA_DIR, 'backups'); const files = fs.readdirSync(dir).filter((n) => n.startsWith('auto-'));
  assert.ok(files.length >= 1);
  for (const n of files) { const t = fs.readFileSync(path.join(dir, n), 'utf8'); for (const s of SECRETS) assert.ok(!t.includes(s), `${s} is in ${n}`); }
});

test('a full backup is encrypted, needs its passphrase, and round-trips the credentials', () => {
  assert.throws(() => backup.create({ full: true, passphrase: 'short' }), /at least 8/);
  const b = backup.create({ full: true, passphrase: 'correct horse battery' });
  for (const s of SECRETS) assert.ok(!b.text.includes(s), `${s} is readable in the encrypted backup`);
  assert.throws(() => backup.inspect(b.text, 'wrong passphrase!'), /Wrong passphrase/);
  const info = backup.inspect(b.text, 'correct horse battery'); assert.equal(info.includesCredentials, true);
});

test('restoring a configuration-only backup keeps the passwords already saved', () => {
  const b = backup.create({ full: false });
  settings.save({ smartzone: [{ id: 'lab', host: 'moved.example.com', username: 'someone-else', password: 'SZ-NEW-PASSWORD' }, { id: 'annex', password: 'SZ-PASSWORD-TWO', host: '10.20.0.5' }] });
  assert.equal(cfg.sz.controllers[0].host, 'moved.example.com');
  backup.restore(b.text, '', ['settings.json']);
  const lab = cfg.sz.controllers.find((c) => c.id === 'lab');
  assert.equal(lab.host, 'sz-lab.example.com');          // the backup's details came back
  assert.equal(lab.username, 'readonly');
  assert.equal(lab.password, 'SZ-NEW-PASSWORD');         // the saved password stayed: the backup had none
  assert.equal(cfg.r1.clientSecret, 'RAI-CLIENT-SECRET');
});

test('the pre-restore snapshot is private (mode 600)', () => {
  const dir = path.join(cfg.DATA_DIR, 'backups'); const snaps = fs.readdirSync(dir).filter((n) => n.startsWith('pre-restore-'));
  assert.ok(snaps.length >= 1);
  for (const n of snaps) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600);
});
