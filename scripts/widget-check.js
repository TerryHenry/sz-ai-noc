#!/usr/bin/env node
'use strict';
// Which widgets work with RUCKUS AI data?  Runs every catalog widget against a snapshot and sorts it into:
//   OK       computed, and the result has content
//   EMPTY    computed from data RUCKUS AI supplies, but the result is empty (nothing to show right now, or a sparse field)
//   N/A      MSP-only or external-feed widget (not RUCKUS AI data)
//   PARTLY   computed and non-empty, but built partly on a source RUCKUS AI does not fill (--partly shows what it displays)
//   WARMUP   built on a metric RUCKUS AI data produces, but needs hours/days of history (fills in while the wall runs)
//   NO DATA  needs a source RUCKUS AI does not provide (clients, switch ports, DPSK, guests, Wi-Fi calling, networks, ...)
//   BROKEN   threw an error
//
//   Live:      RAI_CLIENT_ID=... RAI_CLIENT_SECRET=... [RAI_TENANT=...] [RAI_API=https://api.eu.ruckus.cloud]  node scripts/widget-check.js
//   Saved:     node scripts/widget-check.js --snapshot snap.json      (made with --save snap.json; it holds your real names: keep it local)
//   Demo:      node scripts/widget-check.js --demo                    (offline regression: the demo data with everything RUCKUS AI does not supply blanked out)
//              --demo --raw                                            (demo data as is, R1-shaped)
//   Options:   --write-unavailable (save the NO DATA widget types to lib/widget-availability.json: the editor hides them)   --json (machine-readable)   --all (also list the OK ones)   --group "Name" (only that group)
// Exit code 1 when a widget is BROKEN, or when a default screen / offered preset holds a NO DATA widget. The history database goes to a scratch folder, never to ./data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
const env = process.env;

if (!process.env.NOC_DATA_DIR) process.env.NOC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-check-'));
if (flag('demo')) { process.env.NOC_DEMO = '1'; if (!flag('raw')) process.env.NOC_DEMO_AI = '1'; }
if (env.RAI_CLIENT_ID) { env.R1_CLIENT_ID = env.RAI_CLIENT_ID; env.R1_CLIENT_SECRET = env.RAI_CLIENT_SECRET || ''; env.R1_TENANT_ID = env.RAI_TENANT || ''; if (env.RAI_API) env.R1_API_BASE = env.RAI_API; }

const collect = require('../lib/collect');
const widgets = require('../lib/widgets');
const dash = require('../lib/dashboard');
const history = require('../lib/history');

// Snapshot fields RUCKUS AI fills in (lib/collect.js pollRai). Anything else a widget reads while it is empty means NO DATA.
const SUPPLIED = new Set(['venues', 'aps', 'switches', 'alarms', 'controllers', 'intents', 'clientTotal', 'analytics', 'errors', 'at', 'source', 'diag', 'setup', 'starting', 'customers']);
const SUPPLIED_NEEDS = new Set(['analytics']);
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

