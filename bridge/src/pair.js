import fs from 'node:fs';

const configPath = new URL('../config.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pairingCode = process.env.FMP_PAIRING_CODE;
delete process.env.FMP_PAIRING_CODE;
if (!pairingCode) throw new Error('Set FMP_PAIRING_CODE to the one-use print bridge code from your manager');
const server = new URL(config.serverUrl);
if (server.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)) {
  throw new Error('Remote pairing requires HTTPS');
}
const response = await fetch(new URL('/api/auth/terminal/register', server), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
  body: JSON.stringify({ pairingCode, kind: 'bridge', name: config.name || 'Store print bridge' }),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error || 'Pairing failed');
if (data.kind !== 'bridge') throw new Error('A print bridge pairing code is required');
fs.writeFileSync(configPath, JSON.stringify({ ...config, deviceToken: data.deviceToken, storeId: data.storeId }, null, 2) + '\n', { mode: 0o600 });
console.log('Print bridge paired with store ' + data.storeId);
