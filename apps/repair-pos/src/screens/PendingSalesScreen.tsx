import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCents } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface ParkedLine {
  id: number;
  kind: string;
  description: string;
  qty: number;
  unitCents: number;
  discountCents: number;
  taxable: boolean;
  inventoryItemId: number | null;
}

interface ParkedSale {
  id: number;
  ticketNumber: string;
  totalCents: number;
  parkedNote: string | null;
  createdAt: string;
  customerId: number | null;
  customerName: string | null;
  cashierName: string | null;
  subtotalCents: number;
  taxCents: number;
  lines: ParkedLine[];
}

export function PendingSalesScreen() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ParkedSale[]>([]);
  const [selected, setSelected] = useState<ParkedSale | null>(null);
  const [query, setQuery] = useState('');
  const [voiding, setVoiding] = useState<ParkedSale | null>(null);
  const [error, setError] = useState('');
  const isManager = session.user?.role === 'manager';

  async function load() {
    const data = await api<ParkedSale[]>('/api/sales/parked').catch(() => []);
    setRows(data);
    setSelected((prev) => data.find((d) => d.id === prev?.id) ?? data[0] ?? null);
  }

  useEffect(() => {
    void load();
  }, []);

  function resume(sale: ParkedSale) {
    sessionStorage.setItem(
      'fmp.resumeSale',
      JSON.stringify({
        id: sale.id,
        customer: sale.customerId ? { id: sale.customerId, name: sale.customerName ?? 'Customer' } : null,
        lines: sale.lines.map((l) => ({
          kind: l.kind,
          description: l.description,
          qty: l.qty,
          unitCents: l.unitCents,
          discountCents: l.discountCents,
          taxable: l.taxable,
          inventoryItemId: l.inventoryItemId,
        })),
      }),
    );
    navigate('/register');
  }

  async function voidSale(sale: ParkedSale) {
    setError('');
    try {
      await api(`/api/sales/${sale.id}/void`, { method: 'POST', body: JSON.stringify({ reason: 'Voided from pending' }) });
      setVoiding(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Void failed');
    }
  }

  const filtered = rows.filter(
    (r) =>
      !query ||
      r.ticketNumber.includes(query) ||
      (r.customerName ?? '').toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 24px Inter, sans-serif' }}>Pending sales</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 12, marginTop: 2 }}>
              {rows.length} parked ticket{rows.length === 1 ? '' : 's'} · nothing charged yet
            </div>
          </div>
          <Button variant="dark" onClick={() => navigate('/register')}>
            Back to new sale
          </Button>
        </div>

        <div style={{ position: 'relative', marginTop: 16 }}>
          <i className="bi bi-search" style={{ position: 'absolute', left: 14, top: 13, color: 'var(--ink-4)', fontSize: 14 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search parked sales by ticket, name, or phone"
            style={{ width: '100%', padding: '12px 14px 12px 38px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 13 }}
          />
        </div>

        <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em', margin: '18px 0 8px' }}>
          PARKED TODAY
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((sale) => (
            <div
              key={sale.id}
              onClick={() => setSelected(sale)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'var(--card)',
                borderRadius: 14,
                border: `1.5px solid ${selected?.id === sale.id ? 'var(--orange)' : 'var(--line-soft)'}`,
                padding: '12px 16px',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 999,
                  background: 'var(--blue-bg)',
                  color: 'var(--blue)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  font: '700 12px Inter, sans-serif',
                }}
              >
                {(sale.customerName ?? 'W I')
                  .split(' ')
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join('')}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: '600 14px Inter, sans-serif' }}>
                  {sale.customerName ?? 'Walk-in'}{' '}
                  <span style={{ color: 'var(--ink-4)', font: '500 11px Inter, sans-serif' }}>#{sale.ticketNumber}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {sale.lines.map((l) => l.description).join(' · ')} · {sale.lines.length} item{sale.lines.length === 1 ? '' : 's'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ font: '700 14px Inter, sans-serif' }}>{formatCents(sale.totalCents)}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-4)' }}>
                  Parked {new Date(sale.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · {sale.cashierName}
                </div>
              </div>
              <Button variant="secondary" onClick={(e) => { e.stopPropagation(); resume(sale); }}>
                Resume
              </Button>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ color: 'var(--ink-4)', fontSize: 13, marginTop: 30, textAlign: 'center' }}>No parked sales.</div>}
        </div>

        <div style={{ marginTop: 24, fontSize: 11, color: 'var(--ink-4)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <i className="bi bi-info-circle" /> Parked sales clear at end-of-day close. Resuming one replaces whatever is in the current sale.
        </div>
      </div>

      {/* Detail panel */}
      <div style={{ width: 340, flexShrink: 0, background: 'var(--card)', borderLeft: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', padding: '22px 20px' }}>
        {selected ? (
          <>
            <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>{selected.customerName ?? 'Walk-in'}</h2>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
              #{selected.ticketNumber} · parked {new Date(selected.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </div>
            <div style={{ marginTop: 14, flex: 1, overflow: 'auto' }}>
              {selected.lines.map((l) => (
                <div key={l.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: '9px 12px', marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ font: '600 12px Inter, sans-serif' }}>{l.description}</span>
                    <span style={{ font: '700 12px Inter, sans-serif' }}>{formatCents(l.qty * l.unitCents - l.discountCents)}</span>
                  </div>
                  {l.qty > 1 && <div style={{ fontSize: 10, color: 'var(--ink-4)' }}>{l.qty} × {formatCents(l.unitCents)}</div>}
                </div>
              ))}
              {selected.parkedNote && (
                <div style={{ background: 'var(--amber-bg)', color: 'var(--amber)', borderRadius: 10, padding: '9px 12px', fontSize: 11 }}>
                  <i className="bi bi-sticky" /> Note: {selected.parkedNote}
                </div>
              )}
            </div>
            <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)' }}>
                <span>Subtotal</span>
                <span>{formatCents(selected.subtotalCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>
                <span>Tax</span>
                <span>{formatCents(selected.taxCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                <span style={{ font: '700 15px Inter, sans-serif' }}>Total</span>
                <span style={{ font: '800 20px Inter, sans-serif' }}>{formatCents(selected.totalCents)}</span>
              </div>
              {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{error}</div>}
              <Button variant="primary" size="lg" style={{ width: '100%', marginTop: 12 }} onClick={() => resume(selected)}>
                Resume this sale
              </Button>
              <Button
                variant="danger"
                style={{ width: '100%', marginTop: 8 }}
                disabled={!isManager}
                title={isManager ? undefined : 'Manager PIN required'}
                onClick={() => setVoiding(selected)}
              >
                Void sale{isManager ? '' : ' (manager)'}
              </Button>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--ink-4)', fontSize: 13, marginTop: 40, textAlign: 'center' }}>Select a parked sale.</div>
        )}
      </div>

      <Modal open={voiding !== null} onClose={() => setVoiding(null)} width={360}>
        <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>Void parked sale?</h2>
        <p style={{ fontSize: 13, color: 'var(--ink-2)' }}>
          #{voiding?.ticketNumber} · {formatCents(voiding?.totalCents ?? 0)} — this can't be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => setVoiding(null)}>Keep it</Button>
          <Button variant="danger" onClick={() => voiding && void voidSale(voiding)}>Void sale</Button>
        </div>
      </Modal>
    </div>
  );
}
