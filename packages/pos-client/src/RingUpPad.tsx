import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { formatCents } from '@fmp/shared';
import { Keypad } from '@fmp/ui';
import { api } from './api';
import type { CartCustomer } from './cart';
import type { PaymentDraft } from './PaymentModal';

export interface RingUpPadHandle {
  focus: () => void;
  /** set the description used for the next punched-in item (from the search bar or preset buttons) */
  setDescription: (text: string) => void;
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
    /** true when the sale contains an item rung up with tax removed — card and tap are blocked */
    taxRemovedInSale?: boolean;
    /** false hides the pad's own description/preset row (the parent provides them, e.g. via the search bar) */
    showItemOptions?: boolean;
    /** the register's primary action tiles (New repair, Accessory, Device sale), shown between the amount entry and the tender row */
    quickActions?: ReactNode;
    onAdd: (item: RingUpItem) => void;
    /** card fast path: parent adds the pending item (if any) and completes as card */
    onCollectCard: (item: RingUpItem | null) => void;
    onComplete: (payments: PaymentDraft[]) => void;
  }
>(function RingUpPad(
  {
    taxRateBp,
    subtotalCents,
    taxCents,
    totalCents,
    customer,
    busy,
    taxRemovedInSale = false,
    showItemOptions = true,
    quickActions,
    onAdd,
    onCollectCard,
    onComplete,
  },
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
    setDescription(text: string) {
      setDescription(text);
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  function startTender(withMethod: PaymentDraft['method'] = 'cash') {
    const item = currentItem();
    if (item) onAdd(item);
    else if (totalCents <= 0) return;
    resetEntry();
    setMethod(withMethod);
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
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl bg-navy px-5 py-3 [container-type:inline-size]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">SUBTOTAL</div>
          <div className="text-[clamp(17px,3.8cqw,38px)] leading-tight font-extrabold whitespace-nowrap text-white/80">{formatCents(subtotalCents)}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">TAX</div>
          <div className="text-[clamp(17px,3.8cqw,38px)] leading-tight font-extrabold whitespace-nowrap text-white/80">{formatCents(taxCents)}</div>
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
            <div className="text-[clamp(17px,3.8cqw,38px)] leading-tight font-extrabold whitespace-nowrap text-white">{formatCents(tendered)}</div>
          </div>
        )}
        <div className="text-right">
          <div className="text-[11px] font-semibold tracking-[0.1em] text-white/50">
            {showEntry ? 'ENTRY' : paidSoFar > 0 ? 'REMAINING DUE' : 'AMOUNT DUE'}
          </div>
          <div className="text-[clamp(17px,3.8cqw,38px)] leading-tight font-extrabold whitespace-nowrap text-orange">
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
              className={`text-[clamp(17px,3.8cqw,38px)] leading-tight font-extrabold whitespace-nowrap ${
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

  const TENDER_CAPTIONS: Record<string, string> = {
    cash: 'Drawer · change due',
    card: 'Tap, chip or swipe',
    tap: 'Phone or watch',
    zelle: 'Bank transfer · confirm',
    cash_app: 'Scan $cashtag',
    split: 'Two tenders',
    store_credit: 'Store credit balance',
  };

  /**
   * Tender tile in the register's card style (icon badge + label), the same in entry
   * and tender mode; the caption shows on hover, and the chosen tender lights up orange.
   */
  const tenderTile = (
    id: string,
    icon: string,
    label: string,
    opts: { active?: boolean; disabled?: boolean; title?: string; onClick: () => void },
  ) => {
    const caption = id === 'store_credit' && customer && credit > 0 ? `${formatCents(credit)} available` : TENDER_CAPTIONS[id];
    const state = opts.disabled
      ? 'border-line-soft bg-line-soft text-ink-4'
      : opts.active
        ? 'border-orange bg-orange-soft text-ink shadow-sm'
        : 'border-line bg-card text-ink shadow-sm';
    const badge = opts.disabled ? 'bg-card text-ink-4' : opts.active ? 'bg-orange text-white' : 'bg-line-soft text-ink-2';
    return (
      <button
        key={id}
        disabled={opts.disabled}
        title={opts.title ?? caption}
        aria-label={`${label} — ${caption}`}
        aria-pressed={opts.active}
        onClick={opts.onClick}
        className={`flex min-h-[60px] items-center gap-3 rounded-[12px] border px-3 py-2 text-left ${state}`}
      >
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-[10px] ${badge}`}>
          <i className={`bi ${icon} text-[19px]`} />
        </span>
        <span className={`min-w-0 truncate text-[15px] leading-tight font-bold ${opts.active ? 'text-orange' : ''}`}>{label}</span>
      </button>
    );
  };

  const disabledBtn = 'bg-line-soft text-ink-4';
  // No-tax deals are cash only: card/tap blocked when tax was removed on the sale
  // or on the item currently being punched in.
  const cardBlocked = taxRemovedInSale || (cents > 0 && !taxable);

  return (
    <div ref={containerRef} className="mt-3 flex flex-col gap-2.5 rounded-2xl border border-line-soft bg-card p-3 shadow-sm">
      {/* register display spans the whole pad */}
      {displayPanel}

      <div className="flex flex-wrap gap-4">
        {/* keys */}
        <div className="flex min-w-[340px] max-w-[640px] shrink-0 grow-0 basis-[40%] max-[1180px]:basis-full max-[1180px]:max-w-[560px]">
          <Keypad
            size="lg"
            fill
            onDigit={(d) => keypadTarget.set(Math.min(keypadTarget.value * 10 + d, 9_999_999))}
            onDoubleZero={() => keypadTarget.set(Math.min(keypadTarget.value * 100, 9_999_999))}
            onBackspace={() => keypadTarget.set(Math.floor(keypadTarget.value / 10))}
            onClear={() => keypadTarget.set(0)}
          />
        </div>

        {/* right side */}
        <div className="flex min-w-0 flex-1 basis-[300px] flex-col gap-2.5">
        {mode === 'entry' ? (
          <>
            <div className="flex flex-col rounded-xl bg-line-soft px-4 py-3.5">
              <div className="text-[13px] font-semibold tracking-wide text-ink-3">
                AMOUNT — TYPE ON KEYPAD OR TAP A QUICK AMOUNT
              </div>
              <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(76px,1fr))] gap-2.5">
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
            {showItemOptions ? (
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  ref={descRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className="min-w-[160px] flex-1 rounded-[10px] border border-line bg-card px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-4 focus:border-orange focus:outline-none"
                />
                {['Accessory', 'Service fee'].map((preset) => {
                  const active = description === preset;
                  return (
                    <button
                      key={preset}
                      onClick={() => setDescription(active ? '' : preset)}
                      className={`min-h-[46px] shrink-0 rounded-xl px-3.5 text-[14px] font-semibold ${
                        active ? 'bg-navy text-white' : 'border border-line bg-card text-ink-2'
                      }`}
                    >
                      {preset}
                    </button>
                  );
                })}
                <button
                  onClick={() => setTaxable((t) => !t)}
                  title={taxable ? 'Tap to remove tax from this item (logged)' : 'Tax removed — tap to add it back'}
                  className={`flex min-h-[46px] shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-semibold select-none ${
                    taxable ? 'bg-orange-soft text-orange' : 'border border-line bg-card text-ink-4'
                  }`}
                >
                  <i className="bi bi-percent text-[16px]" />
                  <span className={taxable ? '' : 'line-through'}>
                    Tax {(taxRateBp / 100).toFixed(taxRateBp % 100 === 0 ? 0 : 2)}%
                  </span>
                </button>
              </div>
            ) : description ? (
              <div className="flex items-center">
                <span className="flex min-h-[46px] items-center gap-2.5 rounded-xl bg-orange-soft px-4 text-[15.5px] font-semibold text-orange">
                  {description}
                  <button onClick={() => setDescription('')} title="Clear description">
                    <i className="bi bi-x-lg" />
                  </button>
                </span>
              </div>
            ) : null}
            {quickActions}
            <div className="mt-auto flex flex-1 flex-col gap-2.5">
              <button
                onClick={add}
                disabled={cents <= 0}
                className={`flex min-h-[64px] w-full flex-1 items-center justify-center gap-2 rounded-xl text-[21px] font-bold whitespace-nowrap ${
                  cents <= 0 ? disabledBtn : 'bg-orange text-white'
                }`}
              >
                <i className="bi bi-plus-lg" /> Add to sale
              </button>
              {/* tenders: one even row, same tiles and order as tender mode */}
              <div className="grid grid-cols-3 gap-2.5 max-[640px]:grid-cols-2">
                {tenderTile('cash', 'bi-cash', 'Cash', { disabled: busy || (totalCents <= 0 && cents <= 0), onClick: () => startTender() })}
                {tenderTile('card', 'bi-credit-card', 'Card', {
                  disabled: busy || (totalCents <= 0 && cents <= 0) || cardBlocked,
                  title: cardBlocked ? 'Tax was removed — cash only' : undefined,
                  onClick: () => {
                    onCollectCard(currentItem());
                    resetEntry();
                  },
                })}
                {tenderTile('zelle', 'bi-bank', 'Zelle', {
                  disabled: busy || (totalCents <= 0 && cents <= 0) || cardBlocked,
                  title: cardBlocked ? 'Tax was removed — cash only' : undefined,
                  onClick: () => startTender('zelle'),
                })}
                {tenderTile('cash_app', 'bi-qr-code-scan', 'Cash App', {
                  disabled: busy || (totalCents <= 0 && cents <= 0) || cardBlocked,
                  title: cardBlocked ? 'Tax was removed — cash only' : undefined,
                  onClick: () => startTender('cash_app'),
                })}
                {tenderTile('split', 'bi-layout-split', 'Cash split', { disabled: busy || (totalCents <= 0 && cents <= 0), onClick: () => startTender() })}
                {tenderTile('store_credit', 'bi-wallet2', 'Credit', {
                  disabled: busy || (totalCents <= 0 && cents <= 0) || !customer || credit <= 0,
                  title: !customer ? 'Add a customer to use store credit' : credit <= 0 ? 'No store credit on this customer' : undefined,
                  onClick: () => startTender('store_credit'),
                })}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* tender mode */}
            {taxRemovedInSale && (
              <div className="text-[12.5px] font-semibold text-amber">
                Tax was removed on this sale — cash only.
              </div>
            )}

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
            ) : method === 'zelle' || method === 'cash_app' ? (
              <div className="flex flex-1 flex-col justify-center rounded-xl border border-dashed border-line px-4 py-3 text-[14.5px] text-ink-2">
                <div className="text-[15.5px] font-bold text-ink">
                  <i className={`bi ${method === 'zelle' ? 'bi-bank' : 'bi-qr-code-scan'} mr-1.5`} />
                  {method === 'zelle' ? 'Zelle transfer' : 'Cash App payment'} · {formatCents(paying)}
                </div>
                <div className="mt-1">
                  Have the customer send {formatCents(paying)} to the shop's {method === 'zelle' ? 'Zelle' : 'Cash App'}. Tap Complete once
                  it shows as received.
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

            {/* the same tender row as entry mode, in the same place; the active tender is highlighted */}
            <div className="mt-auto grid grid-cols-3 gap-2.5 max-[640px]:grid-cols-2">
              {tenderTile('cash', 'bi-cash', 'Cash', { active: method === 'cash', onClick: () => setMethod('cash') })}
              {tenderTile('card', 'bi-credit-card', 'Card', { active: method === 'card', disabled: taxRemovedInSale, onClick: () => setMethod('card') })}
              {tenderTile('zelle', 'bi-bank', 'Zelle', { active: method === 'zelle', disabled: taxRemovedInSale, onClick: () => setMethod('zelle') })}
              {tenderTile('cash_app', 'bi-qr-code-scan', 'Cash App', { active: method === 'cash_app', disabled: taxRemovedInSale, onClick: () => setMethod('cash_app') })}
              {tenderTile('tap', 'bi-phone', 'Tap', { active: method === 'tap', disabled: taxRemovedInSale, onClick: () => setMethod('tap') })}
              {tenderTile('store_credit', 'bi-wallet2', 'Credit', {
                active: method === 'store_credit',
                disabled: !customer || credit <= 0,
                title: !customer ? 'Add a customer to use store credit' : credit <= 0 ? 'No store credit on this customer' : undefined,
                onClick: () => setMethod('store_credit'),
              })}
            </div>
            <div className="flex gap-2.5 [container-type:inline-size]">
              <button
                onClick={resetAll}
                className="flex min-h-[60px] w-[110px] items-center justify-center rounded-xl border border-line bg-card text-[15.5px] font-bold uppercase text-ink-2"
              >
                Back
              </button>
              <button
                onClick={confirmCurrent}
                disabled={!canConfirm || busy}
                className={`flex min-h-[60px] flex-1 items-center justify-center gap-2 rounded-xl text-[clamp(12px,3.4cqw,17px)] font-bold uppercase whitespace-nowrap ${
                  !canConfirm || busy ? disabledBtn : 'bg-green text-white'
                }`}
              >
                {busy
                  ? 'Saving…'
                  : paying < remaining
                    ? `Take ${formatCents(paying)} — more to collect`
                    : method === 'cash'
                      ? `Complete - Change Due: ${formatCents(Math.max(change, 0))}`
                      : `Complete - ${formatCents(paying)}`}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
});
