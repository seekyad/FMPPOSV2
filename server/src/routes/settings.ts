import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit } from '../util';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

/** Public-ish store config every screen needs (tax rate, name). */
settingsRouter.get('/store', async (req, res) => {
  const db = await getDb();
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  if (!store) {
    res.status(404).json({ error: 'Store not found' });
    return;
  }
  res.json(store);
});

settingsRouter.put('/store', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).max(120).optional(),
      address: z.string().max(200).nullable().optional(),
      phone: z.string().max(30).nullable().optional(),
      taxRateBp: z.number().int().min(0).max(3000).optional(),
      receiptHeader: z.string().max(200).nullable().optional(),
      receiptFooter: z.string().max(300).nullable().optional(),
      settings: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid settings', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  // merge the settings bag rather than replacing it
  const [current] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const merged = body.data.settings
    ? { ...((current?.settings ?? {}) as object), ...body.data.settings }
    : undefined;
  const [row] = await db
    .update(schema.stores)
    .set({ ...body.data, ...(merged ? { settings: merged } : {}) })
    .where(eq(schema.stores.id, req.session!.storeId))
    .returning();
  await audit(db, req, 'settings.store.update', 'store', req.session!.storeId, body.data);
  res.json(row);
});

/** Staff management. */
settingsRouter.get('/staff', async (req, res) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      initials: schema.users.initials,
      role: schema.users.role,
      isTechnician: schema.users.isTechnician,
      active: schema.users.active,
    })
    .from(schema.users)
    .where(eq(schema.users.storeId, req.session!.storeId))
    .orderBy(asc(schema.users.name));
  res.json(rows);
});

settingsRouter.post('/staff', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).max(80),
      pin: z.string().regex(/^\d{4}$/),
      role: z.enum(['employee', 'manager']).default('employee'),
      isTechnician: z.boolean().default(false),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Name and a 4-digit PIN required' });
    return;
  }
  const db = await getDb();
  const initials = body.data.name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const [row] = await db
    .insert(schema.users)
    .values({
      storeId: req.session!.storeId,
      name: body.data.name,
      initials,
      pinHash: bcrypt.hashSync(body.data.pin, 8),
      role: body.data.role,
      isTechnician: body.data.isTechnician,
    })
    .returning();
  await audit(db, req, 'staff.create', 'user', row!.id);
  res.json({ id: row!.id, name: row!.name, role: row!.role });
});

settingsRouter.patch('/staff/:id', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).max(80).optional(),
      pin: z.string().regex(/^\d{4}$/).optional(),
      role: z.enum(['employee', 'manager']).optional(),
      isTechnician: z.boolean().optional(),
      active: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid fields' });
    return;
  }
  const db = await getDb();
  const { pin, ...rest } = body.data;
  const [row] = await db
    .update(schema.users)
    .set({ ...rest, ...(pin ? { pinHash: bcrypt.hashSync(pin, 8) } : {}) })
    .where(eq(schema.users.id, Number(req.params.id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await audit(db, req, 'staff.update', 'user', row.id, { ...rest, pinChanged: Boolean(pin) });
  res.json({ id: row.id, name: row.name, role: row.role, active: row.active });
});
