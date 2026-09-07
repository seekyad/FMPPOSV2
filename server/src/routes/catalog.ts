import { Router } from 'express';
import { asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit } from '../util';

/** Settings: device models + the service catalog (services with price tiers). */
export const catalogRouter = Router();
catalogRouter.use(requireAuth);

catalogRouter.get('/models', async (_req, res) => {
  const db = await getDb();
  res.json(await db.select().from(schema.deviceModels).orderBy(asc(schema.deviceModels.brand), asc(schema.deviceModels.name)));
});

catalogRouter.post('/models', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      brand: z.string().min(1).max(60),
      name: z.string().min(1).max(120),
      kind: z.enum(['phone', 'tablet', 'watch', 'laptop', 'other']).default('phone'),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'brand and name required' });
    return;
  }
  const db = await getDb();
  const [row] = await db.insert(schema.deviceModels).values(body.data).returning();
  await audit(db, req, 'catalog.model.create', 'device_model', row!.id);
  res.json(row);
});

catalogRouter.patch('/models/:id', requireRole('manager'), async (req, res) => {
  const body = z
    .object({ brand: z.string().min(1).optional(), name: z.string().min(1).optional(), active: z.boolean().optional() })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid fields' });
    return;
  }
  const db = await getDb();
  const [row] = await db
    .update(schema.deviceModels)
    .set(body.data)
    .where(eq(schema.deviceModels.id, Number(req.params.id)))
    .returning();
  res.json(row);
});

/** Services with tiers and 30-day performed counts. */
catalogRouter.get('/services', async (_req, res) => {
  const db = await getDb();
  const rows = await db.select().from(schema.services).orderBy(asc(schema.services.category), asc(schema.services.name));
  const tiers = await db.select().from(schema.serviceTiers).orderBy(asc(schema.serviceTiers.sortOrder));
  const last30 = new Date(Date.now() - 30 * 86400_000);
  const performed = await db
    .select({ serviceId: schema.ticketLines.serviceId, n: sql<number>`count(*)` })
    .from(schema.ticketLines)
    .innerJoin(schema.repairTickets, eq(schema.ticketLines.ticketId, schema.repairTickets.id))
    .where(gte(schema.repairTickets.createdAt, last30))
    .groupBy(schema.ticketLines.serviceId);
  const performedMap = new Map(performed.map((p) => [p.serviceId, Number(p.n)]));
  res.json(
    rows.map((s) => ({
      ...s,
      tiers: tiers.filter((t) => t.serviceId === s.id),
      performed30d: performedMap.get(s.id) ?? 0,
    })),
  );
});

const serviceBody = z.object({
  category: z.string().min(1).max(60),
  name: z.string().min(1).max(150),
  deviceGroup: z.string().min(1).max(80).default('Any device'),
  timeMinutes: z.number().int().min(0).default(45),
  timeLabel: z.string().max(30).nullable().optional(),
  partsCostCents: z.number().int().min(0).default(0),
  basePriceCents: z.number().int().min(0),
  warrantyDays: z.number().int().min(0).default(90),
  intakeNotes: z.string().max(2000).nullable().optional(),
  partItemId: z.number().int().nullable().optional(),
  active: z.boolean().default(true),
  tiers: z
    .array(z.object({ label: z.string().min(1).max(80), priceCents: z.number().int().min(0) }))
    .max(20)
    .default([]),
});

async function writeTiers(db: Awaited<ReturnType<typeof getDb>>, serviceId: number, tiers: Array<{ label: string; priceCents: number }>) {
  await db.delete(schema.serviceTiers).where(eq(schema.serviceTiers.serviceId, serviceId));
  if (tiers.length > 0) {
    await db.insert(schema.serviceTiers).values(tiers.map((t, i) => ({ ...t, serviceId, sortOrder: i })));
  }
}

