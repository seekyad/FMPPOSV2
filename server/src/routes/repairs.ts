import { financialTransaction, ticketPayments as readTicketPayments } from '../finance';
import bcrypt from 'bcryptjs';
import { HttpError } from '../http';
import { allowAuthAttempt } from '../pairing';
import { verifyManagerCode } from '../security';
import { createRouter as Router } from '../http';
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeTotals } from '@fmp/shared';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';
import { audit, emitStore, nextTicketNumber, peekTicketNumber } from '../util';
import { getOpenDrawer } from './drawer';
import { requireStoreReferences } from '../store-scope';

export const repairsRouter = Router();
repairsRouter.use(requireAuth);

/** anything not yet picked up / cancelled counts as an open ticket */
const OPEN_STATUSES = ['open', 'in_progress', 'waiting_part', 'completed'] as const;
/** statuses where the promised time still matters */
const WORKING_STATUSES = ['open', 'in_progress', 'waiting_part'] as const;

/** Tickets draw from the store's shared transaction series, same as receipts. */
async function nextRepairNumber(db: Awaited<ReturnType<typeof getDb>>, storeId: number, reserve = true): Promise<string> {
  return reserve ? nextTicketNumber(db, storeId) : peekTicketNumber(db, storeId);
}

/** Catalog metadata for the New Repair window: services with price tiers. */
repairsRouter.get('/meta', async (req, res) => {
  const db = await getDb();
  const models = await db
    .select()
    .from(schema.deviceModels)
    .where(eq(schema.deviceModels.active, true))
    .orderBy(asc(schema.deviceModels.brand), asc(schema.deviceModels.name));
  const serviceRows = await db
    .select()
    .from(schema.services)
    .where(eq(schema.services.active, true))
    .orderBy(asc(schema.services.category), asc(schema.services.name));
  const tiers = await db.select().from(schema.serviceTiers).orderBy(asc(schema.serviceTiers.sortOrder));
  const technicians = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.active, true), eq(schema.users.isTechnician, true), eq(schema.users.storeId, req.session!.storeId)));
  const nextNumber = await nextRepairNumber(db, req.session!.storeId, false);
  res.json({
    models,
    services: serviceRows.map((s) => ({ ...s, tiers: tiers.filter((t) => t.serviceId === s.id) })),
    technicians,
    nextNumber,
  });
});

/**
 * Board list: a status tab crossed with a date range. A ticket falls in the
 * range when it was created, completed, or picked up inside it; `withOpen=1`
 * (the board's Today view) adds every still-open ticket regardless of date.
 * The legacy `filter=` param is still honoured for older callers.
 */
