import { useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api } from '../../api';

/** Take a deposit against a repair ticket. */
export function DepositModal({
  ticket,
  onClose,
  onDone,
}: {
  ticket: { id: number; number: string; balanceCents: number } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<'cash' | 'card' | 'tap'>('cash');
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const amountCents = parseDollars(amount || '0') ?? 0;
  const tenderedCents = parseDollars(tendered || '0') ?? 0;
  const change = method === 'cash' && tenderedCents > 0 ? tenderedCents - amountCents : null;

  async function take() {
    if (!ticket || amountCents <= 0) {
      setError('Enter a deposit amount.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/repairs/${ticket.id}/deposit`, {
        method: 'POST',
        body: JSON.stringify({
          method,
          amountCents,
          tenderedCents: method === 'cash' && tenderedCents > 0 ? tenderedCents : null,
        }),
      });
      setAmount('');
      setTendered('');
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deposit failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={ticket !== null} onClose={onClose} width={380}>
      <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>Take deposit · {ticket?.number}</h2>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ink-3)' }}>
        Balance {formatCents(ticket?.balanceCents ?? 0)} — rest is collected at pickup.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {(['cash', 'card', 'tap'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            style={{
              flex: 1,
              padding: '9px 0',
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: method === m ? 'var(--navy)' : 'var(--card)',
              color: method === m ? '#fff' : 'var(--ink-2)',
              font: '600 12px Inter, sans-serif',
              textTransform: 'capitalize',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Deposit $ *"
          style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
        />
        <Button variant="secondary" onClick={() => ticket && setAmount((ticket.balanceCents / 100).toFixed(2))}>
          Full balance
        </Button>
      </div>
      {method === 'cash' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input
            value={tendered}
            onChange={(e) => setTendered(e.target.value)}
            placeholder="Cash tendered $"
            style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
          {change != null && (
            <span style={{ font: '700 13px Inter, sans-serif', color: change >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {change >= 0 ? `Change ${formatCents(change)}` : `Short ${formatCents(-change)}`}
            </span>
          )}
        </div>
      )}
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || amountCents <= 0} onClick={() => void take()}>
          Take {formatCents(amountCents)} deposit
        </Button>
      </div>
    </Modal>
  );
}
