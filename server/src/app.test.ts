import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from './app';
import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { seedIfEmpty } from './db/seed';

process.env.PGLITE_MEMORY = '1';

let app: Express;
let deviceToken = '';

beforeAll(async () => {
  const db = await getDb();
  await runMigrations(db);
  await seedIfEmpty(db);
  app = createApp();
}, 60_000);

describe('health & auth flow', () => {
  it('responds to health check', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('lists stores', async () => {
    const res = await request(app).get('/api/auth/stores');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Cedar Park #3');
  });

  it('registers a terminal', async () => {
    const stores = await request(app).get('/api/auth/stores');
    const res = await request(app)
      .post('/api/auth/terminal/register')
      .send({ storeId: stores.body[0].id, name: 'Front counter' });
    expect(res.status).toBe(200);
    expect(res.body.deviceToken).toHaveLength(48);
    deviceToken = res.body.deviceToken;
  });

  it('lists staff for the PIN pad', async () => {
    const res = await request(app).get('/api/auth/staff').query({ deviceToken });
    expect(res.status).toBe(200);
    expect(res.body.staff.map((s: { name: string }) => s.name)).toContain('Mike K.');
  });

  it('rejects a wrong PIN', async () => {
    const staff = await request(app).get('/api/auth/staff').query({ deviceToken });
    const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
    const res = await request(app)
      .post('/api/auth/pin')
      .send({ deviceToken, userId: mike.id, pin: '9999' });
    expect(res.status).toBe(401);
  });

  it('signs in with the right PIN and returns a manager session', async () => {
    const staff = await request(app).get('/api/auth/staff').query({ deviceToken });
    const mike = staff.body.staff.find((s: { name: string }) => s.name === 'Mike K.');
    const res = await request(app)
      .post('/api/auth/pin')
      .send({ deviceToken, userId: mike.id, pin: '1234' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('manager');
  });
});
