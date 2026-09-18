import { useEffect, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Button, Keypad } from '@fmp/ui';

/**
 * Register-style money entry on the shared keypad: digits shift in as cents
 * (1 → $0.01, 1-5 → $0.15, 1-5-0-0 → $15.00), 00 adds two zeros, ⌫ drops one,
 * C clears. Sits above every modal and window (z 130) so it works from the
 * repair window too. Commits on Done.
 */
export function MoneyKeypadSheet({
  open,
  label,
  cents,
  onCommit,
  onClose,
}: {
  open: boolean;
  label: string;
  cents: number;
  onCommit: (cents: number) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return <Body key={label + ':' + cents} label={label} cents={cents} onCommit={onCommit} onClose={onClose} />;
}

function Body({ label, cents, onCommit, onClose }: { label: string; cents: number; onCommit: (cents: number) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(cents);
  // first keystroke replaces the seeded value instead of appending to it
  const [fresh, setFresh] = useState(true);
  const push = (next: (current: number) => number) =>
    setDraft((d) => {
      const base = fresh ? 0 : d;
      return Math.min(next(base), 9_999_999);
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter') {
        onCommit(draft);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, onCommit, onClose]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(17, 24, 39, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 380, maxWidth: '100%', background: 'var(--card)', borderRadius: 20, boxShadow: 'var(--shadow)', padding: 22 }}
      >
        <div style={{ font: '600 11.5px Inter, sans-serif', letterSpacing: '0.06em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>Price</div>
        <div style={{ marginTop: 2, font: '600 14.5px Inter, sans-serif', color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>{label}</div>
        <div
          data-testid="money-keypad-value"
          style={{
            marginTop: 10,
            marginBottom: 14,
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid var(--line)',
            background: 'var(--line-soft)',
            font: '800 30px Inter, sans-serif',
            textAlign: 'right',
            color: fresh ? 'var(--ink-3)' : 'var(--ink)',
          }}
        >
          {formatCents(draft)}
        </div>
        <Keypad
          onDigit={(d) => {
            push((b) => b * 10 + d);
            setFresh(false);
          }}
          onDoubleZero={() => {
            push((b) => b * 100);
            setFresh(false);
          }}
          onBackspace={() => {
            setDraft((d) => Math.floor(d / 10));
            setFresh(false);
          }}
          onClear={() => {
            setDraft(0);
            setFresh(false);
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onCommit(draft);
              onClose();
            }}
          >
            Set {formatCents(draft)}
          </Button>
        </div>
      </div>
    </div>
  );
}
