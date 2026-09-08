import { code128Widths, getTagPrefs, type TicketLabelFields } from './labels';

/**
 * On-screen render of the 50 × 80 mm claim tag exactly as it will print —
 * same fields (per the Print center template), same layout, real barcode.
 */
export function TicketLabelPreview({ fields }: { fields: TicketLabelFields }) {
  const p = getTagPrefs();
  const widths = p.barcode ? code128Widths(fields.number) : null;
  const now = new Date();
  const hasHead = p.date || p.ticket || (p.customer && fields.customer) || (p.phone && fields.phone);
  const hasBody =
    (p.device && fields.device) ||
    (p.repair && fields.issue) ||
    (p.passcode && fields.passcode) ||
    (p.notes && fields.notes) ||
    (p.promise && fields.promised);

  return (
    <div
      style={{
        width: 189,
        height: 302,
        background: '#fff',
        color: '#111',
        border: '1px solid var(--line)',
        borderRadius: 2,
        padding: '12px 12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        flexShrink: 0,
      }}
    >
      {p.date && (
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })}{' '}
          {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </span>
      )}
      {p.ticket && <span style={{ fontSize: 11, fontWeight: 700, color: '#555' }}>Ticket {fields.number}</span>}
      {p.customer && fields.customer && (
        <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.01em' }}>{fields.customer}</span>
      )}
      {p.phone && fields.phone && <span style={{ fontSize: 17, fontWeight: 700 }}>{fields.phone}</span>}
      {hasHead && hasBody && <span style={{ borderTop: '2px solid #111', margin: '4px 0', flexShrink: 0 }} />}
      {p.device && fields.device && <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1 }}>{fields.device}</span>}
      {p.repair && fields.issue && (
        <span style={{ fontSize: 14, fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.1 }}>{fields.issue}</span>
      )}
      {p.passcode && fields.passcode && <span style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>Passcode {fields.passcode}</span>}
      {p.notes && fields.notes && (
        <span style={{ fontSize: 9.5, lineHeight: 1.25, borderTop: '1px dotted #555', paddingTop: 3, marginTop: 3 }}>{fields.notes}</span>
      )}
      {p.promise && fields.promised && <span style={{ fontSize: 9.5, fontWeight: 600, marginTop: 2 }}>Promised: {fields.promised}</span>}
      <span style={{ flex: 1 }} />
      {widths && (
        <span style={{ display: 'flex', height: 26, margin: '4px 1px 2px', flexShrink: 0 }}>
          {widths.map((w, i) => (
            <span key={i} style={{ flex: w, background: i % 2 === 0 ? '#111' : 'transparent' }} />
          ))}
        </span>
      )}
      {p.price && fields.priceText && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            border: '2px solid #111',
            padding: '3px 7px',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 800 }}>{fields.priceText}</span>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em' }}>
            {fields.paid === true ? 'PAID' : fields.paid === false ? 'UNPAID' : ''}
          </span>
        </span>
      )}
    </div>
  );
}
