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
let meta: {
  models: Array<{ id: number; name: string }>;
  types: Array<{ id: number; name: string }>;
  catalog: Array<{ id: number; modelId: number; repairTypeId: number; priceCents: number; partItemId: number | null }>;
  technicians: Array<{ id: number; name: string }>;
};
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
    .send({ storeId: stores.body[0].id, name: 'Repairs test' });
  const staff = await request(app).get('/api/auth/staff').query({ deviceToken: reg.body.deviceToken });
  const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
  token = (
    await request(app).post('/api/auth/pin').send({ deviceToken: reg.body.deviceToken, userId: mike.id, pin: '1234' })
  ).body.token;
  meta = (await request(app).get('/api/repairs/meta').set(auth())).body;
  const [dana] = await db.select().from(schema.customers).where(eq(schema.customers.name, 'Dana Nguyen'));
  customerId = dana!.id;
}, 60_000);

function catalogFor(modelName: string, repairName: string) {
  const model = meta.models.find((m) => m.name === modelName)!;
  const type = meta.types.find((t) => t.name === repairName)!;
  return meta.catalog.find((c) => c.modelId === model.id && c.repairTypeId === type.id)!;
}

async function partQty(partItemId: number): Promise<number> {
  const db = await getDb();
  const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, partItemId));
  return item!.qty;
}

describe('repairs flow', () => {
  let ticketId = 0;
  let cracked: ReturnType<typeof catalogFor>;

  it('creates a two-device ticket with catalog pricing', async () => {
    cracked = catalogFor('iPhone 13', 'Cracked screen');
    const battery = catalogFor('iPhone 13', 'Battery replacement');
    const model = meta.models.find((m) => m.name === 'iPhone 13')!;
    const res = await request(app)
      .post('/api/repairs')
      .set(auth())
      .send({
        customerId,
        callFlag: true,
        technicianId: meta.technicians[0]!.id,
        devices: [
          { modelId: model.id, label: 'iPhone 13 · 128 GB', imei: '353912340073522', powersOn: true, unlockMethod: 'passcode', unlockValue: '4821' },
        ],
        lines: [
          { deviceIndex: 0, serviceCatalogId: cracked.id, description: 'Cracked screen', priceCents: cracked.priceCents, warrantyDays: 90 },
          { deviceIndex: 0, serviceCatalogId: battery.id, description: 'Battery replacement', priceCents: battery.priceCents, warrantyDays: 90 },
        ],
        notesForTech: 'Customer reports touch dead in top-right corner',
      });
    expect(res.status).toBe(200);
    ticketId = res.body.ticket.id;
    expect(res.body.ticket.number).toMatch(/^R-/);
    // 129 + 79 = 208 + 6% = 220.48
    expect(res.body.ticket.totalCents).toBe(22048);
    expect(res.body.ticket.callFlag).toBe(true);
  });

  it('shows on the board with balance due', async () => {
    const res = await request(app).get('/api/repairs?filter=today').set(auth());
    const row = res.body.rows.find((r: { id: number }) => r.id === ticketId);
    expect(row).toBeTruthy();
    expect(row.paidCents).toBe(0);
    expect(row.customerName).toBe('Dana Nguyen');
    expect(row.deviceSummary).toContain('iPhone 13');
  });

  it('takes a deposit and blocks over-deposits', async () => {
    const dep = await request(app)
      .post(`/api/repairs/${ticketId}/deposit`)
      .set(auth())
      .send({ method: 'cash', amountCents: 5000, tenderedCents: 5000 });
    expect(dep.status).toBe(200);
    const over = await request(app)
      .post(`/api/repairs/${ticketId}/deposit`)
      .set(auth())
      .send({ method: 'cash', amountCents: 99999 });
    expect(over.status).toBe(400);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.paidCents).toBe(5000);
    expect(detail.body.balanceCents).toBe(22048 - 5000);
  });

  it('walks the status flow and consumes the linked part on completion', async () => {
    expect(cracked.partItemId).toBeTruthy();
    const before = await partQty(cracked.partItemId!);
    await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'in_progress' });
    await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'ready' });
    const done = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'completed' });
    expect(done.status).toBe(200);
    expect(await partQty(cracked.partItemId!)).toBe(before - 1);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.history.map((h: { status: string }) => h.status)).toEqual([
      'intake',
      'in_progress',
      'ready',
      'completed',
    ]);
  });

  it('pays the remaining balance through a register sale', async () => {
    const balance = 22048 - 5000;
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth())
      .send({
        customerId,
        lines: [
          {
            kind: 'repair',
            description: 'Ticket balance',
            qty: 1,
            unitCents: Math.round(balance / 1.06),
            taxable: true,
            ticketId,
          },
        ],
        payments: [{ method: 'card', amountCents: 99999 }],
      });
    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.balanceCents).toBeLessThanOrEqual(2); // rounding cent tolerance
  });

  it('cancels a fresh ticket and restores consumed parts', async () => {
    const model = meta.models.find((m) => m.name === 'iPhone 13')!;
    const created = await request(app)
      .post('/api/repairs')
      .set(auth())
      .send({
        customerId,
        devices: [{ modelId: model.id, label: 'iPhone 13 spare', powersOn: false }],
        lines: [{ deviceIndex: 0, serviceCatalogId: cracked.id, description: 'Cracked screen', priceCents: cracked.priceCents }],
      });
    const freshId = created.body.ticket.id;
    const cancelled = await request(app)
      .post(`/api/repairs/${freshId}/cancel`)
      .set(auth())
      .send({ reason: 'customer declined quote' });
    expect(cancelled.status).toBe(200);
    const again = await request(app).patch(`/api/repairs/${freshId}`).set(auth()).send({ status: 'ready' });
    expect(again.status).toBe(400);
  });

  it('creates a linked warranty ticket at $0', async () => {
    const model = meta.models.find((m) => m.name === 'iPhone 13')!;
    const res = await request(app)
      .post('/api/repairs')
      .set(auth())
      .send({
        customerId,
        warrantyOfTicketId: ticketId,
        devices: [{ modelId: model.id, label: 'iPhone 13 · 128 GB', powersOn: true }],
        lines: [{ deviceIndex: 0, description: 'Warranty rework: cracked screen', priceCents: 0 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.ticket.totalCents).toBe(0);
    expect(res.body.ticket.warrantyOfTicketId).toBe(ticketId);
  });

  it('creates a new customer inline when none exists', async () => {
    const model = meta.models.find((m) => m.name === 'Pixel 7a')!;
    const res = await request(app)
      .post('/api/repairs')
      .set(auth())
      .send({
        newCustomer: { name: 'Jordan Blake', phone: '(737) 555-0155' },
        devices: [{ modelId: model.id, label: 'Pixel 7a', powersOn: true }],
        lines: [{ deviceIndex: 0, description: 'Ghost touch', priceCents: 13900 }],
      });
    expect(res.status).toBe(200);
    const search = await request(app).get('/api/sales/search/all').set(auth()).query({ q: 'Jordan' });
    expect(search.body.customers.length).toBeGreaterThan(0);
  });
});
