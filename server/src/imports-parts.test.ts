import { issuePairing } from './pairing';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { createApp } from './app';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';

process.env.PGLITE_MEMORY = '1';

let app: Express;
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const sheet = {
  version: 1 as const,
  kind: 'parts' as const,
  source: 'test sheet',
  models: [
    { brand: 'Apple', family: 'iPhone', name: 'iPhone 13', kind: 'phone' as const }, // seeded already
    { brand: 'Apple', family: 'iPhone', name: 'iPhone 17 Pro Max', kind: 'phone' as const },
    { brand: 'Motorola', family: 'Moto G Power', name: 'Moto G Power (2025)', kind: 'phone' as const },
  ],
  parts: [
    { brand: 'Apple', model: 'iPhone 13', part: 'Soft OLED screen', note: null, costCents: 4000 },
    { brand: 'Apple', model: 'iPhone 13', part: 'Battery', note: null, costCents: 1200 },
    { brand: 'apple', model: 'IPHONE 17 PRO MAX', part: 'COF LCD screen', note: '120 Hz', costCents: 4500 },
    { brand: 'Motorola', model: 'Moto G Power (2025)', part: 'LCD screen', note: null, costCents: 4000 },
    { brand: 'Samsung', model: 'Galaxy Z Fold 9', part: 'Battery', note: null, costCents: 2000 }, // no such model
  ],
};

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();
  const stores = await request(app).get('/api/auth/stores');
  const reg = await request(app)
    .post('/api/auth/terminal/register')
    .send({ pairingCode: (await issuePairing(await getDb(), stores.body[0].id, 'pos')).pairingCode, name: 'Parts import test' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  token = (await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })).body.token;
});

describe('parts cost sheet import', () => {
  it('creates missing models, adds parts linked to their model at cost, and skips unknown models', async () => {
    const res = await request(app).post('/api/imports/parts').set(auth()).send(sheet);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ modelsCreated: 2, modelsMatched: 1, partsCreated: 4, partsUpdated: 0, partsUnchanged: 0 });
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toContain('Galaxy Z Fold 9');

    const db = await getDb();
    const [model] = await db.select().from(schema.deviceModels).where(eq(schema.deviceModels.name, 'iPhone 17 Pro Max'));
    expect(model).toBeTruthy();
    expect(model!.family).toBe('iPhone');
    const parts = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.modelId, model!.id));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'part', name: 'IPHONE 17 PRO MAX COF LCD screen (120 Hz)', costCents: 4500, qty: 0, priceCents: 0, taxable: false });
    expect(parts[0]!.sku).toBe('PRT-IPHONE17PROMAX-COFLCDSCRE120H');

    const [thirteen] = await db.select().from(schema.deviceModels).where(eq(schema.deviceModels.name, 'iPhone 13'));
    const thirteenParts = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.modelId, thirteen!.id));
    expect(thirteenParts.map((p) => p.name).sort()).toEqual(['iPhone 13 Battery', 'iPhone 13 Soft OLED screen']);
  });

  it('re-import refreshes changed costs only and never duplicates', async () => {
    const again = { ...sheet, parts: sheet.parts.map((p) => (p.part === 'Battery' && p.model === 'iPhone 13' ? { ...p, costCents: 1500 } : p)) };
    const res = await request(app).post('/api/imports/parts').set(auth()).send(again);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ modelsCreated: 0, modelsMatched: 3, partsCreated: 0, partsUpdated: 1, partsUnchanged: 3 });
    const db = await getDb();
    const [thirteen] = await db.select().from(schema.deviceModels).where(eq(schema.deviceModels.name, 'iPhone 13'));
    const battery = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.modelId, thirteen!.id));
    expect(battery.filter((p) => p.name === 'iPhone 13 Battery')).toHaveLength(1);
    expect(battery.find((p) => p.name === 'iPhone 13 Battery')!.costCents).toBe(1500);
  });

  it('rejects a legacy payload sent to the parts endpoint', async () => {
    const res = await request(app).post('/api/imports/parts').set(auth()).send({ version: 1, customers: [], tickets: [] });
    expect(res.status).toBe(400);
  });
});
