import { issuePairing } from './pairing';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from './app';
import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';

process.env.PGLITE_MEMORY = '1';

let app: Express;
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const file = {
  version: 1 as const,
  kind: 'services' as const,
  source: 'test rule',
  services: [
    {
      category: 'Screens',
      name: 'Screen replacement — iPhone (Soft OLED)',
      deviceGroup: 'iPhone',
      timeMinutes: 45,
      warrantyDays: 90,
      partsCostCents: 4000,
      basePriceCents: 9900,
      tiers: [
        { label: 'iPhone 13', priceCents: 9900 },
        { label: 'iPhone 15', priceCents: 11900 },
        { label: 'iPhone 17 Pro Max', priceCents: 12900 },
      ],
    },
    {
      category: 'Batteries',
      name: 'Battery replacement — iPad',
      deviceGroup: 'iPad',
      timeMinutes: 30,
      warrantyDays: 90,
      partsCostCents: 1800,
      basePriceCents: 7900,
      tiers: [{ label: 'iPad 9', priceCents: 7900 }, { label: 'iPad 10', priceCents: 8900 }],
    },
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
    .send({ pairingCode: (await issuePairing(await getDb(), stores.body[0].id, 'pos')).pairingCode, name: 'Services import test' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  token = (await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })).body.token;
});

describe('services import', () => {
  it('creates services with per-model tiers that intake can see', async () => {
    const res = await request(app).post('/api/imports/services').set(auth()).send(file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ servicesCreated: 2, servicesUpdated: 0, tiersWritten: 5 });

    const meta = (await request(app).get('/api/repairs/meta').set(auth())).body;
    const oled = meta.services.find((s: { name: string }) => s.name === 'Screen replacement — iPhone (Soft OLED)');
    expect(oled).toBeTruthy();
    expect(oled.deviceGroup).toBe('iPhone');
    expect(oled.basePriceCents).toBe(9900);
    expect(oled.tiers.map((t: { label: string; priceCents: number }) => [t.label, t.priceCents])).toEqual([
      ['iPhone 13', 9900],
      ['iPhone 15', 11900],
      ['iPhone 17 Pro Max', 12900],
    ]);
  });

  it('re-import updates prices and replaces tiers instead of duplicating', async () => {
    const again = {
      ...file,
      services: [{ ...file.services[0]!, basePriceCents: 10900, tiers: [{ label: 'iPhone 13', priceCents: 10900 }, { label: 'iPhone 16', priceCents: 12900 }] }],
    };
    const res = await request(app).post('/api/imports/services').set(auth()).send(again);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ servicesCreated: 0, servicesUpdated: 1, tiersWritten: 2 });
    const meta = (await request(app).get('/api/repairs/meta').set(auth())).body;
    const matches = meta.services.filter((s: { name: string }) => s.name === 'Screen replacement — iPhone (Soft OLED)');
    expect(matches).toHaveLength(1);
    expect(matches[0].basePriceCents).toBe(10900);
    expect(matches[0].tiers.map((t: { label: string }) => t.label)).toEqual(['iPhone 13', 'iPhone 16']);
  });

  it('rejects other import files', async () => {
    const res = await request(app).post('/api/imports/services').set(auth()).send({ version: 1, kind: 'parts', models: [], parts: [] });
    expect(res.status).toBe(400);
  });
});
