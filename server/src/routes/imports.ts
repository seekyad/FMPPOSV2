import express from 'express';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createRouter as Router } from '../http';
import { requireAuth, requireRole } from '../auth';
import { getDb, schema } from '../db/index';
import { audit } from '../util';

/**
 * One-time data import from the previous system (RepairStorePOS). A manager uploads the
 * payload produced from the old database dump; customers are matched by phone (or by name
 * when there is no phone) so re-running never duplicates them, and tickets whose number
 * already exists are skipped, so the import can be sent in chunks and retried safely.
 *
 * Mounted before the app-wide JSON parser: a chunk of a few hundred tickets is larger than
 * the 1 MB body limit every other route lives under.
 */
export const importsRouter = Router();
importsRouter.use(express.json({ limit: '40mb' }));
importsRouter.use(requireAuth, requireRole('manager'));

const STATUSES = ['open', 'in_progress', 'waiting_part', 'completed', 'picked_up', 'cancelled', 'abandoned'] as const;
const METHODS = ['cash', 'card', 'tap', 'zelle', 'cash_app'] as const;

const payloadSchema = z.object({
  version: z.literal(1),
  customers: z.array(z.object({
    key: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    phone: z.string().max(40).nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
    createdAt: z.string().datetime().nullable().optional(),
  })).max(5000),
  tickets: z.array(z.object({
    number: z.string().min(1).max(40),
    customerKey: z.string().min(1).max(120),
    status: z.enum(STATUSES),
    createdAt: z.string().datetime().nullable().optional(),
    completedAt: z.string().datetime().nullable().optional(),
    notesForTech: z.string().max(4000).nullable().optional(),
    paid: z.object({
      amountCents: z.number().int().min(1),
      method: z.enum(METHODS),
      at: z.string().datetime().nullable().optional(),
    }).nullable().optional(),
    devices: z.array(z.object({
      label: z.string().min(1).max(200),
      imei: z.string().max(60).nullable().optional(),
      passcode: z.string().max(120).nullable().optional(),
      notes: z.string().max(4000).nullable().optional(),
      lines: z.array(z.object({ description: z.string().min(1).max(300), priceCents: z.number().int().min(0) })).max(20),
    })).min(1).max(20),
    history: z.array(z.object({
      status: z.enum(STATUSES),
      note: z.string().max(600).nullable().optional(),
      at: z.string().datetime().nullable().optional(),
    })).max(200),
  })).max(500),
});

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
/** Customers match on phone digits; a phoneless walk-in matches on the exact name. */
const customerMatchKey = (name: string, phone: string | null | undefined) => {
  const d = digits(phone);
  return d ? `p:${d}` : `n:${name.trim().toLowerCase()}`;
};
const when = (s: string | null | undefined) => (s ? new Date(s) : new Date());

importsRouter.post('/legacy', async (req, res) => {
  const body = payloadSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Import file is not in the expected format', detail: body.error.issues.slice(0, 5) });
    return;
  }
  const storeId = req.session!.storeId;
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const counts = { customersCreated: 0, customersMatched: 0, ticketsCreated: 0, ticketsSkipped: 0 };
    const skipped: string[] = [];

    const existing = await tx
      .select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone })
      .from(schema.customers)
      .where(isNull(schema.customers.mergedInto));
    const known = new Map<string, number>();
    for (const c of existing) {
      const k = customerMatchKey(c.name, c.phone);
      if (!known.has(k)) known.set(k, c.id);
    }
    const keyToId = new Map<string, number>();
    for (const c of body.data.customers) {
      const k = customerMatchKey(c.name, c.phone);
      let id = known.get(k);
      if (id) {
        counts.customersMatched++;
      } else {
        const [row] = await tx
          .insert(schema.customers)
          .values({ name: c.name.trim(), phone: c.phone?.trim() || null, note: c.note?.trim() || null, createdAt: when(c.createdAt) })
          .returning();
        id = row!.id;
        known.set(k, id);
        counts.customersCreated++;
      }
      keyToId.set(c.key, id);
    }

    const numbers = body.data.tickets.map((t) => t.number.trim());
    const taken = new Set(
      numbers.length
        ? (await tx.select({ number: schema.repairTickets.number }).from(schema.repairTickets).where(inArray(schema.repairTickets.number, numbers))).map((r) => r.number)
        : [],
    );

    for (const t of body.data.tickets) {
      const number = t.number.trim();
      if (taken.has(number)) {
        counts.ticketsSkipped++;
        continue;
      }
      const customerId = keyToId.get(t.customerKey);
      if (!customerId) {
        counts.ticketsSkipped++;
        skipped.push(`${number}: customer ${t.customerKey} not in this file`);
        continue;
      }
      const totalCents = t.devices.reduce((s, d) => s + d.lines.reduce((x, l) => x + l.priceCents, 0), 0);
      const [ticket] = await tx
        .insert(schema.repairTickets)
        .values({
          storeId,
          number,
          customerId,
          status: t.status,
          totalCents,
          notesForTech: t.notesForTech?.trim() || null,
          completedAt: t.completedAt ? new Date(t.completedAt) : null,
          createdAt: when(t.createdAt),
        })
        .returning();
      taken.add(number);
      for (const d of t.devices) {
        const [device] = await tx
          .insert(schema.ticketDevices)
          .values({
            ticketId: ticket!.id,
            label: d.label.trim(),
            imei: d.imei?.trim() || null,
            unlockMethod: d.passcode ? 'passcode' : 'none',
            unlockValue: d.passcode?.trim() || null,
            conditionNotes: d.notes?.trim() || null,
          })
          .returning();
        if (d.lines.length) {
          await tx.insert(schema.ticketLines).values(
            d.lines.map((l) => ({ ticketId: ticket!.id, ticketDeviceId: device!.id, description: l.description.trim(), priceCents: l.priceCents, warrantyDays: 90 })),
          );
        }
      }
      const history = t.history.length ? t.history : [{ status: t.status, note: 'Imported from the previous system', at: t.createdAt ?? null }];
      await tx.insert(schema.ticketStatusHistory).values(
        history.map((h) => ({ ticketId: ticket!.id, status: h.status, note: h.note?.trim() || null, createdAt: when(h.at) })),
      );
      if (t.paid) {
        // a deposit-style ticket payment brings the balance to zero without inventing a register sale
        await tx.insert(schema.payments).values({
          ticketId: ticket!.id,
          method: t.paid.method,
          amountCents: t.paid.amountCents,
          isDeposit: true,
          createdAt: when(t.paid.at),
        });
      }
      counts.ticketsCreated++;
    }

    return { ...counts, skipped: skipped.slice(0, 50) };
  });
  await audit(db, req, 'import.legacy', 'store', storeId, { ...result, skipped: result.skipped.length, tickets: body.data.tickets.length, customers: body.data.customers.length });
  res.json(result);
});


