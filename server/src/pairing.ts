import crypto from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { getDb, schema, type Db } from './db/index';
import { HttpError } from './http';

export const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const normalizePairingCode = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();

export async function issuePairing(db: Db, storeId: number, kind: 'pos' | 'bridge', createdBy?: number) {
  const [store] = await db.select({ id: schema.stores.id }).from(schema.stores).where(eq(schema.stores.id, storeId));
  if (!store) throw new HttpError(404, 'Store not found');
  const code = crypto.randomBytes(16).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await db.insert(schema.terminalPairings).values({ storeId, kind, codeHash: hashToken(code), expiresAt, createdBy });
  return { pairingCode: code.match(/.{4}/g)!.join('-'), expiresAt, kind };
}

/** A conditional UPDATE claims each code once, even across concurrent app instances. */
export async function redeemPairing(code: string, name: string, kind: 'pos' | 'bridge' = 'pos') {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [pairing] = await tx.update(schema.terminalPairings).set({ usedAt: new Date() }).where(and(
      eq(schema.terminalPairings.codeHash, hashToken(normalizePairingCode(code))),
      eq(schema.terminalPairings.kind, kind), isNull(schema.terminalPairings.usedAt), gt(schema.terminalPairings.expiresAt, new Date()),
    )).returning();
    if (!pairing) throw new HttpError(401, 'Pairing code is invalid, expired or already used');
    if (pairing.createdBy) {
      const [issuer] = await tx.select().from(schema.users).where(and(eq(schema.users.id, pairing.createdBy),
        eq(schema.users.storeId, pairing.storeId), eq(schema.users.active, true), eq(schema.users.role, 'manager')));
      if (!issuer) throw new HttpError(401, 'Pairing approval is no longer valid');
    }
    const deviceToken = crypto.randomBytes(24).toString('hex');
    const [terminal] = await tx.insert(schema.terminals).values({
      storeId: pairing.storeId, name, kind: pairing.kind, deviceToken: hashToken(deviceToken),
    }).returning();
    await tx.insert(schema.auditLog).values({ storeId: pairing.storeId, userId: pairing.createdBy,
      action: 'terminal.paired', entity: 'terminal', entityId: terminal!.id, detail: { kind: pairing.kind, name } });
    return { terminalId: terminal!.id, storeId: terminal!.storeId, kind: terminal!.kind, deviceToken };
  });
}

export async function findDevice(token: string, kind: 'pos' | 'bridge') {
  const db = await getDb();
  const [device] = await db.select().from(schema.terminals).where(and(
    eq(schema.terminals.deviceToken, hashToken(token)), eq(schema.terminals.kind, kind), eq(schema.terminals.revoked, false),
  ));
  return device;
}

/** Persistent fixed-window limits also apply across process restarts. Keys contain no raw credential. */
export async function allowAuthAttempt(key: string, limit: number) {
  const db = await getDb();
  const now = new Date();
  await db.delete(schema.authThrottle).where(lt(schema.authThrottle.expiresAt, now));
  const [row] = await db.insert(schema.authThrottle).values({
    key: hashToken(key), attempts: 1, expiresAt: new Date(Date.now() + 15 * 60_000),
  }).onConflictDoUpdate({ target: schema.authThrottle.key, set: { attempts: sql`${schema.authThrottle.attempts} + 1` } }).returning();
  return row!.attempts <= limit;
}
