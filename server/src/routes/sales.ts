import { financialTransaction, checkedTotals, snapshotLines, allocateTicket, ticketPayments } from '../finance';
import bcrypt from 'bcryptjs';
import { HttpError } from '../http';
import { allowAuthAttempt, hashToken } from '../pairing';
import { verifyManagerCode } from '../security';
import { createRouter as Router } from '../http';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeTotals } from '@fmp/shared';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { receiptEscpos, receiptText, type ReceiptData } from '../receipts';
import { applyReceiptPrefs, logPrintJob, printSettingsOf } from './print';
import { audit, emitBridge, emitStore, nextTicketNumber } from '../util';
import { getOpenDrawer } from './drawer';
import { requireStoreReferences } from '../store-scope';

export const salesRouter = Router();
salesRouter.use(requireAuth);

const lineSchema = z.object({
  kind: z.enum(['product', 'repair', 'custom', 'tradein', 'payout', 'deposit']),
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
  method: z.enum(['cash', 'card', 'tap', 'zelle', 'cash_app', 'store_credit']),
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
    checkoutKey?: string;
    checkoutHash?: string;
  },
) {
  await requireStoreReferences(db, req.session!.storeId, {
    inventoryIds: lines.map(line => line.inventoryItemId), ticketIds: lines.map(line => line.ticketId),
  });
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
      checkoutKey: opts.checkoutKey,
      checkoutHash: opts.checkoutHash,
      completedAt: opts.status === 'completed' ? new Date() : null,
    })
    .returning();
  const snapshots = snapshotLines(lines, totals);
  const storedLines = await db.insert(schema.saleLines).values(lines.map((l, i) => ({ ...l, ...snapshots[i], saleId: sale!.id }))).returning();
  return { sale: sale!, totals, storedLines };
}

/** Sell-through inventory effects for a completed sale. */

async function applyInventoryForSale(db: Awaited<ReturnType<typeof getDb>>, userId: number, storeId: number, saleId: number,
  lines: z.infer<typeof lineSchema>[]) {
  const qtyByItem = new Map<number, number>();
  for (const line of lines) if (line.kind === 'product' && line.inventoryItemId) {
    qtyByItem.set(line.inventoryItemId, (qtyByItem.get(line.inventoryItemId) ?? 0) + line.qty);
  }
  for (const [itemId, qty] of [...qtyByItem].sort((a,b)=>a[0]-b[0])) {
    const [item] = await db.select().from(schema.inventoryItems).where(and(eq(schema.inventoryItems.id, itemId), eq(schema.inventoryItems.storeId, storeId)));
    if (!item || (item.kind === 'device' && qty !== 1)) throw new HttpError(409, 'A serialized device must be sold as one unit');
    const [sold] = await db.update(schema.inventoryItems)
      .set(item.kind === 'device' ? { qty: 0, status: 'sold', soldAt: new Date() } : { qty: sql`${schema.inventoryItems.qty} - ${qty}` })
      .where(and(eq(schema.inventoryItems.id, itemId), eq(schema.inventoryItems.storeId, storeId),
        eq(schema.inventoryItems.status, 'in_stock'), item.kind === 'device' ? eq(schema.inventoryItems.qty, 1) : gte(schema.inventoryItems.qty, qty))).returning();
    if (!sold) throw new HttpError(409, 'Insufficient available stock for ' + item.name);
    await db.insert(schema.inventoryMovements).values({ itemId, deltaQty: -qty, kind: 'sale', refId: saleId, userId });
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
  const [customer] = sale.customerId
    ? await db.select().from(schema.customers).where(eq(schema.customers.id, sale.customerId))
    : [];
  return applyReceiptPrefs({
    header: store?.receiptHeader ?? store?.name ?? 'FMP',
    address: store?.address,
    phone: store?.phone,
    ticketNumber: sale.ticketNumber,
    cashier,
    customer: customer?.name ?? null,
    customerPhone: customer?.phone ?? null,
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
  }, printSettingsOf(store).receipt);
}

/**
 * Complete a sale in one shot: lines + payments arrive together from the Register.
 * Validates payment coverage, records everything, applies inventory, prints.
 */


/** Reconciliation closes the race with a delayed /complete under the same store lock. */
salesRouter.post('/checkout/:key/reconcile', async (req,res)=>{
  const key=z.string().uuid().safeParse(req.params.key);
  if(!key.success)throw new HttpError(400,'Invalid checkout reference');
  const result=await financialTransaction(req.session!.storeId,async db=>{
    const [sale]=await db.select().from(schema.sales).where(and(eq(schema.sales.storeId,req.session!.storeId),eq(schema.sales.checkoutKey,key.data)));
    if(sale && sale.terminalId !== req.session!.terminalId)throw new HttpError(403,'Check this sale from its original register');
    let [decision]=await db.select().from(schema.checkoutRecoveries).where(and(eq(schema.checkoutRecoveries.storeId,req.session!.storeId),eq(schema.checkoutRecoveries.key,key.data)));
    if(decision && decision.terminalId !== req.session!.terminalId)throw new HttpError(403,'Recovery belongs to another register');
    if(!decision) {
      [decision]=await db.insert(schema.checkoutRecoveries).values({storeId:req.session!.storeId,terminalId:req.session!.terminalId,
        key:key.data,saleId:sale?.id ?? null,createdBy:req.session!.id}).returning();
      await audit(db,req,'checkout.reconcile','checkout_recovery',decision!.id,{saleId:sale?.id ?? null,outcome:sale ? 'saved' : 'not_saved'});
    }
    if(!sale)return {state:'not_saved' as const,acknowledged:decision!.acknowledgedAt != null};
    const lines=await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId,sale.id));
    const payments=await db.select().from(schema.payments).where(eq(schema.payments.saleId,sale.id));
    const [cashier]=sale.userId ? await db.select().from(schema.users).where(eq(schema.users.id,sale.userId)) : [];
    const receipt=await buildReceipt(db,sale.storeId,cashier?.name ?? '',sale,lines,payments);
    return {state:'saved' as const,saleId:sale.id,ticketNumber:sale.ticketNumber,saleStatus:sale.status,
      receiptText:receiptText(receipt),acknowledged:decision!.acknowledgedAt != null};
  });
  res.json(result);
});

