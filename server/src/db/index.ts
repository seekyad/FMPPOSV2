import * as schema from './schema';

/**
 * Database driver switch:
 * - Production (Render): DATABASE_URL set -> node-postgres.
 * - Local dev / tests: no DATABASE_URL -> embedded PGlite, persisted to ./pgdata
 *   (or in-memory when PGLITE_MEMORY=1, used by tests).
 */
export type Db = Awaited<ReturnType<typeof createDb>>;

let dbPromise: Promise<any> | null = null;

export async function createDb() {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
    });
    return drizzle(pool, { schema });
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client =
    process.env.PGLITE_MEMORY === '1' ? new PGlite() : new PGlite('./pgdata');
  return drizzle(client, { schema });
}

export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

export { schema };
