import { Router } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeTotals } from '@fmp/shared';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';
import { audit, emitStore } from '../util';
import { getOpenDrawer } from './drawer';

export const repairsRouter = Router();
repairsRouter.use(requireAuth);

const OPEN_STATUSES = ['intake', 'in_progress', 'waiting_part', 'ready'] as const;

async function nextRepairNumber(db: Awaited<ReturnType<typeof getDb>>): Promise<string> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(schema.repairTickets);
  return `R-${2264 + Number(row?.n ?? 0)}`;
}

/** Catalog metadata for the New Repair window. */
repairsRouter.get('/meta', async (_req, res) => {
  const db = await getDb();
  const models = await db
    .select()
    .from(schema.deviceModels)
    .where(eq(schema.deviceModels.active, true))
    .orderBy(asc(schema.deviceModels.brand), asc(schema.deviceModels.name));
  const types = await db
    .select()
    .from(schema.repairTypes)
    .where(eq(schema.repairTypes.active, true))
    .orderBy(asc(schema.repairTypes.category), asc(schema.repairTypes.sortOrder));
  const catalog = await db.select().from(schema.serviceCatalog).where(eq(schema.serviceCatalog.active, true));
  const technicians = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.active, true), eq(schema.users.isTechnician, true)));
  res.json({ models, types, catalog, technicians });
});

