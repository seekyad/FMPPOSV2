import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from './db/index';
import { HttpError } from './http';

/** Shared customers are intentional. Operational references must belong to the acting store. */
export async function requireStoreReferences(db: Db, storeId: number, refs: {
  inventoryIds?: Array<number | null | undefined>;
  ticketIds?: Array<number | null | undefined>;
  userIds?: Array<number | null | undefined>;
}) {
  const groups = [
    [schema.inventoryItems, refs.inventoryIds],
    [schema.repairTickets, refs.ticketIds],
    [schema.users, refs.userIds],
  ] as const;
  for (const [table, values] of groups) {
    const ids = [...new Set((values ?? []).filter((id): id is number => id != null))];
    if (!ids.length) continue;
    const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.storeId, storeId), inArray(table.id, ids)));
    if (rows.length !== ids.length) throw new HttpError(404, 'Referenced record not found in this store');
  }
}
