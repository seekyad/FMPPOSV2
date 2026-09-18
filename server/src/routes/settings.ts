import bcrypt from 'bcryptjs';
import { createRouter as Router } from '../http';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit } from '../util';
import { publicStore, settingsPatchSchema } from '../store-settings';
import { adminCodeHash, verifyManagerCode } from '../security';
import { allowAuthAttempt } from '../pairing';

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
  res.json(publicStore(store, req.session!.role === 'manager'));
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
      settings: settingsPatchSchema.optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid settings', detail: body.error.flatten() });
    return;
  }
  const db = await getDb();
  // merge the settings bag rather than replacing it
  const [current] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const paymentPatch = body.data.settings?.dejavoo;
  if (paymentPatch) {
    const previous = ((current?.settings as Record<string, unknown>)?.dejavoo ?? {}) as Record<string, unknown>;
    const { authKey, clearAuthKey, ...fields } = paymentPatch;
    const paymentSettings = { ...previous, ...fields, authKey: clearAuthKey ? '' : authKey || (typeof previous.authKey === 'string' ? previous.authKey : '') };
    body.data.settings!.dejavoo = paymentSettings;
  }
  const merged = body.data.settings
    ? { ...((current?.settings ?? {}) as object), ...body.data.settings }
    : undefined;
  const [row] = await db
    .update(schema.stores)
    .set({ ...body.data, ...(merged ? { settings: merged } : {}) })
    .where(eq(schema.stores.id, req.session!.storeId))
    .returning();
  await audit(db, req, 'settings.store.update', 'store', req.session!.storeId, {
    fields: Object.keys(body.data).filter(key => key !== 'settings'),
    settingsSections: Object.keys(body.data.settings ?? {}), paymentCredentialsChanged: Boolean(paymentPatch),
  });
  res.json(publicStore(row!, true));
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
  const initials = rest.name ? rest.name.trim().split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase() : undefined;
  const [row] = await db
    .update(schema.users)
    .set({ ...rest, ...(initials ? { initials } : {}), ...(pin ? { pinHash: await bcrypt.hash(pin, 10) } : {}), ...((pin || rest.active !== undefined || rest.role !== undefined) ? { sessionVersion: sql`${schema.users.sessionVersion} + 1` } : {}) })
    .where(and(eq(schema.users.id, Number(req.params.id)), eq(schema.users.storeId, req.session!.storeId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (pin || rest.active !== undefined || rest.role !== undefined) req.app.get('io')?.in('user:' + row.id).disconnectSockets(true);
  await audit(db, req, 'staff.update', 'user', row.id, { ...rest, pinChanged: Boolean(pin) });
  res.json({ id: row.id, name: row.name, role: row.role, active: row.active });
});

/** Delete a staff member for good. Anyone with sales, tickets or drawer history keeps it and must be deactivated instead. */
settingsRouter.delete('/staff/:id', requireRole('manager'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session!.id) { res.status(400).json({ error: 'You cannot delete your own sign-in' }); return; }
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.storeId, req.session!.storeId)));
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  try {
    await db.delete(schema.users).where(eq(schema.users.id, id));
  } catch {
    res.status(409).json({ error: `${user.name} has sales, tickets or drawer history and can only be deactivated` });
    return;
  }
  req.app.get('io')?.in('user:' + id).disconnectSockets(true);
  await audit(db, req, 'staff.delete', 'user', id, { name: user.name, role: user.role });
  res.json({ ok: true });
});

/** Whether the store has an admin code (never the code itself). */
settingsRouter.get('/admin-code', requireRole('manager'), async (req, res) => {
  const db = await getDb();
  res.json({ set: (await adminCodeHash(db, req.session!.storeId)) !== null });
});

/**
 * Set or change the store admin code. Once a code exists, changing it takes the
 * current code or the signed-in manager's own PIN, so a walk-up at an unlocked
 * register can't quietly swap it.
 */
settingsRouter.put('/admin-code', requireRole('manager'), async (req, res) => {
  const body = z.object({
    currentCode: z.string().regex(/^\d{4,6}$/).optional().nullable(),
    newCode: z.string().regex(/^\d{4,6}$/),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'The admin code is 4 to 6 digits' }); return; }
  const db = await getDb();
  const storeId = req.session!.storeId;
  const existing = await adminCodeHash(db, storeId);
  if (existing) {
    if (!body.data.currentCode) { res.status(403).json({ error: 'Enter the current admin code or your manager PIN' }); return; }
    if (!(await allowAuthAttempt('admin-code:' + storeId, 10))) { res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }); return; }
    const [self] = await db.select({ pinHash: schema.users.pinHash }).from(schema.users).where(eq(schema.users.id, req.session!.id));
    const ok = (await bcrypt.compare(body.data.currentCode, existing)) || (self ? await bcrypt.compare(body.data.currentCode, self.pinHash) : false);
    if (!ok) { res.status(403).json({ error: 'That code is not the current admin code or your PIN' }); return; }
  }
  const [store] = await db.select({ settings: schema.stores.settings }).from(schema.stores).where(eq(schema.stores.id, storeId));
  const settings = { ...((store?.settings ?? {}) as Record<string, unknown>) };
  settings.security = { ...((settings.security as Record<string, unknown> | undefined) ?? {}), adminCodeHash: await bcrypt.hash(body.data.newCode, 10) };
  await db.update(schema.stores).set({ settings }).where(eq(schema.stores.id, storeId));
  await audit(db, req, existing ? 'security.admin_code_changed' : 'security.admin_code_set', 'store', storeId);
  res.json({ set: true });
});

/** Check a code without acting on it — lets screens confirm an approval before a long form. */
settingsRouter.post('/admin-code/verify', async (req, res) => {
  const body = z.object({ code: z.string().regex(/^\d{4,6}$/) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'Code required' }); return; }
  if (!(await allowAuthAttempt('verify-code:' + req.session!.storeId, 20))) { res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }); return; }
  const approval = await verifyManagerCode(await getDb(), req.session!.storeId, body.data.code);
  if (!approval) { res.status(403).json({ error: 'Wrong code' }); return; }
  res.json({ ok: true, via: approval.via });
});
