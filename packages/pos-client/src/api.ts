import type { AuthResponse, SessionUser } from '@fmp/shared';

const TOKEN_KEY = 'fmp.sessionToken';
const USER_KEY = 'fmp.sessionUser';
const DEVICE_KEY = 'fmp.deviceToken';

const sessionInvalidationListeners=new Set<()=>void>();
export const subscribeSessionInvalidation=(listener:()=>void)=>{sessionInvalidationListeners.add(listener);return ()=>{sessionInvalidationListeners.delete(listener);};};

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  get user(): SessionUser | null {
    const raw = localStorage.getItem(USER_KEY);

    try {
      const parsed:unknown=raw ? JSON.parse(raw) : null;
      if(!parsed || typeof parsed!=='object')return null;
      const user=parsed as SessionUser;
      return [user.id,user.storeId,user.terminalId].every(n=>Number.isSafeInteger(n)&&n>0) &&
        typeof user.name==='string' && ['manager','employee'].includes(user.role) ? user : null;
    } catch { return null; }

  },
  set(auth: AuthResponse) {
    localStorage.setItem(TOKEN_KEY, auth.token);
    localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    for(const listener of sessionInvalidationListeners)listener();
  },
  get deviceToken() {
    return localStorage.getItem(DEVICE_KEY);
  },
  setDeviceToken(token: string) {
    localStorage.setItem(DEVICE_KEY, token);
  },
};

export type PosSystem = 'repair' | 'retail';

/**
 * Cross-system switching. In production both apps share one origin
 * (/ and /retail) so localStorage already carries the session; in dev they run
 * on different ports, so the session rides along in the URL hash.
 */
export function switchSystemUrl(target: PosSystem): string {
  const isDev = window.location.port === '5173' || window.location.port === '5174';
  if (!isDev) return target === 'retail' ? '/retail/' : '/';
  const payload = encodeURIComponent(
    JSON.stringify({
      token: session.token,
      user: localStorage.getItem(USER_KEY),
      deviceToken: session.deviceToken,
    }),
  );
  const hash = `#fmp-session=${payload}`;
  if (isDev) {
    return target === 'retail' ? `http://localhost:5174/retail/${hash}` : `http://localhost:5173/${hash}`;
  }
  return target === 'retail' ? `/retail/${hash}` : `/${hash}`;
}

/** Pick up a session handed over from the other system (call once at startup). */
export function adoptSessionFromHash(): void {
  const match = window.location.hash.match(/fmp-session=([^&]+)/);
  if (!match) return;
  try {
    const payload = JSON.parse(decodeURIComponent(match[1]!)) as {
      token?: string | null;
      user?: string | null;
      deviceToken?: string | null;
    };
    if (payload.token) localStorage.setItem(TOKEN_KEY, payload.token);
    if (payload.user) localStorage.setItem(USER_KEY, payload.user);
    if (payload.deviceToken) localStorage.setItem(DEVICE_KEY, payload.deviceToken);
  } catch {
    // malformed hash — ignore
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}



export type PendingCheckout = { fingerprint: string; key: string };
export type CheckoutRecoveryResult =
  | { state: 'not_saved'; acknowledged: boolean }
  | { state: 'saved'; acknowledged: boolean; saleId: number; ticketNumber: string; saleStatus: string; receiptText: string };

const recoveryListeners = new Set<() => void>();
const checkoutDispatches = new Map<string, Promise<unknown>>();
const notifyRecovery = () => { for(const listener of recoveryListeners) listener(); };
export const subscribeCheckoutRecovery = (listener:()=>void) => { recoveryListeners.add(listener); return ()=>{recoveryListeners.delete(listener);}; };
export const checkoutIsInFlight = () => checkoutDispatches.size > 0;
const recoveryStorageKey = (owner:SessionUser) => 'fmp.checkoutRecovery.'+owner.storeId+'.'+owner.terminalId;
const legacyStorageKey = (owner:SessionUser) => 'fmp.pendingCheckouts.'+owner.storeId+'.'+owner.terminalId;

function parsePending(raw:string|null):PendingCheckout[] {
  if(!raw)return [];
  const parsed:unknown=JSON.parse(raw);
  if(!Array.isArray(parsed)||parsed.some(p=>!p||typeof p.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.fingerprint)||
    typeof p.key!=='string'||!/^[a-f0-9-]{36}$/i.test(p.key))) {
    throw new Error('Checkout recovery data is unreadable. Ask a manager to reconcile this register before clearing browser data.');
  }
  return parsed as PendingCheckout[];
}
export function pendingCheckouts(owner=session.user):PendingCheckout[] {
  if(!owner)return [];
  const current=parsePending(localStorage.getItem(recoveryStorageKey(owner)));
  const legacy=parsePending(sessionStorage.getItem(legacyStorageKey(owner)));
  const merged=[...new Map([...current,...legacy].map(p=>[p.key,p])).values()];
  if(legacy.length) {
    localStorage.setItem(recoveryStorageKey(owner),JSON.stringify(merged));
    sessionStorage.removeItem(legacyStorageKey(owner));
  }
  return merged;
}
function writePending(owner:SessionUser,entries:PendingCheckout[]) {
  localStorage.setItem(recoveryStorageKey(owner),JSON.stringify(entries));
  notifyRecovery();
}
export async function reconcileCheckout(key:string):Promise<CheckoutRecoveryResult> {
  return api<CheckoutRecoveryResult>('/api/sales/checkout/'+encodeURIComponent(key)+'/reconcile',{method:'POST'});
}
export async function acknowledgeCheckout(key:string,state:CheckoutRecoveryResult['state']) {
  const owner=session.user;
  if(!owner)throw new Error('Sign in again to finish recovery');
  await api('/api/sales/checkout/'+encodeURIComponent(key)+'/acknowledge',{method:'POST',
    body:JSON.stringify({decision:state==='saved' ? 'saved_sale_reviewed' : 'payment_reconciled'})});
  writePending(owner,pendingCheckouts(owner).filter(p=>p.key!==key));
}

