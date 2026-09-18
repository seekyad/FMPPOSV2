import { HttpError } from '../http';
import { createRouter as Router } from '../http';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index';
import { requireAuth } from '../auth';
import { audit } from '../util';

export const customersRouter = Router();
customersRouter.use(requireAuth);

const customerBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().max(120).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  vip: z.boolean().optional(),
});

/** List with search + aggregate stats (visits, lifetime spend, open tickets). */
customersRouter.get('/', async (req, res) => {
  const db = await getDb();
  const q = String(req.query.query ?? '').trim();
  const c = schema.customers;
  const where = and(
    isNull(c.mergedInto),
    q ? or(ilike(c.name, `%${q}%`), ilike(c.phone, `%${q}%`), ilike(c.email, `%${q}%`)) : undefined,
  );
  const rows = await db
    .select({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      vip: c.vip,
      storeCreditCents: c.storeCreditCents,
      createdAt: c.createdAt,
      visits: sql<number>`(select count(*) from sales s where s.refund_of_sale_id is null and s.status != 'voided' and s.customer_id = ${c.id} and (s.status in ('completed','refunded') or (s.status = 'voided' and exists (select 1 from sales reversal where reversal.refund_of_sale_id = s.id))) and s.completed_at is not null)`,
      lifetimeCents: sql<number>`coalesce((select sum(s.total_cents) from sales s where s.customer_id = ${c.id} and (s.status in ('completed','refunded') or (s.status = 'voided' and exists (select 1 from sales reversal where reversal.refund_of_sale_id = s.id))) and s.completed_at is not null), 0)`,
      openTickets: sql<number>`(select count(*) from repair_tickets t where t.customer_id = ${c.id} and t.status in ('open','in_progress','waiting_part','completed'))`,
      balanceDueCents: sql<number>`coalesce((select sum(t.total_cents) - coalesce(sum((coalesce((select sum(p.amount_cents) from payments p where p.ticket_id = t.id),0) + coalesce((select sum(a.amount_cents) from ticket_allocations a where a.ticket_id = t.id),0))), 0) from repair_tickets t where t.customer_id = ${c.id} and t.status in ('open','in_progress','waiting_part','completed')), 0)`,
      lastSeen: sql<string | null>`(select max(s.created_at) from sales s where s.customer_id = ${c.id})`,
    })
    .from(c)
    .where(where)
    .orderBy(desc(sql`coalesce((select sum(s.total_cents) from sales s where s.customer_id = ${c.id} and (s.status in ('completed','refunded') or (s.status = 'voided' and exists (select 1 from sales reversal where reversal.refund_of_sale_id = s.id))) and s.completed_at is not null), 0)`))
    .limit(200);
  res.json(rows);
});

/** Drill-in: devices on file, open tickets, purchase/repair history, credit. */
customersRouter.get('/:id', async (req, res) => {
  const db = await getDb();
  const id = Number(req.params.id);
  const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.id, id));
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const devices = await db.select().from(schema.customerDevices).where(eq(schema.customerDevices.customerId, id));
  const tickets = await db
    .select()
    .from(schema.repairTickets)
    .where(eq(schema.repairTickets.customerId, id))
    .orderBy(desc(schema.repairTickets.createdAt))
    .limit(50);
  const saleHistory = await db
    .select({
      id: schema.sales.id,
      ticketNumber: schema.sales.ticketNumber,
      totalCents: schema.sales.totalCents,
      status: schema.sales.status,
      createdAt: schema.sales.createdAt,
    })
    .from(schema.sales)
    .where(and(eq(schema.sales.customerId, id), sql`${schema.sales.completedAt} is not null`, sql`(${schema.sales.status} in ('completed','refunded') or (${schema.sales.status} = 'voided' and exists (select 1 from sales reversal where reversal.refund_of_sale_id = ${schema.sales.id})))`))
    .orderBy(desc(schema.sales.createdAt))
    .limit(50);
  const credit = await db
    .select()
    .from(schema.storeCreditLedger)
    .where(eq(schema.storeCreditLedger.customerId, id))
    .orderBy(desc(schema.storeCreditLedger.createdAt))
    .limit(20);
  const [summary] = await db.select({
    visits: sql<number>`count(*) filter (where ${schema.sales.refundOfSaleId} is null and ${schema.sales.status} != 'voided')`,
    lifetimeCents: sql<number>`coalesce(sum(${schema.sales.totalCents}),0)`,
  }).from(schema.sales).where(and(eq(schema.sales.customerId,id),sql`${schema.sales.completedAt} is not null`, sql`(${schema.sales.status} in ('completed','refunded') or (${schema.sales.status} = 'voided' and exists (select 1 from sales reversal where reversal.refund_of_sale_id = ${schema.sales.id})))`));
  const visits = Number(summary?.visits ?? 0);
  const lifetimeCents = Number(summary?.lifetimeCents ?? 0);
  res.json({ customer: { ...customer, visits, lifetimeCents }, devices, tickets, saleHistory, credit });
});