/** Board list with filters. */
repairsRouter.get('/', async (req, res) => {
  const db = await getDb();
  const t = schema.repairTickets;
  const filter = String(req.query.filter ?? 'today');
  const q = String(req.query.query ?? '').trim();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const filterWhere =
    filter === 'today'
      ? gte(t.createdAt, todayStart)
      : filter === 'open'
        ? inArray(t.status, [...OPEN_STATUSES])
        : filter === 'in_progress'
          ? eq(t.status, 'in_progress')
          : filter === 'waiting_part'
            ? eq(t.status, 'waiting_part')
            : filter === 'call'
              ? and(eq(t.callFlag, true), inArray(t.status, [...OPEN_STATUSES]))
              : filter === 'ready'
                ? eq(t.status, 'ready')
                : filter === 'past_promised'
                  ? and(inArray(t.status, [...OPEN_STATUSES]), isNotNull(t.promisedAt), lt(t.promisedAt, new Date()))
                  : eq(t.status, 'completed');

  const rows = await db
    .select({
      ticket: t,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      technicianName: schema.users.name,
      paidCents: sql<number>`coalesce((select sum(p.amount_cents) from payments p where p.ticket_id = ${t.id}), 0)`,
      deviceSummary: sql<string>`(select string_agg(d.label, ' + ') from ticket_devices d where d.ticket_id = ${t.id})`,
      serviceSummary: sql<string>`(select string_agg(l.description, ', ') from ticket_lines l where l.ticket_id = ${t.id})`,
    })
    .from(t)
    .leftJoin(schema.customers, eq(t.customerId, schema.customers.id))
    .leftJoin(schema.users, eq(t.technicianId, schema.users.id))
    .where(
      and(
        eq(t.storeId, req.session!.storeId),
        filterWhere,
        q
          ? or(
              ilike(t.number, `%${q}%`),
              ilike(schema.customers.name, `%${q}%`),
              ilike(schema.customers.phone, `%${q}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(t.createdAt))
    .limit(200);

  const counts = await db
    .select({ status: t.status, callFlag: t.callFlag, n: sql<number>`count(*)` })
    .from(t)
    .where(eq(t.storeId, req.session!.storeId))
    .groupBy(t.status, t.callFlag);

  const [todayRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(and(eq(t.storeId, req.session!.storeId), gte(t.createdAt, todayStart)));

  res.json({
    rows: rows.map((r) => ({
      ...r.ticket,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      technicianName: r.technicianName,
      paidCents: Number(r.paidCents),
      deviceSummary: r.deviceSummary,
      serviceSummary: r.serviceSummary,
    })),
    counts,
    todayCount: Number(todayRow?.n ?? 0),
  });
});

/** Intake strip on the Register. */
repairsRouter.get('/taken-today', async (req, res) => {
  const db = await getDb();
  const t = schema.repairTickets;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      ticket: t,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      deviceSummary: sql<string>`(select string_agg(d.label, ' + ') from ticket_devices d where d.ticket_id = ${t.id})`,
    })
    .from(t)
    .leftJoin(schema.customers, eq(t.customerId, schema.customers.id))
    .where(and(eq(t.storeId, req.session!.storeId), gte(t.createdAt, todayStart)))
    .orderBy(asc(t.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.ticket.id,
      number: r.ticket.number,
      status: r.ticket.status,
      createdAt: r.ticket.createdAt,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      deviceSummary: r.deviceSummary,
    })),
  );
});

const deviceSchema = z.object({
  modelId: z.number().int().optional().nullable(),
  label: z.string().min(1).max(120),
  imei: z.string().max(20).optional().nullable(),
  powersOn: z.boolean().default(true),
  unlockMethod: z.enum(['passcode', 'password', 'pattern', 'none']).optional().nullable(),
  unlockValue: z.string().max(60).optional().nullable(),
  conditionNotes: z.string().max(1000).optional().nullable(),
});

const ticketLineSchema = z.object({
  deviceIndex: z.number().int().min(0),
  serviceCatalogId: z.number().int().optional().nullable(),
  description: z.string().min(1).max(200),
  priceCents: z.number().int().min(0),
  warrantyDays: z.number().int().min(0).default(90),
});

/** Create a repair ticket (New repair window). */
repairsRouter.post('/', async (req, res) => {
  const body = z
    .object({
      customerId: z.number().int().optional().nullable(),
      newCustomer: z.object({ name: z.string().min(1), phone: z.string().optional().nullable() }).optional().nullable(),
      callFlag: z.boolean().default(false),
      technicianId: z.number().int().optional().nullable(),
      promisedAt: z.string().datetime().optional().nullable(),
      notesForTech: z.string().max(2000).optional().nullable(),
      devices: z.array(deviceSchema).min(1),
      lines: z.array(ticketLineSchema).min(1),
      warrantyOfTicketId: z.number().int().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid ticket', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();

  let customerId = body.data.customerId ?? null;
  if (!customerId && body.data.newCustomer) {
    const [c] = await db
      .insert(schema.customers)
      .values({ name: body.data.newCustomer.name, phone: body.data.newCustomer.phone ?? null })
      .returning();
    customerId = c!.id;
  }
  if (!customerId) {
    res.status(400).json({ error: 'A customer is required for a repair ticket' });
    return;
  }

  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const totals = computeTotals(
    body.data.lines.map((l) => ({ qty: 1, unitCents: l.priceCents, taxable: true })),
    store?.taxRateBp ?? 600,
  );

  const number = await nextRepairNumber(db);
  const [ticket] = await db
    .insert(schema.repairTickets)
    .values({
      storeId: req.session!.storeId,
      number,
      customerId,
      status: 'intake',
      callFlag: body.data.callFlag,
      technicianId: body.data.technicianId ?? null,
      promisedAt: body.data.promisedAt ? new Date(body.data.promisedAt) : null,
      totalCents: totals.totalCents,
      warrantyOfTicketId: body.data.warrantyOfTicketId ?? null,
      intakeBy: req.session!.id,
      notesForTech: body.data.notesForTech ?? null,
    })
    .returning();

  const deviceRows = await db
    .insert(schema.ticketDevices)
    .values(body.data.devices.map((d) => ({ ...d, ticketId: ticket!.id })))
    .returning();

  const lineRows = await db
    .insert(schema.ticketLines)
    .values(
      body.data.lines.map((l) => ({
        ticketId: ticket!.id,
        ticketDeviceId: deviceRows[l.deviceIndex]?.id ?? null,
        serviceCatalogId: l.serviceCatalogId ?? null,
        description: l.description,
        priceCents: l.priceCents,
        warrantyDays: l.warrantyDays,
      })),
    )
    .returning();

  await db.insert(schema.ticketStatusHistory).values({ ticketId: ticket!.id, status: 'intake', userId: req.session!.id });
  await audit(db, req, 'ticket.create', 'repair_ticket', ticket!.id, { total: totals.totalCents });
  emitStore(req, 'repairs-changed');
  res.json({ ticket, devices: deviceRows, lines: lineRows, totals });
});

/** Ticket detail. */
repairsRouter.get('/:id', async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.id, ticket.customerId));
  const devices = await db.select().from(schema.ticketDevices).where(eq(schema.ticketDevices.ticketId, id));
  const lines = await db.select().from(schema.ticketLines).where(eq(schema.ticketLines.ticketId, id));
  const ticketPayments = await db.select().from(schema.payments).where(eq(schema.payments.ticketId, id));
  const history = await db
    .select({ h: schema.ticketStatusHistory, userName: schema.users.name })
    .from(schema.ticketStatusHistory)
    .leftJoin(schema.users, eq(schema.ticketStatusHistory.userId, schema.users.id))
    .where(eq(schema.ticketStatusHistory.ticketId, id))
    .orderBy(asc(schema.ticketStatusHistory.createdAt));
  const paidCents = ticketPayments.reduce((s, p) => s + p.amountCents, 0);
  res.json({
    ticket,
    customer,
    devices,
    lines,
    payments: ticketPayments,
    history: history.map((r) => ({ ...r.h, userName: r.userName })),
    paidCents,
    balanceCents: ticket.totalCents - paidCents,
  });
});

/** Status transitions, tech assignment, call flag, promised time. */
repairsRouter.patch('/:id', async (req, res) => {
  const body = z
    .object({
      status: z.enum(['intake', 'in_progress', 'waiting_part', 'ready', 'completed']).optional(),
      technicianId: z.number().int().nullable().optional(),
      callFlag: z.boolean().optional(),
      promisedAt: z.string().datetime().nullable().optional(),
      notesForTech: z.string().max(2000).nullable().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  if (['cancelled', 'abandoned'].includes(ticket.status)) {
    res.status(400).json({ error: `Ticket is ${ticket.status}` });
    return;
  }

  const update: Partial<typeof schema.repairTickets.$inferInsert> = {};
  if (body.data.technicianId !== undefined) update.technicianId = body.data.technicianId;
  if (body.data.callFlag !== undefined) update.callFlag = body.data.callFlag;
  if (body.data.promisedAt !== undefined)
    update.promisedAt = body.data.promisedAt ? new Date(body.data.promisedAt) : null;
  if (body.data.notesForTech !== undefined) update.notesForTech = body.data.notesForTech;

  if (body.data.status && body.data.status !== ticket.status) {
    update.status = body.data.status;
    if (body.data.status === 'completed') {
      update.completedAt = new Date();
      await consumeParts(db, req.session!.id, id);
    }
    await db.insert(schema.ticketStatusHistory).values({ ticketId: id, status: body.data.status, userId: req.session!.id });
  }

  const [row] = await db.update(schema.repairTickets).set(update).where(eq(schema.repairTickets.id, id)).returning();
  await audit(db, req, 'ticket.update', 'repair_ticket', id, body.data);
  emitStore(req, 'repairs-changed');
  res.json(row);
});

/** Consume linked catalog parts exactly once when work is completed. */
async function consumeParts(db: Awaited<ReturnType<typeof getDb>>, userId: number, ticketId: number) {
  const lines = await db
    .select({ line: schema.ticketLines, partItemId: schema.serviceCatalog.partItemId })
    .from(schema.ticketLines)
    .leftJoin(schema.serviceCatalog, eq(schema.ticketLines.serviceCatalogId, schema.serviceCatalog.id))
    .where(eq(schema.ticketLines.ticketId, ticketId));
  for (const { line, partItemId } of lines) {
    if (!partItemId || line.partConsumed) continue;
    await db
      .update(schema.inventoryItems)
      .set({ qty: sql`greatest(${schema.inventoryItems.qty} - 1, 0)` })
      .where(eq(schema.inventoryItems.id, partItemId));
    await db.insert(schema.inventoryMovements).values({
      itemId: partItemId,
      deltaQty: -1,
      kind: 'repair_consume',
      refId: ticketId,
      userId,
    });
    await db.update(schema.ticketLines).set({ partConsumed: true }).where(eq(schema.ticketLines.id, line.id));
  }
}

/** Take a deposit against the ticket. */
repairsRouter.post('/:id/deposit', async (req, res) => {
  const body = z
    .object({
      method: z.enum(['cash', 'card', 'tap']),
      amountCents: z.number().int().min(1),
      tenderedCents: z.number().int().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'method and amount required' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  if (body.data.method === 'cash') await getOpenDrawer(db, req.session!.storeId, req.session!.id);
  const existing = await db.select().from(schema.payments).where(eq(schema.payments.ticketId, id));
  const paid = existing.reduce((s, p) => s + p.amountCents, 0);
  if (paid + body.data.amountCents > ticket.totalCents) {
    res.status(400).json({ error: 'Deposit exceeds ticket balance' });
    return;
  }
  const change =
    body.data.method === 'cash' && body.data.tenderedCents != null
      ? body.data.tenderedCents - body.data.amountCents
      : null;
  await db.insert(schema.payments).values({
    ticketId: id,
    method: body.data.method,
    amountCents: body.data.amountCents,
    tenderedCents: body.data.method === 'cash' ? (body.data.tenderedCents ?? null) : null,
    changeCents: change,
    isDeposit: true,
    userId: req.session!.id,
  });
  await audit(db, req, 'ticket.deposit', 'repair_ticket', id, body.data);
  emitStore(req, 'repairs-changed');
  res.json({ ok: true, changeCents: change, paidCents: paid + body.data.amountCents });
});

/** Cancel: parts restock (if consumed), deposit note surfaced for manual handling. */
repairsRouter.post('/:id/cancel', async (req, res) => {
  const body = z.object({ reason: z.string().min(2).max(300) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A reason is required' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  if (['completed', 'cancelled', 'abandoned'].includes(ticket.status)) {
    res.status(400).json({ error: `Cannot cancel a ${ticket.status} ticket` });
    return;
  }
  // restore any consumed parts
  const lines = await db
    .select({ line: schema.ticketLines, partItemId: schema.serviceCatalog.partItemId })
    .from(schema.ticketLines)
    .leftJoin(schema.serviceCatalog, eq(schema.ticketLines.serviceCatalogId, schema.serviceCatalog.id))
    .where(eq(schema.ticketLines.ticketId, id));
  for (const { line, partItemId } of lines) {
    if (!partItemId || !line.partConsumed) continue;
    await db
      .update(schema.inventoryItems)
      .set({ qty: sql`${schema.inventoryItems.qty} + 1` })
      .where(eq(schema.inventoryItems.id, partItemId));
    await db.insert(schema.inventoryMovements).values({
      itemId: partItemId,
      deltaQty: 1,
      kind: 'repair_restore',
      refId: id,
      userId: req.session!.id,
    });
  }
  await db.update(schema.repairTickets).set({ status: 'cancelled' }).where(eq(schema.repairTickets.id, id));
  await db.insert(schema.ticketStatusHistory).values({ ticketId: id, status: 'cancelled', userId: req.session!.id });
  const deposits = await db.select().from(schema.payments).where(eq(schema.payments.ticketId, id));
  const depositCents = deposits.reduce((s, p) => s + p.amountCents, 0);
  await audit(db, req, 'ticket.cancel', 'repair_ticket', id, { reason: body.data.reason, depositCents });
  emitStore(req, 'repairs-changed');
  res.json({ ok: true, depositCents });
});