catalogRouter.post('/services', requireRole('manager'), async (req, res) => {
  const body = serviceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid service', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const { tiers, ...data } = body.data;
  const [row] = await db.insert(schema.services).values(data).returning();
  await writeTiers(db, row!.id, tiers);
  await audit(db, req, 'catalog.service.create', 'service', row!.id);
  res.json(row);
});

catalogRouter.put('/services/:id', requireRole('manager'), async (req, res) => {
  const body = serviceBody.partial().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid service', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const { tiers, ...data } = body.data;
  const [row] = await db.update(schema.services).set(data).where(eq(schema.services.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: 'Service not found' });
    return;
  }
  if (tiers) await writeTiers(db, id, tiers);
  await audit(db, req, 'catalog.service.update', 'service', id, data);
  res.json(row);
});

catalogRouter.post('/services/:id/duplicate', requireRole('manager'), async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [original] = await db.select().from(schema.services).where(eq(schema.services.id, id));
  if (!original) {
    res.status(404).json({ error: 'Service not found' });
    return;
  }
  const { id: _id, createdAt: _c, ...rest } = original;
  const [copy] = await db.insert(schema.services).values({ ...rest, name: `${original.name} (copy)` }).returning();
  const tiers = await db.select().from(schema.serviceTiers).where(eq(schema.serviceTiers.serviceId, id));
  if (tiers.length > 0) {
    await db.insert(schema.serviceTiers).values(tiers.map((t) => ({ serviceId: copy!.id, label: t.label, priceCents: t.priceCents, sortOrder: t.sortOrder })));
  }
  await audit(db, req, 'catalog.service.duplicate', 'service', copy!.id, { from: id });
  res.json(copy);
});

/**
 * Bulk data import (spreadsheet upload): upserts device models, services,
 * and per-device price tiers. Matching is by name so re-importing an updated
 * sheet applies changes instead of duplicating.
 */
