import { useEffect, useMemo, useState } from 'react';
import { formatCents, parseDollars, tradeInOffer, type TradeInCondition, type TradeInConfig } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api } from '../../api';
import type { CartCustomer } from '../../cart';

interface PricebookRow {
  id: number;
  modelId: number;
  storage: string;
  baseValueCents: number;
  modelName: string;
  brand: string;
}

const CONDITIONS: Array<{ id: TradeInCondition; label: string; sub: string; note: string }> = [
  { id: 'good', label: 'Good', sub: 'Full value', note: 'Clean screen, holds charge, no frame damage' },
  { id: 'fair', label: 'Fair', sub: '75% of value', note: 'Light scratches or worn battery — resells as B-grade' },
  { id: 'broken', label: 'Broken', sub: '40% of value', note: 'Cracked glass or dead board — parts value only' },
];

/** Design-faithful trade-in modal: pricebook offer, condition, payout, manual override. */
export function TradeInModal({
  open,
  customer,
  onClose,
  onDone,
}: {
  open: boolean;
  customer: CartCustomer | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [book, setBook] = useState<PricebookRow[]>([]);
  const [config, setConfig] = useState<TradeInConfig | null>(null);
  const [rowId, setRowId] = useState<number | ''>('');
  const [imei, setImei] = useState('');
  const [condition, setCondition] = useState<TradeInCondition>('good');
  const [payout, setPayout] = useState<'cash' | 'credit'>('cash');
  const [manual, setManual] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    void api<{ rows: PricebookRow[]; config: TradeInConfig }>('/api/tradein/pricebook')
      .then((res) => {
        setBook(res.rows);
        setConfig(res.config);
        if (res.rows.length > 0 && rowId === '') setRowId(res.rows[0]!.id);
      })
      .catch(() => {});
  }, [open]);

  const row = book.find((b) => b.id === rowId);
  const suggested = useMemo(
    () => (row && config ? tradeInOffer(row.baseValueCents, condition, payout, config) : null),
    [row, config, condition, payout],
  );
  const isManual = manual !== null;
  const offerCents = isManual ? (parseDollars(manual || '0') ?? 0) : (suggested ?? 0);

  function reset() {
    setImei('');
    setCondition('good');
    setPayout('cash');
    setManual(null);
    setError('');
  }

  async function accept() {
    if (!row) return;
    if (payout === 'credit' && !customer) {
      setError('Attach a customer to the sale first — store credit needs an account.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/tradein', {
        method: 'POST',
        body: JSON.stringify({
          modelId: row.modelId,
          storage: row.storage,
          imei: imei || null,
          condition,
          payout,
          customerId: customer?.id ?? null,
          manualOfferCents: isManual ? offerCents : null,
        }),
      });
      onDone(
        payout === 'cash'
          ? `Paid out ${formatCents(offerCents)} cash · device added to Inventory › Trade-ins`
          : `Issued ${formatCents(offerCents)} store credit to ${customer!.name}`,
      );
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Trade-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} width={480}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>Trade-in</h2>
          <p style={{ margin: '2px 0 0', color: 'var(--ink-3)', fontSize: 12 }}>Buying a device from the customer</p>
        </div>
        <button onClick={onClose} style={{ border: 'none', background: 'var(--line-soft)', borderRadius: 999, width: 28, height: 28 }}>
          <i className="bi bi-x" />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <select
          value={rowId}
          onChange={(e) => setRowId(e.target.value === '' ? '' : Number(e.target.value))}
          style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13, background: 'var(--card)' }}
        >
          {book.map((b) => (
            <option key={b.id} value={b.id}>
              {b.modelName} · {b.storage} — base {formatCents(b.baseValueCents)}
            </option>
          ))}
        </select>
        <input
          value={imei}
          onChange={(e) => setImei(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="Scan IMEI"
          style={{ width: 130, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
        />
      </div>

      <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '14px 0 6px' }}>CONDITION</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {CONDITIONS.map((c) => (
          <button
            key={c.id}
            onClick={() => setCondition(c.id)}
            style={{
              flex: 1,
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 12,
              border: `1.5px solid ${condition === c.id ? 'var(--orange)' : 'var(--line)'}`,
              background: condition === c.id ? 'var(--orange-soft)' : 'var(--card)',
            }}
          >
            <div style={{ font: '700 13px Inter, sans-serif' }}>{c.label}</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{c.sub}</div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 5 }}>
        {CONDITIONS.find((c) => c.id === condition)?.note}
      </div>

      <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '14px 0 6px' }}>PAY OUT AS</div>
      <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
        {(
          [
            ['cash', 'Cash'],
            ['credit', `Store credit · +${config ? config.creditBonusBp / 100 : 10}%`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPayout(id)}
            style={{
              flex: 1,
              padding: '10px 0',
              border: 'none',
              background: payout === id ? 'var(--navy)' : 'var(--card)',
              color: payout === id ? '#fff' : 'var(--ink)',
              font: '600 13px Inter, sans-serif',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        style={{
          marginTop: 12,
          background: 'var(--navy)',
          borderRadius: 14,
          padding: '14px 18px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ color: '#9aa1ad', fontSize: 11 }}>
          <div style={{ font: '600 9px Inter, sans-serif', letterSpacing: '0.08em' }}>OFFER</div>
          {isManual ? `Manual override · suggested was ${suggested != null ? formatCents(suggested) : '—'}` : payout === 'credit' ? 'Store credit · includes bonus' : 'Cash from drawer'}
        </div>
        <div style={{ color: 'var(--orange)', font: '800 30px Inter, sans-serif' }}>{formatCents(offerCents)}</div>
      </div>

      {isManual ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <input
            autoFocus
            value={manual ?? ''}
            onChange={(e) => setManual(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="Manual offer $"
            style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--orange)', fontSize: 13 }}
          />
          <Button variant="ghost" onClick={() => setManual(null)}>
            Back to suggested
          </Button>
        </div>
      ) : (
        <button
          onClick={() => setManual(suggested != null ? (suggested / 100).toFixed(2) : '')}
          style={{ width: '100%', marginTop: 10, padding: '9px 0', borderRadius: 10, border: '1px dashed var(--line)', background: 'var(--card)', color: 'var(--ink-2)', font: '600 12px Inter, sans-serif' }}
        >
          <i className="bi bi-pencil" /> Enter amount manually — manual amounts are logged against your ID
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 11, color: 'var(--ink-4)' }}>
        <i className="bi bi-person-badge" /> ID checked and photographed · device added to Inventory › Trade-ins
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Button variant="ghost" style={{ flex: 1 }} onClick={() => { reset(); onClose(); }}>
          Cancel
        </Button>
        <Button variant="primary" size="lg" style={{ flex: 2 }} disabled={busy || offerCents <= 0} onClick={() => void accept()}>
          {payout === 'credit' ? 'Issue store credit' : 'Pay out cash'} · {formatCents(offerCents)}
        </Button>
      </div>
    </Modal>
  );
}
