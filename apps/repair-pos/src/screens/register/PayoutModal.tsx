import { useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api } from '@fmp/pos-client';

/** Cash paid out of the register (audited drawer movement). */
export function PayoutModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<'drawer' | 'back_office'>('drawer');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const cents = parseDollars(amount || '0') ?? 0;

  async function pay() {
    if (cents <= 0 || reason.trim().length < 2) {
      setError('Amount and reason are required.');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ drawerOpened: boolean }>('/api/drawer/movement', {
        method: 'POST',
        body: JSON.stringify({ kind: 'paid_out', amountCents: cents, reason: reason.trim(), source }),
      });
      onDone(
        source === 'drawer'
          ? `Paid out ${formatCents(cents)} from the drawer${res.drawerOpened ? ' — drawer opened' : ' — drawer offline, open it by key'}`
          : `Paid out ${formatCents(cents)} from the back office — drawer untouched`,
      );
      setAmount('');
      setReason('');
      setSource('drawer');
      setError('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Payout</h2>
      <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--ink-3)' }}>
        Every payout is logged with your name. Pick where the cash comes from.
      </p>
      <div role="radiogroup" aria-label="Cash source" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        {(
          [
            { id: 'drawer', icon: 'bi-cash-stack', label: 'From drawer', caption: 'Opens the cash drawer and counts against it' },
            { id: 'back_office', icon: 'bi-safe2', label: 'From back office', caption: 'Drawer stays closed and is not affected' },
          ] as const
        ).map((o) => {
          const active = source === o.id;
          return (
            <button
              key={o.id}
              role="radio"
              aria-checked={active}
              onClick={() => setSource(o.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                textAlign: 'left',
                padding: '10px 14px',
                borderRadius: 12,
                border: `1.5px solid ${active ? 'var(--orange)' : 'var(--line)'}`,
                background: active ? 'var(--orange-soft)' : 'var(--card)',
              }}
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: active ? 'var(--orange)' : 'var(--line-soft)',
                  color: active ? '#fff' : 'var(--ink-2)',
                }}
              >
                <i className={`bi ${o.icon}`} style={{ fontSize: 18 }} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', font: '700 14.5px Inter, sans-serif', color: active ? 'var(--orange)' : 'var(--ink)' }}>{o.label}</span>
                <span style={{ display: 'block', fontSize: 12, lineHeight: 1.3, color: 'var(--ink-3)' }}>{o.caption}</span>
              </span>
            </button>
          );
        })}
      </div>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount $ *"
        style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason * — e.g. parts run, window cleaner"
        style={{ width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
      />
      {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || cents <= 0} onClick={() => void pay()}>
          Pay out {formatCents(cents)} {source === 'drawer' ? '· open drawer' : '· back office'}
        </Button>
      </div>
    </Modal>
  );
}
