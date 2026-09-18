import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole, signSession } from '../auth';
import { createRouter as Router } from '../http';
import { allowAuthAttempt, findDevice, issuePairing, redeemPairing } from '../pairing';
import { audit } from '../util';

export const authRouter = Router();

authRouter.post('/terminal/register', async (req, res) => {
  if (!await allowAuthAttempt('pair:' + req.ip, 30)) { res.status(429).json({ error: 'Too many pairing attempts. Try again in 15 minutes.' }); return; }
  const body = z.object({ pairingCode: z.string().min(32).max(50), name: z.string().trim().min(1).max(60), kind: z.enum(['pos', 'bridge']).default('pos') }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'A pairing code and terminal name are required' }); return; }
  res.json(await redeemPairing(body.data.pairingCode, body.data.name, body.data.kind));
});

authRouter.post('/pairing', requireAuth, requireRole('manager'), async (req, res) => {
  const body = z.object({ kind: z.enum(['pos', 'bridge']) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'Choose a POS terminal or print bridge' }); return; }
  const db = await getDb();
  const pairing = await issuePairing(db, req.session!.storeId, body.data.kind, req.session!.id);
  await audit(db, req, 'terminal.pairing_issued', 'store', req.session!.storeId, { kind: body.data.kind });
  res.json(pairing);
});

authRouter.get('/terminals', requireAuth, requireRole('manager'), async (req, res) => {
  const db = await getDb();
  res.json(await db.select({ id: schema.terminals.id, name: schema.terminals.name, kind: schema.terminals.kind,
    revoked: schema.terminals.revoked, lastSeenAt: schema.terminals.lastSeenAt }).from(schema.terminals)
    .where(eq(schema.terminals.storeId, req.session!.storeId)));
});

authRouter.post('/terminals/:id/revoke', requireAuth, requireRole('manager'), async (req, res) => {
  const db = await getDb();
  const [terminal] = await db.update(schema.terminals).set({ revoked: true }).where(and(
    eq(schema.terminals.id, Number(req.params.id)), eq(schema.terminals.storeId, req.session!.storeId),
  )).returning();
  if (!terminal) { res.status(404).json({ error: 'Terminal not found' }); return; }
  req.app.get('io')?.in('terminal:' + terminal.id).disconnectSockets(true);
  await audit(db, req, 'terminal.revoked', 'terminal', terminal.id);
  res.json({ ok: true });
});

/** Store names are non-secret; pairing approval, not this list, grants access. */
authRouter.get('/stores', async (_req, res) => {
  const db = await getDb();
  res.json(await db.select({ id: schema.stores.id, name: schema.stores.name }).from(schema.stores));
});

authRouter.get('/staff', async (req, res) => {
  // Keep long-lived credentials out of proxy URL logs.
  const token = req.get('X-Device-Token') ?? '';
  const terminal = await findDevice(token, 'pos');
  if (!terminal) { res.status(404).json({ error: 'Terminal not registered or access revoked' }); return; }
  const db = await getDb();
  const staff = await db.select({ id: schema.users.id, name: schema.users.name, initials: schema.users.initials, role: schema.users.role })
    .from(schema.users).where(and(eq(schema.users.storeId, terminal.storeId), eq(schema.users.active, true)));
  res.json({ storeId: terminal.storeId, terminalId: terminal.id, staff });
});

authRouter.post('/pin', async (req, res) => {
  if (!await allowAuthAttempt('pin-ip:' + req.ip, 300)) { res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }); return; }
  const body = z.object({ deviceToken: z.string().min(10).max(100), userId: z.number().int().positive(), pin: z.string().regex(/^\d{4}$/) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'A registered device, staff member and four-digit PIN are required' }); return; }
  const terminal = await findDevice(body.data.deviceToken, 'pos');
  if (!terminal) { res.status(401).json({ error: 'Terminal not registered or access revoked' }); return; }
  const db = await getDb();
  if (!await allowAuthAttempt('pin-user:' + body.data.userId, 20)) { res.set('Retry-After', '900').status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }); return; }
  const [user] = await db.select().from(schema.users).where(and(eq(schema.users.id, body.data.userId),
    eq(schema.users.storeId, terminal.storeId), eq(schema.users.active, true)));
  if (!user || !await bcrypt.compare(body.data.pin, user.pinHash)) { res.status(401).json({ error: 'Wrong PIN' }); return; }
  await db.update(schema.terminals).set({ lastSeenAt: new Date() }).where(eq(schema.terminals.id, terminal.id));
  const session = { id: user.id, name: user.name, role: user.role, storeId: terminal.storeId, terminalId: terminal.id };
  res.json({ token: signSession(session, user.sessionVersion), user: session });
});
