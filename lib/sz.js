'use strict';
// RUCKUS SmartZone client (direct, no RUCKUS AI): the controller's public REST API at https://<host>:<port>/wsg/api/public/v<N>_<M>/...
// STATUS: written from the SmartZone public API documentation, not yet confirmed against a live controller.
// Zero dependencies: node:https with a per-controller agent (SmartZone controllers usually have a self-signed certificate).
const https = require('node:https');

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
// Field names come from a live controller (SmartZone 7.2, API v14_0, 2026-10-16) for zones, APs, WLANs and the controller itself. Clients and
// alarms returned no rows on that controller, so their mappings are best guesses and are marked "unconfirmed".
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
const radioRow = (band, ch, tx) => ({ band, channel: Number.isFinite(Number(ch)) && ch !== '' && ch != null ? Number(ch) : null, width: '', txPower: Number.isFinite(parseFloat(tx)) ? parseFloat(tx) : null, rssi: null });
const sev = (v) => (/crit/i.test(v) ? 'Critical' : /major/i.test(v) ? 'Major' : /minor/i.test(v) ? 'Minor' : /warn/i.test(v) ? 'Warning' : 'Info');

async function fetchInventory(clients) {
  const errors = {}; const venues = []; const aps = []; const stations = []; const networks = []; const alarms = []; const controllers = [];
  let clientTotal = 0;
  await Promise.all(clients.map(async ({ id, client }) => {
    const run = async (name, fn) => { try { return await fn(); } catch (e) { errors[`${name}@${id}`] = e.message; return null; } };
    const [zones, apRows, wlans, cl, al, ctrl] = await Promise.all([
      run('zones', () => client.query('/query/zone')), run('aps', () => client.query('/query/ap')), run('networks', () => client.query('/query/wlan')),
      run('clients', () => client.query('/query/client')), run('alarms', () => client.query('/alert/alarm/list')), run('controller', () => client.list('/controller'))]);
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
      if (a.channel24gValue != null) radios.push(radioRow('2.4 GHz', a.channel24gValue, pick(a, ['actualTxPower24G', 'txPower24G'], null)));
      if (a.channel50gValue != null) radios.push(radioRow('5 GHz', a.channel50gValue, pick(a, ['actualTxPower5G', 'txPower5G'], null)));
      if (a.channel6gValue != null) radios.push(radioRow('6 GHz', a.channel6gValue, pick(a, ['actualTxPower6G', 'txPower6G'], null)));
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
    // UNCONFIRMED: this controller had no clients or alarms, so these keys are guesses from the SmartZone documentation. The diagnostics report which ones hit.
    for (const c of cl || []) {
      const ap = apByMac.get(String(pick(c, ['apMac', 'apMacAddress'])).toLowerCase()) || {}; const z = zbyName.get(pick(c, ['zoneName'])) || {};
      const rssi = Number(pick(c, ['rssi', 'receiveSignalStrength', 'signalStrength'], NaN)); const snr = Number(pick(c, ['snr', 'signalToNoise'], NaN));
      stations.push({ venueId: ap.venueId || z.id || '', ssid: pick(c, ['ssid', 'wlanName']), os: pick(c, ['osType', 'deviceType'], 'Unknown'), model: pick(c, ['modelName', 'model']), devType: pick(c, ['deviceType', 'osType']), security: pick(c, ['encryption', 'authMethod']),
        radioType: pick(c, ['radioType', 'radioMode']), health: '', identityGroup: '', vlan: pick(c, ['vlan']) ? `VLAN ${c.vlan}` : '', vendor: pick(c, ['vendor', 'manufacturer']), name: pick(c, ['hostname', 'hostName', 'userName', 'clientMac', 'macAddress']),
        band: /5/.test(String(pick(c, ['radioType', 'band']))) ? '5 GHz' : /6/.test(String(pick(c, ['radioType', 'band']))) ? '6 GHz' : /2\.?4|b\/g|n/i.test(String(pick(c, ['radioType', 'band']))) ? '2.4 GHz' : '', channel: pick(c, ['channel'], null),
        rssi: Number.isFinite(rssi) ? rssi : null, snr: Number.isFinite(snr) ? snr : null, bytes: num(pick(c, ['totalBytes', 'trafficBytes'], 0)), ap: ap.name || pick(c, ['apName']), apSerial: ap.id || '', apGroup: ap.apGroup || '',
        mac: pick(c, ['clientMac', 'macAddress', 'mac']), system: client.label });
    }
    for (const a of al || []) {
      const ap = apByMac.get(String(pick(a, ['apMac', 'entityId'])).toLowerCase()) || {};
      alarms.push({ id: `${id}:${pick(a, ['id', 'alarmUuid', 'alarmId'], alarms.length)}`, severity: sev(String(pick(a, ['severity', 'alarmSeverity']))), time: lastSeenMs(pick(a, ['raisedTime', 'alarmRaisedTime', 'startTime', 'timestamp'], 0)), cleared: Boolean(pick(a, ['clearedTime', 'clearTime'], '')) || /clear/i.test(String(a.state || '')),
        entityType: pick(a, ['category', 'entityType']), device: pick(a, ['apName', 'deviceName', 'source', 'entityName']), venueId: ap.venueId || '', venue: ap.venue || pick(a, ['zoneName']), text: pick(a, ['activity', 'description', 'alarmMessage', 'message', 'alarmType']), kind: pick(a, ['alarmType', 'alarmCode', 'type']) });
    }
    const nodes = ctrl || []; const c = nodes[0] || {};
    controllers.push({ id, name: client.label, model: pick(c, ['model']), serial: pick(c, ['serialNumber']), version: pick(c, ['version']), nodes: nodes.length, uptimeSec: num(c.uptimeInSec), state: errors[`aps@${id}`] ? 'error' : 'onboarded', onboarding: errors[`aps@${id}`] ? 'error' : 'onboarded',
      aps: aps.filter((x) => x.system === client.label).length, zones: (zones || []).length });
  }));
  // zone names repeat across controllers: keep them apart in the venue list (ids already differ)
  const dup = new Map(); for (const v of venues) dup.set(v.name, (dup.get(v.name) || 0) + 1);
  const rename = new Map(); for (const v of venues) if (dup.get(v.name) > 1) { const n = `${v.name} (${v.system})`; rename.set(v.id, n); v.name = n; }
  for (const a of aps) if (rename.has(a.venueId)) a.venue = rename.get(a.venueId);
  for (const x of stations) if (rename.has(x.venueId)) x.venue = rename.get(x.venueId);
  return { errors, venues, aps, switches: [], alarms, controllers, clients: stations, networks, clientTotal, raw: { controllers: clients.length, aps: aps.length, zones: venues.length, clients: stations.length, wlans: networks.length, alarms: alarms.length } };
}

module.exports = { createClient, fetchInventory, request, verKey };
