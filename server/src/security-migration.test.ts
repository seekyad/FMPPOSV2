import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { findDevice, hashToken } from './pairing';

process.env.DATABASE_URL = '';
process.env.PGLITE_MEMORY = '1';

it('upgrades legacy device credentials using the migration SQL without unpairing the register', async () => {
  const db = await getDb();
  await runMigrations(db);
  const [store] = await db.insert(schema.stores).values({ name: 'Legacy store' }).returning();
  const rawToken = 'a'.repeat(48);
  const [device] = await db.insert(schema.terminals).values({ storeId: store!.id, name: 'Legacy POS', deviceToken: rawToken }).returning();
  // Exercise the actual data-migration statement against a pre-upgrade credential row.
  const migration = await readFile(new URL('../drizzle/0008_noisy_hemingway.sql', import.meta.url), 'utf8');
  await db.execute(sql.raw(migration.split('--> statement-breakpoint').at(-1)!));
  const [saved] = await db.select().from(schema.terminals).where(eq(schema.terminals.id, device!.id));
  expect(saved!.deviceToken).toBe(hashToken(rawToken));
  expect((await findDevice(rawToken, 'pos'))?.id).toBe(device!.id);
}, 60_000);