salesRouter.post('/checkout/:key/acknowledge', async(req,res)=>{
  const key=z.string().uuid().safeParse(req.params.key);
  const body=z.object({decision:z.enum(['saved_sale_reviewed','payment_reconciled'])}).safeParse(req.body);
  if(!key.success||!body.success)throw new HttpError(400,'Confirm the checkout recovery outcome');
  await financialTransaction(req.session!.storeId,async db=>{
    const [recovery]=await db.select().from(schema.checkoutRecoveries).where(and(eq(schema.checkoutRecoveries.storeId,req.session!.storeId),
      eq(schema.checkoutRecoveries.terminalId,req.session!.terminalId),eq(schema.checkoutRecoveries.key,key.data)));
    if(!recovery)throw new HttpError(409,'Check the saved sale before clearing recovery');
    const expected=recovery.saleId ? 'saved_sale_reviewed' : 'payment_reconciled';
    if(body.data.decision !== expected)throw new HttpError(409,'Confirmation does not match the saved outcome');
    if(!recovery.acknowledgedAt) {
      await db.update(schema.checkoutRecoveries).set({acknowledgedAt:new Date()}).where(eq(schema.checkoutRecoveries.id,recovery.id));
      await audit(db,req,'checkout.recovery_acknowledged','checkout_recovery',recovery.id,{decision:body.data.decision,saleId:recovery.saleId});
    }
  });
  res.json({ok:true});
});

