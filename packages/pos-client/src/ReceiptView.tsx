import type { CSSProperties } from 'react';

/** The receipt's notes (terms + footer) follow a dotted rule; mirror of the server's splitReceiptNotes. */
function splitNotes(text: string): { body: string; notes: string | null } {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.length >= 10 && /^\.+$/.test(l));
  if (at < 0) return { body: text, notes: null };
  return { body: lines.slice(0, at).join('\n').replace(/\n+$/, ''), notes: lines.slice(at + 1).join('\n').trim() };
}

/**
 * On-screen receipt: the columned body in a clear monospace face, and the notes
 * underneath in the app's own type so terms and the thank-you line are easy to read.
 */
export function ReceiptView({ text, style }: { text: string; style?: CSSProperties }) {
  const { body, notes } = splitNotes(text);
  return (
    <div style={{ background: 'var(--line-soft)', borderRadius: 12, padding: '12px 14px', textAlign: 'left', userSelect: 'text', ...style }}>
      <pre
        style={{
          margin: 0,
          fontSize: 13.5,
          lineHeight: 1.5,
          fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", ui-monospace, monospace',
          color: 'var(--ink)',
          overflow: 'auto',
        }}
      >
        {body}
      </pre>
      {notes && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px dashed var(--line)',
            font: '500 14.5px Inter, sans-serif',
            lineHeight: 1.5,
            color: 'var(--ink-2)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {notes}
        </div>
      )}
    </div>
  );
}
