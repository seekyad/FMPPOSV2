import { issuePairing } from './pairing';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { createApp } from './app';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';

process.env.PGLITE_MEMORY = '1';

let app: Express;
let manager = '';
let employee = '';
let ids: number[] = [];
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();
  const stores = await request(app).get('/api/auth/stores');
  const storeId = stores.body[0].id as number;
  const reg = await request(app)
    .post('/api/auth/terminal/register')
    .send({ pairingCode: (await issuePairing(db, storeId, 'pos')).pairingCode, name: 'Bulk test' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  const sara = staff.body.staff.find((s: { name: string }) => s.name === 'Sara R.');
  manager = (await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })).body.token;
  employee = (await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: sara.id, pin: '2345' })).body.token;
  const rows = await db
    .insert(schema.inventoryItems)
    .values([
      { storeId, kind: 'part', name: 'iPhone 15 Soft OLED screen', qty: 0, costCents: 4000, priceCents: 0, taxable: false },
      { storeId, kind: 'part', name: 'iPhone 15 Battery', qty: 2, costCents: 1800, priceCents: 0, taxable: false },
      { storeId, kind: 'device', name: 'iPhone 15', qty: 1, costCents: 30000, priceCents: 45000, taxable: true },
    ])
    .returning();
  ids = rows.map((r) => r.id);
});

describe('inventory bulk price update', () => {
  it('is manager-only', async () => {
    const res = await request(app).post('/api/inventory/bulk-price').set(auth(employee)).send({ ids, cost: { mode: 'set', value: 100 } });
    expect(res.status).toBe(403);
  });

  it('sets, adds and scales cost and price for parts, leaving devices untouched', async () => {
    const set = await request(app).post('/api/inventory/bulk-price').set(auth(manager)).send({ ids, cost: { mode: 'add', value: 500 }, price: { mode: 'set', value: 9900 } });
    expect(set.status).toBe(200);
    expect(set.body.updated).toBe(2);
    const db = await getDb();
    const rows = await db.select().from(schema.inventoryItems).where(inArray(schema.inventoryItems.id, ids));
    const oled = rows.find((r) => r.name.includes('OLED'))!;
    const battery = rows.find((r) => r.name.includes('Battery'))!;
    const device = rows.find((r) => r.kind === 'device')!;
    expect([oled.costCents, oled.priceCents]).toEqual([4500, 9900]);
    expect([battery.costCents, battery.priceCents]).toEqual([2300, 9900]);
    expect([device.costCents, device.priceCents]).toEqual([30000, 45000]);

    const pct = await request(app).post('/api/inventory/bulk-price').set(auth(manager)).send({ ids: [oled.id], price: { mode: 'percent', value: 10 } });
    expect(pct.status).toBe(200);
    const [after] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, oled.id));
    expect(after!.priceCents).toBe(10890);
    expect(after!.costCents).toBe(4500);
  });

  it('rejects a request with neither cost nor price', async () => {
    const res = await request(app).post('/api/inventory/bulk-price').set(auth(manager)).send({ ids });
    expect(res.status).toBe(400);
  });
});
