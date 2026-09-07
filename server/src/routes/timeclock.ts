import { Router } from 'express';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { audit } from '../util';

export const timeclockRouter = Router();
timeclockRouter.use(requireAuth);

const TWELVE_HOURS = 12 * 3600_000;

/** My open entry (if any) + recent entries; managers get everyone's. */
timeclockRouter.get('/', async (req, res) => {
  const db = await getDb();
  const since = new Date(Date.now() - 14 * 86400_000);
  const isManager = req.session!.role === 'manager';
  const rows = await db
    .select({ entry: schema.timeEntries, userName: schema.users.name })
    .from(schema.timeEntries)
    .innerJoin(schema.users, eq(schema.timeEntries.userId, schema.users.id))
    .where(
      and(
        gte(schema.timeEntries.clockIn, since),
        isManager ? undefined : eq(schema.timeEntries.userId, req.session!.id),
        eq(schema.users.storeId, req.session!.storeId),
      ),
    )
    .orderBy(desc(schema.timeEntries.clockIn))
    .limit(200);
  // auto-flag forgotten clock-outs
  for (const r of rows) {
    if (!r.entry.clockOut && !r.entry.flagged && Date.now() - r.entry.clockIn.getTime() > TWELVE_HOURS) {
      await db.update(schema.timeEntries).set({ flagged: true }).where(eq(schema.timeEntries.id, r.entry.id));
      r.entry.flagged = true;
    }
  }
  const [myOpen] = await db
    .select()
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.userId, req.session!.id), isNull(schema.timeEntries.clockOut)));
  res.json({ entries: rows.map((r) => ({ ...r.entry, userName: r.userName })), openEntry: myOpen ?? null });
});

timeclockRouter.post('/clock-in', async (req, res) => {
  const db = await getDb();
  const [open] = await db
    .select()
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.userId, req.session!.id), isNull(schema.timeEntries.clockOut)));
  if (open) {
    res.status(400).json({ error: 'Already clocked in' });
    return;
  }
  const [row] = await db
    .insert(schema.timeEntries)
    .values({ userId: req.session!.id, clockIn: new Date() })
    .returning();
  res.json(row);
});

timeclockRouter.post('/clock-out', async (req, res) => {
  const db = await getDb();
  const [open] = await db
    .select()
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.userId, req.session!.id), isNull(schema.timeEntries.clockOut)));
  if (!open) {
    res.status(400).json({ error: 'Not clocked in' });
    return;
  }
  const [row] = await db
    .update(schema.timeEntries)
    .set({ clockOut: new Date() })
    .where(eq(schema.timeEntries.id, open.id))
    .returning();
  res.json(row);
});

/** Manager edit of an entry — audited, with a note. */
timeclockRouter.patch('/:id', requireRole('manager'), async (req, res) => {
  const body = z
    .object({
      clockIn: z.string().datetime().optional(),
      clockOut: z.string().datetime().nullable().optional(),
      editNote: z.string().min(2).max(300),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'An edit note is required' });
    return;
  }
  const db = await getDb();
  const id = Number(req.params.id);
  const [row] = await db
    .update(schema.timeEntries)
    .set({
      ...(body.data.clockIn ? { clockIn: new Date(body.data.clockIn) } : {}),
      ...(body.data.clockOut !== undefined
        ? { clockOut: body.data.clockOut ? new Date(body.data.clockOut) : null }
        : {}),
      editedBy: req.session!.id,
      editNote: body.data.editNote,
      flagged: false,
    })
    .where(eq(schema.timeEntries.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'Entry not found' });
    return;
  }
  await audit(db, req, 'timeclock.edit', 'time_entry', id, body.data);
  res.json(row);
});
