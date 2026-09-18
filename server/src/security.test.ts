import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { eq } from 'drizzle-orm';
import { createApp } from './app';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';
import { signSession } from './auth';
import { hashToken, issuePairing } from './pairing';
import { configureRealtime } from './realtime';
import { sessionSecret } from './security-config';

process.env.DATABASE_URL = '';
process.env.PGLITE_MEMORY = '1';

const app = createApp();
const server = http.createServer(app);
const io = new Server(server);
configureRealtime(io);
app.set('io', io);
const clients: Socket[] = [];
let origin = '';
let storeA = 0, storeB = 0, customerId = 0, foreignItem = 0, foreignUser = 0, foreignTicket = 0, foreignActivation = 0, foreignTime = 0;
let managerToken = '', employeeToken = '', terminalId = 0, rawDeviceToken = '';
let manager: typeof schema.users.$inferSelect;
const auth = (token = managerToken) => ({ Authorization: 'Bearer ' + token });
const db = await getDb();

async function pair(storeId: number, kind: 'pos' | 'bridge' = 'pos') {
  const approval = await issuePairing(db, storeId, kind);
  const result = await request(app).post('/api/auth/terminal/register').send({ pairingCode: approval.pairingCode, kind, name: 'Security fixture' });
  expect(result.status).toBe(200);
  return result.body as { terminalId: number; storeId: number; kind: string; deviceToken: string };
}

beforeAll(async () => {
  await runMigrations(db);
  await seedIfEmpty(db);
  const stores = await db.select().from(schema.stores);
  storeA = stores[0]!.id;
  const [second] = await db.insert(schema.stores).values({ name: 'Store B', taxRateBp: 0 }).returning();
  storeB = second!.id;
  const staff = await db.select().from(schema.users);
  manager = staff.find(user => user.role === 'manager')!;
  const employee = staff.find(user => user.role === 'employee')!;
  const terminal = await pair(storeA);
  terminalId = terminal.terminalId; rawDeviceToken = terminal.deviceToken;
  managerToken = signSession({ ...manager, terminalId });
  employeeToken = signSession({ ...employee, terminalId });
  const [customer] = await db.insert(schema.customers).values({ name: 'Shared fixture', storeCreditCents: 1000 }).returning();
  customerId = customer!.id;
  const [item] = await db.insert(schema.inventoryItems).values({ storeId: storeB, kind: 'device', name: 'Other store phone', qty: 1 }).returning();
  foreignItem = item!.id;
  const [user] = await db.insert(schema.users).values({ storeId: storeB, name: 'Other staff', initials: 'OS', pinHash: 'unused' }).returning();
  foreignUser = user!.id;
  const [ticket] = await db.insert(schema.repairTickets).values({ storeId: storeB, number: 'OTHER-1', customerId }).returning();
  foreignTicket = ticket!.id;
  const [activation] = await db.insert(schema.activations).values({ storeId: storeB, customerId, carrier: 'Fixture', kind: 'new_line' }).returning();
  foreignActivation = activation!.id;
  const [entry] = await db.insert(schema.timeEntries).values({ userId: foreignUser, clockIn: new Date() }).returning();
  foreignTime = entry!.id;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  clients.forEach(client => client.disconnect());
  await new Promise<void>(resolve => io.close(() => resolve()));
});