salesRouter.post('/complete', async (req, res) => {
  const body = z.object({
    lines: z.array(lineSchema).min(1).max(500),
    customerId: z.number().int().positive().optional().nullable(),
    saleDiscountCents: z.number().int().min(0).default(0),
    payments: z.array(paymentSchema).min(1).max(20),
    parkedSaleId: z.number().int().positive().optional().nullable(),
    printReceipt: z.boolean().default(true),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'Invalid sale', detail: body.error.flatten() }); return; }
  const key = req.get('Idempotency-Key');
  if (key && !z.string().uuid().safeParse(key).success) throw new HttpError(400, 'Invalid checkout retry key');
  const hash = hashToken(JSON.stringify(body.data));
  const { lines, payments } = body.data;
  const result = await financialTransaction(req.session!.storeId, async db => {
    if (key) {
      const [closed] = await db.select().from(schema.checkoutRecoveries).where(and(eq(schema.checkoutRecoveries.storeId,req.session!.storeId),eq(schema.checkoutRecoveries.key,key)));
      if(closed && closed.saleId == null)throw new HttpError(409,'This checkout attempt was closed during recovery. Its payment must be reconciled before starting a new sale');
      const [existing] = await db.select().from(schema.sales).where(and(eq(schema.sales.storeId, req.session!.storeId), eq(schema.sales.checkoutKey, key)));
      if (existing) {
        if(existing.terminalId !== req.session!.terminalId)throw new HttpError(403,'This checkout belongs to another register');
        if (existing.checkoutHash !== hash) throw new HttpError(409, 'This checkout key already belongs to a different sale');
        const savedLines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, existing.id));
        const savedPayments = await db.select().from(schema.payments).where(eq(schema.payments.saleId, existing.id));
        const receipt = await buildReceipt(db, existing.storeId, req.session!.name, existing, savedLines, savedPayments);
        return { sale: existing, totals: { subtotalCents: existing.subtotalCents, discountCents: existing.discountCents,
          taxCents: existing.taxCents, totalCents: existing.totalCents }, changeCents: savedPayments.reduce((s,p)=>s+(p.changeCents ?? 0),0),
          receipt, replayed: true };
      }
    }
    await requireStoreReferences(db, req.session!.storeId, {
      inventoryIds: lines.map(l => l.inventoryItemId), ticketIds: lines.map(l => l.ticketId),
    });
    if (lines.some(l => (l.inventoryItemId && l.kind !== 'product') || (l.ticketId && l.kind !== 'repair'))) {
      throw new HttpError(400, 'Inventory and repair references must match the line type');
    }
    const [saleCustomer] = body.data.customerId
      ? await db.select().from(schema.customers).where(and(eq(schema.customers.id, body.data.customerId), isNull(schema.customers.mergedInto)))
      : [];
    if (body.data.customerId && !saleCustomer) throw new HttpError(400, 'Select an active customer');
    const depositCents = lines.filter(l => l.kind === 'deposit').reduce((s, l) => s + l.qty * l.unitCents - l.discountCents, 0);
    if (lines.some(l => l.kind === 'deposit')) {
      if (!saleCustomer || !saleCustomer.name.trim() || !saleCustomer.phone?.trim()) {
        throw new HttpError(400, 'A deposit needs a customer with a name and phone number');
      }
      if (lines.some(l => l.kind === 'deposit' && (l.taxable || l.unitCents <= 0))) throw new HttpError(400, 'A deposit must be a positive, untaxed amount');
    }
    const totals = checkedTotals(lines, await getTaxRate(db, req.session!.storeId), body.data.saleDiscountCents);
    const paid = payments.reduce((sum,p)=>sum+p.amountCents,0);
    if (paid !== totals.totalCents) throw new HttpError(400, 'Payment amounts must equal the sale total; record cash handed over as tendered cash');
    if (payments.some(p=>p.method === 'cash' && p.tenderedCents != null && p.tenderedCents < p.amountCents)) {
      throw new HttpError(400, 'Cash tendered cannot be less than the cash payment');
    }
    if (body.data.parkedSaleId) {
      const [parked] = await db.update(schema.sales).set({ status: 'voided' }).where(and(
        eq(schema.sales.id, body.data.parkedSaleId), eq(schema.sales.storeId, req.session!.storeId), eq(schema.sales.status, 'parked'))).returning();
      if (!parked) throw new HttpError(404, 'Parked sale not found or already completed');
    }
    const credit = payments.filter(p=>p.method === 'store_credit').reduce((sum,p)=>sum+p.amountCents,0);
    if (credit) {
      if (!body.data.customerId) throw new HttpError(400, 'Store credit needs a customer on the sale');
      const [customer] = await db.update(schema.customers).set({ storeCreditCents: sql`${schema.customers.storeCreditCents} - ${credit}` })
        .where(and(eq(schema.customers.id, body.data.customerId), isNull(schema.customers.mergedInto), gte(schema.customers.storeCreditCents, credit))).returning();
      if (!customer) throw new HttpError(409, 'Not enough store credit');
    }
    if (payments.some(p=>p.method === 'cash')) await getOpenDrawer(db, req.session!.storeId, req.session!.id);
    const { sale, storedLines } = await insertSaleWithLines(db, req, lines, {
      status: 'completed', customerId: body.data.customerId, saleDiscountCents: body.data.saleDiscountCents,
      checkoutKey: key, checkoutHash: key ? hash : undefined,
    });
    if (credit) await db.insert(schema.storeCreditLedger).values({
      customerId: body.data.customerId!, deltaCents: -credit, reason: 'Spent on sale #' + sale.ticketNumber, saleId: sale.id, userId: req.session!.id,
    });
    const paymentRows = payments.map(p=>({ saleId: sale.id, method: p.method, amountCents: p.amountCents,
      tenderedCents: p.method === 'cash' ? p.tenderedCents ?? null : null,
      changeCents: p.method === 'cash' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : null, userId: req.session!.id }));
    await db.insert(schema.payments).values(paymentRows);
    await applyInventoryForSale(db, req.session!.id, req.session!.storeId, sale.id, lines);
    // deposits become store credit the customer can spend later (Store credit tender)
    if (depositCents > 0) {
      await db.update(schema.customers).set({ storeCreditCents: sql`${schema.customers.storeCreditCents} + ${depositCents}` })
        .where(eq(schema.customers.id, saleCustomer!.id));
      await db.insert(schema.storeCreditLedger).values({ customerId: saleCustomer!.id, deltaCents: depositCents,
        reason: 'Deposit on sale #' + sale.ticketNumber, saleId: sale.id, userId: req.session!.id });
    }
    for (const line of storedLines) await allocateTicket(db, req, sale, line, line.netCents! + line.taxCents!);
    if (body.data.parkedSaleId) await db.update(schema.sales).set({ parkedNote: 'Completed as #' + sale.ticketNumber }).where(eq(schema.sales.id, body.data.parkedSaleId));
    await audit(db, req, 'sale.complete', 'sale', sale.id, { total: sale.totalCents });
    // deposits are untaxed by nature; only real items count as a tax-removed deal
    const taxRemoved = lines.filter(l=>!l.taxable && l.kind !== 'deposit');
    if (taxRemoved.length) await audit(db, req, 'sale.tax_removed', 'sale', sale.id,
      { lines: taxRemoved.map(l=>({ description: l.description, amountCents: l.qty*l.unitCents-l.discountCents })) });
    const receipt = await buildReceipt(db, sale.storeId, req.session!.name, sale, storedLines, paymentRows);
    return { sale, totals, changeCents: paymentRows.reduce((s,p)=>s+(p.changeCents ?? 0),0), receipt, replayed: false };
  });
  let printed = false, printWarning: string | undefined;
  if (body.data.printReceipt && !result.replayed) {
    try {
      const escposBase64 = receiptEscpos(result.receipt, payments.some(p=>p.method === 'cash') && result.receipt.kickDrawer !== false);
      printed = emitBridge(req, { kind: 'receipt', escposBase64 });
      await logPrintJob(req, { kind: 'receipt', name: 'Sales receipt — #' + result.sale.ticketNumber,
        detail: (result.receipt.paperWidth ?? 80) + 'mm · Rongta', printed, payload: { escposBase64: receiptEscpos(result.receipt, false) } });
    } catch { printWarning = 'Sale saved. Receipt dispatch could not be confirmed; use the receipt history to reprint.'; }
  }
  if (!result.replayed) { emitStore(req, 'sales-changed'); emitStore(req, 'repairs-changed'); }
  res.json({ sale: result.sale, totals: result.totals, changeCents: result.changeCents, receiptText: receiptText(result.receipt),
    printed, printWarning, replayed: result.replayed });
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
  const { sale } = await financialTransaction(req.session!.storeId, tx => insertSaleWithLines(tx, req, body.data.lines, {
    status: 'parked',
    customerId: body.data.customerId,
    parkedNote: body.data.note,
  }));
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
      customerPhone: schema.customers.phone,
      lineSummary: sql<string>`(select string_agg(l.description, ', ') from sale_lines l where l.sale_id = ${schema.sales.id})`,
      ticketId: sql<number | null>`(select p.ticket_id from ticket_allocations p where p.sale_id = ${schema.sales.id} and p.ticket_id is not null limit 1)`,
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
  res.json(
    rows.map((r) => ({
      ...r.sale,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      lineSummary: r.lineSummary,
      ticketId: r.ticketId,
    })),
  );
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

