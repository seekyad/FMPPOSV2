
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@fmp/ui';
import { acknowledgeCheckout, checkoutIsInFlight, pendingCheckouts, reconcileCheckout, subscribeCheckoutRecovery,
  type CheckoutRecoveryResult, type PendingCheckout } from './api';

/** Shared register gate; navigation outside the register remains available for investigation/sign-in. */
export function CheckoutRecoveryBoundary({ children, onResolved, onCartCleared }: {
  children: ReactNode; onCartCleared: ()=>void; onResolved: (result:CheckoutRecoveryResult)=>void;
}) {
  const [,refresh]=useState(0);
  const [result,setResult]=useState<CheckoutRecoveryResult|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [handled,setHandled]=useState(false);
  const inFlight=useRef(false);
  const previousKey=useRef<string|undefined>(undefined);
  const clearCart=useRef(onCartCleared);
  clearCart.current=onCartCleared;
  const heading=useRef<HTMLHeadingElement>(null);
  let pending:PendingCheckout[]=[],readError='';
  try { pending=pendingCheckouts(); } catch(e) { readError=e instanceof Error ? e.message : 'Recovery data is unavailable'; }
  const key=pending[0]?.key;
  const saving=checkoutIsInFlight();
  useEffect(()=>{
    const update=()=>refresh(n=>n+1);
    const unsubscribe=subscribeCheckoutRecovery(update);
    window.addEventListener('storage',update);
    return ()=>{unsubscribe();window.removeEventListener('storage',update);};
  },[]);
  useEffect(()=>{setResult(null);setError('');setHandled(false);heading.current?.focus();},[key]);
  useEffect(()=>{
    if(previousKey.current && previousKey.current!==key && !readError) clearCart.current();
    previousKey.current=key;
  },[key,readError]);
  if(!key && !readError)return <>{children}</>;
  return <section aria-labelledby="checkout-recovery-heading" style={{ maxWidth:720, margin:'32px auto', padding:24,
    border:'1px solid var(--line)', borderRadius:16, background:'var(--card)', color:'var(--ink)' }}>
    <h2 id="checkout-recovery-heading" ref={heading} tabIndex={-1} style={{ margin:'0 0 12px',fontSize:24 }}>
      {saving ? 'Saving checkout' : 'Resolve the previous checkout'}
    </h2>
    {readError ? <p role="alert">{readError}</p> : <>
      {saving ? <p role="status">Keep this screen open while the sale is saved. Do not take another payment.</p> :
        <p>The register is paused until this checkout is resolved. Checking it will either find the saved receipt or close the unsaved attempt so it cannot save later.</p>}
      {pending.length>1 && <p>{pending.length} checkout attempts need review.</p>}
      {!result && <Button variant="primary" disabled={saving || busy} onClick={async()=>{
        if(inFlight.current || !key)return;
        inFlight.current=true;setBusy(true);setError('');
        try {setResult(await reconcileCheckout(key));} catch(e){setError(e instanceof Error ? e.message : 'Could not check checkout');}
        finally {inFlight.current=false;setBusy(false);}
      }}>{busy ? 'Checking checkout…' : 'Check and close attempt'}</Button>}
      {result?.state==='saved' && <>
        <p role="status">Sale #{result.ticketNumber} is saved ({result.saleStatus.replace('_',' ')}). Do not collect payment again.</p>
        <pre style={{ maxHeight:'40vh',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',padding:16,
          borderRadius:10,background:'var(--line-soft)',fontSize:13 }}>{result.receiptText}</pre>
      </>}
      {result?.state==='not_saved' && <>
        <p role="status">No sale was saved. This attempt is closed and cannot save later.</p>
        <p>This does not reverse a card charge or return cash. Verify that no payment was collected, or arrange its return before starting another sale.</p>
        <label style={{ display:'flex',gap:12,alignItems:'center',minHeight:48,marginBottom:16 }}>
          <input type="checkbox" checked={handled} disabled={busy} onChange={e=>setHandled(e.target.checked)} />
          No payment was collected, or the payment has been returned or reversed.
        </label>
      </>}
      {result && <>
        <p style={{ color:'var(--ink-3)',fontSize:14 }}>Finishing recovery clears the current cart. It does not send a printer job or charge a payment terminal.</p>
        <Button variant="primary" disabled={busy || (result.state==='not_saved' && !handled)} onClick={async()=>{
          if(inFlight.current || !key)return;
          inFlight.current=true;setBusy(true);setError('');
          try {await acknowledgeCheckout(key,result.state);onResolved(result);}
          catch(e){setError(e instanceof Error ? e.message : 'Could not finish recovery');}
          finally {inFlight.current=false;setBusy(false);}
        }}>{busy ? 'Finishing…' : result.state==='saved' ? 'Receipt reviewed — clear cart' : 'Payment handled — clear cart'}</Button>
      </>}
      {error && <p role="alert" style={{ color:'var(--red)',marginTop:16 }}>{error}</p>}
    </>}
  </section>;
}
