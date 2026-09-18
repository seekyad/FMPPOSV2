import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Keypad, Modal } from '@fmp/ui';
import { ScanModal } from './ScanModal';

export type CodeKind = 'imei' | 'serial' | 'sku';

const MAX_LENGTH: Record<CodeKind, number> = { imei: 15, serial: 40, sku: 40 };

/** Normalizes typed or scanned text for the field kind (IMEI = digits only; serial / SKU = no whitespace, upper-case). */
export function cleanCode(kind: CodeKind, raw: string): string {
  if (kind === 'imei') return raw.replace(/\D/g, '');
  return raw.replace(/\s+/g, '').toUpperCase();
}

const iconButton = (active: boolean): CSSProperties => ({
  width: 36,
  height: 36,
  borderRadius: 9,
  border: 'none',
  background: active ? 'var(--orange-soft)' : 'transparent',
  color: active ? 'var(--orange)' : 'var(--ink-3)',
  fontSize: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
});

/** A camera button that opens the scanner and hands the decoded text back. Drop it into any search box. */
export function ScanButton({
  onScan,
  title = 'Scan barcode',
  hint,
  style,
}: {
  onScan: (text: string) => void;
  title?: string;
  hint?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={title}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(true)}
        style={{ ...iconButton(open), ...style }}
      >
        <i className="bi bi-upc-scan" />
      </button>
      <ScanModal
        open={open}
        title={title}
        hint={hint}
        onClose={() => setOpen(false)}
        onScan={(text) => {
          setOpen(false);
          onScan(text);
        }}
      />
    </>
  );
}

/** On-screen number pad for tablets: edits a copy of the value and commits on Done. */
export function KeypadSheet({
  open,
  label,
  value,
  maxLength,
  onCommit,
  onClose,
}: {
  open: boolean;
  label: string;
  value: string;
  maxLength: number;
  onCommit: (value: string) => void;
  onClose: () => void;
}) {
  // the body only mounts while open, so the draft re-seeds from `value` on every open
  if (!open) return null;
  return <KeypadSheetBody label={label} value={value} maxLength={maxLength} onCommit={onCommit} onClose={onClose} />;
}

function KeypadSheetBody({
  label,
  value,
  maxLength,
  onCommit,
  onClose,
}: {
  label: string;
  value: string;
  maxLength: number;
  onCommit: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const append = (chars: string) => setDraft((d) => (d + chars).slice(0, maxLength));
  return (
    <Modal open onClose={onClose} width={380} style={{ padding: 22 }}>
      <div style={{ font: '600 11.5px Inter, sans-serif', letterSpacing: '0.06em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div
        data-testid="keypad-value"
        style={{
          marginTop: 8,
          marginBottom: 14,
          minHeight: 54,
          padding: '12px 14px',
          borderRadius: 12,
          border: '1px solid var(--line)',
          background: 'var(--line-soft)',
          font: '600 24px Inter, sans-serif',
          letterSpacing: '0.04em',
          color: draft ? 'var(--ink)' : 'var(--ink-4)',
          wordBreak: 'break-all',
        }}
      >
        {draft || 'Enter digits'}
      </div>
      <Keypad
        onDigit={(d) => append(String(d))}
        onDoubleZero={() => append('00')}
        onBackspace={() => setDraft((d) => d.slice(0, -1))}
        onClear={() => setDraft('')}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--ink-4)' }}>
          {draft.length}/{maxLength}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
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
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Text field for IMEI, serial-number and SKU entry. Besides the keyboard
 * (numeric on tablets for IMEI) it offers an on-screen keypad and a camera
 * scan button, and cleans whatever comes in for the code kind.
 */
export function CodeField({
  kind,
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
  disabled,
  style,
  inputStyle,
  inputClassName,
  keypad = true,
  scan = true,
  trailing,
}: {
  kind: CodeKind;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** shown as the keypad sheet title and scanner title; defaults from `kind` */
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** wrapper styles (width, margin…) */
  style?: CSSProperties;
  /** styles applied to the input itself — the wrapper carries the border by default */
  inputStyle?: CSSProperties;
  /** class names for the input, when the caller styles inputs with Tailwind */
  inputClassName?: string;
  keypad?: boolean;
  scan?: boolean;
  /** extra content rendered after the buttons */
  trailing?: ReactNode;
}) {
  const [padOpen, setPadOpen] = useState(false);
  const name = label ?? (kind === 'imei' ? 'IMEI' : kind === 'sku' ? 'SKU' : 'Serial number');
  const maxLength = MAX_LENGTH[kind];
  const buttons = (keypad ? 1 : 0) + (scan ? 1 : 0);

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%', minWidth: 0, ...style }}>
      <input
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(cleanCode(kind, e.target.value).slice(0, maxLength))}
        placeholder={placeholder ?? name}
        aria-label={name}
        inputMode={kind === 'imei' ? 'numeric' : 'text'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="done"
        maxLength={maxLength}
        className={inputClassName}
        style={{
          width: '100%',
          minWidth: 0,
          padding: '10px 12px',
          paddingRight: 8 + buttons * 38,
          borderRadius: 10,
          border: '1px solid var(--line)',
          fontSize: 15,
          background: 'var(--card)',
          ...inputStyle,
        }}
      />
      <div style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 2 }}>
        {keypad && (
          <button
            type="button"
            aria-label={`${name} keypad`}
            title="Keypad"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPadOpen(true)}
            style={iconButton(padOpen)}
          >
            <i className="bi bi-grid-3x3-gap-fill" />
          </button>
        )}
        {scan && (
          <ScanButton
            title={`Scan ${name}`}
            hint={`Point the camera at the ${name} barcode.`}
            onScan={(text) => onChange(cleanCode(kind, text))}
          />
        )}
        {trailing}
      </div>
      {keypad && (
        <KeypadSheet
          open={padOpen}
          label={name}
          value={value}
          maxLength={maxLength}
          onCommit={onChange}
          onClose={() => setPadOpen(false)}
        />
      )}
    </div>
  );
}