/** Re-render a sale's receipt for viewing from the recent-transactions strip. */
salesRouter.get('/:id/receipt', async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, id));
  if (!sale || sale.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Sale not found' });
    return;
  }
  const lines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id));
  // ticket payments duplicate the sale total for repair bookkeeping — leave them off the receipt
  const paymentRows = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.saleId, id), isNull(schema.payments.ticketId)));
  const [cashier] =
    sale.userId == null ? [] : await db.select().from(schema.users).where(eq(schema.users.id, sale.userId));
  const receipt = await buildReceipt(db, sale.storeId, cashier?.name ?? '', sale, lines, paymentRows);
  res.json({ receiptText: receiptText(receipt) });
});

/** Reprint a sale's receipt on the store's thermal printer. */
salesRouter.post('/:id/print', async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, id));
  if (!sale || sale.storeId !== req.session!.storeId) {
    res.status(404).json({ error: 'Sale not found' });
    return;
  }
  const lines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id));
  const paymentRows = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.saleId, id), isNull(schema.payments.ticketId)));
  const [cashier] =
    sale.userId == null ? [] : await db.select().from(schema.users).where(eq(schema.users.id, sale.userId));
  const receipt = await buildReceipt(db, sale.storeId, cashier?.name ?? '', sale, lines, paymentRows);
  const escposBase64 = receiptEscpos(receipt, false);
  const printed = emitBridge(req, { kind: 'receipt', escposBase64 });
  await logPrintJob(req, {
    kind: 'receipt',
    name: `Reprint — #${sale.ticketNumber}`,
    detail: `${receipt.paperWidth ?? 80}mm · Rongta`,
    printed,
    payload: { escposBase64 },
  });
  res.json({ printed });
});


