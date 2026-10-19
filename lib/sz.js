'use strict';
// RUCKUS SmartZone client (direct, no RUCKUS AI): the controller's public REST API at https://<host>:<port>/wsg/api/public/v<N>_<M>/...
// STATUS: written from the SmartZone public API documentation, not yet confirmed against a live controller.
// Zero dependencies: node:https with a per-controller agent (SmartZone controllers usually have a self-signed certificate).
const https = require('node:https');
const N = require('./normalize');

const TIMEOUT_MS = () => Math.max(1000, Number(process.env.SZ_TIMEOUT_MS) || 30000);
const BASE = '/wsg/api/public';
const FALLBACK_VERSIONS = ['v13_1', 'v13_0', 'v12_0', 'v11_1', 'v11_0', 'v10_0', 'v9_1', 'v9_0', 'v8_2', 'v7_1'];
const verKey = (v) => String(v).replace(/^v/, '').split('_').map(Number).reduce((n, x, i) => n + (x || 0) / 100 ** i, 0);

function request(conf, method, path, { headers = {}, body, query } = {}) {
  const qs = query && Object.keys(query).length ? (path.includes('?') ? '&' : '?') + new URLSearchParams(query).toString() : '';
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ host: conf.host, port: conf.port || 8443, method, path: path + qs, rejectUnauthorized: conf.verifyTls === true, timeout: TIMEOUT_MS(),
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${conf.host} within ${Math.round(TIMEOUT_MS() / 1000)} s`)));
    req.on('error', (e) => reject(e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /self.signed|certificate/i.test(e.message) ? new Error(`${conf.host}: certificate not trusted (turn off "Verify certificate" for a self-signed controller)`) : e));
    if (data) req.write(data); req.end();
  });
}

// Sign-in is the SmartZone "service ticket": POST /wsg/api/public/v<N>_<M>/serviceTicket {username, password} answers { serviceTicket, controllerVersion },
// and every later call carries ?serviceTicket=<ticket>. A ticket expires after a period of inactivity, so a 401/403 (or a "session expired" answer)
// signs in again once. Use a dedicated read-only administrator: the wall only reads.
function createClient(conf) {
  let version = conf.version || '', ticket = '', loginAt = 0;
  const label = conf.name || conf.host;
  const apiErr = (r) => (r.json && (r.json.message || r.json.errorMessage || r.json.error)) || '';
  async function apiVersions() {
    try { const r = await request(conf, 'GET', `${BASE}/apiInfo`); const v = r.json && (r.json.apiSupportVersions || r.json.supportedVersions); if (Array.isArray(v) && v.length) return [...v].sort((a, b) => verKey(b) - verKey(a)); } catch { /* fall back */ }
    return FALLBACK_VERSIONS;
  }
  async function login() {
    if (!conf.username || !conf.password) throw new Error(`${label}: no user name or password set`);
    const versions = version ? [version] : await apiVersions(); let last = null;
    for (const v of versions) {
      const r = await request(conf, 'POST', `${BASE}/${v}/serviceTicket`, { body: { username: conf.username, password: conf.password } });
      if (r.status >= 200 && r.status < 300 && r.json && r.json.serviceTicket) { version = v; ticket = r.json.serviceTicket; loginAt = Date.now(); conf.version = v; return { version: v, controllerVersion: r.json.controllerVersion || '' }; }
      last = r;
      if (r.status === 404) continue;   // this controller does not speak that API version
      if (r.status === 401 || r.status === 403 || /password|credential|login|authentic/i.test(apiErr(r))) throw new Error(`${label}: sign-in refused (check the user name and password; the account must be allowed to use the REST API)`);
      throw new Error(`${label}: sign-in → HTTP ${r.status}${apiErr(r) ? ': ' + apiErr(r) : ''}`);
    }
    throw new Error(`${label}: no supported API version answered the sign-in${last ? ` (last HTTP ${last.status})` : ''}`);
  }
  async function get(path, query = {}, retry = true) {
    if (!ticket) await login();
    const r = await request(conf, 'GET', `${BASE}/${version}${path}`, { query: { ...query, serviceTicket: ticket } });
    if ((r.status === 401 || r.status === 403 || /session|ticket|expired/i.test(apiErr(r)) && r.status >= 400) && retry) { ticket = ''; return get(path, query, false); }
    if (r.status < 200 || r.status >= 300) throw new Error(`${label}: ${path} → HTTP ${r.status}${apiErr(r) ? ': ' + apiErr(r) : ''}`);
    return r.json;
  }
  async function post(path, body, retry = true) {
    if (!ticket) await login();
    const r = await request(conf, 'POST', `${BASE}/${version}${path}`, { body, query: { serviceTicket: ticket } });
    if ((r.status === 401 || r.status === 403 || /session|ticket|expired/i.test(apiErr(r)) && r.status >= 400) && retry) { ticket = ''; return post(path, body, false); }
    if (r.status < 200 || r.status >= 300) throw new Error(`${label}: ${path} → HTTP ${r.status}${apiErr(r) ? ': ' + apiErr(r) : ''}`);
    return r.json;
  }
  // Query endpoints (POST /query/ap, /query/zone, /query/wlan, /query/client, /alert/alarm/list): body { page, limit }, answer { totalCount, hasMore, list }.
  async function query(path, { limit = 1000, maxPages = 30, filters } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const j = await post(path, { page, limit, ...(filters ? { filters } : {}) });
      const rows = (j && j.list) || [];
      out.push(...rows);
      if (!j || !j.hasMore || !rows.length) break;
    }
    return out;
  }
  // List endpoints answer { totalCount, hasMore, firstIndex, list: [...] }.
  async function list(path, { pageSize = 1000, maxPages = 50, query = {} } = {}) {
    const out = [];
    for (let i = 0, index = 0; i < maxPages; i++) {
      const j = await get(path, { ...query, index, listSize: pageSize });
      const rows = Array.isArray(j) ? j : (j && j.list) || [];
      out.push(...rows);
      if (Array.isArray(j) || !j || !j.hasMore || !rows.length) break;
      index += rows.length;
    }
    return out;
  }
  async function test() {
    const who = await login();
    const zones = await get('/rkszones', { index: 0, listSize: 1 });
    const total = zones && (zones.totalCount != null ? zones.totalCount : (zones.list || []).length);
    return { venues: total, sample: [], version: who.version, controllerVersion: who.controllerVersion, summary: `API ${who.version}${who.controllerVersion ? `, controller ${who.controllerVersion}` : ''}, signed in, ${total} zone${total === 1 ? '' : 's'}` };
  }
  return { get, list, post, query, test, login, label, info: () => ({ version }) };
}

// ---- inventory: from every enabled controller, in the shape the rest of the app uses (the same as lib/rai.js) ----
// Field names come from a live controller (SmartZone 7.2, API v14_0, 2026-10-16/19): zones, APs, WLANs, clients, alarms, DPSK, VLAN pools, Wi-Fi calling, controller load.
const pick = (o, keys, d = '') => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return d; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const lastSeenMs = (v) => { const n = Number(v); return Number.isFinite(n) ? (n > 1e11 ? n : n * 1000) : 0; };
function apState(a) {
  const st = String(pick(a, ['status'])); const reg = String(pick(a, ['registrationState']));
  if (/^online$/i.test(st)) return 'Operational';
  if (/flag|degrad/i.test(st)) return 'Degraded';
  if (/offline|disconnect/i.test(st)) return /pending/i.test(reg) ? 'Initializing' : 'Disconnected';
  if (/discover|provision|initial|reboot|boot/i.test(st)) return 'Initializing';
  return /^connect/i.test(String(pick(a, ['connectionStatus']))) ? 'Operational' : /disconnect/i.test(String(pick(a, ['connectionStatus']))) ? 'Disconnected' : 'Unknown';
}
// "36 (80MHz)" -> channel 36, width 80 MHz. noise is in dBm, airtime a percentage (both only meaningful while the AP is online).
const widthOf = (s) => { const m = /\((\d+)\s*MHz\)/i.exec(String(s || '')); return m ? `${m[1]} MHz` : ''; };
// actualTxPower is a number or "N/A"/"max"; the first usable number wins (parseFloat of a text value is NaN, so the EIRP fallback is passed in as a second candidate)
const firstNum = (o, keys) => { for (const k of keys) { const n = parseFloat(o[k]); if (Number.isFinite(n)) return n; } return null; };
const radioRow = (band, ch, tx, label, noise, airtime) => ({ band, channel: Number.isFinite(Number(ch)) && ch !== '' && ch != null ? Number(ch) : null, width: widthOf(label), txPower: Number.isFinite(parseFloat(tx)) ? parseFloat(tx) : null, rssi: null,
  noise: Number.isFinite(Number(noise)) && noise != null ? Number(noise) : null, airtime: Number.isFinite(Number(airtime)) && airtime != null ? Number(airtime) : null });
const sev = (v) => (/crit/i.test(v) ? 'Critical' : /major/i.test(v) ? 'Major' : /minor/i.test(v) ? 'Minor' : /warn/i.test(v) ? 'Warning' : 'Info');

// Slower, rarely changing data (DPSK, VLAN pools, Wi-Fi calling, controller load) is cached per controller for a few minutes.
const TTL = { dpsk: 300e3, vlanPools: 300e3, wfc: 300e3, stats: 120e3, alarmSummary: 30e3 };
async function fetchInventory(clients, cache = new Map()) {
  const errors = {}; const venues = []; const aps = []; const stations = []; const networks = []; const alarms = []; const controllers = [];
  const dpskPools = []; const dpsk = []; const vlanPools = []; const wfcProfiles = []; const alarmCounts = { Critical: 0, Major: 0, Minor: 0, Warning: 0, any: false };
  let clientTotal = 0;
  await Promise.all(clients.map(async ({ id, client }) => {
    // Optional services (DPSK, VLAN pools, Wi-Fi calling, controller load, alarm counts): a controller release without them answers 404, which is not a problem.
    const OPTIONAL = new Set(['dpsk', 'vlanPools', 'wifiCalling', 'controllerLoad', 'alarmCounts']);
    const run = async (name, fn) => { try { return await fn(); } catch (e) { if (!(OPTIONAL.has(name) && /HTTP 404/.test(e.message))) errors[`${name}@${id}`] = e.message; return null; } };
    const cached = (name, fn) => { const k = `${id}|${name}`; const c = cache.get(k); if (c && Date.now() - c.at < TTL[name]) return Promise.resolve(c.rows); return fn().then((rows) => { cache.set(k, { at: Date.now(), rows }); return rows; }); };
    const [zones, apRows, wlans, cl, al, ctrl, dpskRows, vpRows, wfcRows, cstats, asum] = await Promise.all([
      run('zones', () => client.query('/query/zone')), run('aps', () => client.query('/query/ap')), run('networks', () => client.query('/query/wlan')),
      run('clients', () => client.query('/query/client')), run('alarms', () => client.query('/alert/alarm/list')), run('controller', () => client.list('/controller')),
      run('dpsk', () => cached('dpsk', () => client.query('/query/dpsk'))), run('vlanPools', () => cached('vlanPools', () => client.query('/vlanpoolings/query'))), run('wifiCalling', () => cached('wfc', () => client.query('/wifiCalling/query'))),
      run('controllerLoad', async () => { const c0 = (await client.list('/controller'))[0]; return c0 ? cached('stats', () => client.get(`/controller/${c0.id}/statistics`).then((j) => (Array.isArray(j) ? j : (j && j.list) || []))) : []; }),
      run('alarmCounts', () => cached('alarmSummary', () => client.post('/alert/alarmSummary', {})))]);
    const zmap = new Map(); const zbyName = new Map();
    for (const z of zones || []) {
      const zid = pick(z, ['id', 'zoneId']); const vid = `z:${id}/${zid}`; const name = pick(z, ['zoneName', 'name'], vid);
      const v = { id: vid, name, kind: 'zone', zone: name, system: client.label, domain: pick(z, ['domainName']), clients: num(z.clientCount), apCountAI: num(z.apCountOnline) + num(z.apCountFlagged) + num(z.apCountOffline) };
      venues.push(v); zmap.set(String(zid), v); zbyName.set(name, v); clientTotal += num(z.clientCount);
    }
    const apByMac = new Map();
    for (const a of apRows || []) {
      const z = zmap.get(String(pick(a, ['zoneId']))) || zbyName.get(pick(a, ['zoneName'])) || { id: '', name: pick(a, ['zoneName']) };
      const st = apState(a);
      const radios = [];
      const live = st === 'Operational' || st === 'Degraded';   // an offline AP still reports its last noise and airtime: leave them out
      const ok = (v) => v != null && Number(v) > 0;   // channel 0 = the radio is not operating
      if (ok(a.channel24gValue)) radios.push(radioRow('2.4 GHz', a.channel24gValue, firstNum(a, ['actualTxPower24G', 'eirp24G']), a.channel24G, live ? a.noise24G : null, live ? a.airtime24G : null));
      if (ok(a.channel50gValue)) radios.push(radioRow('5 GHz', a.channel50gValue, firstNum(a, ['actualTxPower5G', 'eirp50G']), a.channel5G, live ? a.noise5G : null, live ? a.airtime5G : null));
      if (ok(a.channel6gValue)) radios.push(radioRow('6 GHz', a.channel6gValue, firstNum(a, ['actualTxPower6G', 'eirp6G']), a.channel6G, live ? a.noise6G : null, live ? a.airtime6G : null));
      const row = { id: pick(a, ['serial', 'apMac']), name: pick(a, ['deviceName', 'name', 'apMac']), mac: pick(a, ['apMac', 'mac']), model: pick(a, ['model']), firmware: pick(a, ['firmwareVersion']), ip: pick(a, ['ip', 'extIp']),
        venueId: z.id, venue: z.name, status: st, health: a.isOverallHealthStatusFlagged ? 'POOR' : st === 'Operational' ? 'GOOD' : 'UNKNOWN', meshRole: /^(auto|disabled|none)?$/i.test(String(a.meshRole || '')) ? '' : String(a.meshRole),
        apGroup: pick(a, ['apGroupName']), apGroupId: pick(a, ['apGroupId']), radios, clients: num(a.numClients), uplink: '', system: client.label, domain: pick(a, ['domainName']) };
      aps.push(row); apByMac.set(String(row.mac).toLowerCase(), row);
    }
    for (const w of wlans || []) {
      const vlan = Number(w.vlan);
      networks.push({ id: `${id}:${pick(w, ['wlanId', 'id'])}`, name: pick(w, ['name', 'ssid']), ssid: pick(w, ['ssid', 'name']), type: pick(w, ['authType']), subType: '', security: [pick(w, ['authMethod']), pick(w, ['encryptionMethod'])].filter((x) => x && !/^none$/i.test(x)).join(' / ') || pick(w, ['authType']),
        captive: /hotspot|guest|web/i.test(String(w.authType || '')) ? String(w.authType) : '', vlan: Number.isFinite(vlan) ? `VLAN ${vlan}` : '', vlanId: Number.isFinite(vlan) ? vlan : null, clients: num(w.clients), aps: null, venue: pick(w, ['zoneName']), system: client.label });
    }
    // Clients (confirmed on a live SmartZone 7.2: apMac, apName, hostname, osType, modelName, deviceType, ssid, txBytes/rxBytes, rssi/snr/radioType/channel (null until the client has been active a while), vlan, authMethod, encryptionMethod, wlanId, sessionStartTime).
    for (const c of cl || []) {
      const ap = apByMac.get(String(pick(c, ['apMac'])).toLowerCase()) || {}; const z = zmap.get(String(pick(c, ['zoneId']))) || {};
      const rssi = Number(c.rssi); const snr = Number(c.snr); const ch = Number(c.channel); const rt = String(pick(c, ['radioType']));
      const band = /6\s*g|6ghz/i.test(rt) ? '6 GHz' : /5\s*g|5ghz|11a|ac|ax.*5/i.test(rt) ? '5 GHz' : /2\.?4|11b|11g|11n/i.test(rt) ? '2.4 GHz' : Number.isFinite(ch) && ch > 0 ? (ch <= 14 ? '2.4 GHz' : '5 GHz') : '';
      const vlan = Number(c.vlan);
      stations.push({ venueId: ap.venueId || z.id || '', ssid: pick(c, ['ssid']), os: pick(c, ['osType'], 'Unknown'), model: pick(c, ['modelName']), devType: pick(c, ['deviceType', 'osType']),
        security: pick(c, ['encryptionMethod']) || pick(c, ['authMethod']), radioType: rt, health: '', identityGroup: '', vlan: Number.isFinite(vlan) && c.vlan != null ? `VLAN ${vlan}` : '',
        vendor: N.vendorOf(pick(c, ['clientMac'])), name: pick(c, ['hostname', 'userName', 'clientMac']), band, channel: Number.isFinite(ch) && ch > 0 ? ch : null,
        rssi: Number.isFinite(rssi) && c.rssi != null ? rssi : null, snr: Number.isFinite(snr) && c.snr != null ? snr : null, noiseFloor: null, bytes: num(c.txBytes) + num(c.rxBytes), bytesDown: num(c.txBytes), bytesUp: num(c.rxBytes),   // txBytes = AP to client (downlink), rxBytes = client to AP (uplink)
        
        ap: ap.name || pick(c, ['apName']), apSerial: ap.id || '', apGroup: ap.apGroup || '', mac: pick(c, ['clientMac']), connectedAt: lastSeenMs(pick(c, ['sessionStartTime'], 0)) || null, wfc: false, wfcCarrier: '', system: client.label });
    }
    // Alarms (confirmed: id, insertionTime, alarmType, alarmCode, alarmState "Outstanding"/"Cleared", severity, activity, acknowledged, category, clearTime). The AP is only named inside `activity`: "AP [name@aa:bb:cc:dd:ee:ff] ...".
    for (const a of al || []) {
      const m = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(String(a.activity || '')); const ap = m ? apByMac.get(m[1].toLowerCase()) || {} : {};
      alarms.push({ id: `${id}:${pick(a, ['id'], alarms.length)}`, severity: sev(String(pick(a, ['severity']))), time: lastSeenMs(pick(a, ['insertionTime'], 0)), cleared: /clear/i.test(String(a.alarmState || '')) || Boolean(a.clearTime),
        entityType: pick(a, ['category']), device: ap.name || (m ? m[1] : ''), venueId: ap.venueId || '', venue: ap.venue || '', text: String(pick(a, ['activity', 'alarmType'])).replace(/\s+/g, ' ').trim(), kind: pick(a, ['alarmType']) });
    }
    // DPSK: SmartZone has no pools; a WLAN's DPSKs are the pool. The passphrase (`key`) is never copied into the snapshot.
    const wlanName = new Map((wlans || []).map((w) => [`${w.zoneId}|${w.wlanId}`, pick(w, ['name', 'ssid'])]));
    const poolOf = new Map();
    for (const d of dpskRows || []) {
      const wn = wlanName.get(`${d.zoneId}|${d.wlanId}`) || `WLAN ${d.wlanId}`; const pid = `${id}:${d.zoneId}:${d.wlanId}`;
      if (!poolOf.has(pid)) { const pool = { id: pid, name: wn, format: '', type: 'DPSK', deviceLimit: 0, networks: 1, expiration: Number(d.ttl) > 0 ? 'Time-limited' : 'Never expires', expiresAt: null }; poolOf.set(pid, pool); dpskPools.push(pool); }
      const exp = Number(d.expirationTime) > 0 ? Number(d.expirationTime) : null; const expired = Boolean(d.expired) || (exp != null && exp < Date.now());
      const bound = typeof d.ueMac === 'string' && d.ueMac ? 1 : 0; const vlan = Number(d.vlanId);
      dpsk.push({ id: `${pid}:${dpsk.length}`, pool: wn, poolId: pid, user: String(d.userName || ''), vlan: Number.isFinite(vlan) && d.vlanId != null ? `VLAN ${vlan}` : '', vlanId: Number.isFinite(vlan) && d.vlanId != null ? vlan : null,
        status: expired ? 'Expired' : 'Active', active: !expired, deviceLimit: 0, devices: bound, online: 0, seenRecently: false, lastSeen: null, created: Number(d.createDateTime) || null, expiresAt: exp, expiration: Number(d.ttl) > 0 ? `${d.ttl}` : '' });
    }
    for (const v of vpRows || []) vlanPools.push({ id: `${id}:${v.id}`, name: pick(v, ['name']), members: String(pick(v, ['pool'])), networks: 0, networkNames: '' });
    for (const w of wfcRows || []) wfcProfiles.push({ id: `${id}:${w.id}`, name: pick(w, ['name']), qos: String(pick(w, ['priority'])), epdgs: (Array.isArray(w.epdgs) ? w.epdgs : []).map((e) => e.fqdn || e.ip).filter(Boolean), networks: 0 });
    if (asum && typeof asum === 'object') { alarmCounts.any = true; alarmCounts.Critical += num(asum.criticalCount); alarmCounts.Major += num(asum.majorCount); alarmCounts.Minor += num(asum.minorCount); alarmCounts.Warning += num(asum.warningCount); }
    const lastStat = (cstats || []).reduce((m, r) => (!m || num(r.timestamp) >= num(m.timestamp) ? r : m), null) || {};
    const pct = (o) => (o && Number.isFinite(Number(o.percent)) ? Math.round(Number(o.percent) * 10) / 10 : null);
    const disk = lastStat.disk && num(lastStat.disk.total) > 0 ? Math.round((1 - num(lastStat.disk.free) / num(lastStat.disk.total)) * 1000) / 10 : null;
    const nodes = ctrl || []; const c = nodes[0] || {};
    controllers.push({ id, name: client.label, model: pick(c, ['model']), serial: pick(c, ['serialNumber']), version: pick(c, ['version']), nodes: nodes.length, uptimeSec: num(c.uptimeInSec), cpu: pct(lastStat.cpu), memory: pct(lastStat.memory), disk, state: errors[`aps@${id}`] ? 'error' : 'onboarded', onboarding: errors[`aps@${id}`] ? 'error' : 'onboarded',
      aps: aps.filter((x) => x.system === client.label).length, zones: (zones || []).length });
  }));
  // zone names repeat across controllers: keep them apart in the venue list (ids already differ)
  const dup = new Map(); for (const v of venues) dup.set(v.name, (dup.get(v.name) || 0) + 1);
  const rename = new Map(); for (const v of venues) if (dup.get(v.name) > 1) { const n = `${v.name} (${v.system})`; rename.set(v.id, n); v.name = n; }
  for (const a of aps) if (rename.has(a.venueId)) a.venue = rename.get(a.venueId);
  for (const x of stations) if (rename.has(x.venueId)) x.venue = rename.get(x.venueId);
  return { errors, venues, aps, switches: [], alarms, alarmCounts, controllers, clients: stations, networks, dpskPools, dpsk, vlanPools, wfcProfiles, clientTotal, raw: { controllers: clients.length, aps: aps.length, zones: venues.length, clients: stations.length, wlans: networks.length, alarms: alarms.length, dpsk: dpsk.length, vlanPools: vlanPools.length, wfcProfiles: wfcProfiles.length } };
}

module.exports = { createClient, fetchInventory, request, verKey };
