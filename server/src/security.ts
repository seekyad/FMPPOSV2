import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from './db/index';

export interface CodeApproval {
  /** the manager whose PIN approved, or null when the store admin code was used */
  approverId: number | null;
  via: 'admin_code' | 'manager_pin';
}

/** The store's admin code lives hashed in the settings bag; it is never returned to clients. */
export async function adminCodeHash(db: Db, storeId: number): Promise<string | null> {
  const [store] = await db.select({ settings: schema.stores.settings }).from(schema.stores).where(eq(schema.stores.id, storeId));
  const security = ((store?.settings ?? {}) as { security?: { adminCodeHash?: unknown } }).security;
  return typeof security?.adminCodeHash === 'string' ? security.adminCodeHash : null;
}

/**
 * Approve a sensitive action with a code typed at the register: the store admin
 * code, or any active manager's PIN. Returns who approved, or null when the code
 * matches nothing. Callers rate-limit before calling this.
 */
export async function verifyManagerCode(db: Db, storeId: number, code: string): Promise<CodeApproval | null> {
  const hash = await adminCodeHash(db, storeId);
  if (hash && (await bcrypt.compare(code, hash))) return { approverId: null, via: 'admin_code' };
  const managers = await db
    .select({ id: schema.users.id, pinHash: schema.users.pinHash })
    .from(schema.users)
    .where(and(eq(schema.users.storeId, storeId), eq(schema.users.role, 'manager'), eq(schema.users.active, true)));
  for (const m of managers) if (await bcrypt.compare(code, m.pinHash)) return { approverId: m.id, via: 'manager_pin' };
  return null;
}
