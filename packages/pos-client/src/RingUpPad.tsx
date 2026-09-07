import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Keypad } from '@fmp/ui';

export interface RingUpPadHandle {
  focus: () => void;
}

export interface RingUpItem {
  description: string;
  unitCents: number;
  taxable: boolean;
}

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000];
const QUICK_LABELS = ['Quick repair — walk-in', 'Accessory', 'Service fee'];

/**
 * The ring-up station on the Register: punch or tap an amount like a physical
 * register, then add it to the sale — or collect the whole sale as cash/card
 * on the spot.
 */
export const RingUpPad = forwardRef<
  RingUpPadHandle,
  {
    taxRateBp: number;
    onAdd: (item: RingUpItem) => void;
    /** fast collection: item is the punched amount (null if pad is empty) */
    onCollect: (method: 'cash' | 'card' | 'split', item: RingUpItem | null) => void;
  }
>(function RingUpPad({ taxRateBp, onAdd, onCollect }, ref) {
  const [cents, setCents] = useState(0);
  const [description, setDescription] = useState('');
  const [taxable, setTaxable] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      descRef.current?.focus();
    },
  }));

  function currentItem(): RingUpItem | null {
    if (cents <= 0) return null;
    return { description: description.trim() || 'Custom item', unitCents: cents, taxable };
  }

  function reset() {
    setCents(0);
    setDescription('');
    setTaxable(true);
  }

  function add() {
    const item = currentItem();
    if (!item) return;
    onAdd(item);
    reset();
  }

  function collect(method: 'cash' | 'card' | 'split') {
    onCollect(method, currentItem());
    reset();
  }

  return (
    <div ref={containerRef} className="mt-4 flex flex-wrap gap-4 rounded-2xl border border-line-soft bg-card p-4 shadow-sm">
      {/* keys */}
      <div className="w-[360px] max-w-full flex-none max-[1080px]:w-full max-[1080px]:max-w-[440px]">
        <Keypad
          onDigit={(d) => setCents((c) => Math.min(c * 10 + d, 9_999_999))}
          onDoubleZero={() => setCents((c) => Math.min(c * 100, 9_999_999))}
          onBackspace={() => setCents((c) => Math.floor(c / 10))}
          onClear={() => setCents(0)}
        />
      </div>

      {/* display + controls */}
      <div className="flex min-w-[300px] flex-1 flex-col gap-2.5">
        <div className="rounded-xl bg-navy px-5 py-3.5 text-right text-[40px] leading-tight font-extrabold text-orange">
          {formatCents(cents)}
        </div>

        {/* fast amounts */}
        <div className="grid grid-cols-4 gap-2.5">
          {QUICK_AMOUNTS.map((v) => (
            <button
              key={v}
              onClick={() => setCents(v)}
              className={`h-13 min-h-[52px] rounded-xl text-[18px] font-bold ${
                cents === v ? 'bg-navy text-white' : 'border border-line bg-card text-ink'
              }`}
            >
              ${v / 100}
            </button>
          ))}
        </div>

        {/* one-tap labels + taxable */}
        <div className="flex flex-wrap items-center gap-2">
          {QUICK_LABELS.map((preset) => {
            const active = description === preset;
            return (
              <button
                key={preset}
                onClick={() => setDescription(active ? '' : preset)}
                className={`min-h-[42px] rounded-full px-4 text-[14px] font-semibold ${
                  active ? 'bg-orange-soft text-orange' : 'border border-line bg-card text-ink-2'
                }`}
              >
                {preset}
              </button>
            );
          })}
          <label className="ml-auto flex items-center gap-1.5 text-[13px] text-ink-3 select-none">
            <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} className="size-4 accent-[#f97316]" />
            Tax {(taxRateBp / 100).toFixed(taxRateBp % 100 === 0 ? 0 : 2)}%
          </label>
        </div>

        <input
          ref={descRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full rounded-[10px] border border-line bg-card px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-4 focus:border-orange focus:outline-none"
        />

        {/* actions */}
        <div className="mt-auto flex gap-2.5">
          <button
            onClick={add}
            disabled={cents <= 0}
            className="flex min-h-[60px] flex-1 items-center justify-center gap-2 rounded-xl bg-orange text-[17px] font-bold text-white disabled:opacity-40"
          >
            <i className="bi bi-plus-lg" /> Add to sale
          </button>
          <button
            onClick={() => collect('cash')}
            className="flex min-h-[60px] w-[96px] flex-col items-center justify-center rounded-xl bg-green text-[15.5px] font-bold text-white"
          >
            <i className="bi bi-cash text-[19px]" /> Cash
          </button>
          <button
            onClick={() => collect('card')}
            className="flex min-h-[60px] w-[96px] flex-col items-center justify-center rounded-xl bg-navy text-[15.5px] font-bold text-white"
          >
            <i className="bi bi-credit-card text-[19px]" /> Card
          </button>
          <button
            onClick={() => collect('split')}
            className="flex min-h-[60px] w-[96px] flex-col items-center justify-center rounded-xl border-2 border-navy bg-card text-[15.5px] font-bold text-navy"
          >
            <i className="bi bi-layout-split text-[19px]" /> Split
          </button>
        </div>
      </div>
    </div>
  );
});
