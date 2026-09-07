import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app';
import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';

// Honor the platform-injected PORT only in production (Render); local dev tools
// also set PORT (for the Vite app), so the API pins to API_PORT / 3001 there.
const isProd = Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
const PORT = Number(process.env.API_PORT ?? (isProd ? process.env.PORT : undefined) ?? 3001);

async function main() {
  const db = await getDb();
  await runMigrations(db);
  const seeded = await seedIfEmpty(db);
  if (seeded) console.log('Database seeded with demo data (PINs: Mike 1234, Sara 2345, Deon 3456)');

  const app = createApp();
  const server = http.createServer(app);

  // Realtime: store rooms for board/pending-sale sync and print-bridge dispatch.
  const io = new SocketServer(server, { cors: { origin: true } });
  io.on('connection', (socket) => {
    socket.on('join-store', (storeId: number) => socket.join(`store:${storeId}`));
    socket.on('bridge-online', (storeId: number) => {
      socket.join(`bridge:${storeId}`);
      io.to(`store:${storeId}`).emit('bridge-status', { online: true });
    });
  });
  app.set('io', io);

  server.listen(PORT, () => console.log(`FMP POS server on http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
