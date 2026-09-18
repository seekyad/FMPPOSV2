import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { issuePairing } from './pairing';
import { validateProductionConfig } from './security-config';

async function main() {
  const { values } = parseArgs({ options: {
    store: { type: 'string' }, manager: { type: 'string' },
    'store-id': { type: 'string' }, kind: { type: 'string', default: 'pos' },
  } });
  validateProductionConfig();
  const db = await getDb();
  await runMigrations(db);
  let storeId = Number(values['store-id']);
  if (values.store) {
    const pin = process.env.FMP_BOOTSTRAP_PIN;
    delete process.env.FMP_BOOTSTRAP_PIN;
    if (!values.manager?.trim() || !pin || !/^\d{4}$/.test(pin)) {
      throw new Error('Provide --manager and a four-digit FMP_BOOTSTRAP_PIN environment value');
    }
    const name = values.store.trim();
    if (!name || name.length > 120) throw new Error('Store name must contain 1–120 characters');
    const [existing] = await db.select().from(schema.stores).where(eq(schema.stores.name, name));
    if (existing) throw new Error('Store name already exists; use --store-id to pair an existing store');
    const pinHash = await bcrypt.hash(pin, 10);
    storeId = await db.transaction(async tx => {
      const [store] = await tx.insert(schema.stores).values({ name }).returning();
      await tx.insert(schema.users).values({ storeId: store!.id, name: values.manager!.trim(),
        initials: values.manager!.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase(), role: 'manager', pinHash });
      await tx.insert(schema.auditLog).values({ storeId: store!.id, action: 'store.bootstrap', entity: 'store',
        entityId: store!.id, detail: { source: 'host-admin-cli' } });
      return store!.id;
    });
  }
  if (!Number.isSafeInteger(storeId) || storeId < 1) throw new Error('Provide --store and --manager, or --store-id');
  if (values.kind !== 'pos' && values.kind !== 'bridge') throw new Error('--kind must be pos or bridge');
  const pairing = await issuePairing(db, storeId, values.kind);
  console.log(JSON.stringify({ storeId, ...pairing }, null, 2));
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
