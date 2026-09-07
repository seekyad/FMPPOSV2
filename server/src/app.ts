import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './routes/auth';

/** Express app without the HTTP listener so tests can drive it with supertest. */
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '2.0.0' }));
  app.use('/api/auth', authRouter);

  // Production: serve the built repair-pos SPA.
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const spaDist = path.resolve(dirname, '../../apps/repair-pos/dist');
  app.use(express.static(spaDist));
  app.get(/^\/(?!api\/).*/, (_req, res, next) => {
    res.sendFile(path.join(spaDist, 'index.html'), (err) => (err ? next() : undefined));
  });

  return app;
}
