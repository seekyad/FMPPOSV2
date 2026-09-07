import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Keypad } from '@fmp/ui';
import { api } from './api';
import type { CartCustomer } from './cart';
import type { PaymentDraft } from './PaymentModal';

export interface RingUpPadHandle {
  focus: () => void;
}

export interface RingUpItem {
  description: string;
  unitCents: number;
  taxable: boolean;
}

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000];

/**
 * The register's ring-up + payment station. Entry mode punches amounts into
 * the sale; tender mode collects the payment right here (methods, tendered
 * cash with change, splits) — there is no separate payment popup.
 */
export const RingUpPad = forwardRef<
  RingUpPadHandle,
  {
    taxRateBp: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    customer: CartCustomer | null;
    busy: boolean;
    onAdd: (item: RingUpItem) => void;
    /** card fast path: parent adds the pending item (if any) and completes as card */
    onCollectCard: (item: RingUpItem | null) => void;
    onComplete: (payments: PaymentDraft[]) => void;
  }
>(function RingUpPad(
  { taxRateBp, subtotalCents, taxCents, totalCents, customer, busy, onAdd, onCollectCard, onComplete },
  ref,
) {
  const [mode, setMode] = useState<'entry' | 'tender'>('entry');
  const [cents, setCents] = useState(0);
  const [description, setDescription] = useState('');
  const [taxable, setTaxable] = useState(true);

  // tender state
  const [method, setMethod] = useState<PaymentDraft['method']>('cash');
  const [tendered, setTendered] = useState(0);
  const [taken, setTaken] = useState<PaymentDraft[]>([]);
  const [terminalConfigured, setTerminalConfigured] = useState(false);
  const [terminalState, setTerminalState] = useState<'idle' | 'waiting' | 'declined'>('idle');
  const [terminalMsg, setTerminalMsg] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      descRef.current?.focus();
    },
  }));

  useEffect(() => {
    void api<{ configured: boolean }>('/api/terminal/status')
      .then((s) => setTerminalConfigured(s.configured))
      .catch(() => setTerminalConfigured(false));
  }, []);

  // sale finished (or cleared) elsewhere → leave tender mode
  useEffect(() => {
    if (mode === 'tender' && totalCents <= 0) resetAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCents]);

  const remaining = totalCents - taken.reduce((s, p) => s + p.amountCents, 0);
  const credit = customer?.storeCreditCents ?? 0;
  // Cash: whatever is punched in — less than the total is taken as a partial
  // (split). Store credit: uses up to what the customer has. Card/tap: the rest.
  const paying =
    method === 'cash'
      ? tendered > 0
        ? Math.min(tendered, remaining)
        : remaining
      : method === 'store_credit'
        ? Math.min(remaining, credit)
        : remaining;
  const change = method === 'cash' ? tendered - paying : 0;
  const canConfirm =
    paying > 0 &&
    paying <= remaining &&
    (method === 'cash' ? tendered > 0 : method === 'store_credit' ? credit > 0 : true);

  function currentItem(): RingUpItem | null {
    if (cents <= 0) return null;
    return { description: description.trim() || 'Custom item', unitCents: cents, taxable };
  }

  function resetEntry() {
    setCents(0);
    setDescription('');
    setTaxable(true);
  }

  function resetAll() {
    resetEntry();
    setMode('entry');
    setMethod('cash');
    setTendered(0);
    setTaken([]);
    setTerminalState('idle');
    setTerminalMsg('');
  }

  function add() {
    const item = currentItem();
    if (!item) return;
    onAdd(item);
    resetEntry();
  }

  function startTender() {
    const item = currentItem();
    if (item) onAdd(item);
    else if (totalCents <= 0) return;
    resetEntry();
    setMethod('cash');
    setTendered(0);
    setTaken([]);
    setMode('tender');
  }

  function confirmCurrent() {
    const p: PaymentDraft = { method, amountCents: paying, tenderedCents: method === 'cash' ? tendered : undefined };
    const nextTaken = [...taken, p];
    const nextRemaining = totalCents - nextTaken.reduce((s, x) => s + x.amountCents, 0);
    if (nextRemaining <= 0) {
      onComplete(nextTaken);
      resetAll();
    } else {
      setTaken(nextTaken);
      setTendered(0);
      setMethod('cash');
    }
  }

  const keypadTarget =
    mode === 'entry'
      ? { set: setCents, value: cents }
      : { set: setTendered, value: tendered };

  const paidSoFar = taken.reduce((s, p) => s + p.amountCents, 0);
  const showEntry = mode === 'entry' && cents > 0;

  const cashTender = mode === 'tender' && method === 'cash';

  /** Register display: entry while typing, otherwise the live money state —
   *  in cash tender it also carries TENDERED and CHANGE BACK / STILL DUE. */
  const displayPanel = (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl bg-navy px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">SUBTOTAL</div>
          <div className="text-[38px] leading-tight font-extrabold text-white/80">{formatCents(subtotalCents)}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">TAX</div>
          <div className="text-[38px] leading-tight font-extrabold text-white/80">{formatCents(taxCents)}</div>
        </div>
        {(paidSoFar > 0 || (customer && (customer.storeCreditCents ?? 0) > 0)) && (
          <div className="space-y-0.5 text-[13px] leading-snug text-white/65">
            {customer && (customer.storeCreditCents ?? 0) > 0 && (
              <div>
                Store credit available <b className="text-white/90">{formatCents(customer.storeCreditCents ?? 0)}</b>
              </div>
            )}
            {paidSoFar > 0 && (
              <div>
                Paid so far <b className="text-green-bg">{formatCents(paidSoFar)}</b>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-6 gap-y-2">
        {cashTender && (
          <div className="text-right">
            <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">TENDERED</div>
            <div className="text-[38px] leading-tight font-extrabold text-white">{formatCents(tendered)}</div>
          </div>
        )}
        <div className="text-right">
          <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">
            {showEntry ? 'ENTRY' : paidSoFar > 0 ? 'REMAINING DUE' : 'AMOUNT DUE'}
          </div>
          <div className="text-[38px] leading-tight font-extrabold text-orange">
            {formatCents(showEntry ? cents : mode === 'tender' ? remaining : totalCents)}
          </div>
        </div>
        {cashTender && (
          <div className="-my-1 rounded-lg bg-white/10 px-4 py-1 text-right">
            <div
              className={`text-[11px] font-semibold tracking-[0.1em] ${
                tendered >= remaining ? 'text-[#4ade80]' : 'text-[#fbbf24]'
              }`}
            >
              {tendered >= remaining ? 'CHANGE BACK' : 'STILL DUE'}
            </div>
            <div
              className={`text-[38px] leading-tight font-extrabold ${
                tendered >= remaining ? 'text-[#4ade80]' : 'text-[#fbbf24]'
              }`}
            >
              {formatCents(tendered >= remaining ? change : remaining - tendered)}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const methodBtn = (id: PaymentDraft['method'], icon: string, label: string, disabled = false) => (
    <button
      key={id}
      disabled={disabled}
      onClick={() => setMethod(id)}
      className={`flex min-h-[48px] items-center justify-center gap-2 rounded-xl text-[14.5px] font-semibold ${
        method === id ? 'bg-navy text-white' : 'border border-line bg-card text-ink-2'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      <i className={`bi ${icon}`} /> {label}
    </button>
  );

  const disabledBtn = 'bg-line-soft text-ink-4';

  return (
    <div ref={containerRef} className="mt-4 flex flex-col gap-3 rounded-2xl border border-line-soft bg-card p-4 shadow-sm">
      {/* register display spans the whole pad */}
      {displayPanel}

      <div className="flex flex-wrap gap-4">
        {/* keys */}
        <div className="w-[360px] max-w-full flex-none max-[1080px]:w-full max-[1080px]:max-w-[440px]">
          <Keypad
            onDigit={(d) => keypadTarget.set(Math.min(keypadTarget.value * 10 + d, 9_999_999))}
            onDoubleZero={() => keypadTarget.set(Math.min(keypadTarget.value * 100, 9_999_999))}
            onBackspace={() => keypadTarget.set(Math.floor(keypadTarget.value / 10))}
            onClear={() => keypadTarget.set(0)}
          />
        </div>

        {/* right side */}
        <div className="flex min-w-[300px] flex-1 flex-col gap-2.5">
        {mode === 'entry' ? (
          <>
            <div className="flex flex-1 flex-col rounded-xl bg-line-soft px-4 py-3.5">
              <div className="text-[13px] font-semibold tracking-wide text-ink-3">
                AMOUNT — TYPE ON KEYPAD OR TAP A QUICK AMOUNT
              </div>
              <div className="mt-3 grid flex-1 grid-cols-[repeat(auto-fit,minmax(76px,1fr))] gap-2.5">
                {QUICK_AMOUNTS.map((v) => (
                  <button
                    key={v}
                    onClick={() => setCents(v)}
                    className={`min-h-[60px] rounded-xl text-[20px] font-bold ${
                      cents === v ? 'bg-navy text-white' : 'bg-card text-ink shadow-sm'
                    }`}
                  >
                    ${v / 100}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <input
                ref={descRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
                className="min-w-0 flex-1 rounded-[10px] border border-line bg-card px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-4 focus:border-orange focus:outline-none"
              />
              <label className="flex shrink-0 items-center gap-1.5 text-[13px] text-ink-3 select-none">
                <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} className="size-4 accent-[#f97316]" />
                Tax {(taxRateBp / 100).toFixed(taxRateBp % 100 === 0 ? 0 : 2)}%
              </label>
            </div>
            <div className="mt-auto flex flex-wrap gap-2.5">
              <button
                onClick={add}
                disabled={cents <= 0}
                className={`flex min-h-[60px] min-w-[220px] flex-[2] items-center justify-center gap-2 rounded-xl text-[17px] font-bold whitespace-nowrap ${
                  cents <= 0 ? disabledBtn : 'bg-orange text-white'
                }`}
              >
                <i className="bi bi-plus-lg" /> Add to sale
              </button>
              <button
                onClick={startTender}
                disabled={busy || (totalCents <= 0 && cents <= 0)}
                className={`flex min-h-[60px] min-w-[84px] flex-1 flex-col items-center justify-center rounded-xl text-[15.5px] font-bold ${
                  busy || (totalCents <= 0 && cents <= 0) ? disabledBtn : 'bg-green text-white'
                }`}
              >
                <i className="bi bi-cash text-[19px]" /> Cash
              </button>
              <button
                onClick={() => {
                  onCollectCard(currentItem());
                  resetEntry();
                }}
                disabled={busy || (totalCents <= 0 && cents <= 0)}
                className={`flex min-h-[60px] min-w-[84px] flex-1 flex-col items-center justify-center rounded-xl text-[15.5px] font-bold ${
                  busy || (totalCents <= 0 && cents <= 0) ? disabledBtn : 'bg-navy text-white'
                }`}
              >
                <i className="bi bi-credit-card text-[19px]" /> Card
              </button>
              <button
                onClick={startTender}
                disabled={busy || (totalCents <= 0 && cents <= 0)}
                className={`flex min-h-[60px] min-w-[84px] flex-1 flex-col items-center justify-center rounded-xl text-[15.5px] font-bold ${
                  busy || (totalCents <= 0 && cents <= 0) ? disabledBtn : 'border-2 border-navy bg-card text-navy'
                }`}
              >
                <i className="bi bi-layout-split text-[19px]" /> Split
              </button>
            </div>
          </>
        ) : (
          <>
            {/* tender mode */}
            <div className="grid grid-cols-4 gap-2">
              {methodBtn('cash', 'bi-cash', 'Cash')}
              {methodBtn('card', 'bi-credit-card', 'Card')}
              {methodBtn('tap', 'bi-phone', 'Tap')}
              {methodBtn('store_credit', 'bi-wallet2', 'Credit', !customer || credit <= 0)}
            </div>

            {method === 'cash' ? (
              <div className="flex flex-1 flex-col rounded-xl bg-line-soft px-4 py-3.5">
                <div className="text-[13px] font-semibold tracking-wide text-ink-3">
                  CASH TENDERED — TYPE ON KEYPAD OR TAP A BILL
                </div>
                <div className="mt-3 grid flex-1 grid-cols-[repeat(auto-fit,minmax(76px,1fr))] gap-2.5">
                  {[1000, 2000, 5000, 10000].map((v) => (
                    <button
                      key={v}
                      onClick={() => setTendered(v)}
                      className={`min-h-[60px] rounded-xl text-[20px] font-bold ${
                        tendered === v ? 'bg-navy text-white' : 'bg-card text-ink shadow-sm'
                      }`}
                    >
                      ${v / 100}
                    </button>
                  ))}
                  <button
                    onClick={() => setTendered(remaining)}
                    className={`min-h-[60px] rounded-xl text-[20px] font-bold ${
                      tendered === remaining && remaining > 0 ? 'bg-navy text-white' : 'bg-card text-ink shadow-sm'
                    }`}
                  >
                    Exact
                  </button>
                </div>
              </div>
            ) : method === 'store_credit' ? (
              <div className="rounded-xl bg-purple-bg px-4 py-3 text-[14.5px] text-purple">
                Deducts {formatCents(paying)} from {customer?.name}'s store credit.
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-line px-4 py-3 text-[14.5px] text-ink-2">
                {terminalConfigured ? (
                  <button
                    disabled={terminalState === 'waiting'}
                    onClick={async () => {
                      setTerminalState('waiting');
                      setTerminalMsg('');
                      try {
                        const res = await api<{ approved: boolean; responseMessage: string }>('/api/terminal/charge', {
                          method: 'POST',
                          body: JSON.stringify({ amountCents: paying }),
                        });
                        if (res.approved) {
                          setTerminalState('idle');
                          confirmCurrent();
                        } else {
                          setTerminalState('declined');
                          setTerminalMsg(res.responseMessage);
                        }
                      } catch (e) {
                        setTerminalState('declined');
                        setTerminalMsg(e instanceof Error ? e.message : 'Terminal error');
                      }
                    }}
                    className="w-full rounded-lg bg-navy py-2.5 font-bold text-white disabled:opacity-50"
                  >
                    {terminalState === 'waiting' ? 'Waiting for card on terminal…' : `Send ${formatCents(paying)} to Dejavoo terminal`}
                  </button>
                ) : (
                  <>Run {formatCents(paying)} on the terminal, then confirm below.</>
                )}
                {terminalState === 'declined' && <div className="mt-1.5 text-[13px] font-semibold text-red">{terminalMsg}</div>}
              </div>
            )}

            <div className="mt-auto flex gap-2.5">
              <button
                onClick={resetAll}
                className="flex min-h-[60px] w-[110px] items-center justify-center rounded-xl border border-line bg-card text-[15.5px] font-bold text-ink-2"
              >
                Back
              </button>
              <button
                onClick={confirmCurrent}
                disabled={!canConfirm || busy}
                className={`flex min-h-[60px] flex-1 items-center justify-center gap-2 rounded-xl text-[17px] font-bold ${
                  !canConfirm || busy ? disabledBtn : 'bg-green text-white'
                }`}
              >
                {busy
                  ? 'Saving…'
                  : paying < remaining
                    ? `Take ${formatCents(paying)} — more to collect`
                    : method === 'cash'
                      ? `Complete · change ${formatCents(Math.max(change, 0))}`
                      : `Complete · ${formatCents(paying)}`}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
});
