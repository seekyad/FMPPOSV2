import { Router } from 'express';
import { and, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeTotals } from '@fmp/shared';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { receiptEscpos, receiptText, type ReceiptData } from '../receipts';
import { audit, emitBridge, emitStore, nextTicketNumber } from '../util';
import { getOpenDrawer } from './drawer';

export const salesRouter = Router();
salesRouter.use(requireAuth);

const lineSchema = z.object({
  kind: z.enum(['product', 'repair', 'custom', 'tradein', 'payout']),
  description: z.string().min(1).max(200),
  qty: z.number().int().min(1).max(999),
  unitCents: z.number().int(),
  discountCents: z.number().int().min(0).default(0),
  taxable: z.boolean().default(true),
  inventoryItemId: z.number().int().optional().nullable(),
  /** repair lines: the ticket whose balance this line pays down */
  ticketId: z.number().int().optional().nullable(),
});

const paymentSchema = z.object({
  method: z.enum(['cash', 'card', 'tap', 'store_credit']),
  amountCents: z.number().int().min(1),
  tenderedCents: z.number().int().optional().nullable(),
});

async function getTaxRate(db: Awaited<ReturnType<typeof getDb>>, storeId: number): Promise<number> {
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  return store?.taxRateBp ?? 600;
}

async function insertSaleWithLines(
  db: Awaited<ReturnType<typeof getDb>>,
  req: Parameters<typeof audit>[1],
  lines: z.infer<typeof lineSchema>[],
  opts: {
    status: 'parked' | 'completed';
    customerId?: number | null;
    parkedNote?: string | null;
    saleDiscountCents?: number;
    refundOfSaleId?: number;
  },
) {
  const taxRate = await getTaxRate(db, req.session!.storeId);
  const totals = computeTotals(
    lines.map((l) => ({ qty: l.qty, unitCents: l.unitCents, taxable: l.taxable, discountCents: l.discountCents })),
    taxRate,
    opts.saleDiscountCents ?? 0,
  );
  const ticketNumber = await nextTicketNumber(db, req.session!.storeId);
  const [sale] = await db
    .insert(schema.sales)
    .values({
      storeId: req.session!.storeId,
      terminalId: req.session!.terminalId,
      userId: req.session!.id,
      customerId: opts.customerId ?? null,
      ticketNumber,
      status: opts.status,
      parkedNote: opts.parkedNote ?? null,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      refundOfSaleId: opts.refundOfSaleId,
      completedAt: opts.status === 'completed' ? new Date() : null,
    })
    .returning();
  if (lines.length > 0) {
    await db.insert(schema.saleLines).values(lines.map((l) => ({ ...l, saleId: sale!.id })));
  }
  return { sale: sale!, totals };
}

/** Sell-through inventory effects for a completed sale. */
async function applyInventoryForSale(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: number,
  saleId: number,
  lines: z.infer<typeof lineSchema>[],
) {
  for (const line of lines) {
    if (!line.inventoryItemId || line.kind !== 'product') continue;
    const [item] = await db
      .select()
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, line.inventoryItemId));
    if (!item) continue;
    if (item.kind === 'device') {
      await db
        .update(schema.inventoryItems)
        .set({ status: 'sold', soldAt: new Date(), qty: 0 })
        .where(eq(schema.inventoryItems.id, item.id));
    } else {
      await db
        .update(schema.inventoryItems)
        .set({ qty: sql`greatest(${schema.inventoryItems.qty} - ${line.qty}, 0)` })
        .where(eq(schema.inventoryItems.id, item.id));
    }
    await db.insert(schema.inventoryMovements).values({
      itemId: item.id,
      deltaQty: -line.qty,
      kind: 'sale',
      refId: saleId,
      userId,
    });
  }
}

