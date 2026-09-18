
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from './app';
import { getDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { hashToken } from './pairing';
import { signSession } from './auth';
import { nextTicketNumber } from './util';
import { snapshotLines } from './finance';
import { computeTotals, taxCents } from '@fmp/shared';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = '';
process.env.PGLITE_MEMORY = '1';
const db = await getDb();
const app = createApp();
let storeId=0, otherStore=0, token='', otherToken='', customerId=0;
const auth = (t=token)=>({Authorization:'Bearer '+t});
beforeAll(async()=>{
  await runMigrations(db);
  for (let i=0;i<2;i++) {
    const [store]=await db.insert(schema.stores).values({name:'Finance '+i,taxRateBp:0}).returning();
    const [user]=await db.insert(schema.users).values({storeId:store!.id,name:'Manager',initials:'M',pinHash:'unused',role:'manager'}).returning();
    const [terminal]=await db.insert(schema.terminals).values({storeId:store!.id,name:'Test',deviceToken:hashToken(randomUUID())}).returning();
    const jwt=signSession({id:user!.id,name:user!.name,role:'manager',storeId:store!.id,terminalId:terminal!.id});
    if(i===0){storeId=store!.id;token=jwt;}else{otherStore=store!.id;otherToken=jwt;}
  }
  const [customer]=await db.insert(schema.customers).values({name:'Shared finance customer',storeCreditCents:5000}).returning();
  customerId=customer!.id;
},60000);
const line = (cents=1000)=>({kind:'custom',description:'Fixture',qty:1,unitCents:cents,taxable:false});
const payload = (lines=[line()],amount=1000)=>({lines,payments:[{method:'cash',amountCents:amount}],printReceipt:false});
const complete=(body:object,t=token,key?:string)=>{
  const call=request(app).post('/api/sales/complete').set(auth(t));
  if(key)call.set('Idempotency-Key',key);
  return call.send(body);
};
async function item(kind:'accessory'|'device'='accessory',qty=2){
  const [row]=await db.insert(schema.inventoryItems).values({storeId,kind,name:'Stock fixture',qty}).returning();return row!;
}
const saleLines=async(id:number)=>(await db.select().from(schema.saleLines).where(eq(schema.saleLines.saleId,id)));
const balance=async()=> (await db.select().from(schema.customers).where(eq(schema.customers.id,customerId)))[0]!.storeCreditCents;
async function counts(){
  const result=await db.execute(sql`select (select count(*) from sales)::int sales,
    (select count(*) from payments)::int payments,(select count(*) from inventory_movements)::int movements,
    (select count(*) from store_credit_ledger)::int credit,(select count(*) from audit_log)::int audit,
    (select count(*) from drawer_sessions)::int drawers`);
  return result.rows[0];
}
describe('financial invariants',()=>{
  it('rejects invalid credit, overpayment, underpayment and cash tender without persisting writes',async()=>{
    const before=await counts();
    const bad=[
      {...payload(),payments:[{method:'store_credit',amountCents:1000}]},
      payload([line()],999),payload([line()],1001),
      {...payload(),payments:[{method:'cash',amountCents:1000,tenderedCents:999}]},
    ];
    for(const b of bad) expect((await complete(b)).status).toBe(400);
    expect(await counts()).toEqual(before);
  });
  it('deducts every credit tender once and handles concurrent redemption across stores',async()=>{
    await db.update(schema.customers).set({storeCreditCents:2000}).where(eq(schema.customers.id,customerId));
    const b={...payload([line(2000)],2000),customerId,payments:[{method:'store_credit',amountCents:1000},{method:'store_credit',amountCents:1000}]};
    const r=await complete(b);expect(r.status).toBe(200);expect(await balance()).toBe(0);
    await db.update(schema.customers).set({storeCreditCents:1000}).where(eq(schema.customers.id,customerId));
    const spend={...payload(),customerId,payments:[{method:'store_credit',amountCents:1000}]};
    const results=await Promise.all([complete(spend),complete(spend,otherToken)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(await balance()).toBe(0);
  });
  it('rolls back stock, credit, sale, drawer and audit if a late database write fails',async()=>{
    await db.update(schema.customers).set({storeCreditCents:1000}).where(eq(schema.customers.id,customerId));
    const stock=await item();
    await db.execute(sql.raw("CREATE FUNCTION finance_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'sale.complete' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$"));
    await db.execute(sql.raw("CREATE TRIGGER finance_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION finance_fail_audit()"));
    const before=await counts();
    try {
      const r=await complete({customerId,lines:[{...line(),kind:'product',inventoryItemId:stock.id}],
        payments:[{method:'store_credit',amountCents:500},{method:'cash',amountCents:500}],printReceipt:false});
      expect(r.status).toBe(500);expect(await counts()).toEqual(before);expect(await balance()).toBe(1000);
      expect((await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id,stock.id)))[0]!.qty).toBe(2);
    } finally {await db.execute(sql.raw('DROP TRIGGER finance_failure ON audit_log'));await db.execute(sql.raw('DROP FUNCTION finance_fail_audit()'));}
  });
  it('rejects overselling, duplicate serialized quantities and concurrent sale of one device',async()=>{
    const stock=await item('accessory',1);
    const b={...payload(),lines:[{...line(),kind:'product',inventoryItemId:stock.id,qty:2,unitCents:500}]};
    const before=await counts();expect((await complete(b)).status).toBe(409);expect(await counts()).toEqual(before);
    const device=await item('device',1);
    expect((await complete({...b,lines:[{...b.lines[0],inventoryItemId:device.id}]})).status).toBe(409);
    const sell={...payload(),lines:[{...line(),kind:'product',inventoryItemId:device.id}]};
    const results=await Promise.all([complete(sell),complete(sell)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  });
  it('replays checkout once and rejects a reused key with different amounts',async()=>{
    const key=randomUUID(),before=await counts();
    const results=await Promise.all([complete(payload(),token,key),complete(payload(),token,key)]);
    expect(results.map(r=>r.status)).toEqual([200,200]);
    expect(results[0]!.body.sale.id).toBe(results[1]!.body.sale.id);
    expect(Number((await counts())!.sales)-Number(before!.sales)).toBe(1);
    expect((await complete(payload([line(1100)],1100),token,key)).status).toBe(409);
  });
  it('consumes a parked cart only once',async()=>{
    const parked=await request(app).post('/api/sales/park').set(auth()).send({lines:[line()]});
    const b={...payload(),parkedSaleId:parked.body.sale.id};
    const results=await Promise.all([complete(b),complete(b)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,404]);
  });
  it('snapshots discounts and tax and refunds each line exactly once after a tax change',async()=>{
    await db.update(schema.stores).set({taxRateBp:600}).where(eq(schema.stores.id,storeId));
    const lines=[{...line(),taxable:true},{...line(2000),taxable:false,discountCents:500}];
    const totals=computeTotals(lines,600,501);
    const sale=await complete({...payload(lines,totals.totalCents),saleDiscountCents:501});expect(sale.status).toBe(200);
    const originalLines=await saleLines(sale.body.sale.id);
    expect(originalLines.reduce((s,l)=>s+l.netCents!+l.taxCents!,0)).toBe(totals.totalCents);
    await db.update(schema.stores).set({taxRateBp:1500}).where(eq(schema.stores.id,storeId));
    const refund=(ids:number[])=>request(app).post('/api/sales/'+sale.body.sale.id+'/refund').set(auth()).send({method:'cash',lineIds:ids});
    const first=await refund([originalLines[0]!.id]);expect(first.status).toBe(200);
    expect(first.body.refundAmountCents).toBe(originalLines[0]!.netCents!+originalLines[0]!.taxCents!);
    const before=await counts();expect((await refund([originalLines[0]!.id])).status).toBe(409);expect(await counts()).toEqual(before);
    const second=await refund([originalLines[1]!.id]);expect(second.status).toBe(200);
    expect(first.body.refundAmountCents+second.body.refundAmountCents).toBe(totals.totalCents);
    expect((await db.select().from(schema.sales).where(eq(schema.sales.id,sale.body.sale.id)))[0]!.status).toBe('refunded');
    await db.update(schema.stores).set({taxRateBp:0}).where(eq(schema.stores.id,storeId));
  });
  it('rejects empty, foreign and duplicate refund line selections without money changes',async()=>{
    const sale=await complete(payload());const lines=await saleLines(sale.body.sale.id);
    const before=await counts();
    for(const ids of [[],[999999],[lines[0]!.id,lines[0]!.id]]) {
      expect((await request(app).post('/api/sales/'+sale.body.sale.id+'/refund').set(auth()).send({method:'cash',lineIds:ids})).status).toBe(409);
    }expect(await counts()).toEqual(before);
  });
  it('serializes concurrent refunds and restocks a line once',async()=>{
    const stock=await item();
    const sale=await complete({...payload(),lines:[{...line(),kind:'product',inventoryItemId:stock.id}]});
    const refund=()=>request(app).post('/api/sales/'+sale.body.sale.id+'/refund').set(auth()).send({method:'cash'});
    const results=await Promise.all([refund(),refund()]);
    expect(results.map(r=>r.status).sort()).toEqual([200,404]);
    expect((await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id,stock.id)))[0]!.qty).toBe(2);
  });
  it('repair checkout counts money once; refund reverses allocation without reversing physical pickup',async()=>{
    const [ticket]=await db.insert(schema.repairTickets).values({storeId,number:randomUUID(),customerId,totalCents:1000,status:'completed'}).returning();
    const drawerBefore=await request(app).get('/api/drawer').set(auth());
    const sale=await complete({...payload(),customerId,lines:[{...line(),kind:'repair',ticketId:ticket!.id}]});
    expect(sale.status).toBe(200);
    const payments=await db.select().from(schema.payments).where(eq(schema.payments.saleId,sale.body.sale.id));
    expect(payments).toHaveLength(1);
    const detail=await request(app).get('/api/repairs/'+ticket!.id).set(auth());
    expect(detail.body.paidCents).toBe(1000);expect(detail.body.ticket.status).toBe('picked_up');
    const drawerAfter=await request(app).get('/api/drawer').set(auth());
    expect(drawerAfter.body.expectedCents-drawerBefore.body.expectedCents).toBe(1000);
    const r=await request(app).post('/api/sales/'+sale.body.sale.id+'/refund').set(auth()).send({method:'cash'});
    expect(r.status).toBe(200);
    const after=await request(app).get('/api/repairs/'+ticket!.id).set(auth());
    expect(after.body.paidCents).toBe(0);expect(after.body.ticket.status).toBe('picked_up');
  });
  it('rejects closed-repair deposits and unpaid pickup and serializes competing deposits',async()=>{
    const [ticket]=await db.insert(schema.repairTickets).values({storeId,number:randomUUID(),customerId,totalCents:1000,status:'open'}).returning();
    expect((await request(app).patch('/api/repairs/'+ticket!.id).set(auth()).send({status:'picked_up'})).status).toBe(409);
    const deposit=()=>request(app).post('/api/repairs/'+ticket!.id+'/deposit').set(auth()).send({method:'cash',amountCents:1000});
    expect((await Promise.all([deposit(),deposit()])).map(r=>r.status).sort()).toEqual([200,400]);
    expect((await request(app).post('/api/repairs/'+ticket!.id+'/cancel').set(auth()).send({reason:'Cancel'})).status).toBe(409);
    await db.update(schema.repairTickets).set({status:'cancelled'}).where(eq(schema.repairTickets.id,ticket!.id));
    expect((await deposit()).status).toBe(409);
  });
  it('voids cash through an immutable reversal and rejects card void without provider settlement',async()=>{
    const cash=await complete(payload());
    expect((await request(app).post('/api/sales/'+cash.body.sale.id+'/void').set(auth()).send({})).status).toBe(200);
    const p=await db.select().from(schema.payments).where(eq(schema.payments.saleId,cash.body.sale.id));expect(p[0]!.amountCents).toBe(1000);
    const reversal=await db.select().from(schema.sales).where(eq(schema.sales.refundOfSaleId,cash.body.sale.id));expect(reversal[0]!.totalCents).toBe(-1000);
    const card=await complete({...payload(),payments:[{method:'card',amountCents:1000}]});
    expect((await request(app).post('/api/sales/'+card.body.sale.id+'/void').set(auth()).send({})).status).toBe(409);
  });
  it('allocates unique document numbers across concurrent calls and stores',async()=>{
    const values=await Promise.all(Array.from({length:8},(_,i)=>nextTicketNumber(db,i%2 ? storeId : otherStore)));
    expect(new Set(values).size).toBe(8);
    // receipts, tickets and payouts share one series per store
    expect(await nextTicketNumber(db, storeId)).toMatch(/^S\d+-\d{5}$/);
  });
  it('migrates duplicate ticket bookkeeping to allocations without losing its source evidence',async()=>{
    const sale=await complete(payload());
    const [ticket]=await db.insert(schema.repairTickets).values({storeId,number:randomUUID(),customerId,totalCents:1000}).returning();
    const [old]=await db.insert(schema.payments).values({saleId:sale.body.sale.id,ticketId:ticket!.id,method:'cash',amountCents:1000}).returning();
    const migration=await readFile(new URL('../drizzle/0009_premium_thunderbolt_ross.sql',import.meta.url),'utf8');
    for(const statement of migration.split('--> statement-breakpoint').slice(-2)) await db.execute(sql.raw(statement));
    expect(await db.select().from(schema.payments).where(eq(schema.payments.id,old!.id))).toHaveLength(0);
    const allocated=await db.select().from(schema.ticketAllocations).where(eq(schema.ticketAllocations.ticketId,ticket!.id));
    expect(allocated[0]!.legacyPayment).toMatchObject({id:old!.id,amount_cents:1000});
  });
  it('rounds tax reversals symmetrically and distributes every discounted cent',()=>{
    expect(taxCents(-5,1000)).toBe(-1);expect(taxCents(5,1000)).toBe(1);
    const lines=[{qty:1,unitCents:5,taxable:true},{qty:1,unitCents:5,taxable:true},{qty:1,unitCents:5,taxable:false}];
    const totals=computeTotals(lines,1000,4);
    expect(snapshotLines(lines,totals).reduce((s,l)=>s+l.netCents+l.taxCents,0)).toBe(totals.totalCents);
  });
});

it('rolls a refund back when its final audit insert fails', async()=>{
  const sold=await complete(payload());
  const before=await counts();
  await db.execute(sql.raw("CREATE FUNCTION finance_fail_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'sale.refund' THEN RAISE EXCEPTION 'injected refund failure'; END IF; RETURN NEW; END $$"));
  await db.execute(sql.raw("CREATE TRIGGER finance_refund_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION finance_fail_refund()"));
  try {
    const r=await request(app).post('/api/sales/'+sold.body.sale.id+'/refund').set(auth()).send({method:'cash'});
    expect(r.status).toBe(500);expect(await counts()).toEqual(before);
    expect((await db.select().from(schema.sales).where(eq(schema.sales.id,sold.body.sale.id)))[0]!.status).toBe('completed');
  } finally {
    await db.execute(sql.raw('DROP TRIGGER finance_refund_failure ON audit_log'));
    await db.execute(sql.raw('DROP FUNCTION finance_fail_refund()'));
  }
  expect((await request(app).post('/api/sales/'+sold.body.sale.id+'/refund').set(auth()).send({method:'cash'})).status).toBe(200);
});
it('does not complete a repair or consume earlier parts if a later required part is unavailable', async()=>{
  const [ticket]=await db.insert(schema.repairTickets).values({storeId,number:randomUUID(),customerId,totalCents:2000,status:'in_progress'}).returning();
  const first=await item('accessory',1),second=await item('accessory',0);
  for(const part of [first,second]) {
    const [service]=await db.insert(schema.services).values({category:'Repair',name:'Part fixture',basePriceCents:1000,partItemId:part.id}).returning();
    await db.insert(schema.ticketLines).values({ticketId:ticket!.id,serviceId:service!.id,description:'Repair part',priceCents:1000});
  }
  expect((await request(app).patch('/api/repairs/'+ticket!.id).set(auth()).send({status:'completed'})).status).toBe(409);
  expect((await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id,first.id)))[0]!.qty).toBe(1);
  expect((await db.select().from(schema.repairTickets).where(eq(schema.repairTickets.id,ticket!.id)))[0]!.status).toBe('in_progress');
  const lines=await db.select().from(schema.ticketLines).where(eq(schema.ticketLines.ticketId,ticket!.id));
  expect(lines.every(l=>!l.partConsumed)).toBe(true);
});

