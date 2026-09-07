import { getDb } from './index';
import { runMigrations } from './migrate';
import { seedIfEmpty } from './seed';

const db = await getDb();
await runMigrations(db);
const seeded = await seedIfEmpty(db);
console.log(seeded ? 'Seeded demo data.' : 'Database not empty — left untouched.');
process.exit(0);
