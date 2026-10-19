'use strict';
// A synthetic RUCKUS AI (token, REST onboardedSystems, analytics GraphQL) for tests: two controllers, three zones, a few APs and switches, one incident,
// a handful of Intent AI rows. Names and numbers are made up; the shapes follow what a live tenant returned.
const https = require('node:https');

function startMockAi({ key, cert }, port = 0) {
  const stats = { tokens: 0, graphql: 0 }; const now = Date.now();
  const ap = (name, mac, model, st) => ({ type: 'ap', name, mac, serial: `SN-${name}`, model: [model], firmware: ['7.1.0'], connectionStatus: [st] });
  const network = {
    zones: [{ zoneName: 'North', domain: 'Acme', systemName: 'SZ-One', apCount: 3, clientCount: 12 }, { zoneName: 'South', domain: 'Acme', systemName: 'SZ-One', apCount: 1, clientCount: 0 }, { zoneName: 'Lab', domain: 'Acme', systemName: 'SZ-Two', apCount: 0, clientCount: 3 }],
    controllers: [{ name: ['SZ-One'], latestName: 'SZ-One', model: 'SZ144', systemId: 'sys1', serial: 'C1' }, { name: ['SZ-Two'], latestName: 'SZ-Two', model: 'vSCGc', systemId: 'sys2', serial: 'C2' }],
    apHierarchy: [{ type: 'domain', name: 'Acme', children: [{ type: 'system', name: 'SZ-One', children: [
      { type: 'zone', name: 'North', children: [ap('AI-AP-1', 'aa:00:00:00:01:01', 'R550', 'online'), ap('AI-AP-2', 'aa:00:00:00:01:02', 'R650', 'online'), ap('AI-AP-3', 'aa:00:00:00:01:03', 'R550', 'offline')] },
      { type: 'zone', name: 'South', children: [ap('AI-AP-4', 'aa:00:00:00:01:04', 'T350', 'online')] }] }] }],
    switchHierarchy: [{ type: 'domain', name: 'Acme', children: [{ type: 'system', name: 'SZ-One', children: [{ type: 'switchGroup', name: 'Closets', children: [{ type: 'switch', name: 'AI-SW-1', mac: 'bb:00:00:00:01:01' }, { type: 'switch', name: 'AI-SW-2', mac: 'bb:00:00:00:01:02' }] }] }] }]
  };
  const iso = (m) => new Date(m).toISOString();
  const data = (q) => {
    if (/apHierarchy/.test(q)) return { network };
    if (/switches \{/.test(q)) return { network: { hierarchyNode: { switches: [{ name: 'AI-SW-1', mac: 'bb:00:00:00:01:01', model: 'ICX7150-C12P', switchStatus: 'online', firmware: 'SPR10010f', switchIp: '10.9.0.1', type: 'switch', totalPortCount: '12', connectedWiredDevices: 3, poeUtilization: 0.25 }, { name: 'AI-SW-2', mac: 'bb:00:00:00:01:02', model: 'ICX7150-C10ZP', switchStatus: 'offline', firmware: 'SPR10010f', switchIp: '10.9.0.2', type: 'switch', totalPortCount: '10', connectedWiredDevices: 0, poeUtilization: null }] } } };
    if (/incidents/.test(q)) return { network: { hierarchyNode: { incidents: [{ id: 'i1', code: 'i-switch-loop-detection', severity: 0.7, startTime: iso(now - 7200e3), endTime: iso(now - 600e3), sliceType: 'switch', sliceValue: 'AI-SW-1', system: 'SZ-One', path: [{ name: 'SZ-One', type: 'system' }], impactedClientCount: 0 }] } } };
    if (/intents\(/.test(q)) return { network: { intents: { total: 3, totalActionNeeded: 1, totalAutoManaged: 2, totalNoAction: 0, data: [{ code: 'c-probeflex-5g', status: 'new', displayStatus: 'new', sliceType: 'zone', root: 'x' }, { code: 'c-probeflex-5g', status: 'active', displayStatus: 'applied', sliceType: 'zone', root: 'y' }, { code: 'c-bgscan24g-enable', status: 'active', displayStatus: 'applied', sliceType: 'zone', root: 'z' }] } } };
    return { network: {} };
  };
  const server = https.createServer({ key, cert }, (req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/oauth2/token')) { stats.tokens++; return send(200, { access_token: 'tok', expires_in: 7200 }); }
      if (req.headers.authorization !== 'Bearer tok') return send(401, { message: 'unauthorized' });
      if (req.url.startsWith('/ai/onboardedSystems')) return send(200, [{ deviceId: 'sys1', deviceName: 'SZ-One', state: 'onboarded', status: 'onboarded' }, { deviceId: 'sys2', deviceName: 'SZ-Two', state: 'onboarded', status: 'onboarded' }]);
      if (req.url.includes('/graphql/')) { stats.graphql++; return send(200, { data: data((JSON.parse(b || '{}').query) || '') }); }
      send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, stats, close: () => new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) })));
}
module.exports = { startMockAi };