describe('store boundaries', () => {
  it.each(['employee', 'manager'])('denies cross-store inventory mutations for %s', async role => {
    const headers = auth(role === 'employee' ? employeeToken : managerToken);
    const patch = await request(app).patch('/api/inventory/' + foreignItem).set(headers).send({ name: 'Tampered' });
    expect(patch.status).toBe(404);
    for (const action of ['adjust', 'remove']) {
      const result = await request(app).post('/api/inventory/' + foreignItem + '/' + action).set(headers).send({ deltaQty: 1, reason: 'test' });
      expect(result.status).toBe(role === 'employee' ? 403 : 404);
    }
    const purchasesBefore = await db.select().from(schema.purchases);
    const receive = await request(app).post('/api/inventory/receive').set(headers).send({ supplier: 'Fixture', items: [{ itemId: foreignItem, qty: 2, unitCostCents: 500 }] });
    expect(receive.status).toBe(404);
    expect(await db.select().from(schema.purchases)).toHaveLength(purchasesBefore.length);
    const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, foreignItem));
    expect(item!.qty).toBe(1); expect(item!.name).toBe('Other store phone');
  });

  it('rejects direct quantity edits but permits an audited manager adjustment', async () => {
    const [item] = await db.insert(schema.inventoryItems).values({ storeId: storeA, kind: 'part', name: 'Own part', qty: 3 }).returning();
    for (const token of [employeeToken, managerToken]) {
      const result = await request(app).patch('/api/inventory/' + item!.id).set(auth(token)).send({ qty: 999 });
      expect(result.status).toBe(400);
    }
    const changed = await request(app).post('/api/inventory/' + item!.id + '/adjust').set(auth()).send({ deltaQty: 1, reason: 'Stock count' });
    expect(changed.status).toBe(200); expect(changed.body.qty).toBe(4);
    const movements = await db.select().from(schema.inventoryMovements).where(eq(schema.inventoryMovements.itemId, item!.id));
    expect(movements).toHaveLength(1);
  });

  it('denies staff/time/activation edits in another store', async () => {
    expect((await request(app).patch('/api/settings/staff/' + foreignUser).set(auth()).send({ active: false })).status).toBe(404);
    expect((await request(app).patch('/api/timeclock/' + foreignTime).set(auth()).send({ editNote: 'Wrong store', clockOut: new Date().toISOString() })).status).toBe(404);
    expect((await request(app).patch('/api/retail/activations/' + foreignActivation).set(auth(employeeToken)).send({ status: 'cancelled' })).status).toBe(404);
  });

  it.each(['complete', 'park'])('rejects foreign references before writing a %s sale', async action => {
    const before = await db.select().from(schema.sales);
    for (const line of [
      { kind: 'product', inventoryItemId: foreignItem },
      { kind: 'repair', ticketId: foreignTicket },
    ]) {
      const result = await request(app).post('/api/sales/' + action).set(auth(employeeToken)).send({
        lines: [{ ...line, description: 'Foreign reference', qty: 1, unitCents: 1000 }],
        payments: [{ method: 'cash', amountCents: 1060 }], printReceipt: false,
      });
      expect(result.status).toBe(404);
    }
    expect(await db.select().from(schema.sales)).toHaveLength(before.length);
  });

  it('rejects foreign parked sale and technician/activation associations', async () => {
    const [parked] = await db.insert(schema.sales).values({ storeId: storeB, ticketNumber: 'OTHER-PARKED', status: 'parked' }).returning();
    const result = await request(app).post('/api/sales/complete').set(auth(employeeToken)).send({
      parkedSaleId: parked!.id, lines: [{ kind: 'custom', description: 'Fixture', qty: 1, unitCents: 1000 }],
      payments: [{ method: 'cash', amountCents: 1060 }], printReceipt: false,
    });
    expect(result.status).toBe(404);
    expect((await request(app).post('/api/repairs').set(auth()).send({
      customerId, technicianId: foreignUser, devices: [{ label: 'Phone' }], lines: [{ deviceIndex: 0, description: 'Repair', priceCents: 1000 }],
    })).status).toBe(404);
    expect((await request(app).post('/api/retail/activations').set(auth()).send({
      customerId, carrier: 'Fixture', kind: 'new_line', deviceItemId: foreignItem,
    })).status).toBe(404);
  });

  it('preserves shared customers and usable cross-store credit', async () => {
    const otherTerminal = await pair(storeB);
    const [otherManager] = await db.insert(schema.users).values({ storeId: storeB, name: 'Store B manager', initials: 'BM', role: 'manager', pinHash: 'unused' }).returning();
    const token = signSession({ ...otherManager!, terminalId: otherTerminal.terminalId });
    const found = await request(app).get('/api/customers/' + customerId).set(auth(token));
    expect(found.status).toBe(200); expect(found.body.customer.storeCreditCents).toBe(1000);
    const spent = await request(app).post('/api/sales/complete').set(auth(token)).send({
      customerId, lines: [{ kind: 'custom', description: 'Shared credit spend', qty: 1, unitCents: 100, taxable: false }],
      payments: [{ method: 'store_credit', amountCents: 100 }], printReceipt: false,
    });
    expect(spent.status).toBe(200);
    const fromA = await request(app).get('/api/customers/' + customerId).set(auth(employeeToken));
    expect(fromA.body.customer.storeCreditCents).toBe(900);
  });
});

