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
let customerId = 0;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();
  const stores = await request(app).get('/api/auth/stores');
  const reg = await request(app)
    .post('/api/auth/terminal/register')
    .send({ storeId: stores.body[0].id, name: 'Retail terminal' });
  const staff = await request(app).get('/api/auth/staff').query({ deviceToken: reg.body.deviceToken });
  const sara = staff.body.staff.find((s: { name: string }) => s.name === 'Sara R.');
  token = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: sara.id, pin: '2345' })
  ).body.token;
  const [dana] = await db.select().from(schema.customers).where(eq(schema.customers.name, 'Dana Nguyen'));
  customerId = dana!.id;
}, 60_000);

describe('retail: activations', () => {
  it('creates an activation with an inline new customer', async () => {
    const res = await request(app)
      .post('/api/retail/activations')
      .set(auth())
      .send({
        newCustomer: { name: 'Priya Raman', phone: '(734) 555-0221' },
        kind: 'new_line',
        carrier: 'T-Mobile',
        planName: 'Go5G',
        phoneNumber: '(734) 555-0221',
        monthlyCents: 7500,
        notes: 'Ported from AT&T',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('creates a wifi-box activation for an existing customer and lists both', async () => {
    const res = await request(app)
      .post('/api/retail/activations')
      .set(auth())
      .send({ customerId, kind: 'wifi_box', carrier: 'T-Mobile', planName: 'Home Internet', monthlyCents: 5000 });
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/retail/activations').set(auth());
    expect(list.body).toHaveLength(2);
    expect(list.body.map((a: { kind: string }) => a.kind)).toContain('wifi_box');
    const search = await request(app).get('/api/retail/activations?query=Priya').set(auth());
    expect(search.body).toHaveLength(1);
  });

  it('updates activation status', async () => {
    const list = await request(app).get('/api/retail/activations').set(auth());
    const res = await request(app)
      .patch(`/api/retail/activations/${list.body[0].id}`)
      .set(auth())
      .send({ status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});

describe('retail: bill payments', () => {
  it('takes a cash bill payment with fee and books a sale + drawer cash', async () => {
    const res = await request(app)
      .post('/api/retail/bill-payments')
      .set(auth())
      .send({
        customerId,
        carrier: 'Boost',
        accountNumber: '889912345',
        amountCents: 6500,
        feeCents: 300,
        method: 'cash',
        tenderedCents: 7000,
      });
    expect(res.status).toBe(200);
    expect(res.body.changeCents).toBe(200);
    expect(res.body.sale.totalCents).toBe(6800);
    expect(res.body.sale.taxCents).toBe(0);

    const list = await request(app).get('/api/retail/bill-payments').set(auth());
    expect(list.body.today.count).toBe(1);
    expect(list.body.today.amountCents).toBe(6500);
    expect(list.body.today.feeCents).toBe(300);

    // the cash landed in the drawer expectation
    const drawer = await request(app).get('/api/drawer').set(auth());
    expect(drawer.body.cashSalesCents).toBeGreaterThanOrEqual(6800);
  });

  it('rejects under-tendered cash', async () => {
    const res = await request(app)
      .post('/api/retail/bill-payments')
      .set(auth())
      .send({ carrier: 'Boost', accountNumber: '1', amountCents: 5000, method: 'cash', tenderedCents: 1000 });
    expect(res.status).toBe(400);
  });
});
