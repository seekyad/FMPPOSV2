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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();

  const stores = await request(app).get('/api/auth/stores');
  const reg = await request(app)
    .post('/api/auth/terminal/register')
    .send({ pairingCode: (await issuePairing(await getDb(), stores.body[0].id, 'pos')).pairingCode, name: 'Print test terminal' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  managerToken = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })
  ).body.token;
}, 60_000);

describe('print center', () => {
  it('previews a receipt honoring toggles and paper width', async () => {
    const wide = await request(app)
      .post('/api/print/preview')
      .set(auth(managerToken))
      .send({ receipt: { paper: 80 } });
    expect(wide.status).toBe(200);
    expect(wide.body.receiptText).toContain('Sample Customer');
    expect(wide.body.receiptText.split('\n')[3]).toHaveLength(42);

    const narrow = await request(app)
      .post('/api/print/preview')
      .set(auth(managerToken))
      .send({ receipt: { paper: 58, customer: false, terms: true, termsText: 'No refunds after 30 days.' } });
    expect(narrow.body.receiptText).not.toContain('Sample Customer');
    expect(narrow.body.receiptText).toContain('No refunds after 30 days.');
    expect(Math.max(...narrow.body.receiptText.split('\n').map((l: string) => l.length))).toBeLessThanOrEqual(32);
  });

  it('saved settings shape real sale receipts', async () => {
    const put = await request(app)
      .put('/api/settings/store')
      .set(auth(managerToken))
      .send({ settings: { print: { receipt: { customer: false, paper: 58 } } } });
    expect(put.status).toBe(200);

    const sale = await request(app)
      .post('/api/sales/complete')
      .set(auth(managerToken))
      .send({
        customerId: 1,
        lines: [{ kind: 'custom', description: 'Print-settings test item', qty: 1, unitCents: 1000, taxable: true }],
        payments: [{ method: 'cash', amountCents: 1060, tenderedCents: 1060 }],
      });
    expect(sale.status).toBe(200);
    expect(sale.body.receiptText).not.toContain('Customer:');
    expect(Math.max(...sale.body.receiptText.split('\n').map((l: string) => l.length))).toBeLessThanOrEqual(32);

    // restore defaults for other tests
    await request(app)
      .put('/api/settings/store')
      .set(auth(managerToken))
      .send({ settings: { print: {} } });
  });

  it('logs printed receipts in the queue and can reprint them', async () => {
    const queue = await request(app).get('/api/print/queue').set(auth(managerToken));
    expect(queue.status).toBe(200);
    const job = queue.body.find((q: { name: string }) => q.name.startsWith('Sales receipt'));
    expect(job).toBeDefined();
    expect(job.canReprint).toBe(true);

    // no bridge connected in tests: reprint records a failed attempt but succeeds as a call
    const reprint = await request(app).post(`/api/print/jobs/${job.id}/reprint`).set(auth(managerToken));
    expect(reprint.status).toBe(200);
    expect(reprint.body.printed).toBe(false);
  });

  it('logs browser label prints', async () => {
    const log = await request(app)
      .post('/api/print/log')
      .set(auth(managerToken))
      .send({ kind: 'label', name: 'Claim tag — R-9999', detail: '50 × 30 mm · browser', payload: { number: 'R-9999' } });
    expect(log.status).toBe(200);
    const queue = await request(app).get('/api/print/queue').set(auth(managerToken));
    const job = queue.body.find((q: { name: string }) => q.name === 'Claim tag — R-9999');
    expect(job.kind).toBe('label');
    expect(job.status).toBe('sent');
  });

  it('reports bridge status', async () => {
    const res = await request(app).get('/api/print/status').set(auth(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.bridgeOnline).toBe(false);
  });
});