customersRouter.post('/', async (req, res) => {
  const body = customerBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  const db = await getDb();
  const [row] = await db.insert(schema.customers).values(body.data).returning();
  await audit(db, req, 'customer.create', 'customer', row!.id);
  res.json(row);
});

customersRouter.patch('/:id', async (req, res) => {
  const body = customerBody.partial().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Invalid fields' });
    return;
  }
  const db = await getDb();
  const [row] = await db
    .update(schema.customers)
    .set(body.data)
    .where(eq(schema.customers.id, Number(req.params.id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  res.json(row);
});

customersRouter.post('/:id/devices', async (req, res) => {
  const body = z
    .object({
      label: z.string().min(1).max(120),
      imei: z.string().max(20).optional().nullable(),
      detail: z.string().max(200).optional().nullable(),
      modelId: z.number().int().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Device label required' });
    return;
  }
  const db = await getDb();
  const [row] = await db
    .insert(schema.customerDevices)
    .values({ ...body.data, customerId: Number(req.params.id) })
    .returning();
  res.json(row);
});

/** Merge `duplicateId` into this customer: repoint sales/tickets/devices/credit, keep both names searchable via note. */

customersRouter.post('/:id/merge', async (req,res)=>{
  const keepId=Number(req.params.id),dupId=Number(req.body?.duplicateId);
  if (!Number.isSafeInteger(keepId)||!Number.isSafeInteger(dupId)||keepId<1||dupId<1||keepId===dupId) throw new HttpError(400,'Choose two different customers');
  const db=await getDb();
  await db.transaction(async tx=>{
    // A shared customer can own transactions in either store. Match store-before-customer lock order.
    await tx.select({id:schema.stores.id}).from(schema.stores).orderBy(schema.stores.id).for('update');
    const customers=await tx.select().from(schema.customers).where(inArray(schema.customers.id,[keepId,dupId])).orderBy(schema.customers.id).for('update');
    const kept=customers.find(c=>c.id===keepId),dup=customers.find(c=>c.id===dupId);
    if(!kept||!dup||kept.mergedInto||dup.mergedInto)throw new HttpError(409,'Both customers must be active, unmerged profiles');
    for(const table of [schema.sales,schema.repairTickets,schema.customerDevices,schema.storeCreditLedger,schema.activations,schema.billPayments]) {
      await tx.update(table).set({customerId:keepId}).where(eq(table.customerId,dupId));
    }
    await tx.update(schema.customers).set({mergedInto:keepId,storeCreditCents:0}).where(eq(schema.customers.id,dupId));
    await tx.update(schema.customers).set({storeCreditCents:kept.storeCreditCents+dup.storeCreditCents}).where(eq(schema.customers.id,keepId));
    await audit(tx as unknown as Awaited<ReturnType<typeof getDb>>,req,'customer.merge','customer',keepId,{duplicateId:dupId,transferredCreditCents:dup.storeCreditCents});
  });
  res.json({ok:true});
});