catalogRouter.post('/import', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      devices: z
        .array(z.object({ brand: z.string().min(1), name: z.string().min(1), kind: z.string().optional() }))
        .max(2000)
        .default([]),
      services: z
        .array(
          z.object({
            name: z.string().min(1),
            category: z.string().min(1),
            deviceGroup: z.string().optional(),
            timeMinutes: z.number().int().min(0).optional(),
            partsCostCents: z.number().int().min(0).optional(),
            basePriceCents: z.number().int().min(0).optional(),
            warrantyDays: z.number().int().min(0).optional(),
          }),
        )
        .max(500)
        .default([]),
      pricing: z
        .array(
          z.object({
            serviceName: z.string().min(1),
            tierLabel: z.string().min(1),
            priceCents: z.number().int().min(0),
            partsCostCents: z.number().int().min(0).optional(),
          }),
        )
        .max(10000)
        .default([]),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid import payload', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const counts = { devicesCreated: 0, devicesUpdated: 0, servicesCreated: 0, servicesUpdated: 0, tiersWritten: 0 };

  const kindFor = (raw?: string): 'phone' | 'tablet' | 'watch' | 'laptop' | 'other' => {
    const k = (raw ?? '').toLowerCase();
    if (k.includes('tablet') || k.includes('ipad')) return 'tablet';
    if (k.includes('watch')) return 'watch';
    if (k.includes('laptop') || k.includes('book')) return 'laptop';
    if (k.includes('phone') || k === '') return 'phone';
    return 'other';
  };

  const existingModels = await db.select().from(schema.deviceModels);
  const modelKey = (b: string, n: string) => `${b.toLowerCase()}|${n.toLowerCase()}`;
  const modelMap = new Map(existingModels.map((m) => [modelKey(m.brand, m.name), m]));
  for (const d of body.data.devices) {
    const found = modelMap.get(modelKey(d.brand, d.name));
    if (found) {
      counts.devicesUpdated++;
    } else {
      const [row] = await db
        .insert(schema.deviceModels)
        .values({ brand: d.brand.trim(), name: d.name.trim(), kind: kindFor(d.kind) })
        .returning();
      modelMap.set(modelKey(d.brand, d.name), row!);
      counts.devicesCreated++;
    }
  }

  const existingServices = await db.select().from(schema.services);
  const serviceMap = new Map(existingServices.map((s) => [s.name.toLowerCase(), s]));
  for (const s of body.data.services) {
    const found = serviceMap.get(s.name.toLowerCase());
    const values = {
      category: s.category.trim(),
      deviceGroup: s.deviceGroup?.trim() || 'Any device',
      ...(s.timeMinutes != null ? { timeMinutes: s.timeMinutes } : {}),
      ...(s.partsCostCents != null ? { partsCostCents: s.partsCostCents } : {}),
      ...(s.basePriceCents != null ? { basePriceCents: s.basePriceCents } : {}),
      ...(s.warrantyDays != null ? { warrantyDays: s.warrantyDays } : {}),
    };
    if (found) {
      await db.update(schema.services).set(values).where(eq(schema.services.id, found.id));
      counts.servicesUpdated++;
    } else {
      const [row] = await db
        .insert(schema.services)
        .values({ name: s.name.trim(), basePriceCents: s.basePriceCents ?? 0, ...values })
        .returning();
      serviceMap.set(s.name.toLowerCase(), row!);
      counts.servicesCreated++;
    }
  }

  // pricing rows replace the tier set per touched service
  const byService = new Map<number, Array<{ label: string; priceCents: number }>>();
  for (const p of body.data.pricing) {
    const service = serviceMap.get(p.serviceName.toLowerCase());
    if (!service) continue;
    if (!byService.has(service.id)) byService.set(service.id, []);
    byService.get(service.id)!.push({ label: p.tierLabel.trim(), priceCents: p.priceCents });
  }
  for (const [serviceId, tiers] of byService) {
    await db.delete(schema.serviceTiers).where(eq(schema.serviceTiers.serviceId, serviceId));
    for (let i = 0; i < tiers.length; i += 500) {
      await db
        .insert(schema.serviceTiers)
        .values(tiers.slice(i, i + 500).map((t, j) => ({ ...t, serviceId, sortOrder: i + j })));
    }
    counts.tiersWritten += tiers.length;
    // base price = cheapest tier when tiers exist
    const min = Math.min(...tiers.map((t) => t.priceCents));
    if (Number.isFinite(min) && min > 0) {
      await db.update(schema.services).set({ basePriceCents: min }).where(eq(schema.services.id, serviceId));
    }
  }

  await audit(db, req, 'catalog.import', undefined, undefined, counts);
  res.json({ ok: true, ...counts });
});

/** Bulk price update: raise/lower base prices and tiers by a percentage. */
catalogRouter.post('/services/bulk-price', requireRole('manager'), async (req, res) => {
  const body = z
    .object({ percent: z.number().min(-90).max(500), serviceIds: z.array(z.number().int()).min(1) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'percent and serviceIds required' });
    return;
  }
  const db = await getDb();
  const factor = 1 + body.data.percent / 100;
  const targets = await db.select().from(schema.services).where(inArray(schema.services.id, body.data.serviceIds));
  for (const s of targets) {
    await db
      .update(schema.services)
      .set({ basePriceCents: Math.round((s.basePriceCents * factor) / 100) * 100 })
      .where(eq(schema.services.id, s.id));
  }
  const tierRows = await db.select().from(schema.serviceTiers).where(inArray(schema.serviceTiers.serviceId, body.data.serviceIds));
  for (const t of tierRows) {
    await db
      .update(schema.serviceTiers)
      .set({ priceCents: Math.round((t.priceCents * factor) / 100) * 100 })
      .where(eq(schema.serviceTiers.id, t.id));
  }
  await audit(db, req, 'catalog.bulk_price', undefined, undefined, body.data);
  res.json({ ok: true, updated: targets.length });
});