async function buildReceipt(
  db: Awaited<ReturnType<typeof getDb>>,
  storeId: number,
  cashier: string,
  sale: typeof schema.sales.$inferSelect,
  lines: Array<{ description: string; qty: number; unitCents: number; discountCents: number }>,
  payments: Array<{ method: string; amountCents: number; tenderedCents?: number | null; changeCents?: number | null }>,
): Promise<ReceiptData> {
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  return {
    header: store?.receiptHeader ?? store?.name ?? 'FMP',
    address: store?.address,
    phone: store?.phone,
    ticketNumber: sale.ticketNumber,
    cashier,
    createdAt: sale.completedAt ?? sale.createdAt,
    lines: lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      totalCents: l.qty * l.unitCents - l.discountCents,
    })),
    subtotalCents: sale.subtotalCents,
    discountCents: sale.discountCents,
    taxCents: sale.taxCents,
    totalCents: sale.totalCents,
    payments,
    footer: store?.receiptFooter,
    refund: sale.refundOfSaleId != null,
  };
}

/**
 * Complete a sale in one shot: lines + payments arrive together from the Register.
 * Validates payment coverage, records everything, applies inventory, prints.
 */
salesRouter.post('/complete', async (req, res) => {
  const body = z
    .object({
      lines: z.array(lineSchema).min(1),
      customerId: z.number().int().optional().nullable(),
      saleDiscountCents: z.number().int().min(0).default(0),
      payments: z.array(paymentSchema).min(1),
      parkedSaleId: z.number().int().optional().nullable(),
      printReceipt: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid sale', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const { lines, payments } = body.data;

  // cash on the way in: make sure a drawer session exists so the money is counted
  if (payments.some((p) => p.method === 'cash')) {
    await getOpenDrawer(db, req.session!.storeId, req.session!.id);
  }

  const { sale, totals } = await insertSaleWithLines(db, req, lines, {
    status: 'completed',
    customerId: body.data.customerId,
    saleDiscountCents: body.data.saleDiscountCents,
  });

  const paid = payments.reduce((sum, p) => sum + p.amountCents, 0);
  if (paid < totals.totalCents) {
    // roll back the just-created sale rather than storing an underpaid one
    await db.delete(schema.saleLines).where(eq(schema.saleLines.saleId, sale.id));
    await db.delete(schema.sales).where(eq(schema.sales.id, sale.id));
    res.status(400).json({ error: `Payments cover ${paid} of ${totals.totalCents} cents` });
    return;
  }

  // Store credit: verify and deduct.
  const creditPayment = payments.find((p) => p.method === 'store_credit');
  if (creditPayment) {
    if (!body.data.customerId) {
      res.status(400).json({ error: 'Store credit needs a customer on the sale' });
      return;
    }
    const [customer] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, body.data.customerId));
    if (!customer || customer.storeCreditCents < creditPayment.amountCents) {
      res.status(400).json({ error: 'Not enough store credit' });
      return;
    }
    await db
      .update(schema.customers)
      .set({ storeCreditCents: customer.storeCreditCents - creditPayment.amountCents })
      .where(eq(schema.customers.id, customer.id));
    await db.insert(schema.storeCreditLedger).values({
      customerId: customer.id,
      deltaCents: -creditPayment.amountCents,
      reason: `Spent on sale #${sale.ticketNumber}`,
      saleId: sale.id,
      userId: req.session!.id,
    });
  }

  const cashPayment = payments.find((p) => p.method === 'cash');
  const change = cashPayment?.tenderedCents != null ? cashPayment.tenderedCents - cashPayment.amountCents : null;
  const paymentRows = payments.map((p) => ({
    saleId: sale.id,
    method: p.method,
    amountCents: p.amountCents,
    tenderedCents: p.method === 'cash' ? (p.tenderedCents ?? null) : null,
    changeCents: p.method === 'cash' ? change : null,
    userId: req.session!.id,
  }));
  await db.insert(schema.payments).values(paymentRows);

  await applyInventoryForSale(db, req.session!.id, sale.id, lines);

  // Repair lines pay down their ticket: record a ticket payment (line total + its tax share).
  const taxRate = await getTaxRate(db, req.session!.storeId);
  const primaryMethod = payments[0]!.method;
  const byTicket = new Map<number, number>();
  for (const line of lines) {
    if (line.kind !== 'repair' || !line.ticketId) continue;
    const lineTotal = line.qty * line.unitCents - line.discountCents;
    const withTax = line.taxable ? lineTotal + Math.round((lineTotal * taxRate) / 10000) : lineTotal;
    byTicket.set(line.ticketId, (byTicket.get(line.ticketId) ?? 0) + withTax);
  }
  for (const [ticketId, amountCents] of byTicket) {
    await db.insert(schema.payments).values({
      saleId: sale.id,
      ticketId,
      method: primaryMethod,
      amountCents,
      userId: req.session!.id,
    });
  }

  // Resuming a parked sale: mark the parked row consumed.
  if (body.data.parkedSaleId) {
    await db
      .update(schema.sales)
      .set({ status: 'voided', parkedNote: `Completed as #${sale.ticketNumber}` })
      .where(and(eq(schema.sales.id, body.data.parkedSaleId), eq(schema.sales.status, 'parked')));
  }

  const receipt = await buildReceipt(db, req.session!.storeId, req.session!.name, sale, lines, paymentRows);
  let printed = false;
  if (body.data.printReceipt) {
    printed = emitBridge(req, {
      kind: 'receipt',
      escposBase64: receiptEscpos(receipt, cashPayment != null),
    });
  }

  await audit(db, req, 'sale.complete', 'sale', sale.id, { total: totals.totalCents });
  emitStore(req, 'sales-changed');
  res.json({ sale, totals, changeCents: change, receiptText: receiptText(receipt), printed });
});

