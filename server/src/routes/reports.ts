import { Router } from 'express';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
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
      inArray(schema.sales.status, ['completed', 'refunded']),
      isNotNull(schema.sales.completedAt),
      gte(schema.sales.completedAt, from),
      to ? lt(schema.sales.completedAt, to) : undefined,
    );

  const [gross] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.sales.totalCents}), 0)`,
      positives: sql<number>`count(*) filter (where ${schema.sales.totalCents} > 0)`,
    })
    .from(schema.sales)
    .where(completedIn(start));
  const [prevGross] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.sales.totalCents}), 0)` })
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
      balance: sql<number>`coalesce(sum(${schema.repairTickets.totalCents} - coalesce((select sum(p.amount_cents) from payments p where p.ticket_id = ${schema.repairTickets.id}), 0)), 0)`,
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
      revenue: sql<number>`coalesce(sum(${schema.saleLines.qty} * ${schema.saleLines.unitCents} - ${schema.saleLines.discountCents}), 0)`,
    })
    .from(schema.saleLines)
    .innerJoin(schema.sales, eq(schema.saleLines.saleId, schema.sales.id))
    .leftJoin(schema.inventoryItems, eq(schema.saleLines.inventoryItemId, schema.inventoryItems.id))
    .where(completedIn(start))
    .groupBy(schema.saleLines.kind, schema.inventoryItems.kind);
  const revenueByCategory = { repairs: 0, devices: 0, accessories: 0, other: 0 };
  for (const row of categoryRows) {
    const r = Number(row.revenue);
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
