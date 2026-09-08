import { useCallback, useEffect, useState } from 'react';
import { Button } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';
import { printTicketLabel, setLabelPrefs, TAG_DEFAULTS, type TagPrefs } from '../repairs/labels';

interface ReceiptPrefs {
  paper?: 80 | 58;
  store?: boolean;
  customer?: boolean;
  footer?: boolean;
  terms?: boolean;
  termsText?: string;
  kickDrawer?: boolean;
}

interface QueueJob {
  id: number;
  kind: 'receipt' | 'label';
  name: string;
  detail: string | null;
  status: 'sent' | 'failed';
  createdAt: string;
  userName: string | null;
  canReprint: boolean;
}

const RECEIPT_DEFAULTS: Required<ReceiptPrefs> = {
  paper: 80,
  store: true,
  customer: true,
  footer: true,
  terms: false,
  termsText: 'Devices left over 30 days may be sold to recover costs. Back up your data first.',
  kickDrawer: true,
};

const TAG_FIELDS: Array<{ key: keyof Omit<TagPrefs, 'size'>; label: string }> = [
  { key: 'date', label: 'Date and time' },
  { key: 'ticket', label: 'Ticket number' },
  { key: 'customer', label: 'Customer name' },
  { key: 'phone', label: 'Phone number' },
  { key: 'device', label: 'Device' },
  { key: 'repair', label: 'Repair type' },
  { key: 'passcode', label: 'Passcode' },
  { key: 'notes', label: 'Intake notes' },
  { key: 'promise', label: 'Promised time' },
  { key: 'price', label: 'Price and paid status' },
];

const RECEIPT_FIELDS: Array<{ key: keyof ReceiptPrefs; label: string }> = [
  { key: 'store', label: 'Store name, address and phone' },
  { key: 'customer', label: 'Customer' },
  { key: 'terms', label: 'Terms' },
  { key: 'footer', label: 'Footer message' },
];

const SAMPLE_TAG = {
  number: 'R-1051',
  customer: 'Rosa Alvarez',
  phone: '(313) 555-0142',
  device: 'iPhone 13 · 128GB',
  issue: 'Charge port replacement',
  passcode: '4417',
  notes: 'Hairline crack top left · charges intermittently',
  promised: 'today 5:30 PM',
  priceText: '$89.00',
  paid: false,
};

const chipStyle = (active: boolean) =>
  ({
    padding: '9px 15px',
    borderRadius: 10,
    border: active ? '1px solid var(--navy)' : '1px solid var(--line)',
    background: active ? 'var(--navy)' : 'var(--card)',
    color: active ? '#fff' : 'var(--ink-2)',
    font: '600 14px Inter, sans-serif',
    textAlign: 'left' as const,
  }) as const;

const cardStyle = {
  background: 'var(--card)',
  border: '1px solid var(--line-soft)',
  borderRadius: 12,
  padding: '14px 16px',
  boxShadow: 'var(--shadow-card)',
} as const;

const sectionLabel = {
  font: '600 11.5px Inter, sans-serif',
  color: 'var(--ink-4)',
  letterSpacing: '0.08em',
} as const;