async function refundSale(db: Awaited<ReturnType<typeof getDb>>, req: Parameters<typeof audit>[1], id: number,
  options: { lineIds?: number[]; method?: 'cash' | 'store_credit'; restock: boolean; reason?: string; void?: boolean }) {
  const [original] = await db.select().from(schema.sales).where(and(eq(schema.sales.id, id), eq(schema.sales.storeId, req.session!.storeId))).for('update');
  if (!original || original.status !== 'completed') throw new HttpError(404, 'Completed sale not found');
  if (original.refundOfSaleId != null || original.totalCents <= 0) throw new HttpError(400, 'A refund cannot itself be refunded');
  const allLines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id)).orderBy(schema.saleLines.id);
  const previousRefunds = await db.select().from(schema.sales).where(eq(schema.sales.refundOfSaleId, id));
  const claimed = await db.select().from(schema.refundAllocations).where(inArray(schema.refundAllocations.originalLineId, allLines.map(l=>l.id)));
  if (previousRefunds.some(r=>!claimed.some(c=>c.refundSaleId === r.id))) {
    throw new HttpError(409, 'Legacy refund history requires reconciliation before another refund');
  }
  const used = new Set(claimed.map(c=>c.originalLineId));
  if (options.lineIds && (options.lineIds.length === 0 || new Set(options.lineIds).size !== options.lineIds.length ||
    options.lineIds.some(lineId=>!allLines.some(l=>l.id === lineId) || used.has(lineId)))) {
    throw new HttpError(409, 'One or more selected lines are invalid or already refunded');
  }
  const selected = allLines.filter(l=>options.lineIds ? options.lineIds.includes(l.id) : !used.has(l.id));
  if (!selected.length) throw new HttpError(409, 'Nothing remains to refund');
  if (options.void && (claimed.length || previousRefunds.length)) throw new HttpError(409, 'Partially refunded sales must use the refund workflow');
  const legacy = allLines.some(l=>l.netCents == null || l.taxCents == null);
  if (legacy) {
    const snapshots = snapshotLines(allLines, original);
    for (let i=0;i<allLines.length;i++) {
      Object.assign(allLines[i]!, snapshots[i]);
      await db.update(schema.saleLines).set(snapshots[i]!).where(eq(schema.saleLines.id, allLines[i]!.id));
    }
  }
  const refundAmount = selected.reduce((sum,l)=>sum+l.netCents!+l.taxCents!,0);
  const remainingAmount = original.totalCents - claimed.reduce((s,c)=>s+c.amountCents,0);
  if (refundAmount <= 0 || refundAmount > remainingAmount) throw new HttpError(409, 'Refund exceeds the remaining collected amount or contains an unsupported payout allocation');
  await requireStoreReferences(db, original.storeId, { inventoryIds: selected.map(l=>l.inventoryItemId), ticketIds: selected.map(l=>l.ticketId) });
  const originalPayments = await db.select().from(schema.payments).where(eq(schema.payments.saleId, id));
  if (originalPayments.reduce((s,p)=>s+p.amountCents,0) !== original.totalCents) throw new HttpError(409, 'Original tenders require reconciliation before a refund');
  if (options.void && originalPayments.some(p=>['card', 'tap', 'zelle', 'cash_app'].includes(p.method))) {
    throw new HttpError(409, 'Card, Zelle and Cash App tenders settle outside the register; record a refund instead of a void');
  }
  const tenders: Array<{ method: 'cash' | 'store_credit'; amountCents: number }> = options.void
    ? originalPayments.map(p=>({ method: p.method as 'cash' | 'store_credit', amountCents: -p.amountCents }))
    : [{ method: options.method!, amountCents: -refundAmount }];
  if (tenders.some(p=>p.method === 'store_credit') && !original.customerId) throw new HttpError(400, 'Store credit refund needs the original customer');
  if (tenders.some(p=>p.method === 'cash')) await getOpenDrawer(db, original.storeId, req.session!.id);
  const [refund] = await db.insert(schema.sales).values({
    storeId: original.storeId, terminalId: req.session!.terminalId, userId: req.session!.id, customerId: original.customerId,
    ticketNumber: await nextTicketNumber(db, original.storeId), status: 'completed', refundOfSaleId: id, completedAt: new Date(),
    subtotalCents: -selected.reduce((s,l)=>s+l.netCents!,0), discountCents: 0,
    taxCents: -selected.reduce((s,l)=>s+l.taxCents!,0), totalCents: -refundAmount,
  }).returning();
  for (const line of selected) {
    const [refundLine] = await db.insert(schema.saleLines).values({ saleId: refund!.id, kind: line.kind, description: 'Refund: ' + line.description,
      qty: 1, unitCents: -line.netCents!, discountCents: 0, taxable: line.taxable, inventoryItemId: line.inventoryItemId, ticketId: line.ticketId,
      netCents: -line.netCents!, taxCents: -line.taxCents! }).returning();
    await db.insert(schema.refundAllocations).values({ originalLineId: line.id, refundSaleId: refund!.id, amountCents: line.netCents!+line.taxCents! });
    if (line.kind === 'repair' && line.ticketId) {
      const allocations = await db.select().from(schema.ticketAllocations).where(and(eq(schema.ticketAllocations.saleId, original.id), eq(schema.ticketAllocations.ticketId, line.ticketId)));
      if (allocations.some(a=>a.saleLineId == null)) throw new HttpError(409, 'Legacy repair allocations require reconciliation before refund');
      const allocated = allocations.filter(a=>a.saleLineId === line.id).reduce((s,a)=>s+a.amountCents,0);
      if (allocated !== line.netCents!+line.taxCents!) throw new HttpError(409, 'Repair allocation does not match this sale line');
      await db.insert(schema.ticketAllocations).values({ saleId: refund!.id, saleLineId: refundLine!.id, ticketId: line.ticketId, amountCents: -allocated });
      // Payment reversal does not undo the physical handover of a picked-up device.
    }
    if (line.kind === 'deposit') {
      if (!original.customerId) throw new HttpError(409, 'Deposit sale has no customer to reverse credit from');
      const [customer] = await db.update(schema.customers).set({ storeCreditCents: sql`${schema.customers.storeCreditCents} - ${line.netCents!}` })
        .where(and(eq(schema.customers.id, original.customerId), isNull(schema.customers.mergedInto), gte(schema.customers.storeCreditCents, line.netCents!))).returning();
      if (!customer) throw new HttpError(409, 'The deposit was already spent as store credit; refund what remains from the customer record instead');
      await db.insert(schema.storeCreditLedger).values({ customerId: original.customerId, deltaCents: -line.netCents!,
        reason: 'Deposit refunded from #' + original.ticketNumber, saleId: refund!.id, userId: req.session!.id });
    }
    if (options.restock && line.kind === 'product' && line.inventoryItemId) {
      const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, line.inventoryItemId));
      if (!item) throw new HttpError(409, 'Inventory record is unavailable');
      const [restocked] = await db.update(schema.inventoryItems)
        .set(item.kind === 'device' ? { qty: 1, status: 'in_stock', soldAt: null } : { qty: sql`${schema.inventoryItems.qty} + ${line.qty}` })
        .where(and(eq(schema.inventoryItems.id, item.id), eq(schema.inventoryItems.storeId, original.storeId),
          item.kind === 'device' ? and(eq(schema.inventoryItems.status, 'sold'), eq(schema.inventoryItems.qty, 0)) : undefined)).returning();
      if (!restocked) throw new HttpError(409, 'Device inventory state must be reconciled before restocking');
      await db.insert(schema.inventoryMovements).values({ itemId: item.id, deltaQty: line.qty, kind: 'refund_restock', refId: refund!.id, userId: req.session!.id });
    }
  }
  await db.insert(schema.payments).values(tenders.map(p=>({ ...p, saleId: refund!.id, userId: req.session!.id })));
  const credit = -tenders.filter(p=>p.method === 'store_credit').reduce((s,p)=>s+p.amountCents,0);
  if (credit) {
    const [customer] = await db.update(schema.customers).set({ storeCreditCents: sql`${schema.customers.storeCreditCents} + ${credit}` })
      .where(and(eq(schema.customers.id, original.customerId!), isNull(schema.customers.mergedInto))).returning();
    if (!customer) throw new HttpError(409, 'Original customer was merged; reconcile the refund customer first');
    await db.insert(schema.storeCreditLedger).values({ customerId: original.customerId!, deltaCents: credit,
      reason: 'Refund of #' + original.ticketNumber, saleId: refund!.id, userId: req.session!.id });
  }
  if (used.size + selected.length === allLines.length) {
    await db.update(schema.sales).set({ status: options.void ? 'voided' : 'refunded' }).where(eq(schema.sales.id, original.id));
  }
  await audit(db, req, options.void ? 'sale.void' : 'sale.refund', 'sale', original.id,
    { refundSaleId: refund!.id, amount: refundAmount, tenders, reason: options.reason });
  return { ok: true, refundSaleId: refund!.id, refundAmountCents: refundAmount };
}

