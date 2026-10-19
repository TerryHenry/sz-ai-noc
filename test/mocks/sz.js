'use strict';
// A synthetic SmartZone 7.2 (API v14_0 only) for tests. Field names follow what a live controller returned (2026-10); every value is made up.
// Sign-in is the service ticket; the query endpoints reject the "start" property like the real controller; /switchm is the Switch Manager tree.
const https = require('node:https');

function startMockSz({ key, cert }, port = 0, opts = {}) {
  const tickets = new Set(); const stats = { logins: 0, calls: 0 }; const NOW = Date.now(); const clock = new Date(NOW).toISOString().replace('T', ' ').slice(0, 19);
  const zones = [{ id: 'z1', zoneName: 'Alpha', zoneFirmwareVersion: '7.2', domainName: 'Admin', apCountOnline: 1, apCountFlagged: 1, apCountOffline: 2, clientCount: 2 }, { id: 'z2', zoneName: 'Beta', zoneFirmwareVersion: '7.2', domainName: 'Admin', apCountOnline: 0, apCountFlagged: 0, apCountOffline: 0, clientCount: 0 }];
  const aps = [
    { deviceName: 'AP-1', apMac: 'AA:00:00:00:00:01', serial: 'S1', zoneId: 'z1', zoneName: 'Alpha', model: 'R550', status: 'Online', registrationState: 'Approved', connectionStatus: 'Connect', firmwareVersion: '7.2.0', ip: '10.0.0.1', numClients: 2, numClients24G: 1, numClients5G: 1, channel24G: '6 (20MHz)', channel5G: '36 (80MHz)', channel24gValue: 6, channel50gValue: 36, noise24G: -92, noise5G: -95, airtime24G: 12, airtime5G: 3, eirp24G: 18, eirp50G: 20, actualTxPower24G: 'N/A', actualTxPower5G: 'N/A', apGroupName: 'default', meshRole: 'DISABLED', isOverallHealthStatusFlagged: false },
    { deviceName: 'AP-2', apMac: 'AA:00:00:00:00:02', serial: 'S2', zoneId: 'z1', zoneName: 'Alpha', model: 'R650', status: 'Flagged', registrationState: 'Approved', connectionStatus: 'Connect', firmwareVersion: '7.2.0', ip: '10.0.0.2', numClients: 0, channel24gValue: 1, channel50gValue: 0, channel24G: '1 (20MHz)', channel5G: 'Disabled (40MHz)', isOverallHealthStatusFlagged: true, apGroupName: 'default', meshRole: 'DISABLED' },
    { deviceName: 'AP-3', apMac: 'AA:00:00:00:00:03', serial: 'S3', zoneId: 'z1', zoneName: 'Alpha', model: 'R550', status: 'Offline', registrationState: 'Approved', connectionStatus: 'Disconnect', firmwareVersion: '7.2.0', ip: '10.0.0.3', numClients: 0, channel24gValue: 0, channel50gValue: 0, apGroupName: 'default', meshRole: 'DISABLED' },
    { deviceName: 'AP-4', apMac: 'AA:00:00:00:00:04', serial: 'S4', zoneId: 'z1', zoneName: 'Alpha', model: 'R550', status: 'Offline', registrationState: 'Pending', connectionStatus: 'Disconnect', firmwareVersion: '7.2.0', ip: '10.0.0.4', numClients: 0, channel24gValue: 0, channel50gValue: 0, apGroupName: 'default', meshRole: 'DISABLED' }];
  const wlans = [{ wlanId: '12', name: 'Corp', ssid: 'Corp', authType: 'Standard', authMethod: 'OPEN', encryptionMethod: 'WPA2', vlan: 10, clients: 1, zoneId: 'z1', zoneName: 'Alpha' }, { wlanId: '13', name: 'Guest', ssid: 'Guest', authType: 'GuestAccess', authMethod: 'OPEN', encryptionMethod: 'NONE', vlan: 20, clients: 1, zoneId: 'z1', zoneName: 'Alpha' }];
  const clients = [
    { apMac: 'AA:00:00:00:00:01', apName: 'AP-1', hostname: 'laptop', osType: 'Windows', modelName: 'X1', deviceType: 'Laptop', ssid: 'Corp', txBytes: 8000000, rxBytes: 3000000, rssi: -60, snr: 30, radioType: '11ac', channel: 36, vlan: 10, authMethod: 'Standard+Open', encryptionMethod: 'WPA2-AES', userName: 'bob', clientMac: '02:AA:00:00:00:10', zoneId: 'z1', sessionStartTime: NOW - 600e3, wlanId: '12' },
    { apMac: 'AA:00:00:00:00:01', apName: 'AP-1', hostname: 'phone', osType: 'iOS', modelName: 'iPhone', deviceType: 'Phone', ssid: 'Guest', txBytes: 100000, rxBytes: 50000, rssi: -70, snr: 20, radioType: 'b/g/n', channel: 6, vlan: 20, authMethod: 'Standard+Open', encryptionMethod: 'NONE', userName: 'visitor1', clientMac: '02:AA:00:00:00:11', zoneId: 'z1', sessionStartTime: NOW - 300e3, wlanId: '13' }];
  const alarms = [{ id: 'al1', insertionTime: NOW - 120e3, alarmType: 'AP rebooted by system', alarmCode: 302, alarmState: 'Outstanding', severity: 'Major', activity: 'AP [AP-1@AA:00:00:00:00:01] was rebooted by the system.', acknowledged: 'No', category: 'AP', clearTime: null }];
  const events = [{ id: 'ev1', insertionTime: NOW - 60e3, eventType: 'Switch Connection', eventCode: 22082, severity: 'Informational', category: 'Switch', activity: '[SWSERIAL1 / ICX8200-48PF Core] Switch is connected to the controller.' }, { id: 'ev2', insertionTime: NOW - 50e3, eventType: 'AP connected', eventCode: 1, severity: 'Informational', category: 'AP', activity: 'AP connected' }];
  const switches = [
    { id: '38:45:3B:00:00:01', switchName: 'ICX8200-48PF Core', macAddress: '38:45:3B:00:00:01', model: 'ICX8200-48PF', family: 'ICX8200', ipAddress: '10.0.1.1', registrationStatus: 'APPROVED', ports: 4, numOfUnits: 1, poe: { total: 150000, free: 120000, percent: 20 }, alarm: 0, upTime: '1 day, 2:03:04.00', firmwareVersion: 'RDR10010h07', serialNumber: 'SWSERIAL1', groupName: 'Core', groupId: 'g1', status: 'ONLINE', stackId: null, domainId: 'd1' },
    { id: '78:A6:E1:00:00:02', switchName: 'ICX7150-Edge', macAddress: '78:A6:E1:00:00:02', model: 'ICX7150-C12P', family: '', ipAddress: '10.0.1.2', registrationStatus: 'APPROVED', ports: 12, numOfUnits: 1, poe: { total: 0, free: 0, percent: 0 }, alarm: 0, upTime: '', firmwareVersion: 'SPS09010a', serialNumber: 'SWSERIAL2', groupName: 'Core', groupId: 'g1', status: 'OFFLINE', stackId: null, domainId: 'd1' }];
  const ports = [
    { id: 'p1', switchId: '38:45:3B:00:00:01', switchName: 'ICX8200-48PF Core', switchModel: 'ICX8200-48PF', portIdentifier: '1/1/1', name: '1/1/1', status: 'Up', adminStatus: 'Up', portSpeed: '1 Gb/sec', inUtilization: 0.5, outUtilization: 0.2, inUtilizationKbps: 5000, outUtilizationKbps: 2000, poe: { total: 30000, free: 24000, percent: 20 }, portError: { inError: 1, outError: 0, crcError: 2, inDiscard: 0 }, unTaggedVlan: '1', stpState: null, opticsType: '1 Gbits per second copper', connectedDevice: [{ remoteDeviceName: 'ap-uplink' }], lagConfig: { lagName: '' } },
    { id: 'p2', switchId: '38:45:3B:00:00:01', switchName: 'ICX8200-48PF Core', switchModel: 'ICX8200-48PF', portIdentifier: '1/1/2', name: '1/1/2', status: 'Down', adminStatus: 'Up', portSpeed: 'link down or no traffic', inUtilization: 0, outUtilization: 0, inUtilizationKbps: 0, outUtilizationKbps: 0, poe: { total: 0, free: 0, percent: 0 }, portError: { inError: 0, outError: 0, crcError: 0, inDiscard: 0 }, unTaggedVlan: '1', stpState: null, opticsType: '1 Gbits per second copper', connectedDevice: null, lagConfig: { lagName: '' } },
    { id: 'p3', switchId: '38:45:3B:00:00:01', switchName: 'ICX8200-48PF Core', switchModel: 'ICX8200-48PF', portIdentifier: '1/1/3', name: '1/1/3', status: 'Down', adminStatus: 'Down', portSpeed: 'link down or no traffic', inUtilization: 0, outUtilization: 0, inUtilizationKbps: 0, outUtilizationKbps: 0, poe: { total: 0, free: 0, percent: 0 }, portError: { inError: 0, outError: 0, crcError: 0, inDiscard: 0 }, unTaggedVlan: '1', stpState: null, opticsType: '1 Gbits per second copper', connectedDevice: null, lagConfig: { lagName: 'lag1' } }];
  const guests = [{ id: 'gp1', guestName: 'visitor1', wlan: { id: '13', name: 'Guest' }, zone: { id: 'z1', name: 'Alpha' }, passValidFor: { expirationValue: 7, expirationUnit: 'DAY' }, maxDevices: { maxDevicesAllowed: true, maxDevicesNumber: 2 }, generatedOn: clock.replace(/-/g, '/'), expirationDate: new Date(NOW + 7 * 86400e3).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/'), isDisabled: 'NO', key: 'SECRET-PASS-CODE-123' }];
  const dpsk = [{ key: 'SECRET-DPSK-PASSPHRASE', createDateTime: NOW - 86400e3, ueMac: {}, vlanId: 100, wlanId: '12', zoneId: 'z1', userName: 'unit-101', ttl: 0, group: true, expired: false, expirationTime: 0 }];
  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const page = (all, b) => { const pg = b.page || 1, lim = b.limit || 100; return { totalCount: all.length, hasMore: pg * lim < all.length, firstIndex: (pg - 1) * lim, list: all.slice((pg - 1) * lim, pg * lim) }; };

  const server = https.createServer({ key, cert }, (req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'https://x'); const p = u.pathname; stats.calls++;
      if (p === '/__stats') return send(res, 200, stats);
      if (p === '/__expire') { tickets.clear(); return send(res, 200, {}); }
      if (p.endsWith('/apiInfo')) return send(res, 200, { apiSupportVersions: ['v14_0', 'v13_1', 'v11_1'] });
      if (p.endsWith('/serviceTicket') && req.method === 'POST') {
        if (!p.includes('/v14_0/')) return send(res, 404, { success: false });
        const b = JSON.parse(body || '{}'); if (b.username !== 'ro' || b.password !== 'pw') return send(res, 401, { message: 'Invalid credentials' });
        stats.logins++; const t = `ST-${stats.logins}`; tickets.add(t); return send(res, 200, { controllerVersion: '7.2.0.0.1', serviceTicket: t });
      }
      if (p.endsWith('/serviceTicket') && req.method === 'DELETE') return send(res, 200, {});
      if (!tickets.has(u.searchParams.get('serviceTicket'))) return send(res, 401, { message: 'Session expired' });
      if (!p.includes('/v14_0/')) return send(res, 404, { success: false });
      const b = body ? JSON.parse(body) : {}; const q = (all) => send(res, 200, page(all, b));
      if (req.method === 'POST' && 'start' in b) return send(res, 400, { message: 'object instance has properties which are not allowed by the schema: ["start"]' });
      const sw = p.startsWith('/switchm/api/'); const route = p.replace(/^.*\/v14_0/, '');
      if (opts.noSwitchManager && sw) return send(res, 404, { success: false });
      // --- main API
      if (route === '/rkszones') return send(res, 200, page(zones.map((z) => ({ id: z.id, name: z.zoneName })), { page: 1, limit: Number(u.searchParams.get('listSize')) || 100 }));
      if (route === '/domains') return send(res, 200, { totalCount: 2, hasMore: false, firstIndex: 0, list: [{ id: 'd0', name: 'Administration Domain', domainType: 'REGULAR' }, { id: 'd1', name: 'Sub', domainType: 'REGULAR', parentDomainId: 'd0' }] });
      if (route === '/controller') return send(res, 200, { totalCount: 1, hasMore: false, firstIndex: 0, list: [{ id: 'c1', model: 'vSZ-H', serialNumber: 'CS1', version: '7.2.0.0.1', uptimeInSec: 1000, name: 'ctrl' }] });
      if (route === '/controller/c1/statistics') return send(res, 200, { list: [{ timestamp: NOW - 300e3, cpu: { percent: 10 }, memory: { percent: 50 }, disk: { total: 100, free: 50 } }, { timestamp: NOW, cpu: { percent: 40.1 }, memory: { percent: 82.3 }, disk: { total: 100, free: 60 } }] });
      if (route === '/system/systemTime') return send(res, 200, { timezone: 'UTC', currentSystemTimeString: `${clock} UTC`, currentSystemTimeUTCString: `${clock} UTC` });
      if (route === '/query/zone') return q(zones);
      if (route === '/query/ap') return q(aps);
      if (route === '/query/wlan') return q(wlans);
      if (route === '/query/client') return q(clients);
      if (route === '/query/dpsk') return q(dpsk);
      if (route === '/vlanpoolings/query') return q([{ id: 'vp1', name: 'pool-a', pool: '64', algo: 'MAC_HASH' }]);
      if (route === '/wifiCalling/query') return q([{ id: 'w1', name: 'Carrier', priority: 'VOICE', epdgs: [{ fqdn: 'epdg.example.net', ip: '' }] }]);
      if (route === '/alert/alarm/list') return q(alarms);
      if (route === '/alert/event/list') return q(events);
      if (route === '/alert/alarmSummary') return send(res, 200, { criticalCount: 0, majorCount: 1, minorCount: 0, warningCount: 0 });
      if (route === '/identity/guestpassList') return q(guests);
      // --- Switch Manager
      const inDomain = (b.filters || []).some((f) => f.type === 'DOMAIN' && f.value === 'd1');
      if (route === '/switch') return q(inDomain ? switches : []);
      if (route === '/switch/ports/details') return q(inDomain ? ports : []);
      if (route === '/switch/clients') return q(inDomain ? [{ switchId: '38:45:3B:00:00:01', remoteDeviceName: 'ap-uplink' }] : []);
      if (route === '/health/cpu/agg') return send(res, 200, { list: [{ key: 'Max', value: 5 }, { key: 'Avg', value: 3 }, { key: 'Min', value: 1 }, { key: 'ICX8200-48PF Core', value: 4 }] });
      if (route === '/health/mem/agg') return send(res, 200, { list: [{ key: 'Max', value: 45 }, { key: 'Avg', value: 44 }, { key: 'Min', value: 43 }, { key: 'ICX8200-48PF Core', value: 44 }] });
      return send(res, 404, { success: false });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, stats, expireTickets: () => tickets.clear(), close: () => new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) })));
}
module.exports = { startMockSz };
