import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from './app';
import { getDb } from './db/index';
import { runMigrations } from './db/migrate';

process.env.PGLITE_MEMORY = '1';

let app: Express;

beforeAll(async () => {
  await runMigrations(await getDb());
  app = createApp();
});

describe('print bridge installer', () => {
  it('serves the installer with the request host baked in', async () => {
    const res = await request(app).get('/bridge/install.ps1').set('Host', 'www.fmppos.com');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain("'https://www.fmppos.com'");
    expect(res.text).not.toContain('__SERVER_URL__');
    expect(res.text).toContain('/bridge/files/');
  });

  it('uses plain http for a local dev host', async () => {
    const res = await request(app).get('/bridge/install.ps1').set('Host', 'localhost:3001');
    expect(res.text).toContain("'http://localhost:3001'");
  });

  it('serves only the allow-listed bridge files', async () => {
    const index = await request(app).get('/bridge/files/src/index.js');
    expect(index.status).toBe(200);
    expect(index.text).toContain('socket.io-client');
    const pkg = await request(app).get('/bridge/files/package.json');
    expect(pkg.status).toBe(200);
    expect(JSON.parse(pkg.text).name).toBe('bridge');
    for (const forbidden of ['config.json', 'install.ps1', '..%2Fserver%2Fpackage.json']) {
      const res = await request(app).get(`/bridge/files/${forbidden}`);
      expect(res.status, forbidden).toBe(404);
    }
    // a client that collapses the dots lands on the app shell, never on a server file
    for (const dotted of ['/bridge/files/../server/package.json', '/bridge/files/src/../../server/src/index.ts']) {
      const collapsed = await request(app).get(dotted);
      expect(collapsed.text, dotted).not.toContain('"name": "server"');
      expect(collapsed.text, dotted).not.toContain('createApp');
    }
  });
});