function FieldToggle({ label, on, onToggle, note }: { label: string; on: boolean; onToggle: () => void; note?: string }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        width: '100%',
        minHeight: 46,
        padding: '8px 12px',
        borderRadius: 10,
        border: on ? '1px solid var(--line)' : '1px solid var(--line-soft)',
        background: on ? 'var(--line-soft)' : 'var(--card)',
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: on ? 'var(--navy)' : 'var(--card)',
          border: on ? '1px solid var(--navy)' : '1px solid var(--line)',
          color: '#fff',
          fontSize: 13,
        }}
      >
        {on && <i className="bi bi-check-lg" />}
      </span>
      <span style={{ flex: 1, font: '600 14.5px Inter, sans-serif', color: 'var(--ink)' }}>{label}</span>
      {note && <span style={{ fontSize: 11.5, color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase' }}>{note}</span>}
    </button>
  );
}

/** Print center: templates with field toggles + live preview, print queue, printers. */
export function PrintCenterTab() {
  const isManager = session.user?.role === 'manager';
  const [tab, setTab] = useState<'templates' | 'queue' | 'printers'>('templates');
  const [tpl, setTpl] = useState<'receipt' | 'tag'>('receipt');
  const [receipt, setReceipt] = useState<ReceiptPrefs>({ ...RECEIPT_DEFAULTS });
  const [tag, setTag] = useState<TagPrefs>({ ...TAG_DEFAULTS });
  const [preview, setPreview] = useState('');
  const [queue, setQueue] = useState<QueueJob[]>([]);
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  useEffect(() => {
    void api<{ settings?: { print?: { receipt?: ReceiptPrefs; tag?: TagPrefs } } }>('/api/settings/store')
      .then((s) => {
        setReceipt({ ...RECEIPT_DEFAULTS, ...s.settings?.print?.receipt });
        setTag({ ...TAG_DEFAULTS, ...s.settings?.print?.tag });
      })
      .catch(() => {});
    void api<{ bridgeOnline: boolean }>('/api/print/status').then((s) => setBridgeOnline(s.bridgeOnline)).catch(() => {});
  }, []);

  const refreshQueue = useCallback(() => {
    void api<QueueJob[]>('/api/print/queue').then(setQueue).catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === 'queue') refreshQueue();
  }, [tab, refreshQueue]);

  // live receipt preview from the server so it matches the real printout exactly
  useEffect(() => {
    if (tpl !== 'receipt') return;
    const t = setTimeout(() => {
      void api<{ receiptText: string }>('/api/print/preview', { method: 'POST', body: JSON.stringify({ receipt }) })
        .then((r) => setPreview(r.receiptText))
        .catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [tpl, receipt]);

  async function save() {
    setError('');
    try {
      await api('/api/settings/store', {
        method: 'PUT',
        body: JSON.stringify({ settings: { print: { receipt, tag } } }),
      });
      setLabelPrefs(tag);
      flash('Template saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function testPrint() {
    setError('');
    try {
      const r = await api<{ printed: boolean }>('/api/print/test', {
        method: 'POST',
        body: JSON.stringify({ receipt }),
      });
      flash(r.printed ? 'Test page sent to the Rongta.' : 'Print bridge offline — nothing printed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    }
  }

  function printSampleTag() {
    setLabelPrefs(tag);
    printTicketLabel(SAMPLE_TAG, { skipLog: true });
    flash('Sample tag opened in the print dialog.');
  }

  async function reprint(job: QueueJob) {
    setError('');
    try {
      const r = await api<{ printed: boolean; label?: Record<string, unknown> }>(`/api/print/jobs/${job.id}/reprint`, {
        method: 'POST',
      });
      if (r.label) printTicketLabel(r.label as never, { skipLog: true });
      flash(r.printed ? `Reprinting — ${job.name}` : 'Print bridge offline — nothing printed.');
      refreshQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reprint failed');
    }
  }

  const tagOn = (k: keyof Omit<TagPrefs, 'size'>) => tag[k] ?? TAG_DEFAULTS[k];
  const rcptOn = (k: 'store' | 'customer' | 'footer' | 'terms') => receipt[k] ?? RECEIPT_DEFAULTS[k];

  return (
    <div style={{ maxWidth: 1060 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(
          [
            ['templates', 'Templates'],
            ['queue', 'Queue'],
            ['printers', 'Printers'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={chipStyle(tab === id)}>
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {msg && <span style={{ color: 'var(--green)', fontSize: 14, fontWeight: 600 }}>{msg}</span>}
          {error && <span style={{ color: 'var(--red)', fontSize: 14, fontWeight: 600 }}>{error}</span>}
        </span>
      </div>

      {tab === 'templates' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 230px) minmax(280px, 1fr) minmax(240px, 360px)', gap: 14, alignItems: 'start' }}>
          {/* template list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={sectionLabel}>TEMPLATES</span>
            {(
              [
                ['receipt', 'Sales receipt', '80mm thermal · Rongta'],
                ['tag', 'Repair claim tag', 'device sticker · Niimbot'],
              ] as const
            ).map(([id, name, meta]) => (
              <button
                key={id}
                onClick={() => setTpl(id)}
                style={{
                  ...cardStyle,
                  textAlign: 'left',
                  borderLeft: tpl === id ? '4px solid var(--orange)' : '4px solid transparent',
                  background: tpl === id ? 'var(--line-soft)' : 'var(--card)',
                }}
              >
                <div style={{ font: '700 15px Inter, sans-serif' }}>{name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>{meta}</div>
              </button>
            ))}
          </div>

          {/* editor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: 10 }}>{tpl === 'receipt' ? 'PAPER WIDTH' : 'LABEL PRESET'}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {tpl === 'receipt'
                  ? (
                      [
                        [80, '80mm', '42 chars · Rongta'],
                        [58, '58mm', '32 chars · belt printer'],
                      ] as const
                    ).map(([mm, label, sub]) => (
                      <button key={mm} onClick={() => setReceipt((p) => ({ ...p, paper: mm }))} style={chipStyle((receipt.paper ?? 80) === mm)}>
                        <div>{label}</div>
                        <div style={{ fontSize: 11, opacity: 0.75 }}>{sub}</div>
                      </button>
                    ))
                  : (
                      [
                        ['50x30', '50 × 30 mm', 'standard tag'],
                        ['50x80', '50 × 80 mm', 'tall tag · fits notes'],
                      ] as const
                    ).map(([sz, label, sub]) => (
                      <button key={sz} onClick={() => setTag((p) => ({ ...p, size: sz }))} style={chipStyle((tag.size ?? '50x30') === sz)}>
                        <div>{label}</div>
                        <div style={{ fontSize: 11, opacity: 0.75 }}>{sub}</div>
                      </button>
                    ))}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: 10 }}>FIELDS</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tpl === 'receipt' ? (
                  <>
                    <FieldToggle label="Line items" on onToggle={() => {}} note="Required" />
                    <FieldToggle label="Totals and tax" on onToggle={() => {}} note="Required" />
                    {RECEIPT_FIELDS.map((f) => (
                      <FieldToggle
                        key={f.key}
                        label={f.label}
                        on={Boolean(rcptOn(f.key as never))}
                        onToggle={() => setReceipt((p) => ({ ...p, [f.key]: !rcptOn(f.key as never) }))}
                      />
                    ))}
                    {rcptOn('terms') && (
                      <textarea
                        value={receipt.termsText ?? RECEIPT_DEFAULTS.termsText}
                        onChange={(e) => setReceipt((p) => ({ ...p, termsText: e.target.value }))}
                        rows={3}
                        style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 14, resize: 'vertical' }}
                      />
                    )}
                  </>
                ) : (
                  TAG_FIELDS.map((f) => (
                    <FieldToggle key={f.key} label={f.label} on={tagOn(f.key)} onToggle={() => setTag((p) => ({ ...p, [f.key]: !tagOn(f.key) }))} />
                  ))
                )}
              </div>
            </div>

            {tpl === 'receipt' && (
              <div style={cardStyle}>
                <div style={{ ...sectionLabel, marginBottom: 10 }}>OUTPUT</div>
                <FieldToggle
                  label="Kick the cash drawer on cash tender"
                  on={receipt.kickDrawer ?? true}
                  onToggle={() => setReceipt((p) => ({ ...p, kickDrawer: !(p.kickDrawer ?? true) }))}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" disabled={!isManager} onClick={() => void save()}>
                Save template
              </Button>
              {tpl === 'receipt' ? (
                <Button variant="secondary" disabled={!isManager} onClick={() => void testPrint()}>
                  <i className="bi bi-printer" /> Test print
                </Button>
              ) : (
                <Button variant="secondary" onClick={printSampleTag}>
                  <i className="bi bi-tag" /> Print sample
                </Button>
              )}
              {!isManager && <span style={{ alignSelf: 'center', color: 'var(--ink-4)', fontSize: 13.5 }}>Manager sign-in required to save.</span>}
            </div>
          </div>

          {/* live preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={sectionLabel}>
              LIVE PREVIEW · {tpl === 'receipt' ? `${receipt.paper ?? 80}MM` : (tag.size ?? '50x30') === '50x80' ? '50 × 80 MM' : '50 × 30 MM'}
            </span>
            <div style={{ background: 'var(--line-soft)', borderRadius: 12, padding: 16, display: 'flex', justifyContent: 'center' }}>
              {tpl === 'receipt' ? (
                <pre
                  style={{
                    margin: 0,
                    background: 'var(--card)',
                    borderRadius: 8,
                    padding: 12,
                    fontSize: (receipt.paper ?? 80) === 58 ? 10.5 : 11,
                    lineHeight: 1.45,
                    fontFamily: 'ui-monospace, monospace',
                    overflow: 'auto',
                    maxWidth: '100%',
                  }}
                >
                  {preview || 'Loading preview…'}
                </pre>
              ) : (
                (() => {
                  const tall = (tag.size ?? '50x30') === '50x80';
                  const fs = tall
                    ? { date: 13, tkt: 11, name: 20, phone: 17, dev: 14, rep: 14, pass: 13, small: 9.5, price: 18, status: 10 }
                    : { date: 9.5, tkt: 8.5, name: 13.5, phone: 11.5, dev: 10.5, rep: 10.5, pass: 10, small: 8, price: 12, status: 8 };
                  return (
                    <div
                      style={{
                        width: 189,
                        height: tall ? 302 : 113,
                        background: '#fff',
                        color: '#111',
                        border: '1px solid var(--line)',
                        borderRadius: 2,
                        padding: tall ? '12px 12px' : '7px 9px',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                      }}
                    >
                      {tagOn('date') && <span style={{ fontSize: fs.date, fontWeight: 700 }}>08/31/26 3:58 PM</span>}
                      {tagOn('ticket') && <span style={{ fontSize: fs.tkt, fontWeight: 700, color: '#555' }}>Ticket {SAMPLE_TAG.number}</span>}
                      {tagOn('customer') && (
                        <span style={{ fontSize: fs.name, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.01em' }}>{SAMPLE_TAG.customer}</span>
                      )}
                      {tagOn('phone') && <span style={{ fontSize: fs.phone, fontWeight: 700 }}>{SAMPLE_TAG.phone}</span>}
                      {(tagOn('date') || tagOn('ticket') || tagOn('customer') || tagOn('phone')) &&
                        (tagOn('device') || tagOn('repair') || tagOn('passcode') || tagOn('notes') || tagOn('promise')) && (
                          <span style={{ borderTop: '2px solid #111', margin: '4px 0' }} />
                        )}
                      {tagOn('device') && <span style={{ fontSize: fs.dev, fontWeight: 700 }}>{SAMPLE_TAG.device}</span>}
                      {tagOn('repair') && (
                        <span style={{ fontSize: fs.rep, fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.1 }}>{SAMPLE_TAG.issue}</span>
                      )}
                      {tagOn('passcode') && <span style={{ fontSize: fs.pass, fontWeight: 700, marginTop: 2 }}>Passcode {SAMPLE_TAG.passcode}</span>}
                      {tagOn('notes') && (
                        <span style={{ fontSize: fs.small, lineHeight: 1.25, borderTop: '1px dotted #555', paddingTop: 3, marginTop: 3 }}>
                          {SAMPLE_TAG.notes}
                        </span>
                      )}
                      {tagOn('promise') && <span style={{ fontSize: fs.small, fontWeight: 600, marginTop: 2 }}>Promised: {SAMPLE_TAG.promised}</span>}
                      <span style={{ flex: 1 }} />
                      {tagOn('price') && (
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                            border: '2px solid #111',
                            padding: '3px 7px',
                          }}
                        >
                          <span style={{ fontSize: fs.price, fontWeight: 800 }}>{SAMPLE_TAG.priceText}</span>
                          <span style={{ fontSize: fs.status, fontWeight: 800, letterSpacing: '0.08em' }}>UNPAID</span>
                        </span>
                      )}
                    </div>
                  );
                })()
              )}
            </div>
            <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>
              {tpl === 'receipt' ? 'Exactly what the Rongta prints — rendered by the server.' : 'Shown near true size.'}
            </span>
          </div>
        </div>
      )}

      {tab === 'queue' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {queue.map((q) => (
            <div key={q.id} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ width: 88, fontSize: 12.5, color: 'var(--ink-4)', flexShrink: 0 }}>
                {new Date(q.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ font: '700 15px Inter, sans-serif' }}>{q.name}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 1 }}>
                  {[q.detail, q.userName].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              <span
                style={{
                  padding: '4px 11px',
                  borderRadius: 999,
                  font: '700 12px Inter, sans-serif',
                  background: q.status === 'sent' ? 'var(--green-bg)' : 'var(--red-bg)',
                  color: q.status === 'sent' ? 'var(--green)' : 'var(--red)',
                }}
              >
                {q.status === 'sent' ? 'Sent' : 'Failed'}
              </span>
              {q.canReprint && (
                <Button variant="secondary" onClick={() => void reprint(q)}>
                  Reprint
                </Button>
              )}
            </div>
          ))}
          {queue.length === 0 && <div style={{ color: 'var(--ink-4)', fontSize: 15, padding: '30px 0', textAlign: 'center' }}>Nothing printed yet today.</div>}
          <span style={{ fontSize: 12.5, color: 'var(--ink-4)', marginTop: 6 }}>
            Any receipt or label can also be reprinted from its own record — the sale, the ticket, or the cart line.
          </span>
        </div>
      )}

      {tab === 'printers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760 }}>
          {[
            {
              role: 'RECEIPTS',
              printer: 'Rongta thermal',
              sub: 'Configured on the store PC in bridge/config.json — printer IP for network models, Windows share name for USB.',
              status: bridgeOnline ? 'Connected' : 'Bridge offline',
              good: bridgeOnline,
              test: () => void testPrint(),
              testLabel: 'Test',
            },
            {
              role: 'LABELS',
              printer: 'Niimbot',
              sub: 'Prints through the browser dialog at the size picked in the claim-tag template. Native bridge printing comes after validating your model.',
              status: 'Browser print',
              good: true,
              test: printSampleTag,
              testLabel: 'Test',
            },
            {
              role: 'CASH DRAWER',
              printer: 'Drawer on receipt printer',
              sub: 'Kicked by the Rongta on cash tender.',
              status: (receipt.kickDrawer ?? true) ? 'Kicks on cash' : 'Kick disabled',
              good: receipt.kickDrawer ?? true,
              test: null,
              testLabel: '',
            },
          ].map((r) => (
            <div key={r.role} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={sectionLabel}>{r.role}</div>
                <div style={{ font: '700 16px Inter, sans-serif', marginTop: 3 }}>{r.printer}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>{r.sub}</div>
              </div>
              <span
                style={{
                  padding: '4px 11px',
                  borderRadius: 999,
                  font: '700 12px Inter, sans-serif',
                  background: r.good ? 'var(--green-bg)' : 'var(--amber-bg)',
                  color: r.good ? 'var(--green)' : 'var(--amber)',
                }}
              >
                {r.status}
              </span>
              {r.test && (
                <Button variant="secondary" disabled={r.role === 'RECEIPTS' && !isManager} onClick={r.test}>
                  {r.testLabel}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
