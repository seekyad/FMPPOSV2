
import { and, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { computeTotals, type SaleLineInput, type SaleTotals } from '@fmp/shared';
import { getDb, schema, type Db } from './db/index';
import { HttpError } from './http';

/** Serialize each store's financial workflows; shared credit uses a conditional row update too. */
export async function financialTransaction<T>(storeId: number, work: (tx: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async tx => {
    await tx.select({ id: schema.stores.id }).from(schema.stores).where(eq(schema.stores.id, storeId)).for('update');
    return work(tx as unknown as Db);
  });
}

/** Cumulative rounding assigns every cent exactly once, in stable line order. */
function apportion(amount: number, weights: number[]) {
  const total = weights.reduce((a, b) => a + b, 0);
  let accumulated = 0, assigned = 0;
  return weights.map(weight => {
    accumulated += weight;
    const next = total ? Math.round(amount * accumulated / total) : 0;
    const part = next - assigned; assigned = next;
    return part;
  });
}

export function snapshotLines(lines: SaleLineInput[], totals: Pick<SaleTotals, 'discountCents' | 'taxCents' | 'totalCents'>) {
  const gross = lines.map(l => l.qty * l.unitCents);
  const discounts = lines.map((l, i) => gross[i]! > 0 ? Math.min(l.discountCents ?? 0, gross[i]!) : 0);
  const before = gross.map((g, i) => g - discounts[i]!);
  const saleDiscount = totals.discountCents - discounts.reduce((a, b) => a + b, 0);
  const shares = apportion(saleDiscount, before.map(v => Math.max(0, v)));
  const net = before.map((v, i) => v - shares[i]!);
  const taxes = apportion(totals.taxCents, net.map((v, i) => lines[i]!.taxable ? v : 0));
  if (net.reduce((a,b)=>a+b,0) + taxes.reduce((a,b)=>a+b,0) !== totals.totalCents) {
    throw new HttpError(409, 'Sale totals cannot be reconciled; review the original transaction');
  }
  return net.map((netCents, i) => ({ netCents, taxCents: taxes[i]! }));
}

export function checkedTotals(lines: SaleLineInput[], rate: number, discount = 0) {
  if (lines.some(l => l.unitCents < 0 || (l.discountCents ?? 0) > l.qty * l.unitCents)) {
    throw new HttpError(400, 'Use the trade-in, payout or refund workflow for money returned to a customer; discounts cannot exceed a line price');
  }
  const totals = computeTotals(lines, rate, discount);
  if (!Number.isSafeInteger(totals.totalCents) || totals.totalCents <= 0 || totals.totalCents > 2_000_000_000) {
    throw new HttpError(400, 'Sale total must be positive and within the supported amount');
  }
  return totals;
}

export async function ticketPayments(db: Db, ticketId: number) {
  const payments = await db.select().from(schema.payments).where(eq(schema.payments.ticketId, ticketId));
  const allocations = await db.select().from(schema.ticketAllocations).where(eq(schema.ticketAllocations.ticketId, ticketId));
  return [
    ...payments,
    ...allocations.map(a => ({ id: 'allocation-' + a.id, ticketId, saleId: a.saleId, method: 'sale_allocation',
      amountCents: a.amountCents, isDeposit: false, createdAt: a.createdAt })),
  ];
}

export async function allocateTicket(db: Db, req: Request, sale: typeof schema.sales.$inferSelect,
  line: typeof schema.saleLines.$inferSelect, amountCents: number) {
  if (line.kind !== 'repair' || !line.ticketId) return;
  const [ticket] = await db.select().from(schema.repairTickets).where(and(eq(schema.repairTickets.id, line.ticketId),
    eq(schema.repairTickets.storeId, sale.storeId))).for('update');
  if (!ticket || ['cancelled', 'abandoned', 'picked_up'].includes(ticket.status)) {
    throw new HttpError(409, 'Repair is closed or unavailable for payment');
  }
  if (ticket.customerId !== sale.customerId) throw new HttpError(400, 'Repair payment must use the ticket customer');
  const paid = (await ticketPayments(db, ticket.id)).reduce((s, p) => s + p.amountCents, 0);
  const remaining = ticket.totalCents - paid;
  // A taxed register line cannot always land on the balance to the cent; a one-cent overshoot
  // from that rounding is accepted and the allocation is capped at what the ticket still owes.
  if (amountCents > remaining + 1 || (amountCents > 0 && remaining <= 0)) {
    throw new HttpError(409, 'Repair payment exceeds the remaining balance');
  }
  const allocated = Math.min(amountCents, remaining);
  await db.insert(schema.ticketAllocations).values({ saleId: sale.id, saleLineId: line.id, ticketId: ticket.id, amountCents: allocated });
  if (ticket.status === 'completed' && paid + allocated === ticket.totalCents) {
    await db.update(schema.repairTickets).set({ status: 'picked_up' }).where(eq(schema.repairTickets.id, ticket.id));
    await db.insert(schema.ticketStatusHistory).values({ ticketId: ticket.id, status: 'picked_up', userId: req.session!.id });
  }
}
