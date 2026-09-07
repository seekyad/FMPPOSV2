import type { CSSProperties } from 'react';

/** Cash keypad matching the design's custom-item modal: digits, 00, backspace, C, decimal-free cent entry. */
export function Keypad({
  onDigit,
  onDoubleZero,
  onBackspace,
  onClear,
}: {
  onDigit: (d: number) => void;
  onDoubleZero: () => void;
  onBackspace: () => void;
  onClear: () => void;
}) {
  const key = (label: string, onClick: () => void, style?: CSSProperties) => (
    <button
      key={label}
      onClick={onClick}
      style={{
        height: 64,
        borderRadius: 12,
        border: '1px solid var(--line)',
        background: 'var(--card)',
        font: '600 22px Inter, sans-serif',
        color: 'var(--ink)',
        ...style,
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {key('7', () => onDigit(7))}
      {key('8', () => onDigit(8))}
      {key('9', () => onDigit(9))}
      {key('⌫', onBackspace, { background: 'var(--line-soft)' })}
      {key('4', () => onDigit(4))}
      {key('5', () => onDigit(5))}
      {key('6', () => onDigit(6))}
      {key('00', onDoubleZero, { background: 'var(--line-soft)' })}
      {key('1', () => onDigit(1))}
      {key('2', () => onDigit(2))}
      {key('3', () => onDigit(3))}
      <span />
      {key('C', onClear, { background: 'var(--red-bg)', color: 'var(--red)' })}
      {key('0', () => onDigit(0))}
    </div>
  );
}