repairsRouter.get('/', async (req, res) => {
  const db = await getDb();
  const t = schema.repairTickets;
  const h = schema.ticketStatusHistory;
  const q = String(req.query.query ?? '').trim();
  const legacy = String(req.query.filter ?? '');
  const status = String(req.query.status ?? (legacy && legacy !== 'today' ? legacy : 'all'));
  const parseDate = (v: unknown): Date | null => {
    if (!v) return null;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let from = parseDate(req.query.from);
  let to = parseDate(req.query.to);
  let withOpen = req.query.withOpen === '1';
  if (!req.query.status && legacy === 'today') {
    from = new Date();
    from.setHours(0, 0, 0, 0);
    to = null;
    withOpen = false;
  }

  const statusWhere =
    status === 'open'
      ? inArray(t.status, [...OPEN_STATUSES])
      : status === 'in_progress'
        ? eq(t.status, 'in_progress')
        : status === 'waiting_part'
          ? eq(t.status, 'waiting_part')
          : status === 'call'
            ? and(eq(t.callFlag, true), inArray(t.status, [...OPEN_STATUSES]))
            : status === 'parts'
              ? and(eq(t.partsFlag, true), inArray(t.status, [...OPEN_STATUSES]))
            : status === 'ready'
              ? eq(t.status, 'completed')
              : status === 'picked_up'
                ? eq(t.status, 'picked_up')
                : status === 'cancelled'
                  ? inArray(t.status, ['cancelled', 'abandoned'])
                  : status === 'past_promised'
                    ? and(inArray(t.status, [...WORKING_STATUSES]), isNotNull(t.promisedAt), lt(t.promisedAt, new Date()))
                    : undefined;

  const within = (col: typeof t.createdAt | typeof t.completedAt | typeof h.createdAt) =>
    and(from ? gte(col, from) : undefined, to ? lt(col, to) : undefined);
  let dateWhere =
    from || to
      ? or(
          within(t.createdAt),
          and(isNotNull(t.completedAt), within(t.completedAt)),
          exists(db.select({ one: sql`1` }).from(h).where(and(eq(h.ticketId, t.id), eq(h.status, 'picked_up'), within(h.createdAt)))),
        )
      : undefined;
  if (dateWhere && withOpen) dateWhere = or(dateWhere, inArray(t.status, [...OPEN_STATUSES]));

  const rows = await db
    .select({
      ticket: t,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      technicianName: schema.users.name,
      paidCents: sql<number>`(coalesce((select sum(p.amount_cents) from payments p where p.ticket_id = ${t.id}),0) + coalesce((select sum(a.amount_cents) from ticket_allocations a where a.ticket_id = ${t.id}),0))`,
      deviceSummary: sql<string>`(select string_agg(d.label, ' + ') from ticket_devices d where d.ticket_id = ${t.id})`,
      serviceSummary: sql<string>`(select string_agg(l.description, ', ') from ticket_lines l where l.ticket_id = ${t.id})`,
    })
    .from(t)
    .leftJoin(schema.customers, eq(t.customerId, schema.customers.id))
    .leftJoin(schema.users, eq(t.technicianId, schema.users.id))
    .where(
      and(
        eq(t.storeId, req.session!.storeId),
        statusWhere,
        dateWhere,
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

  // tab counts are scoped to the same date range, so every tab agrees with the rows it would show
  const counts = await db
    .select({ status: t.status, callFlag: t.callFlag, partsFlag: t.partsFlag, n: sql<number>`count(*)` })
    .from(t)
    .where(and(eq(t.storeId, req.session!.storeId), dateWhere))
    .groupBy(t.status, t.callFlag, t.partsFlag);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [todayRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(and(eq(t.storeId, req.session!.storeId), gte(t.createdAt, todayStart)));

  // store-wide open work, independent of the tab and date range (the board's headline)
  const [openRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(and(eq(t.storeId, req.session!.storeId), inArray(t.status, [...OPEN_STATUSES])));

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
    openCount: Number(openRow?.n ?? 0),
  });
});

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
  serviceId: z.number().int().optional().nullable(),
  tierLabel: z.string().max(80).optional().nullable(),
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
      partsFlag: z.boolean().default(false),
      alertFlag: z.boolean().default(false),
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
  const result = await financialTransaction(req.session!.storeId, async db => {

  await requireStoreReferences(db, req.session!.storeId, { userIds: [body.data.technicianId], ticketIds: [body.data.warrantyOfTicketId] });
  let customerId = body.data.customerId ?? null;
  if (!customerId && body.data.newCustomer) {
    const [c] = await db
      .insert(schema.customers)
      .values({ name: body.data.newCustomer.name, phone: body.data.newCustomer.phone ?? null })
      .returning();
    customerId = c!.id;
  }
  if (!customerId) {
    throw new HttpError(400, 'A customer is required for a repair ticket');
  }

  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const totals = computeTotals(
    body.data.lines.map((l) => ({ qty: 1, unitCents: l.priceCents, taxable: true })),
    store?.taxRateBp ?? 600,
  );

  const number = await nextRepairNumber(db, req.session!.storeId);
  const [ticket] = await db
    .insert(schema.repairTickets)
    .values({
      storeId: req.session!.storeId,
      number,
      customerId,
      status: 'open',
      callFlag: body.data.callFlag,
      partsFlag: body.data.partsFlag,
      alertFlag: body.data.alertFlag,
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
        serviceId: l.serviceId ?? null,
        tierLabel: l.tierLabel ?? null,
        description: l.description,
        priceCents: l.priceCents,
        warrantyDays: l.warrantyDays,
      })),
    )
    .returning();

  await db.insert(schema.ticketStatusHistory).values({ ticketId: ticket!.id, status: 'open', userId: req.session!.id });
  await audit(db, req, 'ticket.create', 'repair_ticket', ticket!.id, { total: totals.totalCents });
  return { ticket, devices: deviceRows, lines: lineRows, totals };
  });
  emitStore(req, 'repairs-changed');
  res.json(result);
});

