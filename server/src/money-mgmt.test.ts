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
let managerToken = '';
let employeeToken = '';
let customerId = 0;
let iphone13Id = 0;

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asEmployee = () => ({ Authorization: `Bearer ${employeeToken}` });

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();
  const stores = await request(app).get('/api/auth/stores');
  const reg = await request(app)
    .post('/api/auth/terminal/register')
    .send({ storeId: stores.body[0].id, name: 'Money test' });
  const staff = await request(app).get('/api/auth/staff').query({ deviceToken: reg.body.deviceToken });
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  const sara = staff.body.staff.find((s: { name: string }) => s.name === 'Sara R.');
  managerToken = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })
  ).body.token;
  employeeToken = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: sara.id, pin: '2345' })
  ).body.token;
  const [dana] = await db.select().from(schema.customers).where(eq(schema.customers.name, 'Dana Nguyen'));
  customerId = dana!.id;
  const [m13] = await db.select().from(schema.deviceModels).where(eq(schema.deviceModels.name, 'iPhone 13'));
  iphone13Id = m13!.id;
}, 60_000);

describe('trade-ins', () => {
  it('computes the pricebook offer and pays cash from the drawer', async () => {
    const res = await request(app)
      .post('/api/tradein')
      .set(asEmployee())
      .send({ modelId: iphone13Id, storage: '128 GB', imei: '353900001112223', condition: 'good', payout: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.offerCents).toBe(31000); // seeded $310 base, good = 100%
    expect(res.body.item.fromTradeIn).toBe(true);
    expect(res.body.item.status).toBe('needs_intake');

    const drawer = await request(app).get('/api/drawer').set(asEmployee());
    expect(drawer.body.paidOutCents).toBe(31000);
  });

  it('adds the +10% bonus for store credit and books the ledger', async () => {
    const res = await request(app)
      .post('/api/tradein')
      .set(asEmployee())
      .send({ modelId: iphone13Id, storage: '128 GB', condition: 'fair', payout: 'credit', customerId });
    expect(res.status).toBe(200);
    expect(res.body.offerCents).toBe(25575); // 310 * .75 * 1.1
    const detail = await request(app).get(`/api/customers/${customerId}`).set(asEmployee());
    expect(detail.body.customer.storeCreditCents).toBe(25575);
  });

  it('logs manual overrides against the suggested value', async () => {
    const res = await request(app)
      .post('/api/tradein')
      .set(asEmployee())
      .send({ modelId: iphone13Id, storage: '128 GB', condition: 'broken', payout: 'cash', manualOfferCents: 9000 });
    expect(res.status).toBe(200);
    expect(res.body.manual).toBe(true);
    expect(res.body.suggestedCents).toBe(12400);
  });

  it('demands a manual offer when the model is not in the pricebook', async () => {
    const db = await getDb();
    const [watch] = await db.select().from(schema.deviceModels).where(eq(schema.deviceModels.name, 'Apple Watch S8'));
    const res = await request(app)
      .post('/api/tradein')
      .set(asEmployee())
      .send({ modelId: watch!.id, storage: '45 mm', condition: 'good', payout: 'cash' });
    expect(res.status).toBe(400);
  });
});

describe('drawer', () => {
  it('records paid-out with reason and tracks the expectation', async () => {
    await request(app)
      .post('/api/drawer/movement')
      .set(asEmployee())
      .send({ kind: 'paid_out', amountCents: 2500, reason: 'Window cleaner' });
    const drawer = await request(app).get('/api/drawer').set(asEmployee());
    // float 200.00 - 310.00 - 90.00 - 25.00 payouts
    expect(drawer.body.expectedCents).toBe(20000 - 31000 - 9000 - 2500);
  });

  it('close is manager-only, records over/short, and clears parked sales', async () => {
    await request(app)
      .post('/api/sales/park')
      .set(asEmployee())
      .send({ lines: [{ kind: 'custom', description: 'Parked thing', qty: 1, unitCents: 1000, taxable: true }] });
    const denied = await request(app).post('/api/drawer/close').set(asEmployee()).send({ countedCents: 0 });
    expect(denied.status).toBe(403);
    const closed = await request(app).post('/api/drawer/close').set(asManager()).send({ countedCents: 5000 });
    expect(closed.status).toBe(200);
    expect(closed.body.overShortCents).toBe(5000 - closed.body.expectedCents);
    const parked = await request(app).get('/api/sales/parked').set(asEmployee());
    expect(parked.body).toHaveLength(0);
  });
});

describe('time clock', () => {
  it('clocks in, blocks double clock-in, clocks out', async () => {
    const cin = await request(app).post('/api/timeclock/clock-in').set(asEmployee());
    expect(cin.status).toBe(200);
    const dup = await request(app).post('/api/timeclock/clock-in').set(asEmployee());
    expect(dup.status).toBe(400);
    const cout = await request(app).post('/api/timeclock/clock-out').set(asEmployee());
    expect(cout.status).toBe(200);
    expect(new Date(cout.body.clockOut).getTime()).toBeGreaterThan(0);
  });

  it('lets managers edit entries with a note, not employees', async () => {
    const list = await request(app).get('/api/timeclock').set(asManager());
    const entry = list.body.entries[0];
    const denied = await request(app)
      .patch(`/api/timeclock/${entry.id}`)
      .set(asEmployee())
      .send({ editNote: 'trying' });
    expect(denied.status).toBe(403);
    const edited = await request(app)
      .patch(`/api/timeclock/${entry.id}`)
      .set(asManager())
      .send({ clockOut: new Date().toISOString(), editNote: 'forgot to clock out' });
    expect(edited.status).toBe(200);
    expect(edited.body.editNote).toBe('forgot to clock out');
  });
});

describe('settings & staff', () => {
  it('updates the tax rate and merges the settings bag', async () => {
    const updated = await request(app)
      .put('/api/settings/store')
      .set(asManager())
      .send({ taxRateBp: 825, settings: { drawerFloatCents: 15000 } });
    expect(updated.status).toBe(200);
    expect(updated.body.taxRateBp).toBe(825);
    expect(updated.body.settings.drawerFloatCents).toBe(15000);
    // put it back for other assertions
    await request(app).put('/api/settings/store').set(asManager()).send({ taxRateBp: 600 });
  });

  it('creates staff with a PIN they can sign in with', async () => {
    const created = await request(app)
      .post('/api/settings/staff')
      .set(asManager())
      .send({ name: 'Helen Vasquez', pin: '7788', role: 'employee' });
    expect(created.status).toBe(200);
    const stores = await request(app).get('/api/auth/stores');
    const reg = await request(app)
      .post('/api/auth/terminal/register')
      .send({ storeId: stores.body[0].id, name: 'Second terminal' });
    const login = await request(app)
      .post('/api/auth/pin')
      .send({ deviceToken: reg.body.deviceToken, userId: created.body.id, pin: '7788' });
    expect(login.status).toBe(200);
    expect(login.body.user.name).toBe('Helen Vasquez');
  });
});

describe('reports', () => {
  it('summarizes the day including drawer and payment mix', async () => {
    await request(app)
      .post('/api/sales/complete')
      .set(asEmployee())
      .send({
        lines: [{ kind: 'custom', description: 'Diagnostic', qty: 1, unitCents: 5000, taxable: true }],
        payments: [{ method: 'card', amountCents: 5300 }],
      });
    const res = await request(app).get('/api/reports/summary?range=today').set(asEmployee());
    expect(res.status).toBe(200);
    expect(res.body.grossSalesCents).toBeGreaterThan(0);
    expect(res.body.paymentMix.find((p: { method: string }) => p.method === 'card').totalCents).toBeGreaterThanOrEqual(5300);
    expect(res.body.drawer.expectedCents).toBeDefined();
    expect(res.body.revenueByCategory.other).toBeGreaterThanOrEqual(5000);
  });

  it('reports terminal as not configured until credentials are saved', async () => {
    const status = await request(app).get('/api/terminal/status').set(asEmployee());
    expect(status.body.configured).toBe(false);
    const charge = await request(app).post('/api/terminal/charge').set(asEmployee()).send({ amountCents: 1000 });
    expect(charge.status).toBe(409);
  });
});