/** Park the current cart. */
salesRouter.post('/park', async (req, res) => {
  const body = z
    .object({
      lines: z.array(lineSchema).min(1),
      customerId: z.number().int().optional().nullable(),
      note: z.string().max(500).optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Nothing to park' });
    return;
  }
  const db = await getDb();
  const { sale } = await insertSaleWithLines(db, req, body.data.lines, {
    status: 'parked',
    customerId: body.data.customerId,
    parkedNote: body.data.note,
  });
  emitStore(req, 'sales-changed');
  res.json({ sale });
});

/** Parked list for the Pending sales screen. */
salesRouter.get('/parked', async (req, res) => {
  const db = await getDb();
  const rows = await db
    .select({
      sale: schema.sales,
      customerName: schema.customers.name,
      cashierName: schema.users.name,
    })
    .from(schema.sales)
    .leftJoin(schema.customers, eq(schema.sales.customerId, schema.customers.id))
    .leftJoin(schema.users, eq(schema.sales.userId, schema.users.id))
    .where(and(eq(schema.sales.storeId, req.session!.storeId), eq(schema.sales.status, 'parked')))
    .orderBy(desc(schema.sales.createdAt));
  const saleIds = rows.map((r) => r.sale.id);
  const lines = saleIds.length
    ? await db.select().from(schema.saleLines).where(inArray(schema.saleLines.saleId, saleIds))
    : [];
  res.json(
    rows.map((r) => ({
      ...r.sale,
      customerName: r.customerName,
      cashierName: r.cashierName,
      lines: lines.filter((l) => l.saleId === r.sale.id),
    })),
  );
});

/** Recent completed sales (for refunds lookup and the taken-in strip). */
salesRouter.get('/recent', async (req, res) => {
  const db = await getDb();
  const q = String(req.query.query ?? '').trim();
  const rows = await db
    .select({
      sale: schema.sales,
      customerName: schema.customers.name,
    })
    .from(schema.sales)
    .leftJoin(schema.customers, eq(schema.sales.customerId, schema.customers.id))
    .where(
      and(
        eq(schema.sales.storeId, req.session!.storeId),
        eq(schema.sales.status, 'completed'),
        q ? ilike(schema.sales.ticketNumber, `%${q}%`) : undefined,
      ),
    )
    .orderBy(desc(schema.sales.createdAt))
    .limit(30);
  res.json(rows.map((r) => ({ ...r.sale, customerName: r.customerName })));
});

salesRouter.get('/:id', async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, id));
  if (!sale || sale.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Sale not found' });
    return;
  }
  const lines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id));
  const paymentRows = await db.select().from(schema.payments).where(eq(schema.payments.saleId, id));
  res.json({ ...sale, lines, payments: paymentRows });
});

