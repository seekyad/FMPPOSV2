import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role, SessionUser } from '@fmp/shared';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-render-env';
const SESSION_HOURS = 14; // covers a full shift; PIN switch issues a fresh token

export function signSession(user: SessionUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
}

export function verifySession(token: string): SessionUser {
  return jwt.verify(token, JWT_SECRET) as SessionUser;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  try {
    req.session = verifySession(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    if (role === 'manager' && req.session.role !== 'manager') {
      res.status(403).json({ error: 'Manager approval required' });
      return;
    }
    next();
  };
}