it('cancels with an explicit deposit return and issues shared credit once',async()=>{
  const [ticket]=await db.insert(schema.repairTickets).values({storeId,number:randomUUID(),customerId,totalCents:2000}).returning();
  expect((await request(app).post('/api/repairs/'+ticket!.id+'/deposit').set(auth()).send({method:'cash',amountCents:1000})).status).toBe(200);
  const before=await balance();
  const cancel=()=>request(app).post('/api/repairs/'+ticket!.id+'/cancel').set(auth()).send({reason:'Customer declined',refundMethod:'store_credit'});
  const outcomes=await Promise.all([cancel(),cancel()]);
  expect(outcomes.map(r=>r.status).sort()).toEqual([200,400]);
  expect(await balance()).toBe(before+1000);
  const detail=await request(app).get('/api/repairs/'+ticket!.id).set(auth());
  expect(detail.body.ticket.status).toBe('cancelled');expect(detail.body.paidCents).toBe(0);
});
it('restores the original consumed item after its catalog mapping changes',async()=>{
  const [ticket]=await db.insert(schema.repairTickets).values({storeId,number:randomUUID(),customerId,totalCents:1000}).returning();
  const first=await item('accessory',2),replacement=await item('accessory',3);
  const [service]=await db.insert(schema.services).values({category:'Repair',name:'Mapping fixture',basePriceCents:1000,partItemId:first.id}).returning();
  await db.insert(schema.ticketLines).values({ticketId:ticket!.id,serviceId:service!.id,description:'Part',priceCents:1000});
  expect((await request(app).patch('/api/repairs/'+ticket!.id).set(auth()).send({status:'completed'})).status).toBe(200);
  await db.update(schema.services).set({partItemId:replacement.id}).where(eq(schema.services.id,service!.id));
  expect((await request(app).post('/api/repairs/'+ticket!.id+'/cancel').set(auth()).send({reason:'Cancelled'})).status).toBe(200);
  expect((await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id,first.id)))[0]!.qty).toBe(2);
  expect((await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id,replacement.id)))[0]!.qty).toBe(3);
});
it('merges shared credit and all customer references once, including retail records',async()=>{
  const [duplicate]=await db.insert(schema.customers).values({name:'Duplicate',storeCreditCents:750}).returning();
  const [activation]=await db.insert(schema.activations).values({storeId:otherStore,customerId:duplicate!.id,carrier:'Fixture',kind:'new_line'}).returning();
  const before=await balance();
  const merge=()=>request(app).post('/api/customers/'+customerId+'/merge').set(auth()).send({duplicateId:duplicate!.id});
  expect((await Promise.all([merge(),merge()])).map(r=>r.status).sort()).toEqual([200,409]);
  expect(await balance()).toBe(before+750);
  expect((await db.select().from(schema.activations).where(eq(schema.activations.id,activation!.id)))[0]!.customerId).toBe(customerId);
  expect((await db.select().from(schema.customers).where(eq(schema.customers.id,duplicate!.id)))[0]!.storeCreditCents).toBe(0);
});
it('customer lifetime totals include original sales and reversals beyond the latest 50 receipts',async()=>{
  const [customer]=await db.insert(schema.customers).values({name:'History fixture'}).returning();
  await db.insert(schema.sales).values(Array.from({length:55},()=>({storeId,customerId:customer!.id,ticketNumber:randomUUID(),status:'completed' as const,
    subtotalCents:100,totalCents:100,completedAt:new Date()})));
  const r=await request(app).get('/api/customers/'+customer!.id).set(auth());
  expect(r.body.saleHistory).toHaveLength(50);expect(r.body.customer.visits).toBe(55);expect(r.body.customer.lifetimeCents).toBe(5500);
});

