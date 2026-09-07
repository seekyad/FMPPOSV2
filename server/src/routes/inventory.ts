import { Router } from 'express';
import { and, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit } from '../util';

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth);

/** Tabbed list: ?tab=phones|parts|accessories|tradeins|sold & ?query= */
inventoryRouter.get('/', async (req, res) => {
  const db = await getDb();
  const i = schema.inventoryItems;
  const tab = String(req.query.tab ?? 'phones');
  const q = String(req.query.query ?? '').trim();

  const tabWhere =
    tab === 'phones'
      ? and(eq(i.kind, 'device'), ne(i.status, 'sold'), ne(i.status, 'removed'), eq(i.fromTradeIn, false))
      : tab === 'parts'
        ? and(eq(i.kind, 'part'), ne(i.status, 'removed'))
        : tab === 'accessories'
          ? and(eq(i.kind, 'accessory'), ne(i.status, 'removed'))
          : tab === 'tradeins'
            ? and(eq(i.fromTradeIn, true), ne(i.status, 'sold'), ne(i.status, 'removed'))
            : eq(i.status, 'sold');

  const rows = await db
    .select()
    .from(i)
    .where(
      and(
        eq(i.storeId, req.session!.storeId),
        tabWhere,
        q ? or(ilike(i.name, `%${q}%`), ilike(i.imei, `%${q}%`), ilike(i.sku, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(i.receivedAt))
    .limit(300);

  const counts = await db
    .select({ kind: i.kind, fromTradeIn: i.fromTradeIn, status: i.status, n: sql<number>`count(*)` })
    .from(i)
    .where(eq(i.storeId, req.session!.storeId))
    .groupBy(i.kind, i.fromTradeIn, i.status);

  res.json({ rows, counts });
});

const itemBody = z.object({
  kind: z.enum(['device', 'part', 'accessory']),
  name: z.string().min(1).max(200),
  sku: z.string().max(60).optional().nullable(),
  modelId: z.number().int().optional().nullable(),
  imei: z.string().max(20).optional().nullable(),
  storage: z.string().max(30).optional().nullable(),
  conditionGrade: z.enum(['A', 'B', 'C']).optional().nullable(),
  carrier: z.string().max(40).optional().nullable(),
  qty: z.number().int().min(0).optional(),
  costCents: z.number().int().min(0).optional(),
  priceCents: z.number().int().min(0).optional(),
  taxable: z.boolean().optional(),
  status: z.enum(['in_stock', 'hold_repair', 'needs_intake']).optional(),
});

inventoryRouter.post('/', async (req, res) => {
  const body = itemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid item', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const [row] = await db
    .insert(schema.inventoryItems)
    .values({ ...body.data, storeId: req.session!.storeId })
    .returning();
  await db.insert(schema.inventoryMovements).values({
    itemId: row!.id,
    deltaQty: row!.qty,
    kind: 'receive',
    userId: req.session!.id,
  });
  await audit(db, req, 'inventory.create', 'inventory_item', row!.id);
  res.json(row);
});

inventoryRouter.patch('/:id', async (req, res) => {
  const body = itemBody.partial().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid fields' });
    return;
  }
  const db = await getDb();
  const [row] = await db
    .update(schema.inventoryItems)
    .set(body.data)
    .where(eq(schema.inventoryItems.id, Number(req.params.id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json(row);
});

/** Manager-only quantity adjustment with reason (shrinkage, correction). */
inventoryRouter.post('/:id/adjust', requireRole('manager'), async (req, res) => {
  const body = z.object({ deltaQty: z.number().int(), reason: z.string().min(2).max(300) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'deltaQty and reason required' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id));
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const newQty = item.qty + body.data.deltaQty;
  if (newQty < 0) {
    res.status(400).json({ error: 'Quantity cannot go below zero' });
    return;
  }
  const [row] = await db
    .update(schema.inventoryItems)
    .set({ qty: newQty })
    .where(eq(schema.inventoryItems.id, id))
    .returning();
  await db.insert(schema.inventoryMovements).values({
    itemId: id,
    deltaQty: body.data.deltaQty,
    kind: 'adjustment',
    reason: body.data.reason,
    userId: req.session!.id,
  });
  await audit(db, req, 'inventory.adjust', 'inventory_item', id, body.data);
  res.json(row);
});

/** Manager-only removal (item disappears from active tabs, kept for history). */
inventoryRouter.post('/:id/remove', requireRole('manager'), async (req, res) => {
  const body = z.object({ reason: z.string().min(2).max(300) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A reason is required to remove inventory' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [row] = await db
    .update(schema.inventoryItems)
    .set({ status: 'removed' })
    .where(eq(schema.inventoryItems.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  await db.insert(schema.inventoryMovements).values({
    itemId: id,
    deltaQty: -row.qty,
    kind: 'removal',
    reason: body.data.reason,
    userId: req.session!.id,
  });
  await audit(db, req, 'inventory.remove', 'inventory_item', id, body.data);
  res.json(row);
});

/** Receive a shipment: creates/tops-up items and a purchase record. */
inventoryRouter.post('/receive', async (req, res) => {
  const body = z
    .object({
      supplier: z.string().min(1).max(120),
      note: z.string().max(500).optional(),
      items: z
        .array(
          z.object({
            itemId: z.number().int().optional(),
            new: itemBody.optional(),
            qty: z.number().int().min(1),
            unitCostCents: z.number().int().min(0),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'supplier and items required' });
    return;
  }
  const db = await getDb();
  let totalCost = 0;
  const [purchase] = await db
    .insert(schema.purchases)
    .values({
      storeId: req.session!.storeId,
      supplier: body.data.supplier,
      note: body.data.note,
      receivedBy: req.session!.id,
    })
    .returning();
  for (const line of body.data.items) {
    totalCost += line.qty * line.unitCostCents;
    let itemId = line.itemId;
    if (!itemId && line.new) {
      const [created] = await db
        .insert(schema.inventoryItems)
        .values({ ...line.new, qty: 0, costCents: line.unitCostCents, storeId: req.session!.storeId })
        .returning();
      itemId = created!.id;
    }
    if (!itemId) continue;
    await db
      .update(schema.inventoryItems)
      .set({ qty: sql`${schema.inventoryItems.qty} + ${line.qty}`, costCents: line.unitCostCents })
      .where(eq(schema.inventoryItems.id, itemId));
    await db.insert(schema.inventoryMovements).values({
      itemId,
      deltaQty: line.qty,
      kind: 'receive',
      refId: purchase!.id,
      userId: req.session!.id,
    });
  }
  await db
    .update(schema.purchases)
    .set({ totalCostCents: totalCost })
    .where(eq(schema.purchases.id, purchase!.id));
  await audit(db, req, 'inventory.receive', 'purchase', purchase!.id, { totalCost });
  res.json({ ok: true, purchaseId: purchase!.id });
});
