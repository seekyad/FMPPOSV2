import type { CSSProperties, ReactNode } from 'react';

export type ChipTone = 'green' | 'red' | 'blue' | 'purple' | 'amber' | 'orange' | 'neutral';

const TONES: Record<ChipTone, { bg: string; fg: string }> = {
  green: { bg: 'var(--green-bg)', fg: 'var(--green)' },
  red: { bg: 'var(--red-bg)', fg: 'var(--red)' },
  blue: { bg: 'var(--blue-bg)', fg: 'var(--blue)' },
  purple: { bg: 'var(--purple-bg)', fg: 'var(--purple)' },
  amber: { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  orange: { bg: 'var(--orange-soft)', fg: 'var(--orange)' },
  neutral: { bg: 'var(--line-soft)', fg: 'var(--ink-2)' },
};

export function StatusChip({ tone, children, style }: { tone: ChipTone; children: ReactNode; style?: CSSProperties }) {
  const t = TONES[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 12px',
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        font: '600 13px Inter, sans-serif',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
