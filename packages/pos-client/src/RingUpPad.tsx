import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Keypad } from '@fmp/ui';

export interface RingUpPadHandle {
  focus: () => void;
}

/**
 * The always-visible ring-up station on the Register: punch an amount like a
 * physical register, optional description, straight into the current sale.
 */
export const RingUpPad = forwardRef<
  RingUpPadHandle,
  {
    taxRateBp: number;
    onAdd: (item: { description: string; unitCents: number; taxable: boolean }) => void;
  }
>(function RingUpPad({ taxRateBp, onAdd }, ref) {
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

  function add() {
    if (cents <= 0) return;
    onAdd({ description: description.trim() || 'Custom item', unitCents: cents, taxable });
    setCents(0);
    setDescription('');
    setTaxable(true);
  }

  return (
    <div
      ref={containerRef}
      className="mt-4 flex flex-wrap gap-4 rounded-2xl border border-line-soft bg-card p-4 shadow-sm"
    >
      {/* keys */}
      <div className="w-[340px] max-w-full flex-none max-[1080px]:w-full max-[1080px]:max-w-[420px]">
        <Keypad
          onDigit={(d) => setCents((c) => Math.min(c * 10 + d, 9_999_999))}
          onDoubleZero={() => setCents((c) => Math.min(c * 100, 9_999_999))}
          onBackspace={() => setCents((c) => Math.floor(c / 10))}
          onClear={() => setCents(0)}
        />
      </div>
      {/* display + controls */}
      <div className="flex min-w-[260px] flex-1 flex-col gap-2.5">
        <div className="rounded-xl bg-navy px-5 py-4 text-right text-[38px] font-extrabold text-orange">
          {formatCents(cents)}
        </div>
        <div className="flex flex-wrap gap-2">
          {['Quick repair — walk-in', 'Accessory', 'Service fee'].map((preset) => {
            const active = description === preset;
            return (
              <button
                key={preset}
                onClick={() => setDescription(active ? '' : preset)}
                className={`rounded-full px-4 py-2 text-[13.5px] font-semibold ${
                  active ? 'bg-navy text-white' : 'border border-line bg-card text-ink-2'
                }`}
              >
                {preset}
              </button>
            );
          })}
        </div>
        <input
          ref={descRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional) — e.g. Water damage cleaning"
          className="w-full rounded-[10px] border border-line bg-card px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-4 focus:border-orange focus:outline-none"
        />
        <label className="flex items-center gap-2 text-[13.5px] text-ink-3 select-none">
          <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} className="size-4 accent-[#f97316]" />
          Taxable at {(taxRateBp / 100).toFixed(taxRateBp % 100 === 0 ? 0 : 2)}% · applied at checkout
        </label>
        <button
          onClick={add}
          disabled={cents <= 0}
          className="mt-auto flex min-h-[56px] items-center justify-center gap-2 rounded-xl bg-orange text-[17px] font-bold text-white disabled:opacity-40"
        >
          <i className="bi bi-plus-lg" /> Add to sale{cents > 0 ? ` · ${formatCents(cents)}` : ''}
        </button>
      </div>
    </div>
  );
});