/**
 * Supplier parts cost sheet: one stock item per device model and part type, with the supplier
 * price as cost. Models missing from the catalog are created (brand + name, case-insensitive
 * match); a part that already exists for that model and name only gets its cost refreshed, so
 * the sheet can be re-imported whenever prices change without duplicating stock rows.
 */
const partsSchema = z.object({
  version: z.literal(1),
  kind: z.literal('parts'),
  source: z.string().max(200).optional(),
  models: z.array(z.object({
    brand: z.string().min(1).max(60),
    family: z.string().max(60).nullable().optional(),
    name: z.string().min(1).max(120),
    kind: z.enum(['phone', 'tablet', 'watch', 'laptop', 'other']).default('phone'),
  })).max(2000),
  parts: z.array(z.object({
    brand: z.string().min(1).max(60),
    model: z.string().min(1).max(120),
    part: z.string().min(1).max(120),
    note: z.string().max(60).nullable().optional(),
    costCents: z.number().int().min(0),
  })).max(20000),
});

/** Short SKU from brand, model and part, e.g. PRT-IPHONE15PRO-SOFTOLEDSC. Uniqueness comes from model + name, not the SKU. */
function partSku(model: string, part: string, note: string | null | undefined): string {
  const squash = (s: string, n: number) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, n);
  return ['PRT', squash(model, 14), squash(part, 10) + (note ? squash(note, 4) : '')].join('-');
}

importsRouter.post('/parts', async (req, res) => {
  const body = partsSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Parts file is not in the expected format', detail: body.error.issues.slice(0, 5) });
    return;
  }
  const storeId = req.session!.storeId;
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const counts = { modelsCreated: 0, modelsMatched: 0, partsCreated: 0, partsUpdated: 0, partsUnchanged: 0 };
    const skipped: string[] = [];
    const modelKey = (brand: string, name: string) => `${brand.trim().toLowerCase()}|${name.trim().toLowerCase()}`;

    const existingModels = await tx.select().from(schema.deviceModels);
    const modelIds = new Map<string, number>(existingModels.map((m) => [modelKey(m.brand, m.name), m.id]));
    for (const m of body.data.models) {
      const key = modelKey(m.brand, m.name);
      if (modelIds.has(key)) {
        counts.modelsMatched++;
        continue;
      }
      const [row] = await tx.insert(schema.deviceModels).values({ brand: m.brand.trim(), family: m.family?.trim() || null, name: m.name.trim(), kind: m.kind }).returning();
      modelIds.set(key, row!.id);
      counts.modelsCreated++;
    }

    const existingParts = await tx
      .select({ id: schema.inventoryItems.id, modelId: schema.inventoryItems.modelId, name: schema.inventoryItems.name, costCents: schema.inventoryItems.costCents })
      .from(schema.inventoryItems)
      .where(and(eq(schema.inventoryItems.storeId, storeId), eq(schema.inventoryItems.kind, 'part'), sql`${schema.inventoryItems.status} <> 'removed'`));
    const partByKey = new Map(existingParts.map((p) => [`${p.modelId}|${p.name.toLowerCase()}`, p]));

    for (const p of body.data.parts) {
      const modelId = modelIds.get(modelKey(p.brand, p.model));
      if (!modelId) {
        skipped.push(`${p.brand} ${p.model} · ${p.part}: model not in file or catalog`);
        continue;
      }
      const name = `${p.model.trim()} ${p.part.trim()}${p.note ? ` (${p.note.trim()})` : ''}`;
      const found = partByKey.get(`${modelId}|${name.toLowerCase()}`);
      if (found) {
        if (found.costCents === p.costCents) {
          counts.partsUnchanged++;
        } else {
          await tx.update(schema.inventoryItems).set({ costCents: p.costCents }).where(eq(schema.inventoryItems.id, found.id));
          counts.partsUpdated++;
        }
        continue;
      }
      const [row] = await tx
        .insert(schema.inventoryItems)
        .values({ storeId, kind: 'part', name, sku: partSku(p.model, p.part, p.note), modelId, qty: 0, costCents: p.costCents, priceCents: 0, taxable: false })
        .returning();
      partByKey.set(`${modelId}|${name.toLowerCase()}`, { id: row!.id, modelId, name, costCents: p.costCents });
      counts.partsCreated++;
    }
    return { ...counts, skipped: skipped.slice(0, 50) };
  });
  await audit(db, req, 'import.parts', 'store', storeId, { ...result, skipped: result.skipped.length, source: body.data.source ?? null });
  res.json(result);
});
