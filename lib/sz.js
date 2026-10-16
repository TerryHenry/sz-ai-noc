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
  return { get, list, test, login, label, info: () => ({ version }) };
}

// ---- inventory: zones, APs and controller info from every enabled controller, in the shape the rest of the app uses (same as lib/rai.js) ----
const pick = (o, keys, d = '') => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return d; };
const apStatus = (s) => { const v = String(s == null ? '' : s); return /offline|disconnect|lost|down/i.test(v) ? 'Disconnected' : /flag|degrad|warn/i.test(v) ? 'Degraded' : /discover|provision|initial|boot/i.test(v) ? 'Initializing' : /online|connect|up|run|ok/i.test(v) ? 'Operational' : 'Unknown'; };

async function fetchInventory(clients) {
  const errors = {}; const venues = []; const aps = []; const controllers = [];
  await Promise.all(clients.map(async ({ id, client }) => {
    const run = async (name, fn) => { try { return await fn(); } catch (e) { errors[`${name}@${id}`] = e.message; return null; } };
    const [zones, apRows, ctrl] = await Promise.all([run('zones', () => client.list('/rkszones')), run('aps', () => client.list('/aps')), run('controller', () => client.get('/controller'))]);
    const zname = new Map(); const nz = (zones || []).length;
    for (const z of zones || []) { const vid = `z:${id}/${pick(z, ['id', 'zoneId'])}`; zname.set(String(pick(z, ['id', 'zoneId'])), { id: vid, name: pick(z, ['name', 'zoneName']) }); venues.push({ id: vid, name: pick(z, ['name', 'zoneName'], vid), kind: 'zone', zone: pick(z, ['name', 'zoneName']), system: client.label, domain: '', clients: null }); }
    for (const a of apRows || []) {
      const z = zname.get(String(pick(a, ['zoneId']))) || { id: '', name: pick(a, ['zoneName']) };
      aps.push({ id: pick(a, ['serial', 'serialNumber', 'mac']), name: pick(a, ['name', 'deviceName', 'mac']), mac: pick(a, ['mac', 'apMac']), model: pick(a, ['model']), firmware: pick(a, ['firmwareVersion', 'version', 'fwVersion']),
        ip: pick(a, ['ip', 'ipAddress', 'externalIp', 'extIp']), venueId: z.id, venue: z.name, status: apStatus(pick(a, ['status', 'connectionState', 'connectionStatus'])), health: 'UNKNOWN', meshRole: '', apGroup: pick(a, ['apGroupName', 'apGroup']), apGroupId: '',
        radios: [], clients: Number(pick(a, ['numClients', 'clientCount', 'clients'], 0)) || 0, uplink: '', system: client.label, domain: '' });
    }
    const c = Array.isArray(ctrl) ? ctrl[0] : (ctrl && ctrl.list && ctrl.list[0]) || ctrl || {};
    controllers.push({ id, name: client.label, model: pick(c, ['model']), serial: pick(c, ['serialNumber', 'serial']), state: errors[`aps@${id}`] ? 'error' : 'onboarded', onboarding: errors[`aps@${id}`] ? 'error' : 'onboarded', aps: aps.filter((x) => x.system === client.label).length, zones: nz });
  }));
  return { errors, venues, aps, switches: [], alarms: [], controllers, clientTotal: null, raw: { controllers: clients.length, aps: aps.length, zones: venues.length } };
}

module.exports = { createClient, fetchInventory, request, verKey };
