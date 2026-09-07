import { Router } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_TRADEIN_CONFIG, tradeInOffer, type TradeInCondition, type TradeInPayout } from '@fmp/shared';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit, emitStore } from '../util';
import { getOpenDrawer } from './drawer';

export const tradeinRouter = Router();
tradeinRouter.use(requireAuth);

/** Pricebook + condition config for the trade-in modal. */
tradeinRouter.get('/pricebook', async (req, res) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.tradeinPricebook.id,
      modelId: schema.tradeinPricebook.modelId,
      storage: schema.tradeinPricebook.storage,
      baseValueCents: schema.tradeinPricebook.baseValueCents,
      active: schema.tradeinPricebook.active,
      modelName: schema.deviceModels.name,
      brand: schema.deviceModels.brand,
    })
    .from(schema.tradeinPricebook)
    .innerJoin(schema.deviceModels, eq(schema.tradeinPricebook.modelId, schema.deviceModels.id))
    .orderBy(asc(schema.deviceModels.name), asc(schema.tradeinPricebook.storage));
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const settings = (store?.settings ?? {}) as { tradein?: typeof DEFAULT_TRADEIN_CONFIG };
  res.json({ rows, config: settings.tradein ?? DEFAULT_TRADEIN_CONFIG });
});

/** Manager: upsert a pricebook row. */
tradeinRouter.put('/pricebook', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      modelId: z.number().int(),
      storage: z.string().min(1).max(30),
      baseValueCents: z.number().int().min(0),
      active: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'modelId, storage and value required' });
    return;
  }
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(schema.tradeinPricebook)
    .where(
      and(eq(schema.tradeinPricebook.modelId, body.data.modelId), eq(schema.tradeinPricebook.storage, body.data.storage)),
    );
  const [row] = existing
    ? await db.update(schema.tradeinPricebook).set(body.data).where(eq(schema.tradeinPricebook.id, existing.id)).returning()
    : await db.insert(schema.tradeinPricebook).values(body.data).returning();
  await audit(db, req, 'tradein.pricebook.upsert', 'tradein_pricebook', row!.id, body.data);
  res.json(row);
});

/**
 * Execute a trade-in: device enters inventory (Trade-ins tab), payout leaves the
 * drawer as cash or lands on the customer as store credit (+bonus). Manual
 * overrides are audit-logged with the suggested value they replaced.
 */
tradeinRouter.post('/', async (req, res) => {
  const body = z
    .object({
      modelId: z.number().int(),
      storage: z.string().min(1).max(30),
      imei: z.string().max(20).optional().nullable(),
      condition: z.enum(['good', 'fair', 'broken']),
      payout: z.enum(['cash', 'credit']),
      customerId: z.number().int().optional().nullable(),
      manualOfferCents: z.number().int().min(0).optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid trade-in', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const data = body.data;

  if (data.payout === 'credit' && !data.customerId) {
    res.status(400).json({ error: 'Store credit needs a customer' });
    return;
  }

  const [model] = await db.select().from(schema.deviceModels).where(eq(schema.deviceModels.id, data.modelId));
  if (!model) {
    res.status(404).json({ error: 'Unknown device model' });
    return;
  }
  const [book] = await db
    .select()
    .from(schema.tradeinPricebook)
    .where(and(eq(schema.tradeinPricebook.modelId, data.modelId), eq(schema.tradeinPricebook.storage, data.storage)));

  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const settings = (store?.settings ?? {}) as { tradein?: typeof DEFAULT_TRADEIN_CONFIG };
  const config = settings.tradein ?? DEFAULT_TRADEIN_CONFIG;

  const suggested = book
    ? tradeInOffer(book.baseValueCents, data.condition as TradeInCondition, data.payout as TradeInPayout, config)
    : null;
  const offer = data.manualOfferCents ?? suggested;
  if (offer == null || offer <= 0) {
    res.status(400).json({ error: 'No pricebook value for this device — enter a manual offer' });
    return;
  }

  const grade = data.condition === 'good' ? 'A' : data.condition === 'fair' ? 'B' : 'C';
  const [item] = await db
    .insert(schema.inventoryItems)
    .values({
      storeId: req.session!.storeId,
      kind: 'device',
      name: model.name,
      modelId: model.id,
      imei: data.imei ?? null,
      storage: data.storage,
      conditionGrade: grade,
      carrier: null,
      fromTradeIn: true,
      qty: 1,
      costCents: offer,
      priceCents: 0,
      status: 'needs_intake',
    })
    .returning();
  await db.insert(schema.inventoryMovements).values({
    itemId: item!.id,
    deltaQty: 1,
    kind: 'receive',
    reason: 'trade-in',
    userId: req.session!.id,
  });

  if (data.payout === 'cash') {
    const session = await getOpenDrawer(db, req.session!.storeId, req.session!.id);
    await db.insert(schema.cashMovements).values({
      drawerSessionId: session.id,
      kind: 'tradein_payout',
      amountCents: offer,
      reason: `Trade-in ${model.name} ${data.storage}${data.imei ? ` · IMEI …${data.imei.slice(-5)}` : ''}`,
      userId: req.session!.id,
    });
  } else {
    await db
      .update(schema.customers)
      .set({ storeCreditCents: sql`${schema.customers.storeCreditCents} + ${offer}` })
      .where(eq(schema.customers.id, data.customerId!));
    await db.insert(schema.storeCreditLedger).values({
      customerId: data.customerId!,
      deltaCents: offer,
      reason: `Trade-in ${model.name} ${data.storage} (incl. credit bonus)`,
      userId: req.session!.id,
    });
  }

  await audit(db, req, 'tradein.accept', 'inventory_item', item!.id, {
    offer,
    suggested,
    manual: data.manualOfferCents != null,
    condition: data.condition,
    payout: data.payout,
  });
  emitStore(req, 'drawer-changed');
  res.json({ item, offerCents: offer, suggestedCents: suggested, manual: data.manualOfferCents != null });
});