/** Managers approve directly; anyone else supplies the store admin code or a manager's PIN. Runs before any store transaction. */
async function approveWithManager(req: Parameters<typeof audit>[1], pin: string | null):
  Promise<{ ok: true; approverId: number | null } | { ok: false; status: number; error: string }> {
  if (req.session!.role === 'manager') return { ok: true, approverId: null };
  if (!pin) return { ok: false, status: 403, error: 'An admin code is required to correct a completed sale' };
  if (!(await allowAuthAttempt('amend-pin:' + req.session!.storeId, 20))) return { ok: false, status: 429, error: 'Too many code attempts. Try again in 15 minutes.' };
  const approval = await verifyManagerCode(await getDb(), req.session!.storeId, pin);
  if (!approval) return { ok: false, status: 403, error: 'Wrong admin code' };
  return { ok: true, approverId: approval.approverId };
}

/**
 * Correct a completed sale (Edit sale on the receipt). Completed history is never
 * rewritten in place: the original is voided with a note, a corrected sale takes the
 * new lines, the original tenders move onto it, and the difference is collected
 * (`payments`) or given back (`refundMethod`). Inventory is restocked and re-sold so
 * movements stay traceable. Repair, trade-in and payout lines have their own ledgers
 * and are refused; refund those and ring a new sale.
 */
