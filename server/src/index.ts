import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app';
import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';
import { isProduction, validateProductionConfig } from './security-config';
import { configureRealtime } from './realtime';

// Honor the platform-injected PORT only in production (Render); local dev tools
// also set PORT (for the Vite app), so the API pins to API_PORT / 3001 there.
const isProd = Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
const PORT = Number(process.env.API_PORT ?? (isProd ? process.env.PORT : undefined) ?? 3001);

async function main() {
  validateProductionConfig();
  const db = await getDb();
  await runMigrations(db);
  const seeded = !isProduction() && process.env.SEED_DEMO === '1' ? await seedIfEmpty(db) : false;
  if (seeded) console.log('Database seeded with demo data (PINs: Mike 1234, Sara 2345, Deon 3456)');

  const app = createApp();
  const server = http.createServer(app);

  // Realtime: store rooms for board/pending-sale sync and print-bridge dispatch.
  const io = new SocketServer(server, { cors: { origin: true } });
  configureRealtime(io);
  app.set('io', io);

  server.listen(PORT, () => console.log(`FMP POS server on http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
