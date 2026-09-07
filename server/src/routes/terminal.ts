import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';
import { audit } from '../util';
import { chargeDejavoo, type DejavooConfig } from '../dejavoo';

export const terminalRouter = Router();
terminalRouter.use(requireAuth);

/** Is a card terminal configured for this store? */
terminalRouter.get('/status', async (req, res) => {
  const db = await getDb();
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const settings = (store?.settings ?? {}) as { dejavoo?: DejavooConfig };
  res.json({ configured: Boolean(settings.dejavoo?.tpn && settings.dejavoo?.authKey) });
});

/** Send the amount to the Dejavoo terminal and wait for approve/decline. */
terminalRouter.post('/charge', async (req, res) => {
  const body = z
    .object({ amountCents: z.number().int().min(1), paymentType: z.enum(['Credit', 'Debit']).default('Credit') })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'amountCents required' });
    return;
  }
  const db = await getDb();
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, req.session!.storeId));
  const settings = (store?.settings ?? {}) as { dejavoo?: DejavooConfig };
  if (!settings.dejavoo?.tpn || !settings.dejavoo.authKey) {
    res.status(409).json({ error: 'Card terminal not configured — confirm the payment manually' });
    return;
  }
  const refId = `FMP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    const result = await chargeDejavoo(settings.dejavoo, body.data.amountCents, refId, body.data.paymentType);
    await audit(db, req, 'terminal.charge', undefined, undefined, {
      refId,
      amount: body.data.amountCents,
      approved: result.approved,
      message: result.responseMessage,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: `Terminal unreachable: ${err instanceof Error ? err.message : 'unknown'} — confirm manually if the terminal approved`,
      refId,
    });
  }
});
