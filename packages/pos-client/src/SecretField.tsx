import { useId, useState } from 'react';

export function SecretField({ label, value, onChange, disabled, readOnly, hint, error, autoComplete = 'off', inputMode, maxLength }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; readOnly?: boolean; hint?: string; error?: string; autoComplete?: string; inputMode?: 'numeric'; maxLength?: number;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 5 }}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input id={id} type={visible ? 'text' : 'password'} value={value} disabled={disabled} readOnly={readOnly} autoComplete={autoComplete} inputMode={inputMode} maxLength={maxLength}
          autoCapitalize="none" spellCheck={false} onChange={e => onChange(e.target.value)}
          aria-invalid={Boolean(error)} aria-describedby={error ? id + '-error' : hint ? id + '-hint' : undefined}
          style={{ minWidth: 0, width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 16, color: 'var(--ink)', background: 'var(--card)' }} />
        <button type="button" disabled={disabled} aria-pressed={visible} aria-label={(visible ? 'Hide ' : 'Show ') + label.toLowerCase()}
          onClick={() => setVisible(!visible)} style={{ minWidth: 60, minHeight: 44, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', color: 'var(--ink)' }}>
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && <div id={id + '-hint'} style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 5 }}>{hint}</div>}
      {error && <div id={id + '-error'} role="alert" style={{ fontSize: 14, color: 'var(--red)', marginTop: 5 }}>{error}</div>}
    </div>
  );
}
