import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit } from '../util';

/** Settings: device models, repair types, service catalog pricing. Reads for all staff, writes for managers. */
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

catalogRouter.get('/repair-types', async (_req, res) => {
  const db = await getDb();
  res.json(
    await db.select().from(schema.repairTypes).orderBy(asc(schema.repairTypes.category), asc(schema.repairTypes.sortOrder)),
  );
});

catalogRouter.post('/repair-types', requireRole('manager'), async (req, res) => {
  const body = z.object({ category: z.string().min(1).max(60), name: z.string().min(1).max(120) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'category and name required' });
    return;
  }
  const db = await getDb();
  const [row] = await db.insert(schema.repairTypes).values(body.data).returning();
  res.json(row);
});

/** Full pricing grid for one model. */
catalogRouter.get('/services', async (req, res) => {
  const db = await getDb();
  const modelId = Number(req.query.modelId);
  const rows = modelId
    ? await db.select().from(schema.serviceCatalog).where(eq(schema.serviceCatalog.modelId, modelId))
    : await db.select().from(schema.serviceCatalog);
  res.json(rows);
});

/** Upsert one model × repair-type price row. */
catalogRouter.put('/services', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      modelId: z.number().int(),
      repairTypeId: z.number().int(),
      priceCents: z.number().int().min(0),
      partCostCents: z.number().int().min(0).default(0),
      laborCents: z.number().int().min(0).default(0),
      warrantyDays: z.number().int().min(0).default(90),
      turnaroundMinutes: z.number().int().min(0).default(120),
      partItemId: z.number().int().nullable().optional(),
      active: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid service row', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  const existing = await db
    .select()
    .from(schema.serviceCatalog)
    .where(eq(schema.serviceCatalog.modelId, body.data.modelId));
  const match = existing.find((r) => r.repairTypeId === body.data.repairTypeId);
  const [row] = match
    ? await db.update(schema.serviceCatalog).set(body.data).where(eq(schema.serviceCatalog.id, match.id)).returning()
    : await db.insert(schema.serviceCatalog).values(body.data).returning();
  await audit(db, req, 'catalog.service.upsert', 'service_catalog', row!.id, body.data);
  res.json(row);
});