/** Statuses whose tickets can no longer be edited at all. */
const CLOSED_STATUSES = ['cancelled', 'abandoned'] as const;

/**
 * Full ticket edit (Edit ticket in the board's side panel): customer, devices,
 * repair lines, notes, flags. Replaces the device and line rows wholesale.
 * A completed, picked-up, or partly/fully paid ticket is locked and needs a
 * manager code; the approving manager is recorded in the audit log and history.
 */
repairsRouter.put('/:id', async (req, res) => {
  const body = z
    .object({
      customerId: z.number().int().optional().nullable(),
      newCustomer: z.object({ name: z.string().min(1), phone: z.string().optional().nullable() }).optional().nullable(),
      callFlag: z.boolean().default(false),
      partsFlag: z.boolean().default(false),
      alertFlag: z.boolean().default(false),
      technicianId: z.number().int().optional().nullable(),
      promisedAt: z.string().datetime().optional().nullable(),
      notesForTech: z.string().max(2000).optional().nullable(),
      devices: z.array(deviceSchema).min(1),
      lines: z.array(ticketLineSchema).min(1),
      managerPin: z.string().regex(/^\d{4,6}$/).optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid ticket', detail: body.error.flatten() });
    return;
  }
  const id = Number(req.params.id);
  const storeId = req.session!.storeId;
  const t = schema.repairTickets;

  // Lock check and manager-code verification happen before the store transaction:
  // the rate limiter and bcrypt work must not run while the single DB connection is inside it.
  const db0 = await getDb();
  const [current] = await db0.select().from(t).where(eq(t.id, id));
  if (!current || current.storeId !== storeId) { res.status(404).json({ error: 'Ticket not found' }); return; }
  if ((CLOSED_STATUSES as readonly string[]).includes(current.status)) {
    res.status(400).json({ error: `A ${current.status} ticket can't be edited` }); return;
  }
  const paidBefore = (await readTicketPayments(db0, id)).reduce((s, p) => s + p.amountCents, 0);
  const locked = current.status === 'completed' || current.status === 'picked_up' || paidBefore > 0;
  let approver: { id: number | null; name: string } | null = null;
  if (locked) {
    if (!body.data.managerPin) { res.status(403).json({ error: 'This ticket is completed or paid. An admin code is required to edit it.' }); return; }
    if (!(await allowAuthAttempt('edit-pin:' + storeId, 20))) { res.status(429).json({ error: 'Too many code attempts. Try again in 15 minutes.' }); return; }
    const approval = await verifyManagerCode(db0, storeId, body.data.managerPin);
    if (!approval) { res.status(403).json({ error: 'Wrong admin code' }); return; }
    if (approval.via === 'admin_code') approver = { id: null, name: 'admin code' };
    else {
      const [m] = await db0.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, approval.approverId!));
      approver = { id: approval.approverId, name: m?.name ?? 'manager' };
    }
  }

  const result = await financialTransaction(storeId, async (db) => {
    const [ticket] = await db.select().from(t).where(eq(t.id, id));
    if (!ticket || ticket.storeId !== storeId) throw new HttpError(404, 'Ticket not found');
    if ((CLOSED_STATUSES as readonly string[]).includes(ticket.status)) {
      throw new HttpError(400, `A ${ticket.status} ticket can't be edited`);
    }
    const paidCents = (await readTicketPayments(db, id)).reduce((s, p) => s + p.amountCents, 0);
    if (!locked && (ticket.status === 'completed' || paidCents > 0)) {
      throw new HttpError(409, 'The ticket changed while you were editing. Reopen it and try again.');
    }

    await requireStoreReferences(db, storeId, { userIds: [body.data.technicianId] });
    let customerId = body.data.customerId ?? ticket.customerId;
    if (!body.data.customerId && body.data.newCustomer) {
      const [c] = await db
        .insert(schema.customers)
        .values({ name: body.data.newCustomer.name, phone: body.data.newCustomer.phone ?? null })
        .returning();
      customerId = c!.id;
    }

    const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, storeId));
    const totals = computeTotals(
      body.data.lines.map((l) => ({ qty: 1, unitCents: l.priceCents, taxable: true })),
      store?.taxRateBp ?? 600,
    );
    if (totals.totalCents < paidCents) {
      throw new HttpError(400, `The new total is below what the customer already paid (${(paidCents / 100).toFixed(2)})`);
    }

    // parts already consumed on completion stay consumed for the same service
    const oldLines = await db.select().from(schema.ticketLines).where(eq(schema.ticketLines.ticketId, id));
    const consumed = new Set(oldLines.filter((l) => l.partConsumed && l.serviceId != null).map((l) => l.serviceId!));
    await db.delete(schema.ticketLines).where(eq(schema.ticketLines.ticketId, id));
    await db.delete(schema.ticketDevices).where(eq(schema.ticketDevices.ticketId, id));
    const deviceRows = await db
      .insert(schema.ticketDevices)
      .values(body.data.devices.map((d) => ({ ...d, ticketId: id })))
      .returning();
    const lineRows = await db
      .insert(schema.ticketLines)
      .values(
        body.data.lines.map((l) => ({
          ticketId: id,
          ticketDeviceId: deviceRows[l.deviceIndex]?.id ?? null,
          serviceId: l.serviceId ?? null,
          tierLabel: l.tierLabel ?? null,
          description: l.description,
          priceCents: l.priceCents,
          warrantyDays: l.warrantyDays,
          partConsumed: l.serviceId != null && consumed.has(l.serviceId),
        })),
      )
      .returning();

    const [row] = await db
      .update(t)
      .set({
        customerId,
        callFlag: body.data.callFlag,
        partsFlag: body.data.partsFlag,
        alertFlag: body.data.alertFlag,
        technicianId: body.data.technicianId === undefined ? ticket.technicianId : body.data.technicianId,
        promisedAt: body.data.promisedAt === undefined ? ticket.promisedAt : body.data.promisedAt ? new Date(body.data.promisedAt) : null,
        notesForTech: body.data.notesForTech === undefined ? ticket.notesForTech : body.data.notesForTech,
        totalCents: totals.totalCents,
      })
      .where(eq(t.id, id))
      .returning();

    await db.insert(schema.ticketStatusHistory).values({
      ticketId: id,
      status: ticket.status,
      note: approver ? (approver.id === null ? 'Ticket edited · approved with the admin code' : `Ticket edited · manager code by ${approver.name}`) : 'Ticket edited',
      userId: req.session!.id,
    });
    await audit(db, req, 'ticket.edit', 'repair_ticket', id, {
      before: { totalCents: ticket.totalCents, customerId: ticket.customerId, lines: oldLines.length },
      after: { totalCents: totals.totalCents, customerId, lines: lineRows.length },
      locked,
      approvedBy: approver?.id ?? null,
    });
    return { ticket: row, devices: deviceRows, lines: lineRows, totals };
  });
  emitStore(req, 'repairs-changed');
  res.json(result);
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
  const ticketPayments = await readTicketPayments(db,id);
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
      status: z.enum(['open', 'in_progress', 'waiting_part', 'completed', 'picked_up']).optional(),
      /** recorded on the status-history entry, e.g. which part we're waiting on */
      statusNote: z.string().max(300).nullable().optional(),
      technicianId: z.number().int().nullable().optional(),
      callFlag: z.boolean().optional(),
      partsFlag: z.boolean().optional(),
      alertFlag: z.boolean().optional(),
      promisedAt: z.string().datetime().nullable().optional(),
      notesForTech: z.string().max(2000).nullable().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }
  const result = await financialTransaction(req.session!.storeId, async db => {
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    throw new HttpError(404, 'Ticket not found');
  }
  if (['picked_up', 'cancelled', 'abandoned'].includes(ticket.status)) {
    throw new HttpError(400, `Ticket is ${ticket.status.replace('_', ' ')}`);
  }

  await requireStoreReferences(db, req.session!.storeId, { userIds: [body.data.technicianId] });
  const update: Partial<typeof schema.repairTickets.$inferInsert> = {};
  if (body.data.technicianId !== undefined) update.technicianId = body.data.technicianId;
  if (body.data.callFlag !== undefined) update.callFlag = body.data.callFlag;
  if (body.data.partsFlag !== undefined) update.partsFlag = body.data.partsFlag;
  if (body.data.alertFlag !== undefined) update.alertFlag = body.data.alertFlag;
  if (body.data.promisedAt !== undefined)
    update.promisedAt = body.data.promisedAt ? new Date(body.data.promisedAt) : null;
  if (body.data.notesForTech !== undefined) update.notesForTech = body.data.notesForTech;

  if (body.data.status && body.data.status !== ticket.status) {
    if (body.data.status === 'picked_up' && (ticket.status !== 'completed' || (await readTicketPayments(db,id)).reduce((s,p)=>s+p.amountCents,0) < ticket.totalCents)) throw new HttpError(409,'Repair must be completed and fully paid before pickup');
    update.status = body.data.status;
    if (body.data.status === 'completed') {
      update.completedAt = new Date();
      await consumeParts(db, req.session!.id, id, req.session!.storeId);
    }
    await db.insert(schema.ticketStatusHistory).values({
      ticketId: id,
      status: body.data.status,
      note: body.data.statusNote?.trim() || null,
      userId: req.session!.id,
    });
  } else if (body.data.statusNote?.trim()) {
    // a note on its own ("Customer notified", "Left a message") is logged against the current status
    await db.insert(schema.ticketStatusHistory).values({
      ticketId: id,
      status: ticket.status,
      note: body.data.statusNote.trim(),
      userId: req.session!.id,
    });
  }

  // a note-only patch has nothing to set on the ticket row itself
  const [row] = Object.keys(update).length
    ? await db.update(schema.repairTickets).set(update).where(eq(schema.repairTickets.id, id)).returning()
    : [ticket];
  await audit(db, req, 'ticket.update', 'repair_ticket', id, body.data);
  return row;
  });
  emitStore(req, 'repairs-changed');
  res.json(result);
});

