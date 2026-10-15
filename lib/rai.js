'use strict';
// RUCKUS AI (ruckus.cloud/ai) client + inventory collector.
// Auth (https://ai.docs.ruckus.cloud/api/ai/): an Application Token (Administration > Developers > Application Tokens) is a
// client ID + secret exchanged at https://auth.ruckus.cloud/oauth2/token (client_credentials, no tenant in the path) for a JWT.
// Documented REST lives at https://api.<region>ruckus.cloud/ai; the analytics GraphQL (undocumented, the same schema RUCKUS One's
// AI pages use) lives at https://<region>ruckus.cloud/analytics/api/rsa-data-api/graphql/<endpoint>. Both confirmed live.
// Delegated access (an MSP account reading a customer): add x-rks-tenantid — sent only when a tenant ID is configured.
const cfg = require('./config').r1;
const N = require('./normalize');

const AUTH = (process.env.RAI_AUTH_BASE || 'https://auth.ruckus.cloud').replace(/\/$/, '');
const TIMEOUT_MS = () => Math.max(1000, Number(process.env.R1_TIMEOUT_MS) || 45000);
async function fetchT(url, opts, what) {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS()) }); }
  catch (e) { if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${what} → no answer from RUCKUS AI within ${Math.round(TIMEOUT_MS() / 1000)} s`); throw e; }
}
// https://api.eu.ruckus.cloud -> https://eu.ruckus.cloud (the web host that serves the analytics GraphQL)
const webOf = (apiBase) => String(apiBase || 'https://api.ruckus.cloud').replace(/\/$/, '').replace('://api.', '://');

function createClient(conf) {
  let cached = null;
  const tenantHdr = () => (conf.tenantId ? { 'x-rks-tenantid': conf.tenantId } : {});
  async function getToken(force = false) {
    if (!conf.clientId || !conf.clientSecret) throw new Error('RUCKUS AI credentials not configured (Application Token client ID and secret)');
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const res = await fetchT(`${AUTH}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: conf.clientId, client_secret: conf.clientSecret }) }, 'token request');
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`RUCKUS AI token request failed (HTTP ${res.status}) — check the Application Token client ID and secret`);
    cached = { token: j.access_token, expiresAt: Date.now() + Math.max((Number(j.expires_in) || 3600) * 1000 - 60000, 15000) };
    return cached.token;
  }
  async function get(path, retry = true) {
    const res = await fetchT(`${String(conf.apiBase).replace(/\/$/, '')}/ai${path}`, { headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json', ...tenantHdr() } }, path);
    if (res.status === 401 && retry) { await getToken(true); return get(path, false); }
    const text = await res.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}${j && j.message ? `: ${j.message}` : ''}`);
    return j;
  }
  async function gql(query, variables, endpoint = 'analytics', retry = true) {
    const res = await fetchT(`${webOf(conf.apiBase)}/analytics/api/rsa-data-api/graphql/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json', ...tenantHdr() }, body: JSON.stringify({ query, variables }) }, endpoint);
    if (res.status === 401 && retry) { await getToken(true); return gql(query, variables, endpoint, false); }
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok || !j || j.errors) { const e = j && j.errors && j.errors[0]; throw new Error(`${endpoint} HTTP ${res.status}${e ? `: ${e.message}${e.extensions && e.extensions.code ? ` (${e.extensions.code})` : ''}` : ''}`); }
    return j.data;
  }
  // Used by the settings GUI: forget the token and prove the credentials work end to end (REST + GraphQL).
  async function test() {
    cached = null; await getToken(true);
    const systems = await get('/onboardedSystems');
    const now = Date.now(); const d = await gql('query($s:DateTime,$e:DateTime){ network(start:$s,end:$e){ zones { zoneName } } }', { s: new Date(now - 3600e3).toISOString(), e: new Date(now).toISOString() });
    const live = (systems || []).filter((s) => s.state === 'onboarded');
    return { venues: (d.network.zones || []).length, sample: live.slice(0, 3).map((s) => s.deviceName), summary: `${live.length} onboarded controller${live.length === 1 ? '' : 's'}, ${(d.network.zones || []).length} zones` };
  }
  return { get, gql, test, getToken, reset: () => { cached = null; } };
}

