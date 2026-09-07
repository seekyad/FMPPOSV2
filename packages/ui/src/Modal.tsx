import type { CSSProperties, ReactNode } from 'react';

export function Modal({
  open,
  onClose,
  width = 560,
  children,
  style,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17, 24, 39, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 40px)',
          overflow: 'auto',
          background: 'var(--card)',
          borderRadius: 20,
          boxShadow: 'var(--shadow)',
          padding: 24,
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
}