salesRouter.post('/:id/amend', async (req, res) => {
  const body = z.object({
    lines: z.array(lineSchema).min(1),
    /** undefined keeps the original customer; null detaches; a number attaches */
    customerId: z.number().int().positive().optional().nullable(),
    payments: z.array(paymentSchema).default([]),
    refundMethod: z.enum(['cash', 'store_credit']).optional().nullable(),
    managerPin: z.string().regex(/^\d{4,6}$/).optional().nullable(),
    reason: z.string().max(300).optional().nullable(),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'Invalid correction' }); return; }
  if (body.data.lines.some(l => l.kind !== 'product' && l.kind !== 'custom')) {
    res.status(409).json({ error: 'Only product and custom lines can be corrected. Repair, trade-in and payout lines need a refund and a new sale.' }); return;
  }
  const approval = await approveWithManager(req, body.data.managerPin ?? null);
  if (!approval.ok) { res.status(approval.status).json({ error: approval.error }); return; }
  const id = Number(req.params.id);
  const result = await financialTransaction(req.session!.storeId, async db => {
    const [original] = await db.select().from(schema.sales)
      .where(and(eq(schema.sales.id, id), eq(schema.sales.storeId, req.session!.storeId))).for('update');
    if (!original || original.status !== 'completed') throw new HttpError(404, 'Completed sale not found');
    if (original.refundOfSaleId != null || original.totalCents <= 0) throw new HttpError(400, 'A refund cannot be corrected');
    const oldLines = await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id));
    if (oldLines.some(l => l.kind !== 'product' && l.kind !== 'custom')) {
      throw new HttpError(409, 'This sale paid a repair, trade-in, payout or deposit. Refund it and ring a new sale instead.');
    }
    const [priorRefund] = await db.select().from(schema.sales).where(eq(schema.sales.refundOfSaleId, id));
    if (priorRefund) throw new HttpError(409, 'A partly refunded sale must finish through the refund workflow');
    const oldPayments = await db.select().from(schema.payments).where(eq(schema.payments.saleId, id));
    const paid = oldPayments.reduce((s, p) => s + p.amountCents, 0);
    const customerId = body.data.customerId === undefined ? original.customerId : body.data.customerId;
    if (customerId) {
      const [customer] = await db.select().from(schema.customers).where(and(eq(schema.customers.id, customerId), isNull(schema.customers.mergedInto)));
      if (!customer) throw new HttpError(400, 'Select an active customer');
    }

    // put back what the original sold, then sell through the corrected lines
    for (const line of oldLines) {
      if (line.kind !== 'product' || !line.inventoryItemId) continue;
      const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, line.inventoryItemId));
      if (!item) throw new HttpError(409, 'Inventory record is unavailable');
      await db.update(schema.inventoryItems)
        .set(item.kind === 'device' ? { qty: 1, status: 'in_stock', soldAt: null } : { qty: sql`${schema.inventoryItems.qty} + ${line.qty}` })
        .where(eq(schema.inventoryItems.id, item.id));
      await db.insert(schema.inventoryMovements).values({ itemId: item.id, deltaQty: line.qty, kind: 'refund_restock', refId: id, userId: req.session!.id });
    }
    const { sale, totals, storedLines } = await insertSaleWithLines(db, req, body.data.lines, {
      status: 'completed', customerId, parkedNote: 'Corrects #' + original.ticketNumber,
    });
    await applyInventoryForSale(db, req.session!.id, req.session!.storeId, sale.id, body.data.lines);

    const diff = totals.totalCents - paid;
    const extra = body.data.payments;
    const extraSum = extra.reduce((s, p) => s + p.amountCents, 0);
    if (diff > 0 && extraSum !== diff) throw new HttpError(400, `The corrected total is ${(diff / 100).toFixed(2)} more than what was paid; collect exactly that difference`);
    if (diff <= 0 && extraSum !== 0) throw new HttpError(400, 'No additional payment is due on this correction');
    if (diff < 0 && !body.data.refundMethod) throw new HttpError(400, 'Choose how to give back the difference: cash or store credit');
    if (extra.some(p => p.method === 'cash') || (diff < 0 && body.data.refundMethod === 'cash')) {
      await getOpenDrawer(db, req.session!.storeId, req.session!.id);
    }

    // tenders: the originals move over unchanged, then the difference is recorded
    await db.update(schema.payments).set({ saleId: sale.id }).where(eq(schema.payments.saleId, id));
    const newRows: Array<typeof schema.payments.$inferInsert> = extra.map(p => ({
      saleId: sale.id, method: p.method, amountCents: p.amountCents,
      tenderedCents: p.method === 'cash' ? p.tenderedCents ?? null : null,
      changeCents: p.method === 'cash' && p.tenderedCents != null ? p.tenderedCents - p.amountCents : null, userId: req.session!.id,
    }));
    if (diff < 0) newRows.push({ saleId: sale.id, method: body.data.refundMethod!, amountCents: diff, userId: req.session!.id });
    if (newRows.length) await db.insert(schema.payments).values(newRows);

    const creditSpent = extra.filter(p => p.method === 'store_credit').reduce((s, p) => s + p.amountCents, 0);
    const creditBack = diff < 0 && body.data.refundMethod === 'store_credit' ? -diff : 0;
    if (creditSpent || creditBack) {
      if (!customerId) throw new HttpError(400, 'Store credit needs a customer on the sale');
      const delta = creditBack - creditSpent;
      const [customer] = await db.update(schema.customers).set({ storeCreditCents: sql`${schema.customers.storeCreditCents} + ${delta}` })
        .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.mergedInto),
          delta < 0 ? gte(schema.customers.storeCreditCents, -delta) : undefined)).returning();
      if (!customer) throw new HttpError(409, 'Not enough store credit');
      await db.insert(schema.storeCreditLedger).values({ customerId, deltaCents: delta,
        reason: 'Correction of #' + original.ticketNumber + ' as #' + sale.ticketNumber, saleId: sale.id, userId: req.session!.id });
    }

    await db.update(schema.sales).set({ status: 'voided', parkedNote: 'Corrected as #' + sale.ticketNumber }).where(eq(schema.sales.id, id));
    await audit(db, req, 'sale.amend', 'sale', sale.id, {
      originalSaleId: id, originalTotal: original.totalCents, newTotal: totals.totalCents, diffCents: diff,
      refundMethod: diff < 0 ? body.data.refundMethod : null, approvedBy: approval.approverId ?? req.session!.id, reason: body.data.reason ?? null,
    });
    const allPayments = await db.select().from(schema.payments).where(eq(schema.payments.saleId, sale.id));
    const receipt = await buildReceipt(db, sale.storeId, req.session!.name, sale, storedLines, allPayments);
    return { sale, totals, diff, receipt };
  });
  emitStore(req, 'sales-changed');
  res.json({ sale: result.sale, totals: result.totals, diffCents: result.diff, receiptText: receiptText(result.receipt) });
});