/** Consume linked catalog parts exactly once when work is completed. */
async function consumeParts(db: Awaited<ReturnType<typeof getDb>>, userId: number, ticketId: number, storeId: number) {
  const lines = await db
    .select({ line: schema.ticketLines, partItemId: schema.services.partItemId })
    .from(schema.ticketLines)
    .leftJoin(schema.services, eq(schema.ticketLines.serviceId, schema.services.id))
    .where(eq(schema.ticketLines.ticketId, ticketId));
  await requireStoreReferences(db, storeId, { inventoryIds: lines.map(row => row.partItemId) });
  for (const { line, partItemId } of lines) {
    if (!partItemId || line.partConsumed) continue;
    const [consumed] = await db.update(schema.inventoryItems).set({ qty: sql`${schema.inventoryItems.qty} - 1` })
      .where(and(eq(schema.inventoryItems.id,partItemId),eq(schema.inventoryItems.storeId,storeId),gte(schema.inventoryItems.qty,1),eq(schema.inventoryItems.status,'in_stock'),ne(schema.inventoryItems.kind,'device'))).returning();
    if (!consumed) throw new HttpError(409,'Required repair part is unavailable');
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
      method: z.enum(['cash', 'card', 'tap', 'zelle', 'cash_app']),
      amountCents: z.number().int().min(1),
      tenderedCents: z.number().int().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'method and amount required' });
    return;
  }
  const result = await financialTransaction(req.session!.storeId, async db => {
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    throw new HttpError(404, 'Ticket not found');
  }
  if (['picked_up','cancelled','abandoned'].includes(ticket.status)) throw new HttpError(409,'Closed repairs cannot receive deposits');
  if (body.data.method === 'cash' && body.data.tenderedCents != null && body.data.tenderedCents < body.data.amountCents) throw new HttpError(400,'Insufficient cash tendered');
  if (body.data.method === 'cash') await getOpenDrawer(db, req.session!.storeId, req.session!.id);
  const existing = await readTicketPayments(db,id);
  const paid = existing.reduce((s, p) => s + p.amountCents, 0);
  if (paid + body.data.amountCents > ticket.totalCents) {
    throw new HttpError(400, 'Deposit exceeds ticket balance');
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
  return { ok: true, changeCents: change, paidCents: paid + body.data.amountCents };
  });
  emitStore(req, 'repairs-changed');
  res.json(result);
});