// Wrap the snapshot so we can see which top-level fields a widget touches, and which fields of each aps/switches/venues/... row.
const ROWS = new Set(['aps', 'switches', 'venues', 'alarms', 'controllers']);
function tracked(S) {
  const reads = new Set(), fields = new Set(); const cache = new Map();
  const rowProxy = (coll, row) => new Proxy(row, { get(t, k) { if (typeof k === 'string') fields.add(`${coll}.${k}`); return t[k]; } });
  const arrProxy = (coll, arr) => { const rows = new Map(); return new Proxy(arr, { get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k) && t[k] && typeof t[k] === 'object') { if (!rows.has(k)) rows.set(k, rowProxy(coll, t[k])); return rows.get(k); } return t[k]; } }); };
  return { reads, fields, S: new Proxy(S, { get(t, k) { if (typeof k !== 'string') return t[k]; reads.add(k); if (ROWS.has(k) && Array.isArray(t[k])) { if (!cache.has(k)) cache.set(k, arrProxy(k, t[k])); return cache.get(k); } return t[k]; } }) };
}
// History keys a widget asks for (trend / compare / "vs yesterday"), checked against the metrics this snapshot really produces.
const histReads = new Set();
for (const fn of ['series', 'range', 'topSeries']) { const orig = history[fn]; history[fn] = function (key, ...rest) { if (typeof key === 'string') histReads.add(key); return orig.call(this, key, ...rest); }; }
// Does a computed payload carry anything to show?
function hasContent(r) {
  if (!r || typeof r !== 'object') return false;
  switch (r.kind) {
    case 'kpi': return r.value != null && r.value !== '—' && r.value !== '';
    case 'line': return Array.isArray(r.points) && r.points.length > 0;
    case 'multiline': return Array.isArray(r.series) && r.series.some((s) => (s.points || []).length);
    case 'table': case 'list': return Array.isArray(r.rows) && r.rows.length > 0;
    case 'stack': return Array.isArray(r.rows) && r.rows.some((x) => (x.segments || []).length);
    case 'bar': case 'donut': return Array.isArray(r.items) && r.items.length > 0;
    case 'error': return false;
    default: for (const k of ['rows', 'items', 'points', 'series', 'groups', 'cells']) if (Array.isArray(r[k])) return r[k].length > 0; return true;
  }
}

