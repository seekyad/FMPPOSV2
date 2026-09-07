import type { ButtonHTMLAttributes, CSSProperties } from 'react';

type Variant = 'primary' | 'secondary' | 'dark' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, CSSProperties> = {
  primary: { background: 'var(--orange)', color: '#fff', border: '1px solid var(--orange)' },
  secondary: { background: 'var(--card)', color: 'var(--ink)', border: '1px solid var(--line)' },
  dark: { background: 'var(--navy)', color: '#fff', border: '1px solid var(--navy)' },
  danger: { background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid var(--red-line)' },
  ghost: { background: 'transparent', color: 'var(--ink-2)', border: '1px solid transparent' },
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'lg';
}

export function Button({ variant = 'secondary', size = 'md', style, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 11,
        padding: size === 'lg' ? '16px 26px' : '12px 20px',
        minHeight: size === 'lg' ? 52 : 44,
        font: `600 ${size === 'lg' ? 17 : 15}px Inter, sans-serif`,
        transition: 'filter .1s',
        opacity: rest.disabled ? 0.5 : 1,
        ...VARIANTS[variant],
        ...style,
      }}
    />
  );
}