/** Void a parked or same-day completed sale. Manager only. */
salesRouter.post('/:id/void', requireRole('manager'), async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, id));
  if (!sale || sale.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Sale not found' });
    return;
  }
  if (sale.status !== 'parked' && sale.status !== 'completed') {
    res.status(400).json({ error: `Cannot void a ${sale.status} sale` });
    return;
  }
  if (sale.status === 'completed') {
    // restore inventory sold on the voided sale
    const lines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id));
    for (const line of lines) {
      if (!line.inventoryItemId || line.kind !== 'product') continue;
      const [item] = await db
        .select()
        .from(schema.inventoryItems)
        .where(eq(schema.inventoryItems.id, line.inventoryItemId));
      if (!item) continue;
      if (item.kind === 'device') {
        await db
          .update(schema.inventoryItems)
          .set({ status: 'in_stock', soldAt: null, qty: 1 })
          .where(eq(schema.inventoryItems.id, item.id));
      } else {
        await db
          .update(schema.inventoryItems)
          .set({ qty: sql`${schema.inventoryItems.qty} + ${line.qty}` })
          .where(eq(schema.inventoryItems.id, item.id));
      }
      await db.insert(schema.inventoryMovements).values({
        itemId: item.id,
        deltaQty: line.qty,
        kind: 'refund_restock',
        refId: id,
        userId: req.session!.id,
      });
    }
  }
  await db.update(schema.sales).set({ status: 'voided' }).where(eq(schema.sales.id, id));
  await audit(db, req, 'sale.void', 'sale', id, { was: sale.status, reason: req.body?.reason });
  emitStore(req, 'sales-changed');
  res.json({ ok: true });
});

/**
 * Refund a completed sale (full or selected lines), to cash or store credit.
 * Creates a negative "refund" sale for reporting and restocks resellable items.
 */
