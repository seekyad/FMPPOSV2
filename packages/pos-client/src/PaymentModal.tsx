import { useEffect, useMemo, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Button, Keypad, Modal } from '@fmp/ui';
import { api } from './api';
import type { CartCustomer } from './cart';

export interface PaymentDraft {
  method: 'cash' | 'card' | 'tap' | 'store_credit';
  amountCents: number;
  tenderedCents?: number;
}

/**
 * Take-payment modal: cash keypad with change, card/tap manual confirm
 * (Dejavoo integration lands in Phase 3), store credit when available,
 * and split payments by adding a partial payment first.
 */
export function PaymentModal({
  open,
  dueCents,
  customer,
  busy,
  initialMethod = 'cash',
  onClose,
  onComplete,
}: {
  open: boolean;
  dueCents: number;
  customer: CartCustomer | null;
  busy: boolean;
  initialMethod?: PaymentDraft['method'];
  onClose: () => void;
  onComplete: (payments: PaymentDraft[]) => void;
}) {
  const [taken, setTaken] = useState<PaymentDraft[]>([]);
  const [method, setMethod] = useState<PaymentDraft['method']>('cash');
  const [tendered, setTendered] = useState(0);
  const [partial, setPartial] = useState<number | null>(null); // null = pay the remainder
  const [terminalConfigured, setTerminalConfigured] = useState(false);
  const [terminalState, setTerminalState] = useState<'idle' | 'waiting' | 'declined'>('idle');
  const [terminalMsg, setTerminalMsg] = useState('');

  useEffect(() => {
    if (open) {
      setMethod(initialMethod);
      void api<{ configured: boolean }>('/api/terminal/status')
        .then((s) => setTerminalConfigured(s.configured))
        .catch(() => setTerminalConfigured(false));
    }
  }, [open, initialMethod]);

  const remaining = dueCents - taken.reduce((s, p) => s + p.amountCents, 0);
  const amount = partial ?? remaining;
  const change = method === 'cash' ? tendered - amount : 0;
  const credit = customer?.storeCreditCents ?? 0;

  const canConfirm = useMemo(() => {
    if (amount <= 0 || amount > remaining) return false;
    if (method === 'cash') return tendered >= amount;
    if (method === 'store_credit') return credit >= amount;
    return true;
  }, [amount, remaining, method, tendered, credit]);

  function reset() {
    setTaken([]);
    setMethod('cash');
    setTendered(0);
    setPartial(null);
  }

  function confirmCurrent() {
    const p: PaymentDraft = {
      method,
      amountCents: amount,
      tenderedCents: method === 'cash' ? tendered : undefined,
    };
    const nextTaken = [...taken, p];
    const nextRemaining = dueCents - nextTaken.reduce((s, x) => s + x.amountCents, 0);
    if (nextRemaining <= 0) {
      onComplete(nextTaken);
      reset();
    } else {
      setTaken(nextTaken);
      setPartial(null);
      setTendered(0);
      setMethod('cash');
    }
  }

  const methods: Array<{ id: PaymentDraft['method']; label: string; icon: string; disabled?: boolean }> = [
    { id: 'cash', label: 'Cash', icon: 'bi-cash' },
    { id: 'card', label: 'Card', icon: 'bi-credit-card' },
    { id: 'tap', label: 'Tap / wallet', icon: 'bi-phone' },
    {
      id: 'store_credit',
      label: `Store credit${customer ? ` · ${formatCents(credit)}` : ''}`,
      icon: 'bi-wallet2',
      disabled: !customer || credit <= 0,
    },
  ];

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      width={480}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>Take payment</h2>
        <div style={{ font: '800 25.5px Inter, sans-serif' }}>{formatCents(remaining)}</div>
      </div>
      {taken.length > 0 && (
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--line-soft)', borderRadius: 10, fontSize: 14 }}>
          {taken.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ textTransform: 'capitalize' }}>{p.method.replace('_', ' ')}</span>
              <span>{formatCents(p.amountCents)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 14 }}>
        {methods.map((m) => (
          <button
            key={m.id}
            disabled={m.disabled}
            onClick={() => setMethod(m.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 14px',
              borderRadius: 10,
              border: `1.5px solid ${method === m.id ? 'var(--navy)' : 'var(--line)'}`,
              background: method === m.id ? 'var(--navy)' : 'var(--card)',
              color: method === m.id ? '#fff' : 'var(--ink)',
              font: '600 15px Inter, sans-serif',
              opacity: m.disabled ? 0.45 : 1,
            }}
          >
            <i className={`bi ${m.icon}`} /> {m.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 14, color: 'var(--ink-3)' }}>Paying now</span>
        <input
          value={(amount / 100).toFixed(2)}
          onChange={(e) => {
            const v = Math.round(parseFloat(e.target.value || '0') * 100);
            setPartial(Number.isFinite(v) ? Math.max(0, Math.min(v, remaining)) : 0);
          }}
          style={{ width: 90, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', font: '600 15px Inter, sans-serif' }}
        />
        {partial != null && partial < remaining && (
          <span style={{ fontSize: 12.5, color: 'var(--amber)' }}>
            Split: {formatCents(remaining - partial)} left after this
          </span>
        )}
      </div>

      {method === 'cash' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginTop: 12 }}>
            {[500, 1000, 2000, 5000, 10000].map((v) => (
              <button
                key={v}
                onClick={() => setTendered(v)}
                style={{
                  padding: '9px 0',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: tendered === v ? 'var(--navy)' : 'var(--card)',
                  color: tendered === v ? '#fff' : 'var(--ink)',
                  font: '600 14px Inter, sans-serif',
                }}
              >
                ${v / 100}
              </button>
            ))}
            <button
              onClick={() => setTendered(amount)}
              style={{
                padding: '9px 0',
                borderRadius: 10,
                border: '1px solid var(--line)',
                background: tendered === amount && amount > 0 ? 'var(--navy)' : 'var(--card)',
                color: tendered === amount && amount > 0 ? '#fff' : 'var(--ink)',
                font: '600 14px Inter, sans-serif',
              }}
            >
              Exact
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, marginTop: 12 }}>
            <Keypad
              onDigit={(d) => setTendered((c) => Math.min(c * 10 + d, 9_999_999))}
              onDoubleZero={() => setTendered((c) => Math.min(c * 100, 9_999_999))}
              onBackspace={() => setTendered((c) => Math.floor(c / 10))}
              onClear={() => setTendered(0)}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ font: '600 10.5px Inter, sans-serif', color: 'var(--ink-4)' }}>TENDERED</div>
                <div style={{ font: '700 20.5px Inter, sans-serif' }}>{formatCents(tendered)}</div>
              </div>
              <div
                style={{
                  border: `1px solid ${change >= 0 ? 'var(--green-line)' : 'var(--red-line)'}`,
                  background: change >= 0 ? 'var(--green-bg)' : 'var(--red-bg)',
                  color: change >= 0 ? 'var(--green)' : 'var(--red)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  flex: 1,
                }}
              >
                <div style={{ font: '600 10.5px Inter, sans-serif' }}>{change >= 0 ? 'CHANGE BACK' : 'STILL DUE'}</div>
                <div style={{ font: '800 27.5px Inter, sans-serif' }}>{formatCents(Math.abs(change))}</div>
              </div>
            </div>
          </div>
        </>
      )}

      {(method === 'card' || method === 'tap') && (
        <div
          style={{
            marginTop: 14,
            padding: '14px 16px',
            border: '1px dashed var(--line)',
            borderRadius: 12,
            fontSize: 15,
            color: 'var(--ink-2)',
          }}
        >
          {terminalConfigured ? (
            <>
              <Button
                variant="dark"
                style={{ width: '100%' }}
                disabled={terminalState === 'waiting'}
                onClick={async () => {
                  setTerminalState('waiting');
                  setTerminalMsg('');
                  try {
                    const res = await api<{ approved: boolean; responseMessage: string }>('/api/terminal/charge', {
                      method: 'POST',
                      body: JSON.stringify({ amountCents: amount }),
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
              >
                {terminalState === 'waiting' ? (
                  <>Waiting for card on terminal…</>
                ) : (
                  <>
                    <i className="bi bi-credit-card-2-front" /> Send {formatCents(amount)} to Dejavoo terminal
                  </>
                )}
              </Button>
              {terminalState === 'declined' && (
                <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 6 }}>{terminalMsg}</div>
              )}
              <div style={{ fontSize: 12.5, color: 'var(--ink-4)', marginTop: 6 }}>
                Or run it on the terminal yourself and confirm below.
              </div>
            </>
          ) : (
            <>
              <i className="bi bi-credit-card-2-front" /> Run {formatCents(amount)} on the terminal, then confirm below.
              <div style={{ fontSize: 12.5, color: 'var(--ink-4)', marginTop: 4 }}>
                Add Dejavoo credentials in More → Store & payments to send the amount automatically.
              </div>
            </>
          )}
        </div>
      )}

      {method === 'store_credit' && customer && (
        <div style={{ marginTop: 14, padding: '15px 16px', background: 'var(--purple-bg)', color: 'var(--purple)', borderRadius: 12, fontSize: 15 }}>
          {customer.name} has {formatCents(credit)} in store credit.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
          Cancel
        </Button>
        <Button variant="primary" size="lg" disabled={!canConfirm || busy} onClick={confirmCurrent}>
          {busy
            ? 'Saving…'
            : amount < remaining
              ? `Add ${formatCents(amount)} payment`
              : method === 'cash'
                ? `Complete · change ${formatCents(Math.max(change, 0))}`
                : `Complete · ${formatCents(amount)}`}
        </Button>
      </div>
    </Modal>
  );
}
