import { Router } from 'express';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';
import { audit, emitStore, nextTicketNumber } from '../util';
import { getOpenDrawer } from './drawer';

/** Retail/carrier POS: activations and bill payments, on shared customers + inventory. */
export const retailRouter = Router();
retailRouter.use(requireAuth);

/* ---------------- Activations ---------------- */

retailRouter.get('/activations', async (req, res) => {
  const db = await getDb();
  const q = String(req.query.query ?? '').trim();
  const rows = await db
    .select({
      activation: schema.activations,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      deviceName: schema.inventoryItems.name,
      userName: schema.users.name,
    })
    .from(schema.activations)
    .innerJoin(schema.customers, eq(schema.activations.customerId, schema.customers.id))
    .leftJoin(schema.inventoryItems, eq(schema.activations.deviceItemId, schema.inventoryItems.id))
    .leftJoin(schema.users, eq(schema.activations.userId, schema.users.id))
    .where(
      and(
        eq(schema.activations.storeId, req.session!.storeId),
        q
          ? or(
              ilike(schema.customers.name, `%${q}%`),
              ilike(schema.activations.accountNumber, `%${q}%`),
              ilike(schema.activations.phoneNumber, `%${q}%`),
              ilike(schema.activations.carrier, `%${q}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(schema.activations.createdAt))
    .limit(200);
  res.json(
    rows.map((r) => ({
      ...r.activation,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      deviceName: r.deviceName,
      userName: r.userName,
    })),
  );
});

retailRouter.post('/activations', async (req, res) => {
  const body = z
    .object({
      customerId: z.number().int().optional().nullable(),
      newCustomer: z.object({ name: z.string().min(1), phone: z.string().optional().nullable() }).optional().nullable(),
      kind: z.enum(['new_line', 'upgrade', 'port_in', 'wifi_box', 'tablet']),
      carrier: z.string().min(1).max(60),
      planName: z.string().max(120).optional().nullable(),
      accountNumber: z.string().max(60).optional().nullable(),
      phoneNumber: z.string().max(30).optional().nullable(),
      monthlyCents: z.number().int().min(0).default(0),
      deviceItemId: z.number().int().optional().nullable(),
      notes: z.string().max(1000).optional().nullable(),
      status: z.enum(['active', 'pending']).default('active'),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid activation', detail: body.error.flatten() });
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
    res.status(400).json({ error: 'A customer is required' });
    return;
  }
  const { newCustomer, ...rest } = body.data;
  const [row] = await db
    .insert(schema.activations)
    .values({ ...rest, customerId, storeId: req.session!.storeId, userId: req.session!.id })
    .returning();
  await audit(db, req, 'activation.create', 'activation', row!.id, { carrier: body.data.carrier, kind: body.data.kind });
  emitStore(req, 'retail-changed');
  res.json(row);
});

retailRouter.patch('/activations/:id', async (req, res) => {
  const body = z
    .object({
      status: z.enum(['active', 'pending', 'cancelled']).optional(),
      accountNumber: z.string().max(60).nullable().optional(),
      phoneNumber: z.string().max(30).nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid update' });
    return;
  }
  const db = await getDb();
  const [row] = await db
    .update(schema.activations)
    .set(body.data)
    .where(eq(schema.activations.id, Number(req.params.id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'Activation not found' });
    return;
  }
  emitStore(req, 'retail-changed');
  res.json(row);
});

/* ---------------- Bill payments ---------------- */

retailRouter.get('/bill-payments', async (req, res) => {
  const db = await getDb();
  const q = String(req.query.query ?? '').trim();
  const rows = await db
    .select({
      payment: schema.billPayments,
      customerName: schema.customers.name,
      userName: schema.users.name,
    })
    .from(schema.billPayments)
    .leftJoin(schema.customers, eq(schema.billPayments.customerId, schema.customers.id))
    .leftJoin(schema.users, eq(schema.billPayments.userId, schema.users.id))
    .where(
      and(
        eq(schema.billPayments.storeId, req.session!.storeId),
        q
          ? or(
              ilike(schema.customers.name, `%${q}%`),
              ilike(schema.billPayments.accountNumber, `%${q}%`),
              ilike(schema.billPayments.carrier, `%${q}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(schema.billPayments.createdAt))
    .limit(200);
  const [totals] = await db
    .select({
      count: sql<number>`count(*)`,
      amount: sql<number>`coalesce(sum(${schema.billPayments.amountCents}), 0)`,
      fees: sql<number>`coalesce(sum(${schema.billPayments.feeCents}), 0)`,
    })
    .from(schema.billPayments)
    .where(
      and(
        eq(schema.billPayments.storeId, req.session!.storeId),
        sql`${schema.billPayments.createdAt} >= date_trunc('day', now())`,
      ),
    );
  res.json({
    rows: rows.map((r) => ({ ...r.payment, customerName: r.customerName, userName: r.userName })),
    today: { count: Number(totals?.count ?? 0), amountCents: Number(totals?.amount ?? 0), feeCents: Number(totals?.fees ?? 0) },
  });
});

/**
 * Take a bill payment: records the tracking row AND a completed sale so the
 * money flows through drawer counts and reports. The carrier remittance
 * (amount) is a non-taxable pass-through; the service fee is taxable revenue.
 */
retailRouter.post('/bill-payments', async (req, res) => {
  const body = z
    .object({
      customerId: z.number().int().optional().nullable(),
      carrier: z.string().min(1).max(60),
      accountNumber: z.string().min(1).max(60),
      amountCents: z.number().int().min(1),
      feeCents: z.number().int().min(0).default(0),
      method: z.enum(['cash', 'card', 'tap']),
      tenderedCents: z.number().int().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'carrier, account and amount required', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const data = body.data;
  const total = data.amountCents + data.feeCents;
  if (data.method === 'cash' && data.tenderedCents != null && data.tenderedCents < total) {
    res.status(400).json({ error: 'Tendered is less than the total' });
    return;
  }

  if (data.method === 'cash') await getOpenDrawer(db, req.session!.storeId, req.session!.id);

  const ticketNumber = await nextTicketNumber(db, req.session!.storeId);
  const [sale] = await db
    .insert(schema.sales)
    .values({
      storeId: req.session!.storeId,
      terminalId: req.session!.terminalId,
      userId: req.session!.id,
      customerId: data.customerId ?? null,
      ticketNumber,
      status: 'completed',
      subtotalCents: total,
      discountCents: 0,
      taxCents: 0,
      totalCents: total,
      completedAt: new Date(),
    })
    .returning();
  await db.insert(schema.saleLines).values([
    {
      saleId: sale!.id,
      kind: 'custom',
      description: `Bill payment · ${data.carrier} · acct …${data.accountNumber.slice(-4)}`,
      qty: 1,
      unitCents: data.amountCents,
      taxable: false,
    },
    ...(data.feeCents > 0
      ? [
          {
            saleId: sale!.id,
            kind: 'custom' as const,
            description: 'Bill payment service fee',
            qty: 1,
            unitCents: data.feeCents,
            taxable: false,
          },
        ]
      : []),
  ]);
  const change = data.method === 'cash' && data.tenderedCents != null ? data.tenderedCents - total : null;
  await db.insert(schema.payments).values({
    saleId: sale!.id,
    method: data.method,
    amountCents: total,
    tenderedCents: data.method === 'cash' ? (data.tenderedCents ?? null) : null,
    changeCents: change,
    userId: req.session!.id,
  });
  const [row] = await db
    .insert(schema.billPayments)
    .values({
      storeId: req.session!.storeId,
      customerId: data.customerId ?? null,
      carrier: data.carrier,
      accountNumber: data.accountNumber,
      amountCents: data.amountCents,
      feeCents: data.feeCents,
      saleId: sale!.id,
      userId: req.session!.id,
    })
    .returning();
  await audit(db, req, 'bill_payment.take', 'bill_payment', row!.id, { total, method: data.method });
  emitStore(req, 'sales-changed');
  res.json({ billPayment: row, sale, changeCents: change });
});