// ---- inventory: zones, controllers, APs, switches, incidents -> the wall's Snapshot rows ----
const iso = (ms) => new Date(ms).toISOString();
const INVENTORY = 'query($s:DateTime,$e:DateTime){ network(start:$s,end:$e){ zones { zoneName domain systemName apCount clientCount } controllers { name latestName model systemId serial } apHierarchy switchHierarchy } }';
// Extra switch fields (confirmed live: ~6 s for ~100 switches). poeUtilization is a 0..1 fraction and only some switches report it; switchCpuUtilizationPct
// came back 0 for every switch, so it is not used. If a tenant's schema rejects the extra fields the plain query runs instead.
const SWITCH_FIELDS = 'name mac model switchStatus firmware';
const SWITCH_EXTRA = 'switchIp type totalPortCount connectedWiredDevices poeUtilization';
const switchQuery = (fields) => `query($s:DateTime,$e:DateTime,$p:[HierarchyNodeInput]){ network(start:$s,end:$e){ hierarchyNode(path:$p,querySwitch:true){ switches { ${fields} } } } }`;
const INCIDENTS = 'query($s:DateTime,$e:DateTime,$p:[HierarchyNodeInput]){ network(start:$s,end:$e){ hierarchyNode(path:$p){ incidents(filter:{includeMuted:false}){ id code severity startTime endTime sliceType sliceValue system path { name type } impactedClientCount } } } }';
const INTENTS = 'query($s:DateTime,$e:DateTime,$p:[HierarchyNodeInput]){ network(start:$s,end:$e){ intents(page:1,pageSize:200,path:$p){ total totalActionNeeded totalAutoManaged totalNoAction data { code status displayStatus sliceType root } } } }';
const ROOT = [{ type: 'network', name: 'Network' }];

const AP_STATUS = { online: 'Operational', offline: 'Disconnected', discovery: 'Initializing' };
const apStatus = (s) => AP_STATUS[String(Array.isArray(s) ? s[0] : s || '').toLowerCase()] || N.normStatus(Array.isArray(s) ? s[0] : s);
const first = (v) => (Array.isArray(v) ? v[0] : v);

// Walk a hierarchy (system > domain… > zone|switchGroup > apGroup > ap|switch), carrying the names of the levels above each leaf.
function walk(nodes, leafType, ctx = {}, out = []) {
  for (const n of nodes || []) {
    if (n.type === leafType) { out.push({ ...n, ...ctx }); continue; }
    const next = { ...ctx }; if (n.type === 'domain') next.domain = ctx.domain ? `${ctx.domain} › ${n.name}` : n.name; else next[n.type] = n.name;
    walk(n.children, leafType, next, out);
  }
  return out;
}

// Zone (and switch group) names repeat across controllers; the id carries the controller so they stay distinct.
function venueTable(zones, groups) {
  const rows = [
    ...zones.map((z) => ({ id: `z:${z.systemName}/${z.zoneName}`, name: z.zoneName, kind: 'zone', system: z.systemName, domain: z.domain || '', clients: Number(z.clientCount) || 0, apCountAI: Number(z.apCount) || 0 })),
    ...groups.map((g) => ({ id: `g:${g.system}/${g.name}`, name: g.name, kind: 'switchGroup', system: g.system, domain: g.domain || '', clients: null }))
  ];
  const dup = new Map(); for (const r of rows) dup.set(r.name, (dup.get(r.name) || 0) + 1);
  for (const r of rows) if (dup.get(r.name) > 1) r.name = `${r.name} (${r.system})`;
  return rows;
}

const SEV = { Critical: 'Critical', High: 'Major', Medium: 'Minor', Low: 'Warning' };

