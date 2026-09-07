import { Router } from 'express';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit, emitStore } from '../util';

export const drawerRouter = Router();
drawerRouter.use(requireAuth);

const DEFAULT_FLOAT_CENTS = 20000;

/** Today's open drawer session, created on first cash activity. */
export async function getOpenDrawer(db: Db, storeId: number, openedBy?: number) {
  const [open] = await db
    .select()
    .from(schema.drawerSessions)
    .where(and(eq(schema.drawerSessions.storeId, storeId), isNull(schema.drawerSessions.closedAt)))
    .orderBy(desc(schema.drawerSessions.openedAt));
  if (open) return open;
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  const settings = (store?.settings ?? {}) as { drawerFloatCents?: number };
  const [created] = await db
    .insert(schema.drawerSessions)
    .values({
      storeId,
      openingFloatCents: settings.drawerFloatCents ?? DEFAULT_FLOAT_CENTS,
      openedBy: openedBy ?? null,
    })
    .returning();
  return created!;
}

/** Cash totals for a session, from payments + movements since it opened. */
export async function drawerExpectation(db: Db, storeId: number, session: typeof schema.drawerSessions.$inferSelect) {
  const since = session.openedAt;
  const [cashRow] = await db
    .select({
      cashIn: sql<number>`coalesce(sum(case when p.amount_cents > 0 then p.amount_cents else 0 end), 0)`,
      cashOut: sql<number>`coalesce(sum(case when p.amount_cents < 0 then -p.amount_cents else 0 end), 0)`,
    })
    .from(sql`payments p`)
    .where(
      sql`p.method = 'cash' and p.created_at >= ${since} and (
        (p.sale_id is not null and exists (select 1 from sales s where s.id = p.sale_id and s.store_id = ${storeId}))
        or (p.ticket_id is not null and exists (select 1 from repair_tickets t where t.id = p.ticket_id and t.store_id = ${storeId}))
      )`,
    );
  const movements = await db
    .select()
    .from(schema.cashMovements)
    .where(eq(schema.cashMovements.drawerSessionId, session.id));
  const paidIn = movements.filter((m) => m.kind === 'paid_in').reduce((s, m) => s + m.amountCents, 0);
  const paidOut = movements
    .filter((m) => m.kind === 'paid_out' || m.kind === 'tradein_payout' || m.kind === 'drop')
    .reduce((s, m) => s + m.amountCents, 0);
  const cashSales = Number(cashRow?.cashIn ?? 0);
  const cashRefunds = Number(cashRow?.cashOut ?? 0);
  return {
    openingFloatCents: session.openingFloatCents,
    cashSalesCents: cashSales,
    cashRefundsCents: cashRefunds,
    paidInCents: paidIn,
    paidOutCents: paidOut,
    expectedCents: session.openingFloatCents + cashSales + paidIn - cashRefunds - paidOut,
    movements,
  };
}

drawerRouter.get('/', async (req, res) => {
  const db = await getDb();
  const session = await getOpenDrawer(db, req.session!.storeId, req.session!.id);
  const expectation = await drawerExpectation(db, req.session!.storeId, session);
  res.json({ session, ...expectation });
});

/** Paid in / paid out / no-sale open — all audited. */
drawerRouter.post('/movement', async (req, res) => {
  const body = z
    .object({
      kind: z.enum(['paid_in', 'paid_out', 'no_sale_open', 'drop']),
      amountCents: z.number().int().min(0),
      reason: z.string().min(2).max(300),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'kind, amount and reason required' });
    return;
  }
  const db = await getDb();
  const session = await getOpenDrawer(db, req.session!.storeId, req.session!.id);
  const [row] = await db
    .insert(schema.cashMovements)
    .values({ drawerSessionId: session.id, ...body.data, userId: req.session!.id })
    .returning();
  await audit(db, req, `drawer.${body.data.kind}`, 'cash_movement', row!.id, body.data);
  emitStore(req, 'drawer-changed');
  res.json(row);
});

/** Close the drawer: counted vs expected, then clear leftover parked sales. */
drawerRouter.post('/close', requireRole('manager'), async (req, res) => {
  const body = z.object({ countedCents: z.number().int().min(0) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'countedCents required' });
    return;
  }
  const db = await getDb();
  const session = await getOpenDrawer(db, req.session!.storeId, req.session!.id);
  const expectation = await drawerExpectation(db, req.session!.storeId, session);
  const [closed] = await db
    .update(schema.drawerSessions)
    .set({
      countedCents: body.data.countedCents,
      expectedCents: expectation.expectedCents,
      closedBy: req.session!.id,
      closedAt: new Date(),
    })
    .where(eq(schema.drawerSessions.id, session.id))
    .returning();
  // end-of-day: parked sales clear
  await db
    .update(schema.sales)
    .set({ status: 'voided', parkedNote: 'Cleared at drawer close' })
    .where(and(eq(schema.sales.storeId, req.session!.storeId), eq(schema.sales.status, 'parked')));
  await audit(db, req, 'drawer.close', 'drawer_session', session.id, {
    counted: body.data.countedCents,
    expected: expectation.expectedCents,
    overShort: body.data.countedCents - expectation.expectedCents,
  });
  emitStore(req, 'sales-changed');
  emitStore(req, 'drawer-changed');
  res.json({ session: closed, ...expectation, overShortCents: body.data.countedCents - expectation.expectedCents });
});