// A compact look at what a widget shows (for --partly), e.g. "value=0", "3 items: 0,0,0".
function glance(r) {
  if (!r) return '';
  if (r.kind === 'kpi') return `value=${JSON.stringify(r.value)}${r.suffix ? ' ' + r.suffix : ''}`;
  if (r.kind === 'stack') return `${(r.rows || []).length} rows: ` + (r.rows || []).map((x) => (x.segments || []).map((g) => g.value).join('/') || '-').join(' | ');
  const items = r.items || r.rows || r.points || []; const vals = (r.items || []).map((x) => x.value).join(',');
  return `${items.length} ${r.kind}${vals ? ': ' + vals.slice(0, 40) : ''}`;
}
// "Does this widget's output depend on data RUCKUS AI does not supply?" Recompute it on a copy of the snapshot where the missing sources
// (clients, ports, radios, ...) and the never-filled AP/switch fields are filled from the demo generator. A different result means the live
// value is a placeholder (a zero or a dash standing in for data that is not there); an identical one means the widget is unaffected.
let filled = null;
function withMissingFilled(S, ctx) {
  if (filled) return filled;
  const keep = history.count; history.count = () => 1;   // the demo would otherwise seed its history into this scratch database
  let D; try { D = require('../lib/demo').tick(); } finally { history.count = keep; }
  const out = { ...S };
  for (const k of Object.keys(D)) if (!SUPPLIED.has(k) && (k in S) ) out[k] = D[k];
  const dead = (coll) => [...ctx.neverFilled].filter((f) => f.startsWith(coll + '.')).map((f) => f.slice(coll.length + 1));
  const lend = (rows, drows, fields) => rows.map((r, i) => { const d = drows[i % drows.length] || {}; const o = { ...r }; for (const f of fields) if (f in d) o[f] = d[f]; return o; });
  out.aps = lend(S.aps || [], D.aps || [], dead('aps'));
  const real = S.aps || [];
  if (real.length) {   // put the demo's clients and radios on the real APs and zones so per-zone / per-AP widgets can see them
    const at = (i) => real[i % real.length];
    if (Array.isArray(out.clients)) out.clients = out.clients.map((c, i) => ({ ...c, venueId: at(i).venueId, venue: at(i).venue, ap: at(i).name, apSerial: at(i).id, apGroup: at(i).apGroup }));
    if (Array.isArray(out.radios)) out.radios = out.radios.map((x, i) => ({ ...x, apId: at(i).id, apName: at(i).name, venueId: at(i).venueId, venue: at(i).venue, apGroup: at(i).apGroup, status: at(i).status }));
  }
  out.switches = lend(S.switches || [], D.switches || [], dead('switches'));
  filled = out; return filled;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Is what the widget shows a zero / dash / empty stand-in rather than a number?
const zeroish = (v) => v == null || v === '' || v === '—' || (typeof v === 'number' && !(v > 0)) || (typeof v === 'string' && /^[-+]?0+(\.0+)?\s*[%A-Za-z]{0,3}$/.test(v.trim()));
const EMPTY_BUCKET = /^(unknown|none|n\/a|—|-|0 clients|)$/i;   // the one bucket everything falls into when the grouping field is never filled
// Known to show a real-looking 0 that the perturbation cannot expose (radio clients are not modelled by the demo).
const MANUAL_NO_DATA = new Set(['g.kpi.load.over20']);
function placeholder(r) {
  if (!r) return true;
  switch (r.kind) {
    case 'kpi': return zeroish(r.value);
    case 'gauge': return zeroish(r.value);
    case 'bar': case 'donut': { const it = r.items || []; return !it.some((x) => x.value > 0) || (it.length === 1 && EMPTY_BUCKET.test(String(it[0].label || '').trim())); }
    case 'stack': return !(r.rows || []).some((x) => (x.segments || []).some((g) => g.value > 0));
    case 'table': { const rows = r.rows || []; return rows.length > 0 && (rows.every((x) => (x.cells || []).slice(1).every(zeroish)) || (rows.length === 1 && EMPTY_BUCKET.test(String((rows[0].cells || [])[0] || '').trim()))); }   // first cell is the row label
    case 'list': return false;
    case 'line': return !(r.points || []).some((p) => p[1] > 0);
    default: return false;
  }
}

function classify(def, S, ctx) {
  if (def.msp || /\.customer(\.|$)/.test(def.type)) return { status: 'N/A', why: 'MSP customer widget (this app has one RUCKUS AI account)' };
  if (def.group === 'Ticker & feeds') return { status: 'N/A', why: 'external feed, not RUCKUS AI data' };
  const unsupplied = (def.needs || []).filter((n) => !SUPPLIED_NEEDS.has(n));
  if (unsupplied.length) return { status: 'NO DATA', why: `needs ${unsupplied.join(', ')} (not available from RUCKUS AI)` };
  const t = tracked(S); histReads.clear();
  let r;
  try { r = widgets.compute({ type: def.type, venue: '', params: {} }, t.S); } catch (e) { return { status: 'BROKEN', why: e.message }; }
  if (r && r.kind === 'error') return { status: 'BROKEN', why: r.message || 'error payload' };
  const missing = [...t.reads].filter((k) => !SUPPLIED.has(k) && k in S && isEmpty(S[k]));
  if (MANUAL_NO_DATA.has(def.type)) return { status: 'NO DATA', why: 'shows a placeholder zero: needs AP radios, which RUCKUS AI does not fill' };
  const deadReads = [...t.fields].filter((f) => ctx.neverFilled.has(f));
  const hkAbsent = [...histReads].filter((k) => ![...ctx.metricKeys].some((m) => m === k || m.startsWith(k)));
  if (hkAbsent.length && hasContent(r)) return { status: 'NO DATA', why: `metric ${hkAbsent.slice(0, 2).join(', ')} is not produced from RUCKUS AI data`, payload: r };
  if (hasContent(r)) {
    if (!missing.length && !deadReads.length) return { status: 'OK', why: '' };
    let r2 = null; try { r2 = widgets.compute({ type: def.type, venue: '', params: {} }, withMissingFilled(S, ctx)); } catch { /* treat as unchanged */ }
    const reads = [...missing, ...deadReads].join(', ');
    if (r2 && !same(r, r2) && (placeholder(r) || (deadReads.length && (r.kind === 'kpi' || r.kind === 'gauge')))) return { status: 'NO DATA', why: `shows placeholders (zeros or dashes): its value depends on ${reads}, which RUCKUS AI does not fill`, payload: r };
    return { status: 'PARTLY', why: `reads ${reads}, but the value does not depend on it`, payload: r };
  }
  if (missing.length) return { status: 'NO DATA', why: `reads ${missing.join(', ')}, which RUCKUS AI does not fill` };
  const dead = [...t.fields].filter((f) => ctx.neverFilled.has(f));
  if (dead.length) return { status: 'NO DATA', why: `reads ${dead.join(', ')}, which RUCKUS AI never fills` };
  const hk = [...histReads];
  if (hk.length) {
    const absent = hk.filter((k) => ![...ctx.metricKeys].some((m) => m === k || m.startsWith(k)));
    if (absent.length) return { status: 'NO DATA', why: `metric ${absent.slice(0, 2).join(', ')} is not produced from RUCKUS AI data` };
    return { status: 'WARMUP', why: 'needs history: fills in as the wall keeps running' };
  }
  return { status: 'EMPTY', why: S.analytics == null && def.needs && def.needs.includes('analytics') ? 'analytics not available' : 'result is empty (no rows / points / value)' };
}

// Which fields of aps / switches / venues carry a value in at least one row (explains EMPTY widgets built on a sparse field).
function coverage(S) {
  const out = {};
  for (const k of ['venues', 'aps', 'switches', 'alarms', 'controllers']) {
    const rows = S[k] || []; const f = {};
    for (const r of rows) for (const [key, v] of Object.entries(r)) if (!isEmpty(v) && v !== 'UNKNOWN' && v !== 0) f[key] = (f[key] || 0) + 1;
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    out[k] = { rows: rows.length, filled: Object.fromEntries([...keys].map((key) => [key, f[key] || 0])) };
  }
  return out;
}

async function getSnapshot() {
  const file = opt('snapshot');
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (flag('demo')) {
    await collect.poll(); const S = JSON.parse(JSON.stringify(collect.get()));
    if (!flag('raw')) for (const k of Object.keys(S)) if (!SUPPLIED.has(k)) { const v = S[k]; S[k] = Array.isArray(v) ? [] : (v && typeof v === 'object' && k !== 'traffic') ? {} : k === 'traffic' ? { dt: 0, bytes: 0, down: 0, up: 0 } : v; }
    return S;
  }
  if (!env.RAI_CLIENT_ID || !env.RAI_CLIENT_SECRET) { console.error('Set RAI_CLIENT_ID and RAI_CLIENT_SECRET (an Application Token), or use --snapshot <file> or --demo.'); process.exit(2); }
  collect.setNeeds(['analytics']);   // analytics is a slow source that is only fetched when something needs it
  await collect.poll();
  const S = collect.get();
  if (S.setup) { console.error(S.setup); process.exit(2); }
  return S;
}

(async () => {
  const S = await getSnapshot();
  if (opt('save')) { fs.writeFileSync(opt('save'), JSON.stringify(S)); console.error(`snapshot saved to ${opt('save')} (contains your real names: do not commit it)`); }
  if (S.at && !flag('snapshot')) { try { history.record(S.at, collect.metricsOf(S, true)); } catch { /* trends then show as EMPTY */ } }   // one point so trend widgets have something
  const only = opt('group');
  const cov = coverage(S);
  const ctx = { neverFilled: new Set(Object.entries(cov).flatMap(([k, c]) => Object.entries(c.filled).filter(([, n]) => n === 0).map(([f]) => `${k}.${f}`))), metricKeys: new Set(Object.keys(collect.metricsOf(S, true))) };
  const results = widgets.catalog().filter((d) => !only || d.group === only).map((d) => ({ type: d.type, title: d.title, group: d.group, ...classify(d, S, ctx) }));
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { widgets: results.length, ok: count('OK'), empty: count('EMPTY'), noData: count('NO DATA'), warmup: count('WARMUP'), partly: count('PARTLY'), na: count('N/A'), broken: count('BROKEN'), snapshot: { aps: (S.aps || []).length, switches: (S.switches || []).length, zones: (S.venues || []).length, controllers: (S.controllers || []).length, alarms: (S.alarms || []).length, intents: S.intents ? S.intents.total : null, analytics: Boolean(S.analytics), errors: S.errors || {} } };
  // Screens people get without choosing widgets themselves: the defaults and the presets the editor offers. They must not hold NO DATA widgets.
  const status = new Map(results.map((r) => [r.type, r.status]));
  const offered = [...dash.DEFAULT.screens.map((sc) => ({ name: `default: ${sc.name}`, widgets: sc.widgets })), ...dash.presets().map((p) => ({ name: `preset: ${p.name}`, widgets: p.widgets }))];
  const problems = offered.map((sc) => ({ name: sc.name, bad: sc.widgets.filter((x) => status.get(x.type) === 'NO DATA').map((x) => x.type), empty: sc.widgets.filter((x) => status.get(x.type) === 'EMPTY').map((x) => x.type) })).filter((x) => x.bad.length || x.empty.length);
  const presetFail = problems.some((x) => x.bad.length);
  if (!only && !flag('write-unavailable') && !flag('json')) { /* printed below */ }
  if (flag('write-unavailable')) {
    if (only) { console.error('--write-unavailable needs the full catalog: drop --group'); process.exit(2); }
    const file = path.join(__dirname, '..', 'lib', 'widget-availability.json');
    fs.writeFileSync(file, JSON.stringify({ note: 'Widget types with no RUCKUS AI data source. Written by scripts/widget-check.js --write-unavailable; the editor hides them. Types only, no customer data.', unavailable: results.filter((r) => r.status === 'NO DATA').map((r) => r.type).sort() }, null, 1) + '\n');
    console.error(`wrote ${path.relative(process.cwd(), file)} (${summary.noData} widget types)`);
  }
  if (flag('json')) { console.log(JSON.stringify({ summary, coverage: cov, results }, null, 2)); process.exitCode = summary.broken || presetFail ? 1 : 0; return; }   // no process.exit: piped output would be cut off

  console.log(`Snapshot: ${summary.snapshot.aps} APs, ${summary.snapshot.switches} switches, ${summary.snapshot.zones} zones/groups, ${summary.snapshot.controllers} controllers, ${summary.snapshot.alarms} alarms, intents ${summary.snapshot.intents ?? 'n/a'}, analytics ${summary.snapshot.analytics ? 'yes' : 'no'}`);
  const errs = Object.entries(summary.snapshot.errors); if (errs.length) console.log('Source errors:\n' + errs.map(([k, e]) => `  ${k}: ${e}`).join('\n'));
  console.log(`\n${summary.widgets} widgets: ${summary.ok} OK · ${summary.partly} partly · ${summary.warmup} need history · ${summary.empty} empty · ${summary.noData} no data · ${summary.na} n/a · ${summary.broken} broken\n`);
  const byGroup = new Map(); for (const r of results) { if (!byGroup.has(r.group)) byGroup.set(r.group, []); byGroup.get(r.group).push(r); }
  for (const [g, rs] of byGroup) {
    const ok = rs.filter((r) => r.status === 'OK').length;
    console.log(`${g}  (${ok}/${rs.length} OK)`);
    for (const r of rs) if (flag('all') || r.status !== 'OK') console.log(`  ${r.status.padEnd(8)} ${r.type.padEnd(34)} ${r.why}`);
  }
  if (flag('partly')) { console.log('\nPARTLY: built on an empty source; check the value is real'); for (const r of results.filter((x) => x.status === 'PARTLY')) console.log(`  ${r.type.padEnd(34)} ${glance(r.payload)}`); }
  console.log('\nField coverage (rows with a value / rows):');
  for (const [k, c] of Object.entries(cov)) { const sparse = Object.entries(c.filled).filter(([, n]) => n === 0).map(([f]) => f); console.log(`  ${k}: ${c.rows} rows${sparse.length ? `; never filled: ${sparse.join(', ')}` : ''}`); }
  if (!only) {
    console.log(`\nDefault screens and offered presets: ${offered.length} checked`);
    if (!problems.length) console.log('  none hold widgets without data');
    for (const x of problems) console.log(`  ${x.bad.length ? 'NO DATA' : 'EMPTY  '} ${x.name}: ${[...x.bad, ...x.empty].join(', ')}`);
  }
  process.exitCode = summary.broken || presetFail ? 1 : 0;
})().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
