import { useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Button, Keypad, Modal } from '@fmp/ui';

/**
 * Design-faithful custom item modal: description, big amount display,
 * quick-cash tender preview with change back, keypad, add to sale.
 */
export function CustomItemModal({
  open,
  taxRateBp,
  onClose,
  onAdd,
}: {
  open: boolean;
  taxRateBp: number;
  onClose: () => void;
  onAdd: (item: { description: string; unitCents: number; taxable: boolean }) => void;
}) {
  const [description, setDescription] = useState('');
  const [cents, setCents] = useState(0);
  const [tendered, setTendered] = useState(0);
  const [taxable, setTaxable] = useState(true);

  function reset() {
    setDescription('');
    setCents(0);
    setTendered(0);
    setTaxable(true);
  }

  const changeBack = tendered - cents;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      width={420}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>Custom item</h2>
          <p style={{ margin: '2px 0 0', color: 'var(--ink-3)', fontSize: 12 }}>
            Type a price, then add it to the current sale
          </p>
        </div>
        <button onClick={onClose} style={{ border: 'none', background: 'var(--line-soft)', borderRadius: 999, width: 28, height: 28 }}>
          <i className="bi bi-x" />
        </button>
      </div>

      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description — e.g. Water damage cleaning"
        style={{
          width: '100%',
          marginTop: 14,
          padding: '11px 13px',
          borderRadius: 10,
          border: '1px solid var(--line)',
          fontSize: 13,
        }}
      />

      <div
        style={{
          marginTop: 12,
          background: 'var(--navy)',
          borderRadius: 14,
          padding: '18px 18px',
          textAlign: 'right',
          color: 'var(--orange)',
          font: '800 32px Inter, sans-serif',
        }}
      >
        {formatCents(cents)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 10 }}>
        {[
          { label: 'ITEM PRICE', value: formatCents(cents), highlight: false },
          { label: 'CASH TENDERED', value: formatCents(tendered), highlight: false },
          {
            label: changeBack >= 0 ? 'CHANGE BACK' : 'STILL DUE',
            value: formatCents(Math.abs(changeBack)),
            highlight: true,
          },
        ].map((cell) => (
          <div
            key={cell.label}
            style={{
              border: `1px solid ${cell.highlight ? 'var(--green-line)' : 'var(--line)'}`,
              background: cell.highlight ? 'var(--green-bg)' : 'var(--card)',
              color: cell.highlight ? 'var(--green)' : 'var(--ink)',
              borderRadius: 10,
              padding: '8px 10px',
            }}
          >
            <div style={{ font: '600 9px Inter, sans-serif', color: cell.highlight ? 'var(--green)' : 'var(--ink-4)' }}>
              {cell.label}
            </div>
            <div style={{ font: '700 13px Inter, sans-serif' }}>{cell.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginTop: 10 }}>
        {[500, 1000, 1500, 2000, 5000, 10000].map((v) => (
          <button
            key={v}
            onClick={() => setTendered(v)}
            style={{
              padding: '9px 0',
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: tendered === v ? 'var(--navy)' : 'var(--card)',
              color: tendered === v ? '#fff' : 'var(--ink)',
              font: '600 12px Inter, sans-serif',
            }}
          >
            ${v / 100}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 10 }}>
        <Keypad
          onDigit={(d) => setCents((c) => Math.min(c * 10 + d, 9_999_999))}
          onDoubleZero={() => setCents((c) => Math.min(c * 100, 9_999_999))}
          onBackspace={() => setCents((c) => Math.floor(c / 10))}
          onClear={() => setCents(0)}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--ink-3)' }}>
          <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
          Taxable at {(taxRateBp / 100).toFixed(taxRateBp % 100 === 0 ? 0 : 2)}% · applied at checkout
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={cents === 0}
            onClick={() => {
              onAdd({ description: description.trim() || 'Custom item', unitCents: cents, taxable });
              reset();
              onClose();
            }}
          >
            <i className="bi bi-plus-lg" /> Add to sale · {formatCents(cents)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
