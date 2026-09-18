import type { CSSProperties } from 'react';

/**
 * Register keypad, classic layout with every cell filled:
 *   7 8 9 ⌫
 *   4 5 6 ⌫   (backspace spans two rows)
 *   1 2 3 00
 *   0 ─── C
 */
const SIZES = {
  /** PIN screen, keypad sheets, code prompts */
  md: { height: 78, font: 27, gap: 10, radius: 14 },
  /** the register's ring-up pad: bigger targets for fast one-handed entry */
  lg: { height: 96, font: 34, gap: 12, radius: 16 },
} as const;

export function Keypad({
  onDigit,
  onDoubleZero,
  onBackspace,
  onClear,
  size = 'md',
  fill = false,
}: {
  onDigit: (d: number) => void;
  onDoubleZero: () => void;
  onBackspace: () => void;
  onClear: () => void;
  size?: keyof typeof SIZES;
  /** stretch the rows to fill the parent's height (keys never shrink below the size's height) */
  fill?: boolean;
}) {
  const s = SIZES[size];
  const key = (label: string, onClick: () => void, style?: CSSProperties) => (
    <button
      key={label}
      onClick={onClick}
      style={{
        height: fill ? '100%' : s.height,
        minHeight: fill ? s.height : undefined,
        borderRadius: s.radius,
        border: '1px solid var(--line)',
        background: 'var(--card)',
        font: `600 ${s.font}px Inter, sans-serif`,
        color: 'var(--ink)',
        ...style,
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gridTemplateRows: fill ? 'repeat(4, minmax(0, 1fr))' : undefined,
        gap: s.gap,
        height: fill ? '100%' : undefined,
        width: fill ? '100%' : undefined,
      }}
    >
      {key('7', () => onDigit(7))}
      {key('8', () => onDigit(8))}
      {key('9', () => onDigit(9))}
      {key('⌫', onBackspace, { background: 'var(--line-soft)', gridRow: 'span 2', height: fill ? '100%' : s.height * 2 + s.gap, minHeight: fill ? s.height * 2 + s.gap : undefined })}
      {key('4', () => onDigit(4))}
      {key('5', () => onDigit(5))}
      {key('6', () => onDigit(6))}
      {key('1', () => onDigit(1))}
      {key('2', () => onDigit(2))}
      {key('3', () => onDigit(3))}
      {key('00', onDoubleZero, { background: 'var(--line-soft)' })}
      {key('0', () => onDigit(0), { gridColumn: 'span 3' })}
      {key('C', onClear, { background: 'var(--red-bg)', color: 'var(--red)' })}
    </div>
  );
}
