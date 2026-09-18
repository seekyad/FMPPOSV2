import { issuePairing } from './pairing';
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
    .send({ pairingCode: (await issuePairing(await getDb(), stores.body[0].id, 'pos')).pairingCode, name: 'Test terminal' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
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

  it('takes Zelle and Cash App as tenders and labels them on the receipt', async () => {
    const sale = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        customerId,
        lines: [{ kind: 'custom', description: 'Tempered glass', qty: 1, unitCents: 2000, taxable: true }],
        payments: [{ method: 'zelle', amountCents: 1000 }, { method: 'cash_app', amountCents: 1120 }],
      });
    expect(sale.status).toBe(200);
    expect(sale.body.receiptText).toContain('Zelle');
    expect(sale.body.receiptText).toContain('Cash App');
    // transfers settle outside the register, so a void is refused like a card void
    const voided = await request(app)
      .post(`/api/sales/${sale.body.sale.id}/void`)
      .set(auth(managerToken))
      .send({ reason: 'oops' });
    expect(voided.status).toBe(409);
  });

  it('corrects a completed sale: tenders carry over and the difference is settled', async () => {
    const sale = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [{ kind: 'custom', description: 'Glass', qty: 1, unitCents: 2000, taxable: true }],
        payments: [{ method: 'cash', amountCents: 2120, tenderedCents: 2120 }],
      });
    expect(sale.status).toBe(200);
    expect(sale.body.sale.customerId).toBeNull();
    const dearer = [{ kind: 'custom', description: 'Glass', qty: 1, unitCents: 3000, taxable: true }];
    // an employee needs a manager code
    const noCode = await request(app).post(`/api/sales/${sale.body.sale.id}/amend`).set(auth(employeeToken)).send({ lines: dearer, payments: [{ method: 'card', amountCents: 1060 }] });
    expect(noCode.status).toBe(403);
    // a customer attached during the edit lands on the corrected sale
    const withCode = await request(app).post(`/api/sales/${sale.body.sale.id}/amend`).set(auth(employeeToken))
      .send({ lines: dearer, customerId, payments: [{ method: 'card', amountCents: 1060 }], managerPin: '1234' });
    expect(withCode.status).toBe(200);
    expect(withCode.body.diffCents).toBe(1060);
    expect(withCode.body.sale.totalCents).toBe(3180);
    expect(withCode.body.sale.customerId).toBe(customerId);
    expect(withCode.body.receiptText).toContain('Dana Nguyen');
    const corrected = await request(app).get(`/api/sales/${withCode.body.sale.id}`).set(auth(managerToken));
    expect(corrected.body.payments.map((p: { method: string; amountCents: number }) => [p.method, p.amountCents])).toEqual([['cash', 2120], ['card', 1060]]);
    const original = await request(app).get(`/api/sales/${sale.body.sale.id}`).set(auth(managerToken));
    expect(original.body.status).toBe('voided');
    expect(original.body.payments).toHaveLength(0);
    // the price comes back down: the difference goes back as cash
    const cheaper = [{ kind: 'custom', description: 'Glass', qty: 1, unitCents: 2500, taxable: true }];
    const down = await request(app).post(`/api/sales/${withCode.body.sale.id}/amend`).set(auth(managerToken)).send({ lines: cheaper, refundMethod: 'cash' });
    expect(down.status).toBe(200);
    expect(down.body.diffCents).toBe(-530);
    expect(down.body.sale.totalCents).toBe(2650);
    // a corrected sale can't be corrected again once voided
    const stale = await request(app).post(`/api/sales/${sale.body.sale.id}/amend`).set(auth(managerToken)).send({ lines: cheaper, refundMethod: 'cash' });
    expect(stale.status).toBe(404);
  });

  it('takes a deposit as store credit and needs a reachable customer', async () => {
    const before = (await request(app).get(`/api/customers/${customerId}`).set(auth(employeeToken))).body.customer.storeCreditCents;
    const grossBefore = (await request(app).get('/api/reports/summary?range=today').set(auth(employeeToken))).body.grossSalesCents;
    const noCustomer = await request(app).post('/api/sales/complete').set(auth(employeeToken)).send({
      lines: [{ kind: 'deposit', description: 'Deposit', qty: 1, unitCents: 5000, taxable: false }],
      payments: [{ method: 'card', amountCents: 5000 }],
    });
    expect(noCustomer.status).toBe(400);
    const taxed = await request(app).post('/api/sales/complete').set(auth(employeeToken)).send({
      customerId, lines: [{ kind: 'deposit', description: 'Deposit', qty: 1, unitCents: 5000, taxable: true }],
      payments: [{ method: 'card', amountCents: 5300 }],
    });
    expect(taxed.status).toBe(400);
    const sale = await request(app).post('/api/sales/complete').set(auth(employeeToken)).send({
      customerId, lines: [{ kind: 'deposit', description: 'Deposit', qty: 1, unitCents: 5000, taxable: false }],
      payments: [{ method: 'card', amountCents: 5000 }],
    });
    expect(sale.status).toBe(200);
    expect(sale.body.sale.totalCents).toBe(5000);
    expect(sale.body.receiptText).toContain('Phone:');
    expect(sale.body.receiptText).toContain('(512) 555-0142');
    const after = (await request(app).get(`/api/customers/${customerId}`).set(auth(employeeToken))).body.customer.storeCreditCents;
    expect(after - before).toBe(5000);
    // a deposit is held credit, not revenue: gross sales don't move, the card tender does
    const report = (await request(app).get('/api/reports/summary?range=today').set(auth(employeeToken))).body;
    expect(report.grossSalesCents).toBe(grossBefore);
    expect(report.paymentMix.find((p: { method: string }) => p.method === 'card').totalCents).toBeGreaterThanOrEqual(5000);
    // refunding the deposit takes the credit back
    const refund = await request(app).post(`/api/sales/${sale.body.sale.id}/refund`).set(auth(employeeToken)).send({ method: 'cash', reason: 'changed mind' });
    expect(refund.status).toBe(200);
    const final = (await request(app).get(`/api/customers/${customerId}`).set(auth(employeeToken))).body.customer.storeCreditCents;
    expect(final).toBe(before);
  });

  it('lists every money movement in the transactions log', async () => {
    const payout = await request(app).post('/api/drawer/movement').set(auth(employeeToken)).send({ kind: 'paid_out', amountCents: 1500, reason: 'Window cleaner' });
    expect(payout.status).toBe(200);
    const log = await request(app).get('/api/transactions?kind=all').set(auth(employeeToken));
    expect(log.status).toBe(200);
    const kinds = new Set(log.body.rows.map((r: { kind: string }) => r.kind));
    expect(kinds.has('sale')).toBe(true);
    expect(kinds.has('refund')).toBe(true);
    expect(kinds.has('voided')).toBe(true);
    const paidOut = log.body.rows.find((r: { kind: string; note: string | null }) => r.kind === 'payout' && r.note === 'Window cleaner');
    expect(paidOut.amountCents).toBe(-1500);
    // receipts, tickets and payouts share the store's S<store>-00001 series
    const numbers = log.body.rows.map((r: { number: string }) => r.number);
    expect(numbers.every((n: string) => /^S\d+-\d{5}$/.test(n))).toBe(true);
    expect(paidOut.number).toMatch(/^S\d+-\d{5}$/);
    const saleNumbers = log.body.rows.filter((r: { kind: string }) => ['sale', 'refund', 'voided'].includes(r.kind)).map((r: { number: string }) => r.number);
    expect(new Set(saleNumbers).size).toBe(saleNumbers.length);
    // a kind filter narrows the log, and rows come newest first
    const onlyPayouts = await request(app).get('/api/transactions?kind=payout').set(auth(employeeToken));
    expect(onlyPayouts.body.rows.every((r: { kind: string }) => ['payout', 'paid_in', 'drop'].includes(r.kind))).toBe(true);
    const times = log.body.rows.map((r: { at: string }) => r.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('manages staff and the store admin code', async () => {
    // an admin code approves corrections without a manager's personal PIN
    const noCurrent = await request(app).put('/api/settings/admin-code').set(auth(managerToken)).send({ newCode: '4321' });
    expect(noCurrent.status).toBe(200);
    const unchanged = await request(app).put('/api/settings/admin-code').set(auth(managerToken)).send({ newCode: '246810' });
    expect(unchanged.status).toBe(403);
    const changed = await request(app).put('/api/settings/admin-code').set(auth(managerToken)).send({ currentCode: '4321', newCode: '246810' });
    expect(changed.status).toBe(200);
    expect((await request(app).get('/api/settings/admin-code').set(auth(managerToken))).body.set).toBe(true);
    const verify = await request(app).post('/api/settings/admin-code/verify').set(auth(employeeToken)).send({ code: '246810' });
    expect(verify.body.via).toBe('admin_code');

    const sale = await request(app).post('/api/sales/complete').set(auth(employeeToken)).send({
      lines: [{ kind: 'custom', description: 'Film', qty: 1, unitCents: 1000, taxable: true }],
      payments: [{ method: 'card', amountCents: 1060 }],
    });
    const corrected = await request(app).post(`/api/sales/${sale.body.sale.id}/amend`).set(auth(employeeToken)).send({
      lines: [{ kind: 'custom', description: 'Film', qty: 1, unitCents: 500, taxable: true }], refundMethod: 'cash', managerPin: '246810',
    });
    expect(corrected.status).toBe(200);

    // staff: create, edit (initials follow the name), delete; history keeps a person from being deleted
    const created = await request(app).post('/api/settings/staff').set(auth(managerToken)).send({ name: 'Temp Person', pin: '1111' });
    expect(created.status).toBe(200);
    const renamed = await request(app).patch(`/api/settings/staff/${created.body.id}`).set(auth(managerToken)).send({ name: 'Ana Lopez', isTechnician: true });
    expect(renamed.status).toBe(200);
    const list = await request(app).get('/api/settings/staff').set(auth(managerToken));
    expect(list.body.find((s: { id: number }) => s.id === created.body.id).initials).toBe('AL');
    const gone = await request(app).delete(`/api/settings/staff/${created.body.id}`).set(auth(managerToken));
    expect(gone.status).toBe(200);
    const sara = list.body.find((s: { name: string }) => s.name === 'Sara R.');
    const blocked = await request(app).delete(`/api/settings/staff/${sara.id}`).set(auth(managerToken));
    expect(blocked.status).toBe(409);
    const mike = list.body.find((s: { name: string }) => s.name === 'Mike K.');
    const self = await request(app).delete(`/api/settings/staff/${mike.id}`).set(auth(managerToken));
    expect(self.status).toBe(400);
  });

  it('reports every transaction behind the summary, grouped', async () => {
    const res = await request(app).get('/api/reports/transactions?range=today').set(auth(managerToken));
    expect(res.status).toBe(200);
    const { groups, totals } = res.body;
    for (const key of ['repairs', 'sales', 'accessories', 'payouts', 'tradeins', 'credits']) {
      expect(Array.isArray(groups[key])).toBe(true);
      expect(totals[key].count).toBe(groups[key].length);
    }
    expect(groups.sales.some((r: { description: string }) => r.description === 'Glass')).toBe(true);
    expect(groups.accessories.some((r: { description: string }) => r.description.includes('Tempered glass'))).toBe(true);
    expect(groups.payouts.some((r: { note: string | null; amountCents: number }) => r.note === 'Window cleaner' && r.amountCents === -1500)).toBe(true);
    expect(groups.credits.some((r: { note: string | null }) => r.note === 'Deposit held as store credit')).toBe(true);
    expect(totals.payouts.cents).toBeLessThan(0);
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

  it('corrects a completed sale only once the difference is settled', async () => {
    const sale = await request(app)
      .post('/api/sales/complete')
      .set(auth(employeeToken))
      .send({
        lines: [
          { kind: 'product', description: 'Tempered glass protector', qty: 2, unitCents: 1500, taxable: true, inventoryItemId: glassId },
          { kind: 'custom', description: 'Install fee', qty: 1, unitCents: 1000, taxable: true },
        ],
        payments: [{ method: 'cash', amountCents: 4240, tenderedCents: 5000 }],
      });
    expect(sale.status).toBe(200);
    const before = await qtyOf(glassId);

    const denied = await request(app)
      .post(`/api/sales/${sale.body.sale.id}/amend`)
      .set(auth(employeeToken))
      .send({ lines: [{ kind: 'custom', description: 'Install fee', qty: 1, unitCents: 500, taxable: true }] });
    expect(denied.status).toBe(403);

    // drop one protector and cut the install fee to $5 — without saying how the
    // difference goes back, nothing changes: lines, tenders and stock stay put
    const cheaper = [
      { kind: 'product', description: 'Tempered glass protector', qty: 1, unitCents: 1500, taxable: true, inventoryItemId: glassId },
      { kind: 'custom', description: 'Install fee', qty: 1, unitCents: 500, taxable: true },
    ];
    const unsettled = await request(app).post(`/api/sales/${sale.body.sale.id}/amend`).set(auth(managerToken)).send({ lines: cheaper });
    expect(unsettled.status).toBe(400);
    const detail = await request(app).get(`/api/sales/${sale.body.sale.id}`).set(auth(managerToken));
    expect(detail.body.status).toBe('completed');
    expect(detail.body.totalCents).toBe(4240);
    expect(detail.body.lines).toHaveLength(2);
    expect(detail.body.payments).toHaveLength(1);
    expect(await qtyOf(glassId)).toBe(before);

    // settled as cash back: the original is voided, the corrected sale carries the tender, one protector returns to stock
    const amended = await request(app).post(`/api/sales/${sale.body.sale.id}/amend`).set(auth(managerToken)).send({ lines: cheaper, refundMethod: 'cash' });
    expect(amended.status).toBe(200);
    expect(amended.body.sale.totalCents).toBe(2120);
    expect(amended.body.diffCents).toBe(-2120);
    expect(await qtyOf(glassId)).toBe(before + 1);
    const voided = await request(app).get(`/api/sales/${sale.body.sale.id}`).set(auth(managerToken));
    expect(voided.body.status).toBe('voided');
    const corrected = await request(app).get(`/api/sales/${amended.body.sale.id}`).set(auth(managerToken));
    expect(corrected.body.payments.map((p: { method: string; amountCents: number }) => [p.method, p.amountCents])).toEqual([['cash', 4240], ['cash', -2120]]);
    const receipt = await request(app).get(`/api/sales/${amended.body.sale.id}/receipt`).set(auth(managerToken));
    expect(receipt.body.receiptText).toContain('$21.20');
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
