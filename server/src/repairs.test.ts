import { issuePairing } from './pairing';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { createApp } from './app';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';
import { netFromGrossCents } from '@fmp/shared';

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
    .send({ pairingCode: (await issuePairing(await getDb(), stores.body[0].id, 'pos')).pairingCode, name: 'Repairs test' });
  const staff = await request(app).get('/api/auth/staff').set('X-Device-Token', reg.body.deviceToken);
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

  it('filters the board by status tab and date range', async () => {
    const find = (body: { rows: Array<{ id: number }> }) => body.rows.some((r) => r.id === ticketId);
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const hourAhead = new Date(Date.now() + 3_600_000).toISOString();
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const todayAll = await request(app).get(`/api/repairs?status=all&from=${dayAgo}&to=${hourAhead}`).set(auth());
    expect(todayAll.status).toBe(200);
    expect(find(todayAll.body)).toBe(true);
    // tab counts are scoped to the range and include this open ticket
    const openCount = todayAll.body.counts.filter((c: { status: string }) => c.status === 'open')
      .reduce((s: number, c: { n: number }) => s + Number(c.n), 0);
    expect(openCount).toBeGreaterThanOrEqual(1);

    const pickedUp = await request(app).get(`/api/repairs?status=picked_up&from=${dayAgo}&to=${hourAhead}`).set(auth());
    expect(find(pickedUp.body)).toBe(false);

    const lastWeekOnly = await request(app).get(`/api/repairs?status=all&from=${lastWeek}&to=${dayAgo}`).set(auth());
    expect(find(lastWeekOnly.body)).toBe(false);

    // the Today board keeps every open ticket even when it was created outside the range
    const lastWeekWithOpen = await request(app).get(`/api/repairs?status=all&from=${lastWeek}&to=${dayAgo}&withOpen=1`).set(auth());
    expect(find(lastWeekWithOpen.body)).toBe(true);
  });

  it('carries Call and Order parts tags and filters the board by them', async () => {
    const tagged = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ partsFlag: true });
    expect(tagged.status).toBe(200);
    expect(tagged.body.partsFlag).toBe(true);
    expect(tagged.body.callFlag).toBe(true);
    const parts = await request(app).get('/api/repairs?status=parts').set(auth());
    expect(parts.body.rows.some((r: { id: number }) => r.id === ticketId)).toBe(true);
    const call = await request(app).get('/api/repairs?status=call').set(auth());
    expect(call.body.rows.some((r: { id: number }) => r.id === ticketId)).toBe(true);
    const cleared = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ partsFlag: false, alertFlag: true });
    expect(cleared.body.partsFlag).toBe(false);
    expect(cleared.body.alertFlag).toBe(true);
    const board = await request(app).get('/api/repairs?status=open').set(auth());
    expect(board.body.rows.find((r: { id: number }) => r.id === ticketId).alertFlag).toBe(true);
  });

  it('edits an open ticket without a manager code and recomputes the total', async () => {
    const detail = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    const body = {
      customerId: detail.ticket.customerId,
      callFlag: false,
      notesForTech: 'Edited before work started',
      devices: detail.devices.map((d: { modelId: number | null; label: string; imei: string | null }) => ({
        modelId: d.modelId, label: d.label, imei: d.imei, powersOn: true, unlockMethod: 'none', unlockValue: null, conditionNotes: null,
      })),
      // drop the battery line: only the screen replacement remains
      lines: detail.lines
        .filter((l: { description: string }) => l.description.startsWith('Screen replacement'))
        .map((l: { serviceId: number | null; tierLabel: string | null; description: string; priceCents: number; warrantyDays: number }) => ({
          deviceIndex: 0, serviceId: l.serviceId, tierLabel: l.tierLabel, description: l.description, priceCents: l.priceCents, warrantyDays: l.warrantyDays,
        })),
    };
    const res = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send(body);
    expect(res.status).toBe(200);
    // 189 + 6% = 200.34
    expect(res.body.ticket.totalCents).toBe(20034);
    expect(res.body.ticket.notesForTech).toBe('Edited before work started');
    const after = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    expect(after.lines).toHaveLength(1);
    expect(after.history.some((h: { note: string | null }) => h.note === 'Ticket edited')).toBe(true);

    // put the battery line back so the rest of the flow (parts, payment) is unchanged
    const battery = serviceByName('Battery replacement — iPhone');
    const restore = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send({
      ...body,
      lines: [...body.lines, { deviceIndex: 0, serviceId: battery.id, description: 'Battery replacement — iPhone', priceCents: battery.basePriceCents, warrantyDays: 90 }],
    });
    expect(restore.status).toBe(200);
    expect(restore.body.ticket.totalCents).toBe(29468);
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

  it('locks a paid ticket behind a manager code', async () => {
    const detail = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    const body = {
      customerId: detail.ticket.customerId,
      callFlag: true,
      devices: detail.devices.map((d: { modelId: number | null; label: string; imei: string | null }) => ({
        modelId: d.modelId, label: d.label, imei: d.imei, powersOn: true, unlockMethod: 'none', unlockValue: null, conditionNotes: null,
      })),
      lines: detail.lines.map((l: { serviceId: number | null; tierLabel: string | null; description: string; priceCents: number; warrantyDays: number }) => ({
        deviceIndex: 0, serviceId: l.serviceId, tierLabel: l.tierLabel, description: l.description, priceCents: l.priceCents, warrantyDays: l.warrantyDays,
      })),
    };
    const noCode = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send(body);
    expect(noCode.status).toBe(403);
    const wrongCode = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send({ ...body, managerPin: '9999' });
    // 403, not 401: a 401 would sign the whole register out
    expect(wrongCode.status).toBe(403);
    // Sara's PIN is an employee PIN, not a manager code
    const employeeCode = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send({ ...body, managerPin: '2345' });
    expect(employeeCode.status).toBe(403);
    // total below what was already paid is refused even with the code
    const tooCheap = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send({
      ...body, managerPin: '1234', lines: [{ deviceIndex: 0, serviceId: null, description: 'Diagnostic only', priceCents: 1000, warrantyDays: 0 }],
    });
    expect(tooCheap.status).toBe(400);
    const ok = await request(app).put(`/api/repairs/${ticketId}`).set(auth()).send({ ...body, managerPin: '1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket.callFlag).toBe(true);
    const after = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    expect(after.history.at(-1).note).toContain('manager code by Mike K.');
  });

  it('walks the status flow and consumes the linked part on completion', async () => {
    const before = await partQty(screen.partItemId!);
    await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'in_progress' });
    const waiting = await request(app)
      .patch(`/api/repairs/${ticketId}`)
      .set(auth())
      .send({ status: 'waiting_part', statusNote: 'Screen from MobileSentrix, lands Thursday' });
    expect(waiting.status).toBe(200);
    const done = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'completed' });
    expect(done.status).toBe(200);
    expect(await partQty(screen.partItemId!)).toBe(before - 1);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    // edits add their own history rows; only status changes are asserted here
    const statusRows = detail.body.history.filter((h: { note: string | null }) => !h.note?.startsWith('Ticket edited'));
    expect(statusRows.map((h: { status: string }) => h.status)).toEqual([
      'open',
      'in_progress',
      'waiting_part',
      'completed',
    ]);
    const waitingEntry = detail.body.history.find((h: { status: string }) => h.status === 'waiting_part');
    expect(waitingEntry.note).toBe('Screen from MobileSentrix, lands Thursday');
  });

  it('pays the remaining balance at the register, which closes the ticket as picked up', async () => {
    const balance = 29468 - 10000;
    const res = await request(app)
      .post('/api/sales/complete')
      .set(auth())
      .send({
        customerId,
        lines: [
          { kind: 'repair', description: 'Ticket balance', qty: 1, unitCents: Math.round(balance / 1.06), taxable: true, ticketId },
        ],
        payments: [{ method: 'card', amountCents: balance }],
      });
    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/repairs/${ticketId}`).set(auth());
    expect(detail.body.balanceCents).toBeLessThanOrEqual(2);
    expect(detail.body.ticket.status).toBe('picked_up');
  });

  it('reopens a picked-up ticket with a manager code and logs the reason', async () => {
    const noCode = await request(app).post(`/api/repairs/${ticketId}/reopen`).set(auth()).send({ reason: 'Screen lifting again' });
    expect(noCode.status).toBe(400);
    const wrong = await request(app).post(`/api/repairs/${ticketId}/reopen`).set(auth()).send({ reason: 'Screen lifting again', managerPin: '9999' });
    expect(wrong.status).toBe(403);
    const ok = await request(app).post(`/api/repairs/${ticketId}/reopen`).set(auth()).send({ reason: 'Screen lifting again', managerPin: '1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('in_progress');
    const detail = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    expect(detail.history.at(-1).status).toBe('in_progress');
    expect(detail.history.at(-1).note).toContain('Reopened · Screen lifting again');
    expect(detail.history.at(-1).note).toContain('manager code by Mike K.');
    // only a picked-up ticket can be reopened
    const again = await request(app).post(`/api/repairs/${ticketId}/reopen`).set(auth()).send({ reason: 'Once more', managerPin: '1234' });
    expect(again.status).toBe(400);
  });

  it('marks the reopened ticket ready, logs the customer call, and closes it without paying twice', async () => {
    const ready = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'completed', callFlag: true });
    expect(ready.status).toBe(200);
    expect(ready.body.callFlag).toBe(true);
    const message = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ statusNote: 'Left a message for the customer' });
    expect(message.status).toBe(200);
    expect(message.body.callFlag).toBe(true);
    const notified = await request(app)
      .patch(`/api/repairs/${ticketId}`)
      .set(auth())
      .send({ callFlag: false, statusNote: 'Customer notified — ready for pickup' });
    expect(notified.status).toBe(200);
    expect(notified.body.callFlag).toBe(false);
    let detail = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    // note-only rows sit on the current status; the completed row itself carries no note
    expect(detail.history.slice(-3).map((h: { status: string; note: string | null }) => [h.status, h.note])).toEqual([
      ['completed', null],
      ['completed', 'Left a message for the customer'],
      ['completed', 'Customer notified — ready for pickup'],
    ]);
    expect(detail.balanceCents).toBe(0);
    const pickedUp = await request(app).patch(`/api/repairs/${ticketId}`).set(auth()).send({ status: 'picked_up' });
    expect(pickedUp.status).toBe(200);
    detail = (await request(app).get(`/api/repairs/${ticketId}`).set(auth())).body;
    expect(detail.ticket.status).toBe('picked_up');
  });

  it('closes a ticket whose balance a taxed register line cannot hit to the cent', async () => {
    const model = meta.models.find((m) => m.name === 'iPhone 13')!;
    const created = await request(app)
      .post('/api/repairs')
      .set(auth())
      .send({
        customerId,
        devices: [{ modelId: model.id, label: 'iPhone 13 rounding', powersOn: true }],
        lines: [{ deviceIndex: 0, serviceId: null, description: 'Charge port clean', priceCents: 10000, warrantyDays: 0 }],
      });
    const id = created.body.ticket.id;
    expect(created.body.ticket.totalCents).toBe(10600);
    // a deposit leaves a 115-cent balance: no net price taxed at 6% totals exactly 115
    const deposit = await request(app).post(`/api/repairs/${id}/deposit`).set(auth()).send({ method: 'card', amountCents: 10485 });
    expect(deposit.status).toBe(200);
    await request(app).patch(`/api/repairs/${id}`).set(auth()).send({ status: 'in_progress' });
    await request(app).patch(`/api/repairs/${id}`).set(auth()).send({ status: 'completed' });
    const net = netFromGrossCents(115, 600);
    expect(net + Math.round(net * 0.06)).toBe(116);
    // more than a cent over the balance is still refused
    const tooMuch = await request(app).post('/api/sales/complete').set(auth()).send({
      customerId,
      lines: [{ kind: 'repair', description: 'Ticket balance', qty: 1, unitCents: net + 2, taxable: true, ticketId: id }],
      payments: [{ method: 'card', amountCents: 118 }],
    });
    expect(tooMuch.status).toBe(409);
    const sale = await request(app).post('/api/sales/complete').set(auth()).send({
      customerId,
      lines: [{ kind: 'repair', description: 'Ticket balance', qty: 1, unitCents: net, taxable: true, ticketId: id }],
      payments: [{ method: 'card', amountCents: 116 }],
    });
    expect(sale.status).toBe(200);
    const detail = (await request(app).get(`/api/repairs/${id}`).set(auth())).body;
    expect(detail.balanceCents).toBe(0);
    expect(detail.ticket.status).toBe('picked_up');
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
    const again = await request(app).patch(`/api/repairs/${freshId}`).set(auth()).send({ status: 'completed' });
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
