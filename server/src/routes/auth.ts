import bcrypt from 'bcryptjs';
import { Router } from 'express';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { signSession } from '../auth';

export const authRouter = Router();

/**
 * Terminal registration: first launch on a device claims a terminal row.
 * The returned deviceToken is kept in localStorage and identifies the terminal.
 */
authRouter.post('/terminal/register', async (req, res) => {
  const body = z.object({ storeId: z.number().int(), name: z.string().min(1).max(60) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'storeId and name required' });
    return;
  }
  const db = await getDb();
  const deviceToken = crypto.randomBytes(24).toString('hex');
  const [terminal] = await db
    .insert(schema.terminals)
    .values({ storeId: body.data.storeId, name: body.data.name, deviceToken })
    .returning();
  res.json({ terminalId: terminal!.id, deviceToken });
});

/** List stores (for first-run terminal setup) and the staff of a terminal's store (for the PIN pad). */
authRouter.get('/stores', async (_req, res) => {
  const db = await getDb();
  const rows = await db.select({ id: schema.stores.id, name: schema.stores.name }).from(schema.stores);
  res.json(rows);
});

authRouter.get('/staff', async (req, res) => {
  const deviceToken = String(req.query.deviceToken ?? '');
  const db = await getDb();
  const [terminal] = await db
    .select()
    .from(schema.terminals)
    .where(and(eq(schema.terminals.deviceToken, deviceToken), eq(schema.terminals.revoked, false)));
  if (!terminal) {
    res.status(404).json({ error: 'Terminal not registered' });
    return;
  }
  const staff = await db
    .select({ id: schema.users.id, name: schema.users.name, initials: schema.users.initials, role: schema.users.role })
    .from(schema.users)
    .where(and(eq(schema.users.storeId, terminal.storeId), eq(schema.users.active, true)));
  res.json({ storeId: terminal.storeId, terminalId: terminal.id, staff });
});

/** PIN sign-in on a registered terminal -> session JWT. */
authRouter.post('/pin', async (req, res) => {
  const body = z
    .object({ deviceToken: z.string().min(10), userId: z.number().int(), pin: z.string().min(4).max(8) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'deviceToken, userId and pin required' });
    return;
  }
  const db = await getDb();
  const [terminal] = await db
    .select()
    .from(schema.terminals)
    .where(and(eq(schema.terminals.deviceToken, body.data.deviceToken), eq(schema.terminals.revoked, false)));
  if (!terminal) {
    res.status(401).json({ error: 'Terminal not registered' });
    return;
  }
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, body.data.userId), eq(schema.users.storeId, terminal.storeId), eq(schema.users.active, true)));
  if (!user || !bcrypt.compareSync(body.data.pin, user.pinHash)) {
    res.status(401).json({ error: 'Wrong PIN' });
    return;
  }
  await db
    .update(schema.terminals)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.terminals.id, terminal.id));
  const session = {
    id: user.id,
    name: user.name,
    role: user.role,
    storeId: terminal.storeId,
    terminalId: terminal.id,
  };
  res.json({ token: signSession(session), user: session });
});
