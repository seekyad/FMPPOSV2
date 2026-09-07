import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { customersRouter } from './routes/customers';
import { drawerRouter } from './routes/drawer';
import { inventoryRouter } from './routes/inventory';
import { repairsRouter } from './routes/repairs';
import { reportsRouter } from './routes/reports';
import { salesRouter } from './routes/sales';
import { settingsRouter } from './routes/settings';
import { terminalRouter } from './routes/terminal';
import { timeclockRouter } from './routes/timeclock';
import { tradeinRouter } from './routes/tradein';

/** Express app without the HTTP listener so tests can drive it with supertest. */
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '2.0.0' }));
  app.use('/api/auth', authRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/sales', salesRouter);
  app.use('/api/repairs', repairsRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/drawer', drawerRouter);
  app.use('/api/tradein', tradeinRouter);
  app.use('/api/timeclock', timeclockRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/terminal', terminalRouter);

  // Production: serve the built repair-pos SPA.
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const spaDist = path.resolve(dirname, '../../apps/repair-pos/dist');
  app.use(express.static(spaDist));
  app.get(/^\/(?!api\/).*/, (_req, res, next) => {
    res.sendFile(path.join(spaDist, 'index.html'), (err) => (err ? next() : undefined));
  });

  return app;
}