describe('pairing and revocation', () => {
  it('denies enrollment without pairing and denies employee approval', async () => {
    expect((await request(app).post('/api/auth/terminal/register').send({ storeId: storeB, name: 'Intruder' })).status).toBe(400);
    expect((await request(app).post('/api/auth/pairing').set(auth(employeeToken)).send({ kind: 'pos' })).status).toBe(403);
    const approved = await request(app).post('/api/auth/pairing').set(auth()).send({ kind: 'pos', storeId: storeB });
    expect(approved.status).toBe(200);
    const result = await request(app).post('/api/auth/terminal/register').send({ pairingCode: approved.body.pairingCode, storeId: storeB, name: 'Approved' });
    expect(result.body.storeId).toBe(storeA);
  });

  it('consumes a pairing code once under concurrent requests and stores only credential hashes', async () => {
    const approval = await issuePairing(db, storeA, 'pos');
    const results = await Promise.all(['One', 'Two'].map(name => request(app).post('/api/auth/terminal/register')
      .send({ pairingCode: approval.pairingCode, name })));
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    const issued = results.find(r => r.status === 200)!;
    const [saved] = await db.select().from(schema.terminals).where(eq(schema.terminals.id, issued.body.terminalId));
    expect(saved!.deviceToken).toBe(hashToken(issued.body.deviceToken));
    expect(saved!.deviceToken).not.toBe(issued.body.deviceToken);
  });

  it('rejects expired/wrong-kind codes without consuming wrong-kind approvals', async () => {
    const approval = await issuePairing(db, storeA, 'bridge');
    const wrong = await request(app).post('/api/auth/terminal/register').send({ pairingCode: approval.pairingCode, name: 'POS' });
    expect(wrong.status).toBe(401);
    const correct = await request(app).post('/api/auth/terminal/register').send({ pairingCode: approval.pairingCode, kind: 'bridge', name: 'Bridge' });
    expect(correct.status).toBe(200);
    expect((await request(app).get('/api/auth/staff').set('X-Device-Token', correct.body.deviceToken)).status).toBe(404);
    const expired = await issuePairing(db, storeA, 'pos');
    await db.update(schema.terminalPairings).set({ expiresAt: new Date(0) }).where(eq(schema.terminalPairings.codeHash, hashToken(expired.pairingCode.replaceAll('-', ''))));
    expect((await request(app).post('/api/auth/terminal/register').send({ pairingCode: expired.pairingCode, name: 'Late' })).status).toBe(401);
  });

  it('revokes existing sessions on PIN, role and active-state changes, including reactivation', async () => {
    const [user] = await db.insert(schema.users).values({ storeId: storeA, name: 'Revocation fixture', initials: 'RF', pinHash: await bcrypt.hash('6789', 4) }).returning();
    const stale = signSession({ ...user!, terminalId });
    expect((await request(app).get('/api/settings/store').set(auth(stale))).status).toBe(200);
    expect((await request(app).patch('/api/settings/staff/' + user!.id).set(auth()).send({ active: false })).status).toBe(200);
    expect((await request(app).get('/api/settings/store').set(auth(stale))).status).toBe(401);
    await request(app).patch('/api/settings/staff/' + user!.id).set(auth()).send({ active: true });
    expect((await request(app).get('/api/settings/store').set(auth(stale))).status).toBe(401);
    let fresh = await request(app).post('/api/auth/pin').send({ deviceToken: rawDeviceToken, userId: user!.id, pin: '6789' });
    expect(fresh.status).toBe(200);
    await request(app).patch('/api/settings/staff/' + user!.id).set(auth()).send({ pin: '7890' });
    expect((await request(app).get('/api/settings/store').set(auth(fresh.body.token))).status).toBe(401);
    fresh = await request(app).post('/api/auth/pin').send({ deviceToken: rawDeviceToken, userId: user!.id, pin: '7890' });
    expect(fresh.status).toBe(200);
    await request(app).patch('/api/settings/staff/' + user!.id).set(auth()).send({ role: 'manager' });
    expect((await request(app).get('/api/settings/store').set(auth(fresh.body.token))).status).toBe(401);
  });

  it('revokes terminals and refuses cross-store revocation', async () => {
    const local = await pair(storeA);
    const remote = await pair(storeB);
    expect((await request(app).post('/api/auth/terminals/' + remote.terminalId + '/revoke').set(auth())).status).toBe(404);
    const token = signSession({ ...manager, terminalId: local.terminalId });
    expect((await request(app).post('/api/auth/terminals/' + local.terminalId + '/revoke').set(auth())).status).toBe(200);
    expect((await request(app).get('/api/settings/store').set(auth(token))).status).toBe(401);
    expect((await request(app).get('/api/auth/staff').set('X-Device-Token', local.deviceToken)).status).toBe(404);
    const list = await request(app).get('/api/auth/terminals').set(auth());
    expect(JSON.stringify(list.body)).not.toContain('deviceToken');
    expect(list.body.some((row: { id: number }) => row.id === remote.terminalId)).toBe(false);
  });

  it('limits repeated PIN guessing even on a paired device', async () => {
    const [user] = await db.insert(schema.users).values({ storeId: storeA, name: 'Limit fixture', initials: 'LF', pinHash: await bcrypt.hash('4567', 4) }).returning();
    for (let n = 0; n < 20; n++) {
      const result = await request(app).post('/api/auth/pin').send({ deviceToken: rawDeviceToken, userId: user!.id, pin: '9999' });
      expect(result.status).toBe(401);
    }
    expect((await request(app).post('/api/auth/pin').send({ deviceToken: rawDeviceToken, userId: user!.id, pin: '4567' })).status).toBe(429);
  });
});

