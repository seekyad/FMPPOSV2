import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import type { Request } from 'express';
import type { Db } from './db/index';
import { auditLog, sales } from './db/schema';

/** Sale ticket numbers look like the design's "#0901-014": MMDD-<seq of the day>. */
export async function nextTicketNumber(db: Db, storeId: number): Promise<string> {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [row] = await db
    .select({ n: count() })
    .from(sales)
    .where(and(eq(sales.storeId, storeId), gte(sales.createdAt, dayStart)));
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const seq = String((row?.n ?? 0) + 1).padStart(3, '0');
  return `${mmdd}-${seq}`;
}

export async function audit(
  db: Db,
  req: Request,
  action: string,
  entity?: string,
  entityId?: number,
  detail?: unknown,
) {
  await db.insert(auditLog).values({
    storeId: req.session?.storeId,
    userId: req.session?.id,
    action,
    entity,
    entityId,
    detail: detail as never,
  });
}

/** Broadcast a realtime event to every terminal of a store. */
export function emitStore(req: Request, event: string, payload?: unknown) {
  const io = req.app.get('io') as SocketServer | undefined;
  io?.to(`store:${req.session?.storeId}`).emit(event, payload);
}

/** Send a print job to the store's print bridge; returns false when no bridge is online. */
export function emitBridge(req: Request, payload: unknown): boolean {
  const io = req.app.get('io') as SocketServer | undefined;
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`bridge:${req.session?.storeId}`);
  if (!room || room.size === 0) return false;
  io.to(`bridge:${req.session?.storeId}`).emit('print-job', payload);
  return true;
}

export const nowSql = sql`now()`;