async function fetchInventory(client, now = Date.now(), { codeInfo, sevLabel, isOpen }) {
  const v = { s: iso(now - 3600e3), e: iso(now) };
  const errors = {};
  const run = async (name, fn) => { try { return await fn(); } catch (e) { errors[name] = e.message; return null; } };
  const [inv, swl, inc, systems] = await Promise.all([
    run('inventory', () => client.gql(INVENTORY, v)),
    run('switches', async () => { try { return await client.gql(switchQuery(`${SWITCH_FIELDS} ${SWITCH_EXTRA}`), { ...v, p: ROOT }); } catch { return client.gql(switchQuery(SWITCH_FIELDS), { ...v, p: ROOT }); } }),
    run('alarms', () => client.gql(INCIDENTS, { s: iso(now - 7 * 86400e3), e: iso(now), p: ROOT })),
    run('controllers', () => client.get('/onboardedSystems'))
  ]);
  const net = (inv && inv.network) || {};
  // controllers: the GraphQL list (model, serial) joined with the REST onboarding state
  const onb = new Map((systems || []).map((s) => [s.deviceId, s]));
  const ctrls = (net.controllers || []).map((c) => { const o = onb.get(c.systemId) || {}; return { id: c.systemId, name: o.deviceName || c.latestName || first(c.name) || c.systemId, model: c.model || '', serial: c.serial || '', state: o.state || '', onboarding: o.status || '' }; });
  for (const s of systems || []) if (!ctrls.some((c) => c.id === s.deviceId) && s.state !== 'offboarded') ctrls.push({ id: s.deviceId, name: s.deviceName, model: '', serial: '', state: s.state || '', onboarding: s.status || '' });
  const sysName = new Map(ctrls.map((c) => [c.id, c.name]));

  const apLeaves = walk(net.apHierarchy, 'ap'); const swLeaves = walk(net.switchHierarchy, 'switch');
  const groups = []; const seenG = new Set();
  for (const l of swLeaves) { const k = `${l.system}/${l.switchGroup}`; if (l.switchGroup && !seenG.has(k)) { seenG.add(k); groups.push({ system: l.system, name: l.switchGroup, domain: l.domain }); } }
  const venues = venueTable(net.zones || [], groups);
  const vid = new Map(venues.map((x) => [x.id, x]));
  const zoneOf = (system, zone) => vid.get(`z:${system}/${zone}`) || { id: '', name: zone || '' };

  const aps = apLeaves.map((a) => { const z = zoneOf(a.system, a.zone); return {
    id: a.serial || a.mac, name: a.name || a.mac, mac: a.mac || '', model: first(a.model) || '', firmware: first(a.firmware) || '', ip: '', venueId: z.id, venue: z.name,
    status: apStatus(a.connectionStatus), health: 'UNKNOWN', meshRole: '', apGroup: a.apGroup || '', apGroupId: '', radios: [], clients: 0, uplink: '', system: a.system || '', domain: a.domain || '' }; });

  const swByMac = new Map((((swl && swl.network.hierarchyNode) || {}).switches || []).map((s) => [String(s.mac).toUpperCase(), s]));
  const swPlace = new Map(swLeaves.map((l) => [String(l.mac).toUpperCase(), l]));
  const macs = new Set([...swByMac.keys(), ...swPlace.keys()]);
  const switches = [...macs].map((mac) => {
    const s = swByMac.get(mac) || {}; const l = swPlace.get(mac) || {}; const g = l.switchGroup ? vid.get(`g:${l.system}/${l.switchGroup}`) : null;
    const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
    return { id: mac, name: s.name || l.name || mac, model: s.model || '', firmware: s.firmware || '', ip: s.switchIp || '', venueId: g ? g.id : '', venue: g ? g.name : '', status: N.normStatus(s.switchStatus), ports: num(s.totalPortCount) || 0, family: '', switchType: s.type || '', stack: '',
      poeTotalW: null, poeUsedW: null, poeUtil: num(s.poeUtilization) == null ? null : Math.max(0, Math.min(100, num(s.poeUtilization) * 100)), cpu: null, memory: null, alerts: 0, warning: false, uptime: '', uptimeSec: null, clients: num(s.connectedWiredDevices) || 0, system: l.system || '', domain: l.domain || '' };
  });

  // open incidents act as the wall's alarms (same list/tile/rule widgets); the full incident history goes to analytics widgets
  const incidents = (((inc && inc.network.hierarchyNode) || {}).incidents || []).map((x) => ({ ...x, start: Date.parse(x.startTime), end: Date.parse(x.endTime) }));
  const alarms = incidents.filter((x) => isOpen(x, now)).map((x) => {
    const p = x.path || []; const sys = (p.find((e) => e.type === 'system') || {}).name || sysName.get(x.system) || '';   // the path carries the controller NAME
    const leaf = p[p.length - 1] || {};
    const venue = leaf.type === 'zone' ? zoneOf(sys, leaf.name) : leaf.type === 'switchGroup' ? (vid.get(`g:${sys}/${leaf.name}`) || { id: '', name: leaf.name }) : { id: '', name: '' };
    const lvl = sevLabel(x.severity); const ci = codeInfo(x.code);
    return { id: x.id, severity: SEV[lvl] || 'Info', time: x.start || 0, cleared: false, entityType: x.sliceType || '', device: sys, venueId: venue.id, venue: venue.name, text: ci.title, kind: x.code, clients: x.impactedClientCount >= 0 ? x.impactedClientCount : null };
  });

  // client counts only exist per zone in RUCKUS AI (there is no per-client list), so the total is the zones' sum
  const clientTotal = (net.zones || []).reduce((n, z) => n + (Number(z.clientCount) || 0), 0);
  return { errors, venues, aps, switches, alarms, controllers: ctrls.map((c) => ({ ...c, aps: aps.filter((a) => a.system === c.name).length, zones: venues.filter((x) => x.kind === 'zone' && x.system === c.name).length })), clientTotal, raw: { zones: (net.zones || []).length, apLeaves: apLeaves.length, swLeaves: swLeaves.length, switchList: swByMac.size, incidents: incidents.length, systems: (systems || []).length } };
}

// Intent AI: what the AI recommends / has applied (slow source — changes rarely).
async function fetchIntents(client, now = Date.now()) {
  const d = await client.gql(INTENTS, { s: iso(now - 3600e3), e: iso(now), p: ROOT });
  const x = d.network.intents || {};
  return { total: x.total || 0, actionNeeded: x.totalActionNeeded || 0, autoManaged: x.totalAutoManaged || 0, noAction: x.totalNoAction || 0, rows: (x.data || []).map((r) => ({ code: r.code, status: r.displayStatus || r.status || '', scope: r.sliceType || '' })) };
}

module.exports = Object.assign(createClient(cfg), { createClient, fetchInventory, fetchIntents, _walk: walk, _venueTable: venueTable });
