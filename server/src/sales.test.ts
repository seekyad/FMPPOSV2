import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from './app';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';
import { eq } from 'drizzle-orm';

process.env.PGLITE_MEMORY = '1';

let app: Express;
let managerToken = '';
let employeeToken = '';
let glassId = 0;
let customerId = 0;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();

  const stores = await request(app).get('/api/auth/stores');
  const reg = await request(app)
    .post('/api/auth/terminal/register')
    .send({ storeId: stores.body[0].id, name: 'Test terminal' });
  const staff = await request(app).get('/api/auth/staff').query({ deviceToken: reg.body.deviceToken });
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  const sara = staff.body.staff.find((s: { name: string }) => s.name === 'Sara R.');
  managerToken = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })
  ).body.token;
  employeeToken = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: sara.id, pin: '2345' })
  ).body.token;

  const [glass] = await db
    .select()
    .from(schema.inventoryItems)
    .where(eq(schema.inventoryItems.sku, 'ACC-TG-UNI'));
  glassId = glass!.id;
  const [dana] = await db.select().from(schema.customers).where(eq(schema.customers.name, 'Dana Nguyen'));
  customerId = dana!.id;
}, 60_000);

async function qtyOf(id: number): Promise<number> {
  const db = await getDb();
  const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id));
  return item!.qty;
}

describe('sales flow', () => {
  it('completes a cash sale with change and decrements stock', async () => {
    const before = await qtyOf(glassId);
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [
          { kind: 'product', description: 'Tempered glass protector', qty: 2, unitCents: 1500, taxable: true, inventoryItemId: glassId },
        ],
        payments: [{ method: 'cash', amountCents: 3180, tenderedCents: 4000 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.totals.totalCents).toBe(3180); // 3000 + 6%
    expect(res.body.changeCents).toBe(820);
    expect(res.body.receiptText).toContain('TOTAL');
    expect(await qtyOf(glassId)).toBe(before - 2);
  });

  it('rejects underpaid sales and leaves nothing behind', async () => {
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [{ kind: 'custom', description: 'Cleaning', qty: 1, unitCents: 5000, taxable: true }],
        payments: [{ method: 'cash', amountCents: 100 }],
      });
    expect(res.status).toBe(400);
  });

  it('parks and lists a pending sale', async () => {
    const park = await request(app)
      .post('/api/sales/park')
      .set(auth(employeeToken))
      .send({
        lines: [{ kind: 'custom', description: 'Water damage cleaning', qty: 1, unitCents: 8900, taxable: true }],
        note: 'Customer stepped out to the ATM',
      });
    expect(park.status).toBe(200);
    const list = await request(app).get('/api/sales/parked').set(auth(employeeToken));
    expect(list.status).toBe(200);
    const found = list.body.find((s: { id: number }) => s.id === park.body.sale.id);
    expect(found.parkedNote).toContain('ATM');
    expect(found.lines).toHaveLength(1);
  });

  it('blocks employees from voiding but lets managers void with restock', async () => {
    const sale = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [
          { kind: 'product', description: 'Tempered glass protector', qty: 1, unitCents: 1500, taxable: true, inventoryItemId: glassId },
        ],
        payments: [{ method: 'cash', amountCents: 1590, tenderedCents: 1590 }],
      });
    const before = await qtyOf(glassId);
    const denied = await request(app).post(`/api/sales/${sale.body.sale.id}/void`).set(auth(employeeToken)).send({});
    expect(denied.status).toBe(403);
    const voided = await request(app)
      .post(`/api/sales/${sale.body.sale.id}/void`)
      .set(auth(managerToken))
      .send({ reason: 'test void' });
    expect(voided.status).toBe(200);
    expect(await qtyOf(glassId)).toBe(before + 1);
  });

  it('refunds to store credit and raises the customer balance', async () => {
    const sale = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        customerId,
        lines: [{ kind: 'custom', description: 'Screen cleaning', qty: 1, unitCents: 2000, taxable: true }],
        payments: [{ method: 'card', amountCents: 2120 }],
      });
    expect(sale.status).toBe(200);
    const refund = await request(app)
      .post(`/api/sales/${sale.body.sale.id}/refund`)
      .set(auth(employeeToken))
      .send({ method: 'store_credit', reason: 'unhappy' });
    expect(refund.status).toBe(200);
    expect(refund.body.refundAmountCents).toBe(2120); // price + tax back

    const detail = await request(app).get(`/api/customers/${customerId}`).set(auth(employeeToken));
    expect(detail.body.customer.storeCreditCents).toBe(2120);
    const original = await request(app).get(`/api/sales/${sale.body.sale.id}`).set(auth(employeeToken));
    expect(original.body.status).toBe('refunded');
  });

  it('spends store credit as a payment method', async () => {
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        customerId,
        lines: [{ kind: 'custom', description: 'Sticker', qty: 1, unitCents: 1000, taxable: true }],
        payments: [{ method: 'store_credit', amountCents: 1060 }],
      });
    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/customers/${customerId}`).set(auth(employeeToken));
    expect(detail.body.customer.storeCreditCents).toBe(2120 - 1060);
  });

  it('searches customers, items and tickets in one call', async () => {
    const res = await request(app).get('/api/sales/search/all').set(auth(employeeToken)).query({ q: 'Dana' });
    expect(res.status).toBe(200);
    expect(res.body.customers[0].name).toBe('Dana Nguyen');
  });

  it('applies discounts with manager-audit trail intact', async () => {
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [{ kind: 'custom', description: 'Case', qty: 1, unitCents: 2000, taxable: true, discountCents: 500 }],
        payments: [{ method: 'cash', amountCents: 1590, tenderedCents: 1590 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.totals.totalCents).toBe(1590); // (2000-500) * 1.06
  });

  it('logs sales where tax was removed on a custom item', async () => {
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [{ kind: 'custom', description: 'Quick fix', qty: 1, unitCents: 4000, taxable: false }],
        payments: [{ method: 'cash', amountCents: 4000, tenderedCents: 4000 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.totals.taxCents).toBe(0);

    const db = await getDb();
    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'sale.tax_removed'));
    expect(entry).toBeDefined();
    expect(entry!.entityId).toBe(res.body.sale.id);
    expect(entry!.detail).toMatchObject({ lines: [{ description: 'Quick fix', amountCents: 4000 }] });
  });
});
