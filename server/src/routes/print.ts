import { Router } from 'express';
import type { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth, requireRole } from '../auth';
import { receiptEscpos, receiptText, type ReceiptData } from '../receipts';
import { audit, emitBridge } from '../util';
import type { Server as SocketServer } from 'socket.io';

/* ------------------------------------------------------------------ */
/* Print-center settings, stored in the store's settings JSON bag      */
/* ------------------------------------------------------------------ */

export interface ReceiptPrefs {
  paper?: 80 | 58;
  store?: boolean;
  customer?: boolean;
  footer?: boolean;
  terms?: boolean;
  termsText?: string;
  kickDrawer?: boolean;
}

export interface TagPrefs {
  size?: '50x30' | '50x80';
  date?: boolean;
  ticket?: boolean;
  customer?: boolean;
  phone?: boolean;
  device?: boolean;
  repair?: boolean;
  passcode?: boolean;
  notes?: boolean;
  promise?: boolean;
  price?: boolean;
}

export interface PrintSettings {
  receipt?: ReceiptPrefs;
  tag?: TagPrefs;
}

export function printSettingsOf(store: { settings: unknown } | undefined): PrintSettings {
  return ((store?.settings as { print?: PrintSettings } | undefined)?.print ?? {}) as PrintSettings;
}

/** Apply the saved receipt prefs onto an already-built receipt. */
export function applyReceiptPrefs(r: ReceiptData, prefs: ReceiptPrefs | undefined): ReceiptData {
  const p = prefs ?? {};
  return {
    ...r,
    header: p.store === false ? '' : r.header,
    address: p.store === false ? null : r.address,
    phone: p.store === false ? null : r.phone,
    customer: p.customer === false ? null : r.customer,
    footer: p.footer === false ? null : r.footer,
    terms: p.terms && p.termsText ? p.termsText : null,
    paperWidth: p.paper === 58 ? 58 : 80,
    kickDrawer: p.kickDrawer !== false,
  };
}

/** Record a job in the Print center queue. Never throws — printing must not fail on logging. */
export async function logPrintJob(
  req: Request,
  job: { kind: 'receipt' | 'label'; name: string; detail?: string | null; printed: boolean; payload?: unknown },
) {
  try {
    const db = await getDb();
    await db.insert(schema.printJobs).values({
      storeId: req.session!.storeId,
      userId: req.session!.id,
      kind: job.kind,
      name: job.name,
      detail: job.detail ?? null,
      status: job.printed ? 'sent' : 'failed',
      payload: (job.payload ?? null) as never,
    });
  } catch {
    /* queue logging is best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const printRouter = Router();
printRouter.use(requireAuth);

/** Bridge + printer status for the Printers tab. */
printRouter.get('/status', (req, res) => {
  const io = req.app.get('io') as SocketServer | undefined;
  const room = io?.sockets.adapter.rooms.get(`bridge:${req.session!.storeId}`);
  res.json({ bridgeOnline: Boolean(room && room.size > 0) });
});

/** Recent jobs for the Queue tab. */
printRouter.get('/queue', async (req, res) => {
  const db = await getDb();
  const rows = await db
    .select({ job: schema.printJobs, userName: schema.users.name })
    .from(schema.printJobs)
    .leftJoin(schema.users, eq(schema.printJobs.userId, schema.users.id))
    .where(eq(schema.printJobs.storeId, req.session!.storeId))
    .orderBy(desc(schema.printJobs.createdAt))
    .limit(50);
  res.json(
    rows.map((r) => ({
      id: r.job.id,
      kind: r.job.kind,
      name: r.job.name,
      detail: r.job.detail,
      status: r.job.status,
      createdAt: r.job.createdAt,
      userName: r.userName,
      canReprint: r.job.payload != null,
    })),
  );
});

/** Re-send a queued job: receipts go back to the bridge, labels return their fields for the browser. */
printRouter.post('/jobs/:id/reprint', async (req, res) => {
  const db = await getDb();
  const [row] = await db.select().from(schema.printJobs).where(eq(schema.printJobs.id, Number(req.params.id)));
  if (!row || row.storeId !== req.session!.storeId || row.payload == null) {
    res.status(404).json({ error: 'Nothing stored to reprint for this job' });
    return;
  }
  if (row.kind === 'receipt') {
    const payload = row.payload as { escposBase64?: string };
    if (!payload.escposBase64) {
      res.status(400).json({ error: 'Job has no stored receipt data' });
      return;
    }
    const printed = emitBridge(req, { kind: 'receipt', escposBase64: payload.escposBase64 });
    await logPrintJob(req, { kind: 'receipt', name: `Reprint — ${row.name}`, detail: row.detail, printed, payload: row.payload });
    res.json({ printed });
    return;
  }
  // label: the client renders it in the browser from the stored fields
  await logPrintJob(req, { kind: 'label', name: `Reprint — ${row.name}`, detail: row.detail, printed: true, payload: row.payload });
  res.json({ printed: true, label: row.payload });
});

/** Log a label the client printed through the browser dialog. */
printRouter.post('/log', async (req, res) => {
  const body = z
    .object({
      kind: z.literal('label'),
      name: z.string().min(1).max(200),
      detail: z.string().max(200).optional().nullable(),
      payload: z.record(z.unknown()).optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'kind and name required' });
    return;
  }
  await logPrintJob(req, {
    kind: 'label',
    name: body.data.name,
    detail: body.data.detail ?? null,
    printed: true,
    payload: body.data.payload ?? null,
  });
  res.json({ ok: true });
});

/** Sample receipt preview honoring the settings passed in (unsaved edits included). */
printRouter.post('/preview', async (req, res) => {
  const prefs = (req.body?.receipt ?? {}) as ReceiptPrefs;
  const db = await getDb();
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const receipt = applyReceiptPrefs(sampleReceipt(store), prefs);
  res.json({ receiptText: receiptText(receipt) });
});

/** Test print to the bridge with the current settings. Manager only. */
printRouter.post('/test', requireRole('manager'), async (req, res) => {
  const prefs = (req.body?.receipt ?? undefined) as ReceiptPrefs | undefined;
  const db = await getDb();
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const saved = printSettingsOf(store).receipt;
  const receipt = applyReceiptPrefs(sampleReceipt(store), prefs ?? saved);
  const escposBase64 = receiptEscpos(receipt, false);
  const printed = emitBridge(req, { kind: 'receipt', escposBase64 });
  await logPrintJob(req, {
    kind: 'receipt',
    name: 'Test page',
    detail: `${receipt.paperWidth ?? 80}mm · Rongta`,
    printed,
    payload: { escposBase64 },
  });
  await audit(db, req, 'print.test', 'store', req.session!.storeId);
  res.json({ printed, receiptText: receiptText(receipt) });
});

function sampleReceipt(store: typeof schema.stores.$inferSelect | undefined): ReceiptData {
  return {
    header: store?.receiptHeader ?? store?.name ?? 'FMP',
    address: store?.address,
    phone: store?.phone,
    ticketNumber: 'TEST-000',
    cashier: 'Print center',
    customer: 'Sample Customer',
    createdAt: new Date(),
    lines: [
      { description: 'Screen replacement — iPhone 13', qty: 1, totalCents: 14999 },
      { description: 'Tempered glass', qty: 2, totalCents: 3998 },
    ],
    subtotalCents: 18997,
    discountCents: 0,
    taxCents: 1140,
    totalCents: 20137,
    payments: [{ method: 'cash', amountCents: 20137, tenderedCents: 21000, changeCents: 863 }],
    footer: store?.receiptFooter,
  };
}