/** Cancel: parts restock (if consumed), deposit note surfaced for manual handling. */
/**
 * Reopen a picked-up ticket (a comeback, or work that was closed too early).
 * Needs the admin code or a manager PIN; the ticket goes back to In progress
 * and the approver plus the reason land on the history so the audit trail is clear.
 */
repairsRouter.post('/:id/reopen', async (req, res) => {
  const body = z.object({ reason: z.string().min(2).max(300), managerPin: z.string().min(4).max(12) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A reason and a manager code are required' });
    return;
  }
  if (!(await allowAuthAttempt('edit-pin:' + req.session!.storeId, 20))) {
    res.status(429).json({ error: 'Too many code attempts. Try again in 15 minutes.' });
    return;
  }
  const db0 = await getDb();
  const approval = await verifyManagerCode(db0, req.session!.storeId, body.data.managerPin);
  if (!approval) {
    res.status(403).json({ error: 'Wrong admin code' });
    return;
  }
  const approver = approval.via === 'admin_code'
    ? { id: null as number | null, name: 'admin code' }
    : { id: approval.approverId, name: (await db0.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, approval.approverId!)))[0]?.name ?? 'manager' };
  const result = await financialTransaction(req.session!.storeId, async db => {
    const id = Number(req.params.id);
    const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
    if (!ticket || ticket.storeId !== req.session!.storeId) throw new HttpError(404, 'Ticket not found');
    if (ticket.status !== 'picked_up') throw new HttpError(400, 'Only a picked-up ticket can be reopened');
    const [row] = await db.update(schema.repairTickets).set({ status: 'in_progress' }).where(eq(schema.repairTickets.id, id)).returning();
    await db.insert(schema.ticketStatusHistory).values({
      ticketId: id,
      status: 'in_progress',
      note: `Reopened · ${body.data.reason.trim()} · ${approver.id === null ? 'approved with the admin code' : `manager code by ${approver.name}`}`,
      userId: req.session!.id,
    });
    await audit(db, req, 'ticket.reopen', 'repair_ticket', id, { reason: body.data.reason.trim(), approvedBy: approver.id });
    return row;
  });
  emitStore(req, 'repairs-changed');
  res.json(result);
});

