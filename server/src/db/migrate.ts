import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Apply pending SQL migrations with the migrator that matches the active driver. */
export async function runMigrations(db: Db) {
  if (process.env.DATABASE_URL) {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as never, { migrationsFolder });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder });
  }
}