salesRouter.post('/:id/void', requireRole('manager'), async (req, res) => {
  const result = await financialTransaction(req.session!.storeId, async db => {
    const id = Number(req.params.id);
    const [sale] = await db.select().from(schema.sales).where(and(eq(schema.sales.id,id),eq(schema.sales.storeId,req.session!.storeId)));
    if (!sale) throw new HttpError(404, 'Sale not found');
    if (sale.status === 'parked') {
      await db.update(schema.sales).set({ status: 'voided' }).where(eq(schema.sales.id,id));
      await audit(db,req,'sale.void','sale',id,{ was: 'parked', reason: req.body?.reason });
      return { ok: true };
    }
    if (new Date(sale.completedAt ?? sale.createdAt).toISOString().slice(0,10) !== new Date().toISOString().slice(0,10)) {
      throw new HttpError(400, "Only today's sales can be voided; use a refund");
    }
    return refundSale(db,req,id,{ restock: true, void: true, reason: req.body?.reason });
  });
  emitStore(req,'sales-changed'); emitStore(req,'repairs-changed');
  res.json(result);
});

salesRouter.post('/:id/refund', async (req,res) => {
  const body = z.object({ lineIds: z.array(z.number().int().positive()).optional(), method: z.enum(['cash','store_credit']),
    restock: z.boolean().default(true), reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, 'Choose a refund method and valid lines');
  const result = await financialTransaction(req.session!.storeId, db=>refundSale(db,req,Number(req.params.id),body.data));
  emitStore(req,'sales-changed'); emitStore(req,'repairs-changed');
  res.json(result);
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
