import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import type { Request } from 'express';
import type { Db } from './db/index';
import { auditLog, documentCounters } from './db/schema';


/** Store/year-qualified identifiers use an atomic database counter and a UTC date. */
/** Every receipt, repair ticket, payout and trade-in in a store shares one series: S<store>-00001, S<store>-00002, … */
export const formatTransactionNumber = (storeId: number, value: number) => `S${storeId}-${String(value).padStart(5, '0')}`;
const transactionCounterKey = (storeId: number) => `TXN-${storeId}`;

/** Reserve the next transaction number for the store (atomic counter bump). */
export async function nextTicketNumber(db: Db, storeId: number): Promise<string> {
  const key = transactionCounterKey(storeId);
  const [row] = await db.insert(documentCounters).values({ key, value: 1 }).onConflictDoUpdate({
    target: documentCounters.key, set: { value: sql`${documentCounters.value} + 1` },
  }).returning();
  return formatTransactionNumber(storeId, row!.value);
}

/** Peek at the number the next reservation would get, without taking it. */
export async function peekTicketNumber(db: Db, storeId: number): Promise<string> {
  const [row] = await db.select().from(documentCounters).where(eq(documentCounters.key, transactionCounterKey(storeId)));
  return formatTransactionNumber(storeId, (row?.value ?? 0) + 1);
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
