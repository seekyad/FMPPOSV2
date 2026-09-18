import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Role, SessionUser } from '@fmp/shared';
import { getDb, schema } from './db/index';
import { sessionSecret } from './security-config';

const claimsSchema = z.object({
  id: z.number().int().positive(), name: z.string(), role: z.enum(['employee', 'manager']),
  storeId: z.number().int().positive(), terminalId: z.number().int().positive(), sessionVersion: z.number().int().nonnegative(),
});

export function signSession(user: SessionUser, sessionVersion = 0): string {
  return jwt.sign(claimsSchema.parse({ ...user, sessionVersion }), sessionSecret(), { algorithm: 'HS256', expiresIn: '14h' });
}

export function verifySession(token: string) {
  return claimsSchema.parse(jwt.verify(token, sessionSecret(), { algorithms: ['HS256'] }));
}

/** Current DB authority supersedes the role and terminal claims in a JWT. */
export async function authenticateSession(token: string): Promise<SessionUser | null> {
  let claims: ReturnType<typeof verifySession>;
  try { claims = verifySession(token); } catch { return null; }
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(and(
    eq(schema.users.id, claims.id), eq(schema.users.storeId, claims.storeId),
    eq(schema.users.active, true), eq(schema.users.sessionVersion, claims.sessionVersion),
  ));
  if (!user) return null;
  const [terminal] = await db.select().from(schema.terminals).where(and(
    eq(schema.terminals.id, claims.terminalId), eq(schema.terminals.storeId, claims.storeId),
    eq(schema.terminals.kind, 'pos'), eq(schema.terminals.revoked, false),
  ));
  return terminal ? { id: user.id, name: user.name, role: user.role, storeId: user.storeId, terminalId: terminal.id } : null;
}

declare global {
  namespace Express { interface Request { session?: SessionUser; } }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Not signed in' }); return; }
  void authenticateSession(header.slice(7)).then((user) => {
    if (!user) { res.status(401).json({ error: 'Session expired or access revoked' }); return; }
    req.session = user;
    next();
  }).catch(next);
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session) { res.status(401).json({ error: 'Not signed in' }); return; }
    if (role === 'manager' && req.session.role !== 'manager') {
      res.status(403).json({ error: 'Manager approval required' }); return;
    }
    next();
  };
}