/** No automatic retry, printer dispatch or payment-provider charge is performed by recovery. */
async function apiRequest<T>(path:string,options:RequestInit={}):Promise<T> {
  const headers=new Headers(options.headers);
  headers.set('Content-Type','application/json');
  const token=session.token;
  if(token)headers.set('Authorization','Bearer '+token);
  const checkout=path==='/api/sales/complete' && options.method?.toUpperCase()==='POST' && typeof options.body==='string';
  const owner=checkout ? session.user : null;
  let pendingKey:string|undefined;
  if(checkout) {
    if(!owner)throw new ApiError(401,'Sign in before completing a sale');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(options.body as string));
    const fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    const pending=pendingCheckouts(owner);
    if(pending.some(p=>p.fingerprint!==fingerprint))throw new ApiError(409,'Resolve the previous checkout before changing the cart or taking another payment');
    const existing=pending.find(p=>p.fingerprint===fingerprint);
    pendingKey=existing?.key ?? crypto.randomUUID();
    if(!existing)writePending(owner,[...pending,{fingerprint,key:pendingKey}]);
    headers.set('Idempotency-Key',pendingKey);
  }
  const controller=checkout ? new AbortController() : undefined;
  const abort=()=>controller?.abort();
  if(options.signal?.aborted)abort();
  options.signal?.addEventListener('abort',abort,{once:true});
  const timeout=controller ? setTimeout(abort,30_000) : undefined;
  try {
    const res=await fetch(path,{...options,headers,signal:controller?.signal ?? options.signal});
    const body=await res.json().catch(error=>{if(checkout && res.ok)throw error;return {};});
    if(!res.ok) {
      const publicAuth=['/api/auth/pin','/api/auth/terminal/register','/api/auth/staff','/api/auth/stores'].includes(path);
      if(res.status===401 && token && session.token===token && !publicAuth)session.clear();
      // Even a rejected save can follow money collected at the counter. Keep the recovery record until reviewed.
      throw new ApiError(res.status,body.error ?? 'Request failed ('+res.status+')');
    }
    if(pendingKey && owner) {
      if(!Number.isInteger(body?.sale?.id))throw new Error('Checkout response is incomplete');
      writePending(owner,pendingCheckouts(owner).filter(p=>p.key!==pendingKey));
    }
    return body as T;
  } catch(error) {
    if(checkout && !(error instanceof ApiError))throw new Error('Checkout outcome could not be confirmed. Use checkout recovery before taking another payment.');
    throw error;
  } finally {
    if(timeout!==undefined)clearTimeout(timeout);
    options.signal?.removeEventListener('abort',abort);
  }
}

export function api<T>(path:string,options:RequestInit={}):Promise<T> {
  if(path!=='/api/sales/complete'||options.method?.toUpperCase()!=='POST'||typeof options.body!=='string')return apiRequest<T>(path,options);
  const owner=session.user;
  const input=owner?.storeId+':'+owner?.terminalId+':'+options.body;
  const running=checkoutDispatches.get(input);
  if(running)return running as Promise<T>;
  const promise=apiRequest<T>(path,options);
  checkoutDispatches.set(input,promise);
  const cleanup=()=>{checkoutDispatches.delete(input);notifyRecovery();};
  void promise.then(cleanup,cleanup);
  return promise;
}
