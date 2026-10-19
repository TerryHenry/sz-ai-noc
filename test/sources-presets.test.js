'use strict';
const { tmp } = require('./helpers');
process.env.NOC_DATA_DIR = tmp('presets');
const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../lib/config');
const sources = require('../lib/sources');
const dash = require('../lib/dashboard');
const widgets = require('../lib/widgets');
const avail = require('../lib/widget-availability.json');

const reset = () => { cfg.r1.clientId = ''; cfg.r1.clientSecret = ''; cfg.aiEnabled = true; cfg.sz.controllers = []; cfg.source = 'rai'; };
const ai = () => { cfg.r1.clientId = 'id'; cfg.r1.clientSecret = 'secret'; };
const szc = (o = {}) => ({ id: 'a', name: 'A', host: 'sz.example.com', port: 8443, username: 'ro', password: 'pw', enabled: true, ...o });

test('which sources are on: RUCKUS AI and every enabled, complete controller', () => {
  reset(); assert.deepEqual(sources.enabled(), []);
  ai(); assert.deepEqual(sources.enabled(), ['rai']);
  cfg.sz.controllers = [szc()]; assert.deepEqual(sources.enabled(), ['rai', 'smartzone']);
  cfg.aiEnabled = false; assert.deepEqual(sources.enabled(), ['smartzone']);
  cfg.aiEnabled = true; cfg.sz.controllers = [szc({ enabled: false })]; assert.deepEqual(sources.enabled(), ['rai']);
  cfg.sz.controllers = [szc({ password: '' })]; assert.deepEqual(sources.enabled(), ['rai']);   // an incomplete controller does not count
});

test('the preferred source and the source a screen shows', () => {
  reset(); ai(); cfg.sz.controllers = [szc()];
  cfg.source = 'smartzone'; assert.equal(sources.primary(), 'smartzone');
  assert.equal(sources.of({}), 'smartzone'); assert.equal(sources.of({ source: 'rai' }), 'rai');
  cfg.aiEnabled = false; assert.equal(sources.of({ source: 'rai' }), 'smartzone');   // a screen whose source is off follows the preferred one
  cfg.source = 'rai'; assert.equal(sources.primary(), 'smartzone');                   // the preferred source is not enabled: the first enabled one
});

test('the stock layout follows the enabled sources', () => {
  reset();
  const one = dash.stockFor(['rai'], 'rai'); assert.ok(one.screens.every((s) => !s.source));
  const both = dash.stockFor(['rai', 'smartzone'], 'smartzone');
  assert.ok(both.screens.every((s) => s.source === 'rai' || s.source === 'smartzone'));
  assert.ok(both.screens[0].name.startsWith('SmartZone · '));   // the preferred source first
  assert.ok(dash.isStock(dash.validate(both), ['rai', 'smartzone'], 'smartzone'));
  assert.ok(!dash.isStock(dash.validate(both), ['rai'], 'rai'));
  const edited = dash.validate({ ...both, screens: both.screens.slice(1) }); assert.ok(!dash.isStock(edited, ['rai', 'smartzone'], 'smartzone'));
});

test('a screen keeps its source through validation', () => {
  const l = dash.validate({ title: 't', screens: [{ name: 'A', source: 'smartzone', widgets: [{ type: 'kpi.aps' }] }, { name: 'B', source: 'bogus', widgets: [{ type: 'kpi.aps' }] }] });
  assert.equal(l.screens[0].source, 'smartzone'); assert.equal(l.screens[1].source, undefined);
});

for (const src of ['rai', 'smartzone']) {
  test(`${src}: stock screens and every offered preset hold only widgets that work for it`, () => {
    const bad = [];
    for (const sc of dash.defaultFor(src).screens) for (const w of sc.widgets) if (widgets.unavailableFor(src, w.type)) bad.push(`default ${sc.name}: ${w.type}`);
    const presets = dash.presetsFor(src); assert.ok(presets.length >= 4, `only ${presets.length} presets for ${src}`);
    for (const p of presets) for (const w of p.widgets) if (widgets.unavailableFor(src, w.type)) bad.push(`preset ${p.name}: ${w.type}`);
    assert.deepEqual(bad, []);
  });
}

test('presets are all or nothing and never cross over to the other source', () => {
  const total = new Map(dash.PRESETS.map((p) => [p.name, p.widgets.length]));
  for (const src of ['rai', 'smartzone']) {
    for (const p of dash.presetsFor(src)) assert.equal(p.widgets.length, total.get(p.name), `${p.name} was trimmed for ${src}`);
    const names = dash.presetsFor(src).map((p) => p.name);
    assert.ok(!names.some((n) => (src === 'rai' ? /^SmartZone /.test(n) : /^RUCKUS AI /.test(n))), `${src} is offered the other source's stock screens`);
  }
  for (const p of [...dash.presetsFor('rai'), ...dash.presetsFor('smartzone')]) assert.ok(!/^msp\./.test(p.widgets.map((w) => w.type).join()), 'an MSP preset was offered');
});

test('the widget availability file only names real widgets', () => {
  const known = new Set(widgets.catalog().map((c) => c.type));
  for (const src of ['rai', 'smartzone']) { assert.ok(Array.isArray(avail[src]) && avail[src].length > 0); for (const t of avail[src]) assert.ok(known.has(t), `${t} (${src}) is not a widget`); }
  assert.ok(avail.smartzone.length < avail.rai.length);   // SmartZone supplies more than RUCKUS AI
});

test('catalog entries say which sources they work for', () => {
  const c = widgets.catalog().find((x) => x.type === 'kpi.intents'); assert.deepEqual(c.sources, ['rai']);
  const k = widgets.catalog().find((x) => x.type === 'table.wfc_profiles'); assert.deepEqual(k.sources, ['smartzone']);   // RUCKUS AI has no Wi-Fi calling policies
  const both = widgets.catalog().find((x) => x.type === 'kpi.aps'); assert.deepEqual(both.sources, ['rai', 'smartzone']);
});
