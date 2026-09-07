import { useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api } from '@fmp/pos-client';

/** Cash paid out of the register (audited drawer movement). */
export function PayoutModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
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
      await api('/api/drawer/movement', {
        method: 'POST',
        body: JSON.stringify({ kind: 'paid_out', amountCents: cents, reason: reason.trim() }),
      });
      onDone(`Paid out ${formatCents(cents)} — logged to the drawer`);
      setAmount('');
      setReason('');
      setError('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={360}>
      <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>Payout</h2>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ink-3)' }}>
        Cash paid from the register — every payout is logged with your name.
      </p>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount $ *"
        style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason * — e.g. parts run, window cleaner"
        style={{ width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
      />
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || cents <= 0} onClick={() => void pay()}>
          Pay out {formatCents(cents)}
        </Button>
      </div>
    </Modal>
  );
}