describe('credential exposure and startup', () => {
  it('never returns saved auth keys; blank saves preserve them and audit contains no secret', async () => {
    const secret = 'synthetic-secret-for-security-test';
    const saved = await request(app).put('/api/settings/store').set(auth()).send({ settings: { dejavoo: { tpn: 'Fixture', authKey: secret, registerId: '1' } } });
    expect(saved.status).toBe(200); expect(JSON.stringify(saved.body)).not.toContain(secret);
    expect(saved.body.settings.dejavoo.hasAuthKey).toBe(true);
    const read = await request(app).get('/api/settings/store').set(auth(employeeToken));
    expect(JSON.stringify(read.body)).not.toContain(secret);
    expect(read.body.settings.dejavoo).toEqual({ configured: true });
    await request(app).put('/api/settings/store').set(auth()).send({ settings: { dejavoo: { registerId: '2', authKey: '' } } });
    const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, storeA));
    expect((store!.settings as { dejavoo: { authKey: string } }).dejavoo.authKey).toBe(secret);
    const logs = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'settings.store.update'));
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect((await request(app).put('/api/settings/store').set(auth()).send({ settings: { dejavoo: { baseUrl: 'http://internal' } } })).status).toBe(400);
    await request(app).put('/api/settings/store').set(auth()).send({ settings: { dejavoo: { clearAuthKey: true } } });
    expect((await request(app).get('/api/terminal/status').set(auth())).body.configured).toBe(false);
  });

  it('omits unknown legacy fields even when they contain a secret', async () => {
    await db.update(schema.stores).set({ settings: { privateIntegration: { password: 'hidden-legacy-value' }, print: { tag: { phone: true, secret: 'hidden-nested-value' } } } }).where(eq(schema.stores.id, storeA));
    const result = await request(app).get('/api/settings/store').set(auth());
    expect(result.body.settings.print.tag).toEqual({ phone: true });
    expect(JSON.stringify(result.body)).not.toContain('hidden-');
  });

  it('blocks demo seeding and insecure signing configuration in production', async () => {
    const mode = process.env.NODE_ENV, secret = process.env.JWT_SECRET;
    try {
      process.env.NODE_ENV = 'production'; delete process.env.JWT_SECRET;
      expect(() => sessionSecret()).toThrow('JWT_SECRET');
      await expect(seedIfEmpty(db)).rejects.toThrow('disabled in production');
    } finally {
      if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
      if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    }
  });
});

function socket(authData: object) {
  const client = connect(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], auth: authData });
  clients.push(client); return client;
}
function event(client: Socket, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing socket event: ' + name)), 3000);
    client.once(name, (...args) => { clearTimeout(timeout); resolve(args[0]); });
  });
}

describe('authenticated print bridge and realtime', () => {
  it('rejects unauthenticated connections and POS credentials posing as a bridge', async () => {
    for (const credential of [{}, { kind: 'bridge', deviceToken: rawDeviceToken }]) {
      const client = socket(credential), denied = event(client, 'connect_error');
      client.connect(); await denied; expect(client.connected).toBe(false);
    }
  });

  it('disconnects a POS client that requests another store room', async () => {
    const client = socket({ token: employeeToken }), ready = event(client, 'connect');
    client.connect(); await ready;
    const disconnected = event(client, 'disconnect');
    client.emit('join-store', storeB); await disconnected;
    expect(io.sockets.adapter.rooms.get('store:' + storeB)?.size ?? 0).toBe(0);
  });

  it('delivers only to the paired store bridge and disconnects it on revocation', async () => {
    const device = await pair(storeA, 'bridge');
    const client = socket({ kind: 'bridge', deviceToken: device.deviceToken }), ready = event(client, 'connect');
    client.connect(); await ready;
    const print = event(client, 'print-job');
    expect((await request(app).post('/api/print/test').set(auth()).send({})).status).toBe(200);
    expect(await print).toHaveProperty('escposBase64');
    const disconnected = event(client, 'disconnect');
    expect((await request(app).post('/api/auth/terminals/' + device.terminalId + '/revoke').set(auth())).status).toBe(200);
    await disconnected;
    expect((await request(app).get('/api/print/status').set(auth())).body.bridgeOnline).toBe(false);
  });
});
