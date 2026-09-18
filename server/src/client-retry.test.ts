
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, pendingCheckouts, acknowledgeCheckout, session } from '../../packages/pos-client/src/api';

const values = new Map<string,string>();
const storage = { getItem: (k:string)=>values.get(k) ?? null, setItem:(k:string,v:string)=>{values.set(k,v);}, removeItem:(k:string)=>{values.delete(k);} };
beforeEach(()=>{
  values.clear();
  vi.stubGlobal('localStorage',storage);vi.stubGlobal('sessionStorage',storage);
  values.set('fmp.sessionUser',JSON.stringify({id:1,storeId:1,terminalId:1,name:'Fixture',role:'manager'}));
});
afterEach(()=>vi.unstubAllGlobals());
const options={method:'POST',body:JSON.stringify({lines:[{description:'fixture'}],payments:[{method:'cash',amountCents:100}]})};

it('reuses the checkout key after an uncertain network response and starts a new key after confirmed success',async()=>{
  const keys:string[]=[];
  let attempt=0;
  vi.stubGlobal('fetch',vi.fn(async(_path,options)=>{
    keys.push(new Headers(options.headers).get('Idempotency-Key')!);
    if(++attempt===1)throw new TypeError('Network disconnected');
    return new Response(JSON.stringify({sale:{id:1}}),{status:200});
  }));
  await expect(api('/api/sales/complete',options)).rejects.toThrow('outcome could not be confirmed');
  await api('/api/sales/complete',options);
  await api('/api/sales/complete',options);
  expect(keys[0]).toBe(keys[1]);expect(keys[2]).not.toBe(keys[1]);
});
it('shares concurrent checkout dispatch and preserves normal non-checkout requests',async()=>{
  let release!:()=>void;
  const wait=new Promise<void>(resolve=>release=resolve);
  const fetch=vi.fn(async()=>{await wait;return new Response(JSON.stringify({sale:{id:1}}),{status:200});});
  vi.stubGlobal('fetch',fetch);
  const first=api('/api/sales/complete',options),second=api('/api/sales/complete',options);
  release();
  expect(await first).toEqual(await second);expect(fetch).toHaveBeenCalledTimes(1);
});
it('retains retry state after a malformed successful checkout response',async()=>{
  const keys:string[]=[];
  let count=0;
  vi.stubGlobal('fetch',vi.fn(async(_path,options)=>{
    keys.push(new Headers(options.headers).get('Idempotency-Key')!);
    return new Response(++count===1 ? '{}' : JSON.stringify({sale:{id:2}}),{status:200});
  }));
  await expect(api('/api/sales/complete',options)).rejects.toThrow('outcome could not be confirmed');
  await api('/api/sales/complete',options);expect(keys[0]).toBe(keys[1]);
});

it('blocks changed-cart submissions after uncertainty and keeps recovery after authentication failure',async()=>{
  let calls=0;
  vi.stubGlobal('fetch',vi.fn(async()=>{
    if(++calls===1)throw new TypeError('disconnected');
    return new Response(JSON.stringify({error:'Sign in again'}),{status:401});
  }));
  await expect(api('/api/sales/complete',options)).rejects.toThrow('outcome could not be confirmed');
  const original=pendingCheckouts()[0]!;
  await expect(api('/api/sales/complete',{...options,body:options.body+' '})).rejects.toThrow('Resolve the previous checkout');
  expect(calls).toBe(1);
  await expect(api('/api/sales/complete',options)).rejects.toThrow('Sign in again');
  expect(pendingCheckouts()[0]!.key).toBe(original.key);
});
it('keeps rejected saves for explicit payment review and only clears after successful acknowledgment',async()=>{
  let ack=false;
  vi.stubGlobal('fetch',vi.fn(async(path)=>{
    if(path.endsWith('/acknowledge')){
      return new Response(JSON.stringify(ack ? {ok:true} : {error:'Offline'}),{status:ack ? 200 : 503});
    }
    return new Response(JSON.stringify({error:'Not enough credit'}),{status:409});
  }));
  await expect(api('/api/sales/complete',options)).rejects.toThrow('Not enough credit');
  const key=pendingCheckouts()[0]!.key;
  await expect(acknowledgeCheckout(key,'not_saved')).rejects.toThrow('Offline');
  expect(pendingCheckouts()).toHaveLength(1);
  ack=true;await acknowledgeCheckout(key,'not_saved');expect(pendingCheckouts()).toHaveLength(0);
});
it('persists only fingerprints/IDs outside tab storage and handles corrupt saved sessions without throwing',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new TypeError('offline');}));
  await expect(api('/api/sales/complete',options)).rejects.toThrow();
  const persisted=values.get('fmp.checkoutRecovery.1.1')!;
  expect(persisted).toBeDefined();expect(persisted).not.toContain('fixture');expect(persisted).not.toContain('cash');
  values.delete('fmp.pendingCheckouts.1.1');expect(pendingCheckouts()).toHaveLength(1);
  values.set('fmp.sessionUser','{invalid');expect(session.user).toBeNull();
  values.set('fmp.sessionUser',JSON.stringify({storeId:'wrong',terminalId:1}));expect(session.user).toBeNull();
});
