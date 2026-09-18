import { createRouter as Router } from '../http';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';
import { drawerExpectation, getOpenDrawer } from './drawer';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function rangeBounds(range: string): { start: Date; prevStart: Date } {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'week') {
    const start = new Date(dayStart.getTime() - 6 * 86400_000);
    return { start, prevStart: new Date(start.getTime() - 7 * 86400_000) };
  }
  if (range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1) };
  }
  return { start: dayStart, prevStart: new Date(dayStart.getTime() - 86400_000) };
}

reportsRouter.get('/summary', async (req, res) => {
  const db = await getDb();
  const storeId = req.session!.storeId;
  const range = String(req.query.range ?? 'today');
  const { start, prevStart } = rangeBounds(range);

  const completedIn = (from: Date, to?: Date) =>
    and(
      eq(schema.sales.storeId, storeId),
      sql`(${schema.sales.status} in ('completed','refunded') or (${schema.sales.status} = 'voided' and exists (select 1 from sales reversal where reversal.refund_of_sale_id = ${schema.sales.id})))`,
      isNotNull(schema.sales.completedAt),
      gte(schema.sales.completedAt, from),
      to ? lt(schema.sales.completedAt, to) : undefined,
    );

  // deposits ride on sales but are held as store credit, so they are not revenue until spent
  const depositOnSale = sql`coalesce((select sum(l.net_cents + l.tax_cents) from sale_lines l where l.sale_id = ${schema.sales.id} and l.kind = 'deposit'), 0)`;
  const [gross] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.sales.totalCents} - ${depositOnSale}), 0)`,
      positives: sql<number>`count(*) filter (where ${schema.sales.totalCents} - ${depositOnSale} > 0)`,
    })
    .from(schema.sales)
    .where(completedIn(start));
  const [prevGross] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.sales.totalCents} - ${depositOnSale}), 0)` })
    .from(schema.sales)
    .where(completedIn(prevStart, start));

  const [ticketStats] = await db
    .select({
      takenIn: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where ${schema.repairTickets.status} in ('completed','picked_up'))`,
      stillOpen: sql<number>`count(*) filter (where ${schema.repairTickets.status} in ('open','in_progress','waiting_part'))`,
    })
    .from(schema.repairTickets)
    .where(and(eq(schema.repairTickets.storeId, storeId), gte(schema.repairTickets.createdAt, start)));

  const [outstanding] = await db
    .select({
      balance: sql<number>`coalesce(sum(${schema.repairTickets.totalCents} - (coalesce((select sum(p.amount_cents) from payments p where p.ticket_id = ${schema.repairTickets.id}),0) + coalesce((select sum(a.amount_cents) from ticket_allocations a where a.ticket_id = ${schema.repairTickets.id}),0))), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(schema.repairTickets)
    .where(
      and(
        eq(schema.repairTickets.storeId, storeId),
        inArray(schema.repairTickets.status, ['open', 'in_progress', 'waiting_part', 'completed']),
      ),
    );

  const categoryRows = await db
    .select({
      kind: schema.saleLines.kind,
      itemKind: schema.inventoryItems.kind,
      revenue: sql<number>`coalesce(sum(coalesce(${schema.saleLines.netCents}, ${schema.saleLines.qty} * ${schema.saleLines.unitCents} - ${schema.saleLines.discountCents})), 0)`,
    })
    .from(schema.saleLines)
    .innerJoin(schema.sales, eq(schema.saleLines.saleId, schema.sales.id))
    .leftJoin(schema.inventoryItems, eq(schema.saleLines.inventoryItemId, schema.inventoryItems.id))
    .where(completedIn(start))
    .groupBy(schema.saleLines.kind, schema.inventoryItems.kind);
  const revenueByCategory = { repairs: 0, devices: 0, accessories: 0, other: 0 };
  for (const row of categoryRows) {
    const r = Number(row.revenue);
    if (row.kind === 'deposit') continue; // held as store credit, not revenue yet
    if (row.kind === 'repair') revenueByCategory.repairs += r;
    else if (row.kind === 'product' && row.itemKind === 'device') revenueByCategory.devices += r;
    else if (row.kind === 'product') revenueByCategory.accessories += r;
    else revenueByCategory.other += r;
  }

  const last30 = new Date(Date.now() - 30 * 86400_000);
  const topRepairs = await db
    .select({
      name: schema.services.name,
      jobs: sql<number>`count(*)`,
      revenue: sql<number>`coalesce(sum(${schema.ticketLines.priceCents}), 0)`,
      partCost: sql<number>`coalesce(sum(${schema.services.partsCostCents}), 0)`,
    })
    .from(schema.ticketLines)
    .innerJoin(schema.repairTickets, eq(schema.ticketLines.ticketId, schema.repairTickets.id))
    .innerJoin(schema.services, eq(schema.ticketLines.serviceId, schema.services.id))
    .where(and(eq(schema.repairTickets.storeId, storeId), gte(schema.repairTickets.createdAt, last30)))
    .groupBy(schema.services.name)
    .orderBy(sql`coalesce(sum(${schema.ticketLines.priceCents}), 0) desc`)
    .limit(6);

  const paymentRows = await db
    .select({
      method: schema.payments.method,
      total: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)`,
    })
    .from(schema.payments)
    .where(
      sql`${schema.payments.createdAt} >= ${start} and (
        (${schema.payments.saleId} is not null and exists (select 1 from sales s where s.id = ${schema.payments.saleId} and s.store_id = ${storeId}))
        or (${schema.payments.ticketId} is not null and exists (select 1 from repair_tickets t where t.id = ${schema.payments.ticketId} and t.store_id = ${storeId}))
      )`,
    )
    .groupBy(schema.payments.method);

  const techRows = await db
    .select({
      name: schema.users.name,
      initials: schema.users.initials,
      jobs: sql<number>`count(*)`,
      revenue: sql<number>`coalesce(sum(${schema.repairTickets.totalCents}), 0)`,
    })
    .from(schema.repairTickets)
    .innerJoin(schema.users, eq(schema.repairTickets.technicianId, schema.users.id))
    .where(
      and(
        eq(schema.repairTickets.storeId, storeId),
        inArray(schema.repairTickets.status, ['completed', 'picked_up']),
        gte(schema.repairTickets.createdAt, start),
      ),
    )
    .groupBy(schema.users.name, schema.users.initials);

  const drawerSession = await getOpenDrawer(db, storeId, req.session!.id);
  const drawer = await drawerExpectation(db, storeId, drawerSession);

  const grossTotal = Number(gross?.total ?? 0);
  res.json({
    range,
    grossSalesCents: grossTotal,
    prevGrossSalesCents: Number(prevGross?.total ?? 0),
    salesCount: Number(gross?.positives ?? 0),
    averageTicketCents: Number(gross?.positives ?? 0) > 0 ? Math.round(grossTotal / Number(gross!.positives)) : 0,
    ticketsTakenIn: Number(ticketStats?.takenIn ?? 0),
    ticketsCompleted: Number(ticketStats?.completed ?? 0),
    ticketsStillOpen: Number(ticketStats?.stillOpen ?? 0),
    outstandingBalanceCents: Number(outstanding?.balance ?? 0),
    outstandingCount: Number(outstanding?.count ?? 0),
    revenueByCategory,
    topRepairs: topRepairs.map((t) => ({
      name: t.name,
      jobs: Number(t.jobs),
      revenueCents: Number(t.revenue),
      marginPct:
        Number(t.revenue) > 0 ? Math.round(((Number(t.revenue) - Number(t.partCost)) / Number(t.revenue)) * 100) : 0,
    })),
    paymentMix: paymentRows.map((p) => ({ method: p.method, totalCents: Number(p.total) })),
    technicianOutput: techRows.map((t) => ({ ...t, jobs: Number(t.jobs), revenueCents: Number(t.revenue) })),
    drawer: {
      openingFloatCents: drawer.openingFloatCents,
      cashSalesCents: drawer.cashSalesCents,
      cashRefundsCents: drawer.cashRefundsCents,
      paidInCents: drawer.paidInCents,
      paidOutCents: drawer.paidOutCents,
      expectedCents: drawer.expectedCents,
      openedAt: drawerSession.openedAt,
    },
  });
});

export interface ReportTxn {
  at: string;
  number: string;
  customer: string | null;
  description: string;
  method: string | null;
  /** money in is positive; money out (refunds, payouts, trade-ins, credit spent) is negative */
  amountCents: number;
  note: string | null;
}

/**
 * Every line behind the summary, grouped the way the shop thinks about the day:
 * repairs (ticket payments and deposits), sales (devices and custom items),
 * accessories (parts and accessories sold), payouts (register cash out and in),
 * trade-ins (cash or credit), and credits (every store-credit movement).
 */
reportsRouter.get('/transactions', async (req, res) => {
  const db = await getDb();
  const storeId = req.session!.storeId;
  const { start } = rangeBounds(String(req.query.range ?? 'today'));
  const groups: Record<'repairs' | 'sales' | 'accessories' | 'payouts' | 'tradeins' | 'credits', ReportTxn[]> = {
    repairs: [], sales: [], accessories: [], payouts: [], tradeins: [], credits: [],
  };

  // sale lines: each item on a completed sale or refund, with the sale's tenders
  const l = schema.saleLines;
  const t = schema.sales;
  const lines = await db
    .select({
      line: l,
      number: t.ticketNumber,
      at: t.completedAt,
      refund: t.refundOfSaleId,
      customer: schema.customers.name,
      itemKind: schema.inventoryItems.kind,
      methods: sql<string | null>`(select string_agg(distinct p.method, ', ') from payments p where p.sale_id = ${t.id})`,
    })
    .from(l)
    .innerJoin(t, eq(l.saleId, t.id))
    .leftJoin(schema.customers, eq(t.customerId, schema.customers.id))
    .leftJoin(schema.inventoryItems, eq(l.inventoryItemId, schema.inventoryItems.id))
    .where(and(eq(t.storeId, storeId), inArray(t.status, ['completed', 'refunded']), isNotNull(t.completedAt), gte(t.completedAt, start)))
    .orderBy(desc(t.completedAt));
  for (const r of lines) {
    const net = r.line.netCents ?? r.line.qty * r.line.unitCents - r.line.discountCents;
    const row: ReportTxn = {
      at: r.at!.toISOString(),
      number: r.number,
      customer: r.customer,
      description: (r.line.qty > 1 ? `${r.line.qty} × ` : '') + r.line.description,
      method: r.methods,
      amountCents: net + (r.line.taxCents ?? 0),
      note: r.refund != null ? 'Refund' : null,
    };
    if (r.line.kind === 'repair') groups.repairs.push(row);
    else if (r.line.kind === 'deposit') groups.credits.push({ ...row, note: 'Deposit held as store credit' });
    else if (r.line.kind === 'product' && (r.itemKind === 'accessory' || r.itemKind === 'part')) groups.accessories.push(row);
    else groups.sales.push(row);
  }

  // repair deposits and deposit refunds taken straight on a ticket
  const p = schema.payments;
  const deposits = await db
    .select({ p, number: schema.repairTickets.number, customer: schema.customers.name })
    .from(p)
    .innerJoin(schema.repairTickets, eq(p.ticketId, schema.repairTickets.id))
    .leftJoin(schema.customers, eq(schema.repairTickets.customerId, schema.customers.id))
    .where(and(eq(schema.repairTickets.storeId, storeId), isNull(p.saleId), gte(p.createdAt, start)))
    .orderBy(desc(p.createdAt));
  for (const r of deposits) {
    groups.repairs.push({
      at: r.p.createdAt.toISOString(), number: r.number, customer: r.customer,
      description: r.p.amountCents < 0 ? 'Repair deposit refunded' : 'Repair deposit', method: r.p.method, amountCents: r.p.amountCents, note: null,
    });
  }

  // register cash movements
  const m = schema.cashMovements;
  const moves = await db
    .select({ m })
    .from(m)
    .innerJoin(schema.drawerSessions, eq(m.drawerSessionId, schema.drawerSessions.id))
    .where(and(eq(schema.drawerSessions.storeId, storeId), inArray(m.kind, ['paid_in', 'paid_out', 'tradein_payout', 'drop']), gte(m.createdAt, start)))
    .orderBy(desc(m.createdAt));
  for (const { m: r } of moves) {
    const row: ReportTxn = {
      at: r.createdAt.toISOString(),
      number: r.number ?? 'CASH-' + String(r.id).padStart(4, '0'),
      customer: null,
      description: r.kind === 'paid_out' ? 'Cash paid out' : r.kind === 'paid_in' ? 'Cash paid in' : r.kind === 'drop' ? 'Cash drop to safe' : 'Trade-in paid in cash',
      method: 'cash',
      amountCents: r.kind === 'paid_in' ? r.amountCents : -r.amountCents,
      note: [r.reason, r.source === 'back_office' ? 'from back office' : null].filter(Boolean).join(' · ') || null,
    };
    if (r.kind === 'tradein_payout') groups.tradeins.push(row);
    else groups.payouts.push(row);
  }

  // store credit: every movement, and trade-ins paid as credit also count as trade-ins
  const c = schema.storeCreditLedger;
  const credits = await db
    .select({ c, customer: schema.customers.name })
    .from(c)
    .innerJoin(schema.customers, eq(c.customerId, schema.customers.id))
    .innerJoin(schema.users, eq(c.userId, schema.users.id))
    .where(and(eq(schema.users.storeId, storeId), gte(c.createdAt, start)))
    .orderBy(desc(c.createdAt));
  for (const r of credits) {
    const row: ReportTxn = {
      at: r.c.createdAt.toISOString(),
      number: r.c.number ?? 'CREDIT-' + String(r.c.id).padStart(4, '0'),
      customer: r.customer,
      description: r.c.reason,
      method: 'store_credit',
      amountCents: r.c.deltaCents,
      note: r.c.deltaCents >= 0 ? 'Credit issued' : 'Credit spent',
    };
    groups.credits.push(row);
    if (r.c.reason.startsWith('Trade-in') && r.c.saleId == null) {
      groups.tradeins.push({ ...row, description: 'Trade-in paid as store credit', note: r.c.reason, amountCents: -r.c.deltaCents });
    }
  }

  for (const key of Object.keys(groups) as Array<keyof typeof groups>) groups[key].sort((a, b) => b.at.localeCompare(a.at));
  const totals = Object.fromEntries(
    (Object.keys(groups) as Array<keyof typeof groups>).map((k) => [k, { count: groups[k].length, cents: groups[k].reduce((s, r) => s + r.amountCents, 0) }]),
  );
  res.json({ range: String(req.query.range ?? 'today'), groups, totals });
});
