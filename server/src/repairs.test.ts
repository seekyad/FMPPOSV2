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
  services: Array<{
    id: number;
    name: string;
    basePriceCents: number;
    partItemId: number | null;
    tiers: Array<{ label: string; priceCents: number }>;
  }>;
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

function serviceByName(name: string) {
  return meta.services.find((s) => s.name === name)!;
}

async function partQty(partItemId: number): Promise<number> {
  const db = await getDb();
  const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, partItemId));
  return item!.qty;
}

describe('repairs flow (services catalog)', () => {
  let ticketId = 0;
  let screen: ReturnType<typeof serviceByName>;

  it('meta exposes services with tiers', () => {
    screen = serviceByName('Screen replacement — iPhone');
    expect(screen.basePriceCents).toBe(18900);
    expect(screen.tiers.map((t) => t.label)).toContain('iPhone 14 / 15');
    expect(screen.partItemId).toBeTruthy();
  });

  it('creates a ticket priced from a service tier', async () => {
    const battery = serviceByName('Battery replacement — iPhone');
    const tier = screen.tiers.find((t) => t.label === 'iPhone 12 / 13')!;
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
          { deviceIndex: 0, serviceId: screen.id, tierLabel: tier.label, description: `Screen replacement — iPhone (${tier.label})`, priceCents: tier.priceCents, warrantyDays: 90 },
          { deviceIndex: 0, serviceId: battery.id, description: 'Battery replacement — iPhone', priceCents: battery.basePriceCents, warrantyDays: 90 },
        ],
        notesForTech: 'Customer reports touch dead in top-right corner',
      });
    expect(res.status).toBe(200);
    ticketId = res.body.ticket.id;
    // 189 + 89 = 278 + 6% = 294.68
    expect(res.body.ticket.totalCents).toBe(29468);
    expect(res.body.lines[0].tierLabel).toBe('iPhone 12 / 13');
  });

  it('shows on the board with balance due', async () => {
    const res = await request(app).get('/api/repairs?filter=today').set(auth());
    const row = res.body.rows.find((r: { id: number }) => r.id === ticketId);
    expect(row).toBeTruthy();
    expect(row.paidCents).toBe(0);
    expect(row.customerName).toBe('Dana Nguyen');
  });

  it('takes a deposit and blocks over-deposits', async () => {
    const dep = await request(app)
      .post(`/api/repairs/${ticketId}/deposit`)
      .set(auth())
      .send({ method: 'cash', amountCents: 10000, tenderedCents: 10000 });
    expect(dep.status).toBe(200);
    const over = await request(app)
      .post(`/api/repairs/${ticketId}/deposit`)
      .set(auth())
      .send({ method: 'cash', amountCents: 999999 });
    expect(over.status).toBe(400);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.paidCents).toBe(10000);
    expect(detail.body.balanceCents).toBe(29468 - 10000);
  });

  it('walks the status flow and consumes the linked part on completion', async () => {
    const before = await partQty(screen.partItemId!);
    await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'in_progress' });
    await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'ready' });
    const done = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'completed' });
    expect(done.status).toBe(200);
    expect(await partQty(screen.partItemId!)).toBe(before - 1);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.history.map((h: { status: string }) => h.status)).toEqual([
      'intake',
      'in_progress',
      'ready',
      'completed',
    ]);
  });

  it('pays the remaining balance through a register sale', async () => {
    const balance = 29468 - 10000;
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth())
      .send({
        customerId,
        lines: [
          { kind: 'repair', description: 'Ticket balance', qty: 1, unitCents: Math.round(balance / 1.06), taxable: true, ticketId },
        ],
        payments: [{ method: 'card', amountCents: 99999 }],
      });
    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.balanceCents).toBeLessThanOrEqual(2);
  });

  it('cancels a fresh ticket and blocks further status changes', async () => {
    const model = meta.models.find((m) => m.name === 'iPhone 13')!;
    const created = await request(app)
      .post('/api/repairs')
      .set(auth())
      .send({
        customerId,
        devices: [{ modelId: model.id, label: 'iPhone 13 spare', powersOn: false }],
        lines: [{ deviceIndex: 0, serviceId: screen.id, description: 'Screen replacement — iPhone', priceCents: screen.basePriceCents }],
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
        lines: [{ deviceIndex: 0, description: 'Warranty rework: screen replacement', priceCents: 0 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.ticket.totalCents).toBe(0);
    expect(res.body.ticket.warrantyOfTicketId).toBe(ticketId);
  });

  it('supports catalog management: create, edit, duplicate, bulk price', async () => {
    const created = await request(app)
      .post('/api/catalog/services')
      .set(auth())
      .send({
        category: 'Screens',
        name: 'Screen replacement — Pixel',
        deviceGroup: 'Pixel 6–9',
        basePriceCents: 19900,
        partsCostCents: 8200,
        tiers: [
          { label: 'Pixel 6 / 7', priceCents: 19900 },
          { label: 'Pixel 8 / 9', priceCents: 22900 },
        ],
      });
    expect(created.status).toBe(200);

    const dup = await request(app).post(`/api/catalog/services/${created.body.id}/duplicate`).set(auth());
    expect(dup.body.name).toContain('(copy)');

    const bulk = await request(app)
      .post('/api/catalog/services/bulk-price')
      .set(auth())
      .send({ percent: 10, serviceIds: [created.body.id] });
    expect(bulk.status).toBe(200);

    const list = await request(app).get('/api/catalog/services').set(auth());
    const updated = list.body.find((s: { id: number }) => s.id === created.body.id);
    expect(updated.basePriceCents).toBe(21900); // 19900 * 1.1 = 21890 → rounds to whole dollars
    expect(updated.tiers.find((t: { label: string }) => t.label === 'Pixel 8 / 9').priceCents).toBe(25200);
  });
});