repairsRouter.post('/:id/cancel', async (req, res) => {
  const body = z.object({ reason: z.string().min(2).max(300), refundMethod: z.enum(['cash','store_credit']).optional() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A reason is required' });
    return;
  }
  const result = await financialTransaction(req.session!.storeId, async db => {
  const id = Number(req.params.id);
  const [ticket] = await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id, id));
  if (!ticket || ticket.storeId !== req.session!.storeId) {
    throw new HttpError(404, 'Ticket not found');
  }
  if (['picked_up', 'cancelled', 'abandoned'].includes(ticket.status)) {
    throw new HttpError(400, `Cannot cancel a ${ticket.status.replace('_', ' ')} ticket`);
  }

  const allocations = await db.select().from(schema.ticketAllocations).where(eq(schema.ticketAllocations.ticketId,id));
  if(allocations.reduce((sum,a)=>sum+a.amountCents,0) !== 0) throw new HttpError(409,'Refund register payments from their original sales before cancelling this repair');
  const paidBefore = (await readTicketPayments(db,id)).reduce((sum,p)=>sum+p.amountCents,0);
  if(paidBefore < 0) throw new HttpError(409,'Repair payment history requires reconciliation');
  if(paidBefore > 0) {
    if(!body.data.refundMethod) throw new HttpError(409,'Choose how to return the recorded deposit before cancelling');
    if(body.data.refundMethod === 'cash') await getOpenDrawer(db,req.session!.storeId,req.session!.id);
    else {
      const [customer] = await db.update(schema.customers).set({storeCreditCents:sql`${schema.customers.storeCreditCents} + ${paidBefore}`})
        .where(and(eq(schema.customers.id,ticket.customerId),isNull(schema.customers.mergedInto))).returning();
      if(!customer)throw new HttpError(409,'Resolve the repair customer before issuing credit');
      await db.insert(schema.storeCreditLedger).values({customerId:ticket.customerId,deltaCents:paidBefore,
        reason:'Cancelled repair '+ticket.number,userId:req.session!.id});
    }
    await db.insert(schema.payments).values({ticketId:id,method:body.data.refundMethod,amountCents:-paidBefore,isDeposit:true,userId:req.session!.id});
    await audit(db,req,'ticket.deposit_refund','repair_ticket',id,{amountCents:paidBefore,method:body.data.refundMethod,reason:body.data.reason});
  }


  // Restore the items actually consumed, even if the service's part mapping changed later.
  const movements = await db.select().from(schema.inventoryMovements).where(and(
    eq(schema.inventoryMovements.refId,id),inArray(schema.inventoryMovements.kind,['repair_consume','repair_restore'])));
  const consumed = new Map<number,number>();
  for(const m of movements) consumed.set(m.itemId,(consumed.get(m.itemId) ?? 0)-m.deltaQty);
  await requireStoreReferences(db,req.session!.storeId,{inventoryIds:[...consumed.keys()]});
  for(const [itemId,qty] of consumed) {
    if(qty<=0)continue;
    await db.update(schema.inventoryItems).set({qty:sql`${schema.inventoryItems.qty} + ${qty}`})
      .where(and(eq(schema.inventoryItems.id,itemId),eq(schema.inventoryItems.storeId,req.session!.storeId)));
    await db.insert(schema.inventoryMovements).values({itemId,deltaQty:qty,kind:'repair_restore',refId:id,userId:req.session!.id});
  }
  await db.update(schema.repairTickets).set({ status: 'cancelled' }).where(eq(schema.repairTickets.id, id));
  await db.insert(schema.ticketStatusHistory).values({ ticketId: id, status: 'cancelled', userId: req.session!.id });
  const deposits = await readTicketPayments(db,id);
  const depositCents = deposits.reduce((s, p) => s + p.amountCents, 0);
  await audit(db, req, 'ticket.cancel', 'repair_ticket', id, { reason: body.data.reason, depositCents });
  return { ok: true, depositCents };
  });
  emitStore(req, 'repairs-changed');
  res.json(result);
});
