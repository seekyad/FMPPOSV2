import type { ReactNode } from 'react';
import { useNarrow } from './useNarrow';

/**
 * Detail panel that sits beside the content on wide screens and becomes a
 * slide-over drawer on tablet-portrait widths.
 */
export function SidePanel({
  open,
  onClose,
  width = 340,
  children,
}: {
  /** narrow mode only: whether the drawer is visible */
  open: boolean;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  const narrow = useNarrow();

  if (!narrow) {
    return (
      <div
        style={{
          width,
          flexShrink: 0,
          background: 'var(--card)',
          borderLeft: '1px solid var(--line-soft)',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    );
  }

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(17,24,39,0.45)' }} />
      <div
        style={{
          position: 'relative',
          width: 'min(440px, 94vw)',
          height: '100%',
          background: 'var(--card)',
          boxShadow: 'var(--shadow)',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close panel"
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            zIndex: 2,
            width: 38,
            height: 38,
            borderRadius: 999,
            border: 'none',
            background: 'var(--line-soft)',
            color: 'var(--ink-2)',
            fontSize: 15,
          }}
        >
          <i className="bi bi-x-lg" />
        </button>
        {children}
      </div>
    </div>
  );
}
