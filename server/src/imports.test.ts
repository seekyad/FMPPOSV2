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
let managerToken = '';
let employeeToken = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const payload = {
  version: 1 as const,
  source: 'test dump',
  customers: [
    { key: 'c-1', name: 'Tainsha Brooks', phone: '(313) 624-6101', note: 'Prefers text', createdAt: '2026-05-08T18:29:22.000Z' },
    { key: 'inline:walk', name: 'Walk-in', phone: null, note: null, createdAt: null },
  ],
  tickets: [
    {
      number: '#96279196',
      customerKey: 'c-1',
      status: 'picked_up' as const,
      createdAt: '2026-05-08T18:29:22.000Z',
      completedAt: '2026-05-08T23:55:22.000Z',
      notesForTech: 'Passcode: 1234 (phone)',
      paid: { amountCents: 9500, method: 'card' as const, at: '2026-05-08T23:55:22.000Z' },
      devices: [{ label: 'iPad Pro 12.9', imei: null, passcode: '1234', notes: null, lines: [{ description: 'Charging Port', priceCents: 9500 }] }],
      history: [
        { status: 'open' as const, note: 'create · Admin', at: '2026-05-08T18:29:22.000Z' },
        { status: 'picked_up' as const, note: 'pickup · Admin', at: '2026-05-08T23:55:22.000Z' },
      ],
    },
    {
      number: '#14854590',
      customerKey: 'inline:walk',
      status: 'open' as const,
      createdAt: '2026-06-01T15:00:00.000Z',
      completedAt: null,
      notesForTech: null,
      paid: null,
      devices: [
        { label: 'iPhone 15', imei: '35000000000001', passcode: null, notes: 'cracked corner', lines: [{ description: 'Screen Replacement', priceCents: 8500 }] },
        { label: 'AirPods', imei: null, passcode: null, notes: null, lines: [{ description: 'Clean', priceCents: 0 }] },
      ],
      history: [],
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
    .send({ pairingCode: (await issuePairing(await getDb(), stores.body[0].id, 'pos')).pairingCode, name: 'Import test' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  const sara = staff.body.staff.find((s: { name: string }) => s.name === 'Sara R.');
  managerToken = (await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })).body.token;
  employeeToken = (await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: sara.id, pin: '2345' })).body.token;
});

describe('legacy import', () => {
  it('is manager-only', async () => {
    const res = await request(app).post('/api/imports/legacy').set(auth(employeeToken)).send(payload);
    expect(res.status).toBe(403);
  });

  it('rejects a file that is not a legacy payload', async () => {
    const res = await request(app).post('/api/imports/legacy').set(auth(managerToken)).send({ version: 2, customers: [] });
    expect(res.status).toBe(400);
  });

  it('imports customers and tickets with devices, lines, history and paid status', async () => {
    const res = await request(app).post('/api/imports/legacy').set(auth(managerToken)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ customersCreated: 2, customersMatched: 0, ticketsCreated: 2, ticketsSkipped: 0 });

    const board = await request(app).get('/api/repairs?status=all').set(auth(managerToken));
    const picked = board.body.rows.find((r: { number: string }) => r.number === '#96279196');
    expect(picked).toBeTruthy();
    expect(picked.status).toBe('picked_up');
    expect(picked.customerName).toBe('Tainsha Brooks');
    expect(picked.totalCents).toBe(9500);
    expect(picked.paidCents).toBe(9500);

    const detail = (await request(app).get(`/api/repairs/${picked.id}`).set(auth(managerToken))).body;
    expect(detail.balanceCents).toBe(0);
    expect(detail.devices).toHaveLength(1);
    expect(detail.devices[0]).toMatchObject({ label: 'iPad Pro 12.9', unlockMethod: 'passcode', unlockValue: '1234' });
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({ description: 'Charging Port', priceCents: 9500, warrantyDays: 90 });
    expect(detail.history.map((h: { status: string }) => h.status)).toEqual(['open', 'picked_up']);
    expect(new Date(detail.ticket.createdAt).toISOString()).toBe('2026-05-08T18:29:22.000Z');

    const open = board.body.rows.find((r: { number: string }) => r.number === '#14854590');
    expect(open.status).toBe('open');
    expect(open.totalCents).toBe(8500);
    expect(open.paidCents).toBe(0);
    const openDetail = (await request(app).get(`/api/repairs/${open.id}`).set(auth(managerToken))).body;
    expect(openDetail.devices).toHaveLength(2);
    // a ticket with no history rows still gets one so the panel has a trail
    expect(openDetail.history).toHaveLength(1);
  });

  it('is idempotent: rerunning matches customers and skips existing tickets', async () => {
    const again = await request(app).post('/api/imports/legacy').set(auth(managerToken)).send(payload);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ customersCreated: 0, customersMatched: 2, ticketsCreated: 0, ticketsSkipped: 2 });
    const customers = await request(app).get('/api/customers?q=Tainsha').set(auth(managerToken));
    const rows = Array.isArray(customers.body) ? customers.body : customers.body.rows ?? customers.body.customers ?? [];
    expect(rows.filter((c: { name: string }) => c.name === 'Tainsha Brooks')).toHaveLength(1);
  });

  it('matches an existing customer by phone digits even when formatted differently', async () => {
    const res = await request(app)
      .post('/api/imports/legacy')
      .set(auth(managerToken))
      .send({
        version: 1,
        customers: [{ key: 'c-9', name: 'T. Brooks', phone: '313-624-6101' }],
        tickets: [
          {
            number: '#77777777',
            customerKey: 'c-9',
            status: 'cancelled',
            devices: [{ label: 'Pixel 7', lines: [{ description: 'Battery', priceCents: 6000 }] }],
            history: [{ status: 'cancelled', note: 'cancel · customer declined', at: '2026-07-01T12:00:00.000Z' }],
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ customersCreated: 0, customersMatched: 1, ticketsCreated: 1 });
  });
});