it('recovers a saved receipt without another payment or print job and audits acknowledgment once',async()=>{
  const key=randomUUID();
  const sale=await complete(payload(),token,key);
  const before=await counts();
  const recover=()=>request(app).post('/api/sales/checkout/'+key+'/reconcile').set(auth()).send({});
  const result=await recover();
  expect(result.status).toBe(200);expect(result.body.state).toBe('saved');
  expect(result.body.saleId).toBe(sale.body.sale.id);expect(result.body.receiptText).toContain(sale.body.sale.ticketNumber);
  expect(Number((await counts())!.payments)).toBe(Number(before!.payments));
  const wrong=await request(app).post('/api/sales/checkout/'+key+'/acknowledge').set(auth()).send({decision:'payment_reconciled'});
  expect(wrong.status).toBe(409);
  const ack=()=>request(app).post('/api/sales/checkout/'+key+'/acknowledge').set(auth()).send({decision:'saved_sale_reviewed'});
  expect((await Promise.all([ack(),ack()])).map(r=>r.status)).toEqual([200,200]);
  expect((await recover()).body.acknowledged).toBe(true);
  const [recovery]=await db.select().from(schema.checkoutRecoveries).where(eq(schema.checkoutRecoveries.key,key));
  const events=await db.select().from(schema.auditLog).where(sql`action='checkout.recovery_acknowledged' and entity_id=${recovery!.id}`);
  expect(events).toHaveLength(1);
});
it('closing an unsaved attempt prevents any delayed checkout from committing',async()=>{
  const key=randomUUID();
  const before=await counts();
  const r=await request(app).post('/api/sales/checkout/'+key+'/reconcile').set(auth()).send({});
  expect(r.status).toBe(200);expect(r.body.state).toBe('not_saved');
  expect((await complete(payload(),token,key)).status).toBe(409);
  expect(Number((await counts())!.sales)).toBe(Number(before!.sales));
  expect(Number((await counts())!.payments)).toBe(Number(before!.payments));
  expect((await request(app).post('/api/sales/checkout/'+key+'/acknowledge').set(auth()).send({decision:'saved_sale_reviewed'})).status).toBe(409);
  expect((await request(app).post('/api/sales/checkout/'+key+'/acknowledge').set(auth()).send({decision:'payment_reconciled'})).status).toBe(200);
  expect((await complete(payload(),token,key)).status).toBe(409);
});
it('checkout racing with reconciliation produces either one saved sale or a closed unsaved attempt',async()=>{
  for(let i=0;i<4;i++) {
    const key=randomUUID();
    const calls=[()=>complete(payload(),token,key),()=>request(app).post('/api/sales/checkout/'+key+'/reconcile').set(auth()).send({})];
    const results=await Promise.all(i%2 ? calls.reverse().map(call=>call()) : calls.map(call=>call()));
    const check=results.find(r=>r.body.state)!;
    const save=results.find(r=>!r.body.state)!;
    if(check.body.state==='saved'){expect(save.status).toBe(200);expect(check.body.saleId).toBe(save.body.sale.id);}
    else {expect(check.body.state).toBe('not_saved');expect(save.status).toBe(409);}
  }
});
it('does not expose another register receipt and requires a checked outcome before acknowledgment',async()=>{
  const key=randomUUID();await complete(payload(),token,key);
  const [user]=await db.select().from(schema.users).where(eq(schema.users.storeId,storeId));
  const [terminal]=await db.insert(schema.terminals).values({storeId,name:'Other register',deviceToken:hashToken(randomUUID())}).returning();
  const other=signSession({id:user!.id,name:user!.name,role:user!.role,storeId,terminalId:terminal!.id});
  expect((await request(app).post('/api/sales/checkout/'+key+'/reconcile').set(auth(other)).send({})).status).toBe(403);
  expect((await request(app).post('/api/sales/checkout/'+key+'/reconcile').set(auth(otherToken)).send({})).body.state).toBe('not_saved');
  expect((await request(app).post('/api/sales/checkout/'+randomUUID()+'/acknowledge').set(auth()).send({decision:'payment_reconciled'})).status).toBe(409);
});
