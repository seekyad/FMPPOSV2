import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createRouter as Router } from '../http';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

export type TransactionKind =
  | 'sale'
  | 'refund'
  | 'voided'
  | 'deposit'
  | 'deposit_refund'
  | 'payout'
  | 'paid_in'
  | 'drop'
  | 'tradein';

export interface TransactionRow {
  /** unique across sources, e.g. "sale-12", "movement-4" */
  key: string;
  kind: TransactionKind;
  /** the transaction number from the store series (S1-000123); deposits carry their ticket's */
  number: string;
  at: string;
  customerName: string | null;
  customerPhone: string | null;
  description: string;
  /** correction trail, payout reason, and similar context */
  note: string | null;
  method: string | null;
  /** money into the store is positive; money out (refunds, payouts, trade-ins) is negative */
  amountCents: number;
  status: string | null;
  userName: string | null;
  saleId: number | null;
  ticketId: number | null;
}

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One log for everything money-related: sales, refunds and voids, repair deposits,
 * register payouts and paid-ins, cash drops, and trade-ins — including the ones that
 * never touched a sale. Filtered by date range and kind server-side; the screen
 * searches the rows it gets.
 */
transactionsRouter.get('/', async (req, res) => {
  const db = await getDb();
  const storeId = req.session!.storeId;
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  const kind = String(req.query.kind ?? 'all');
  const within = (col: Parameters<typeof gte>[0]) => and(from ? gte(col, from) : undefined, to ? lt(col, to) : undefined);
  const LIMIT = 500;

  const rows: TransactionRow[] = [];

  // sales, refunds, and voids that had been completed (a voided parked sale never was a transaction)
  const t = schema.sales;
  const sales = await db
    .select({
      sale: t,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      userName: schema.users.name,
      lineSummary: sql<string | null>`(select string_agg(l.description, ', ') from sale_lines l where l.sale_id = ${t.id})`,
      methods: sql<string | null>`(select string_agg(distinct p.method, ', ') from payments p where p.sale_id = ${t.id})`,
      ticketId: sql<number | null>`(select a.ticket_id from ticket_allocations a where a.sale_id = ${t.id} limit 1)`,
    })
    .from(t)
    .leftJoin(schema.customers, eq(t.customerId, schema.customers.id))
    .leftJoin(schema.users, eq(t.userId, schema.users.id))
    .where(and(eq(t.storeId, storeId), inArray(t.status, ['completed', 'refunded', 'voided']), isNotNull(t.completedAt), within(t.completedAt)))
    .orderBy(desc(t.completedAt))
    .limit(LIMIT);
  for (const r of sales) {
    const isRefund = r.sale.refundOfSaleId != null;
    rows.push({
      key: 'sale-' + r.sale.id,
      kind: r.sale.status === 'voided' ? 'voided' : isRefund ? 'refund' : 'sale',
      number: r.sale.ticketNumber,
      at: (r.sale.completedAt ?? r.sale.createdAt).toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      description: r.lineSummary ?? '',
      note: r.sale.parkedNote ?? null,
      method: r.methods,
      amountCents: r.sale.totalCents,
      status: r.sale.status,
      userName: r.userName,
      saleId: r.sale.id,
      ticketId: r.ticketId,
    });
  }

  // repair deposits and deposit refunds: payments on a ticket with no sale behind them
  const p = schema.payments;
  const deposits = await db
    .select({
      p,
      ticketNumber: schema.repairTickets.number,
      ticketId: schema.repairTickets.id,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      userName: schema.users.name,
    })
    .from(p)
    .innerJoin(schema.repairTickets, eq(p.ticketId, schema.repairTickets.id))
    .leftJoin(schema.customers, eq(schema.repairTickets.customerId, schema.customers.id))
    .leftJoin(schema.users, eq(p.userId, schema.users.id))
    .where(and(eq(schema.repairTickets.storeId, storeId), isNull(p.saleId), within(p.createdAt)))
    .orderBy(desc(p.createdAt))
    .limit(LIMIT);
  for (const r of deposits) {
    rows.push({
      key: 'payment-' + r.p.id,
      kind: r.p.amountCents < 0 ? 'deposit_refund' : 'deposit',
      number: r.ticketNumber,
      at: r.p.createdAt.toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      description: r.p.amountCents < 0 ? 'Repair deposit refunded' : 'Repair deposit',
      note: null,
      method: r.p.method,
      amountCents: r.p.amountCents,
      status: null,
      userName: r.userName,
      saleId: null,
      ticketId: r.ticketId,
    });
  }

  // register cash movements: payouts, paid-ins, drops, and cash trade-ins
  const m = schema.cashMovements;
  const moves = await db
    .select({ m, userName: schema.users.name })
    .from(m)
    .innerJoin(schema.drawerSessions, eq(m.drawerSessionId, schema.drawerSessions.id))
    .leftJoin(schema.users, eq(m.userId, schema.users.id))
    .where(and(eq(schema.drawerSessions.storeId, storeId), inArray(m.kind, ['paid_in', 'paid_out', 'tradein_payout', 'drop']), within(m.createdAt)))
    .orderBy(desc(m.createdAt))
    .limit(LIMIT);
  for (const r of moves) {
    const kind: TransactionKind = r.m.kind === 'paid_out' ? 'payout' : r.m.kind === 'paid_in' ? 'paid_in' : r.m.kind === 'drop' ? 'drop' : 'tradein';
    rows.push({
      key: 'movement-' + r.m.id,
      kind,
      number: r.m.number ?? 'CASH-' + String(r.m.id).padStart(4, '0'),
      at: r.m.createdAt.toISOString(),
      customerName: null,
      customerPhone: null,
      description: kind === 'payout' ? 'Cash paid out' : kind === 'paid_in' ? 'Cash paid in' : kind === 'drop' ? 'Cash drop to safe' : 'Trade-in paid in cash',
      note: [r.m.reason, r.m.source === 'back_office' ? 'from back office · drawer not affected' : null].filter(Boolean).join(' · ') || null,
      method: 'cash',
      amountCents: kind === 'paid_in' ? r.m.amountCents : -r.m.amountCents,
      status: null,
      userName: r.userName,
      saleId: null,
      ticketId: null,
    });
  }

  // trade-ins paid as store credit: only the ledger records them
  const l = schema.storeCreditLedger;
  const creditTradeins = await db
    .select({ l, customerName: schema.customers.name, customerPhone: schema.customers.phone, userName: schema.users.name })
    .from(l)
    .innerJoin(schema.customers, eq(l.customerId, schema.customers.id))
    .innerJoin(schema.users, eq(l.userId, schema.users.id))
    .where(and(eq(schema.users.storeId, storeId), isNull(l.saleId), like(l.reason, 'Trade-in%'), within(l.createdAt)))
    .orderBy(desc(l.createdAt))
    .limit(LIMIT);
  for (const r of creditTradeins) {
    rows.push({
      key: 'credit-' + r.l.id,
      kind: 'tradein',
      number: r.l.number ?? 'CREDIT-' + String(r.l.id).padStart(4, '0'),
      at: r.l.createdAt.toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      description: 'Trade-in paid as store credit',
      note: r.l.reason,
      method: 'store_credit',
      amountCents: -r.l.deltaCents,
      status: null,
      userName: r.userName,
      saleId: null,
      ticketId: null,
    });
  }

  const kinds: Record<string, TransactionKind[]> = {
    all: ['sale', 'refund', 'voided', 'deposit', 'deposit_refund', 'payout', 'paid_in', 'drop', 'tradein'],
    sale: ['sale'],
    refund: ['refund', 'deposit_refund'],
    voided: ['voided'],
    repair: ['deposit', 'deposit_refund'],
    payout: ['payout', 'paid_in', 'drop'],
    tradein: ['tradein'],
  };
  const allowed = kinds[kind] ?? kinds.all!;
  const out = rows.filter((r) => allowed.includes(r.kind)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMIT);
  res.json({ rows: out, truncated: rows.length > LIMIT });
});
