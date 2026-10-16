'use strict';
// RUCKUS SmartZone client (direct, no RUCKUS AI): the controller's public REST API at https://<host>:<port>/wsg/api/public/v<N>_<M>/...
// STATUS: written from the SmartZone public API documentation, not yet confirmed against a live controller. How an API key is presented
// differs between releases, so the client tries the known styles once and remembers the one that works (conf.authStyle).
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

function createClient(conf) {
  let version = conf.version || '', style = conf.authStyle || '';
  const label = conf.name || conf.host;
  const withAuth = (st) => (st === 'bearer' ? { headers: { Authorization: `Bearer ${conf.apiKey}` }, query: {} } : st === 'x-api-key' ? { headers: { 'X-API-Key': conf.apiKey }, query: {} } : { headers: {}, query: { serviceTicket: conf.apiKey } });
  const STYLES = ['bearer', 'x-api-key', 'ticket'];

  async function apiVersions() {
    try { const r = await request(conf, 'GET', `${BASE}/apiInfo`); const v = r.json && (r.json.apiSupportVersions || r.json.supportedVersions); if (Array.isArray(v) && v.length) return [...v].sort((a, b) => verKey(b) - verKey(a)); } catch { /* fall back */ }
    return FALLBACK_VERSIONS;
  }
  // One authenticated GET against a path under the API version. Detects the version and auth style the first time.
  async function get(path, query = {}) {
    if (!conf.apiKey) throw new Error(`${label}: no API key set`);
    const versions = version ? [version] : await apiVersions();
    const styles = style ? [style] : STYLES;
    let last = null;
    for (const v of versions) {
      for (const st of styles) {
        const a = withAuth(st);
        const r = await request(conf, 'GET', `${BASE}/${v}${path}`, { headers: a.headers, query: { ...a.query, ...query } });
        if (r.status >= 200 && r.status < 300) { version = v; style = st; conf.version = v; conf.authStyle = st; return r.json; }
        last = r;
        if (r.status === 404) break;   // this version does not have the path: try the next version, not another auth style
        if (r.status !== 401 && r.status !== 403) throw new Error(`${label}: ${path} → HTTP ${r.status}${r.json && (r.json.message || r.json.errorMessage) ? `: ${r.json.message || r.json.errorMessage}` : ''}`);
      }
    }
    throw new Error(`${label}: ${path} → HTTP ${last ? last.status : 'no answer'}${last && last.status === 404 ? ' (no supported API version has it)' : last && (last.status === 401 || last.status === 403) ? ' (the API key was refused in every known style)' : ''}`);
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
    const zones = await get('/rkszones', { index: 0, listSize: 1 });
    const total = zones && (zones.totalCount != null ? zones.totalCount : (zones.list || []).length);
    return { venues: total, sample: [], version, authStyle: style, summary: `API ${version}, key accepted as ${style}, ${total} zone${total === 1 ? '' : 's'}` };
  }
  return { get, list, test, label, info: () => ({ version, authStyle: style }) };
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