salesRouter.post('/:id/refund', async (req, res) => {
  const body = z
    .object({
      lineIds: z.array(z.number().int()).optional(),
      method: z.enum(['cash', 'store_credit']),
      restock: z.boolean().default(true),
      reason: z.string().max(300).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'method required' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [original] = await db.select().from(schema.sales).where(eq(schema.sales.id, id));
  if (!original || original.storeId !== req.session!.storeId || original.status !== 'completed') {
    res.status(404).json({ error: 'Completed sale not found' });
    return;
  }
  const allLines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id));
  const toRefund = body.data.lineIds?.length
    ? allLines.filter((l) => body.data.lineIds!.includes(l.id))
    : allLines;
  if (toRefund.length === 0) {
    res.status(400).json({ error: 'Nothing to refund' });
    return;
  }
  if (body.data.method === 'store_credit' && !original.customerId) {
    res.status(400).json({ error: 'Store credit refund needs a customer on the original sale' });
    return;
  }

  const negLines = toRefund.map((l) => ({
    kind: l.kind,
    description: `Refund: ${l.description}`,
    qty: l.qty,
    unitCents: -l.unitCents,
    discountCents: 0,
    taxable: l.taxable,
    inventoryItemId: l.inventoryItemId,
  }));
  // line discounts reduce what we give back
  for (let i = 0; i < toRefund.length; i++) {
    if (toRefund[i]!.discountCents > 0) {
      negLines[i]!.unitCents = -(toRefund[i]!.qty * toRefund[i]!.unitCents - toRefund[i]!.discountCents);
      negLines[i]!.qty = 1;
    }
  }

  const { sale: refundSale, totals } = await insertSaleWithLines(db, req, negLines as never, {
    status: 'completed',
    customerId: original.customerId,
    refundOfSaleId: id,
  });
  const refundAmount = -totals.totalCents; // positive number handed back

  await db.insert(schema.payments).values({
    saleId: refundSale.id,
    method: body.data.method === 'cash' ? 'cash' : 'store_credit',
    amountCents: -refundAmount,
    userId: req.session!.id,
  });

  if (body.data.method === 'store_credit' && original.customerId) {
    await db
      .update(schema.customers)
      .set({ storeCreditCents: sql`${schema.customers.storeCreditCents} + ${refundAmount}` })
      .where(eq(schema.customers.id, original.customerId));
    await db.insert(schema.storeCreditLedger).values({
      customerId: original.customerId,
      deltaCents: refundAmount,
      reason: `Refund of #${original.ticketNumber}`,
      saleId: refundSale.id,
      userId: req.session!.id,
    });
  }

  if (body.data.restock) {
    for (const line of toRefund) {
      if (!line.inventoryItemId || line.kind !== 'product') continue;
      const [item] = await db
        .select()
        .from(schema.inventoryItems)
        .where(eq(schema.inventoryItems.id, line.inventoryItemId));
      if (!item) continue;
      if (item.kind === 'device') {
        await db
          .update(schema.inventoryItems)
          .set({ status: 'in_stock', soldAt: null, qty: 1 })
          .where(eq(schema.inventoryItems.id, item.id));
      } else {
        await db
          .update(schema.inventoryItems)
          .set({ qty: sql`${schema.inventoryItems.qty} + ${line.qty}` })
          .where(eq(schema.inventoryItems.id, item.id));
      }
      await db.insert(schema.inventoryMovements).values({
        itemId: item.id,
        deltaQty: line.qty,
        kind: 'refund_restock',
        refId: refundSale.id,
        userId: req.session!.id,
      });
    }
  }

  const fullRefund = toRefund.length === allLines.length;
  if (fullRefund) {
    await db.update(schema.sales).set({ status: 'refunded' }).where(eq(schema.sales.id, id));
  }

  await audit(db, req, 'sale.refund', 'sale', id, {
    refundSaleId: refundSale.id,
    amount: refundAmount,
    method: body.data.method,
    reason: body.data.reason,
  });
  emitStore(req, 'sales-changed');
  res.json({ ok: true, refundSaleId: refundSale.id, refundAmountCents: refundAmount });
});

/** Unified register search: customers, sellable inventory, recent tickets by number. */
salesRouter.get('/search/all', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ customers: [], items: [], sales: [] });
    return;
  }
  const db = await getDb();
  const c = schema.customers;
  const i = schema.inventoryItems;
  const foundCustomers = await db
    .select({ id: c.id, name: c.name, phone: c.phone, storeCreditCents: c.storeCreditCents })
    .from(c)
    .where(and(sql`${c.mergedInto} is null`, or(ilike(c.name, `%${q}%`), ilike(c.phone, `%${q}%`))))
    .limit(6);
  const items = await db
    .select()
    .from(i)
    .where(
      and(
        eq(i.storeId, req.session!.storeId),
        eq(i.status, 'in_stock'),
        or(ilike(i.name, `%${q}%`), ilike(i.imei, `%${q}%`), ilike(i.sku, `%${q}%`)),
      ),
    )
    .limit(8);
  const foundSales = await db
    .select({ id: schema.sales.id, ticketNumber: schema.sales.ticketNumber, totalCents: schema.sales.totalCents, status: schema.sales.status })
    .from(schema.sales)
    .where(and(eq(schema.sales.storeId, req.session!.storeId), ilike(schema.sales.ticketNumber, `%${q}%`)))
    .orderBy(desc(schema.sales.createdAt))
    .limit(5);
  res.json({ customers: foundCustomers, items, sales: foundSales });
});
