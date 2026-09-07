import { useEffect, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api, session, useNarrow } from '@fmp/pos-client';

interface Summary {
  range: string;
  grossSalesCents: number;
  prevGrossSalesCents: number;
  salesCount: number;
  averageTicketCents: number;
  ticketsTakenIn: number;
  ticketsCompleted: number;
  ticketsStillOpen: number;
  outstandingBalanceCents: number;
  outstandingCount: number;
  revenueByCategory: { repairs: number; devices: number; accessories: number; other: number };
  topRepairs: Array<{ name: string; jobs: number; revenueCents: number; marginPct: number }>;
  paymentMix: Array<{ method: string; totalCents: number }>;
  technicianOutput: Array<{ name: string; initials: string; jobs: number; revenueCents: number }>;
  drawer: {
    openingFloatCents: number;
    cashSalesCents: number;
    cashRefundsCents: number;
    paidInCents: number;
    paidOutCents: number;
    expectedCents: number;
    openedAt: string;
  };
}

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
] as const;

const METHOD_LABELS: Record<string, { label: string; icon: string }> = {
  cash: { label: 'Cash', icon: 'bi-cash' },
  card: { label: 'Card', icon: 'bi-credit-card' },
  tap: { label: 'Tap / wallet', icon: 'bi-phone' },
  store_credit: { label: 'Store credit', icon: 'bi-wallet2' },
};

const CATEGORY_META: Array<{ key: keyof Summary['revenueByCategory']; label: string; color: string }> = [
  { key: 'repairs', label: 'Repairs — labor & parts', color: 'var(--orange)' },
  { key: 'devices', label: 'Device sales', color: '#15803d' },
  { key: 'accessories', label: 'Accessories', color: '#4f46e5' },
  { key: 'other', label: 'Diagnostics & other', color: '#7c3aed' },
];

export function ReportsScreen() {
  const narrow = useNarrow();
  const [range, setRange] = useState<string>('today');
  const [data, setData] = useState<Summary | null>(null);
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState('');
  const [closeResult, setCloseResult] = useState<null | { overShortCents: number; expectedCents: number }>(null);
  const [error, setError] = useState('');
  const isManager = session.user?.role === 'manager';

  async function load() {
    setData(await api<Summary>(`/api/reports/summary?range=${range}`).catch(() => null));
  }

  useEffect(() => {
    void load();
  }, [range]);

  function exportCsv() {
    if (!data) return;
    const lines = [
      'metric,value',
      `gross_sales,${(data.grossSalesCents / 100).toFixed(2)}`,
      `sales_count,${data.salesCount}`,
      `average_ticket,${(data.averageTicketCents / 100).toFixed(2)}`,
      `tickets_taken_in,${data.ticketsTakenIn}`,
      `outstanding_balance,${(data.outstandingBalanceCents / 100).toFixed(2)}`,
      '',
      'category,revenue',
      ...CATEGORY_META.map((c) => `${c.label},${(data.revenueByCategory[c.key] / 100).toFixed(2)}`),
      '',
      'repair_type,jobs,revenue,margin_pct',
      ...data.topRepairs.map((t) => `${t.name},${t.jobs},${(t.revenueCents / 100).toFixed(2)},${t.marginPct}`),
      '',
      'payment_method,total',
      ...data.paymentMix.map((p) => `${p.method},${(p.totalCents / 100).toFixed(2)}`),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fmp-report-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function closeDrawer() {
    const cents = parseDollars(counted || '');
    if (cents == null) {
      setError('Enter the counted cash amount.');
      return;
    }
    try {
      const res = await api<{ overShortCents: number; expectedCents: number }>('/api/drawer/close', {
        method: 'POST',
        body: JSON.stringify({ countedCents: cents }),
      });
      setClosing(false);
      setCounted('');
      setCloseResult(res);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Close failed');
    }
  }

  if (!data) return <div style={{ padding: 32, color: 'var(--ink-4)' }}>Loading…</div>;

  const delta = data.prevGrossSalesCents > 0
    ? Math.round(((data.grossSalesCents - data.prevGrossSalesCents) / data.prevGrossSalesCents) * 100)
    : null;
  const collected = data.paymentMix.reduce((s, p) => s + Math.max(p.totalCents, 0), 0);
  const maxCategory = Math.max(...CATEGORY_META.map((c) => data.revenueByCategory[c.key]), 1);

  const card = { background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', padding: '16px 18px' };
  const cardTitle = { font: '700 16px Inter, sans-serif', margin: '0 0 12px' };

  return (
    <div style={{ padding: '22px 24px', height: '100vh', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Reports</h1>
          <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · drawer open since{' '}
            {new Date(data.drawer.openedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={() => window.print()}>
            <i className="bi bi-printer" /> Print
          </Button>
          <Button variant="secondary" onClick={exportCsv}>
            <i className="bi bi-download" /> Export CSV
          </Button>
          <Button variant="primary" disabled={!isManager} title={isManager ? undefined : 'Manager only'} onClick={() => setClosing(true)}>
            <i className="bi bi-lock" /> Close drawer
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {RANGES.map((r) => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: range === r.id ? 'var(--navy)' : 'var(--card)',
              color: range === r.id ? '#fff' : 'var(--ink-2)',
              font: '600 14px Inter, sans-serif',
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12, marginTop: 14 }}>
        <div style={card}>
          <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>GROSS SALES</div>
          <div style={{ font: '800 30px Inter, sans-serif', marginTop: 4 }}>{formatCents(data.grossSalesCents)}</div>
          {delta != null && (
            <div style={{ fontSize: 12.5, marginTop: 3, color: delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
              <i className={`bi ${delta >= 0 ? 'bi-arrow-up' : 'bi-arrow-down'}`} /> {Math.abs(delta)}% vs previous
            </div>
          )}
        </div>
        <div style={card}>
          <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>TICKETS TAKEN IN</div>
          <div style={{ font: '800 30px Inter, sans-serif', marginTop: 4 }}>{data.ticketsTakenIn}</div>
          <div style={{ fontSize: 12.5, marginTop: 3, color: 'var(--ink-3)' }}>
            {data.ticketsCompleted} completed · {data.ticketsStillOpen} still open
          </div>
        </div>
        <div style={card}>
          <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>AVERAGE TICKET</div>
          <div style={{ font: '800 30px Inter, sans-serif', marginTop: 4 }}>{formatCents(data.averageTicketCents)}</div>
          <div style={{ fontSize: 12.5, marginTop: 3, color: 'var(--ink-3)' }}>{data.salesCount} sales</div>
        </div>
        <div style={card}>
          <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>OUTSTANDING BALANCE</div>
          <div style={{ font: '800 30px Inter, sans-serif', marginTop: 4, color: data.outstandingBalanceCents > 0 ? 'var(--red)' : 'var(--ink)' }}>
            {formatCents(data.outstandingBalanceCents)}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 3, color: 'var(--ink-3)' }}>Across {data.outstandingCount} unpaid tickets</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.4fr 1fr', gap: 12, marginTop: 12, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h3 style={cardTitle}>Revenue by category</h3>
              <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>Net of tax</span>
            </div>
            {CATEGORY_META.map((c) => (
              <div key={c.key} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14.5 }}>
                  <span>{c.label}</span>
                  <span style={{ fontWeight: 700 }}>{formatCents(data.revenueByCategory[c.key])}</span>
                </div>
                <div style={{ height: 6, background: 'var(--line-soft)', borderRadius: 999, marginTop: 5 }}>
                  <div
                    style={{
                      height: 6,
                      width: `${Math.max((data.revenueByCategory[c.key] / maxCategory) * 100, 1)}%`,
                      background: c.color,
                      borderRadius: 999,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h3 style={cardTitle}>Top repair types</h3>
              <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>Last 30 days</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 11.5px Inter, sans-serif' }}>
                  <th style={{ padding: '6px 0' }}>REPAIR TYPE</th>
                  <th>JOBS</th>
                  <th>REVENUE</th>
                  <th>AVG MARGIN</th>
                </tr>
              </thead>
              <tbody>
                {data.topRepairs.map((t) => (
                  <tr key={t.name}>
                    <td style={{ padding: '7px 0', borderTop: '1px solid var(--line-soft)' }}>{t.name}</td>
                    <td style={{ borderTop: '1px solid var(--line-soft)' }}>{t.jobs}</td>
                    <td style={{ borderTop: '1px solid var(--line-soft)', fontWeight: 700 }}>{formatCents(t.revenueCents)}</td>
                    <td style={{ borderTop: '1px solid var(--line-soft)', color: t.marginPct >= 50 ? 'var(--green)' : 'var(--amber)', fontWeight: 600 }}>
                      {t.marginPct}%
                    </td>
                  </tr>
                ))}
                {data.topRepairs.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: '10px 0', color: 'var(--ink-4)' }}>No catalog repairs yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={card}>
            <h3 style={cardTitle}>Payment mix</h3>
            {data.paymentMix.map((p) => (
              <div key={p.method} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14.5, padding: '5px 0' }}>
                <span>
                  <i className={`bi ${METHOD_LABELS[p.method]?.icon ?? 'bi-cash'}`} style={{ color: 'var(--ink-4)', marginRight: 8 }} />
                  {METHOD_LABELS[p.method]?.label ?? p.method}
                </span>
                <span>
                  <b>{formatCents(p.totalCents)}</b>{' '}
                  <span style={{ color: 'var(--ink-4)', fontSize: 12.5 }}>
                    {collected > 0 ? Math.round((Math.max(p.totalCents, 0) / collected) * 100) : 0}%
                  </span>
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line-soft)', marginTop: 8, paddingTop: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Collected</span>
              <span style={{ font: '800 17.5px Inter, sans-serif' }}>{formatCents(collected)}</span>
            </div>
          </div>

          <div style={card}>
            <h3 style={cardTitle}>Cash drawer</h3>
            {[
              ['Opening float', data.drawer.openingFloatCents, ''],
              ['Cash sales', data.drawer.cashSalesCents, ''],
              ['Paid in', data.drawer.paidInCents, ''],
              ['Trade-in & payouts', -data.drawer.paidOutCents, 'red'],
              ['Refunds', -data.drawer.cashRefundsCents, 'red'],
            ].map(([label, cents, tone]) => (
              <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14.5, padding: '4px 0' }}>
                <span style={{ color: 'var(--ink-3)' }}>{label}</span>
                <span style={{ color: tone === 'red' && (cents as number) !== 0 ? 'var(--red)' : 'var(--ink)' }}>
                  {formatCents(cents as number)}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line-soft)', marginTop: 8, paddingTop: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Expected in drawer</span>
              <span style={{ font: '800 17.5px Inter, sans-serif' }}>{formatCents(data.drawer.expectedCents)}</span>
            </div>
          </div>

        </div>
      </div>

      {/* Close drawer */}
      <Modal open={closing} onClose={() => setClosing(false)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Close drawer</h2>
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>
          Count the cash, enter the total. Expected: <b>{formatCents(data.drawer.expectedCents)}</b>. Held sales clear on close.
        </p>
        <input
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          placeholder="Counted cash $ *"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setClosing(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void closeDrawer()}>Close drawer</Button>
        </div>
      </Modal>

      <Modal open={closeResult !== null} onClose={() => setCloseResult(null)} width={360}>
        {closeResult && (
          <div style={{ textAlign: 'center' }}>
            <i className="bi bi-lock-fill" style={{ fontSize: 37, color: 'var(--green)' }} />
            <h2 style={{ margin: '8px 0 4px', font: '700 20.5px Inter, sans-serif' }}>Drawer closed</h2>
            <div
              style={{
                borderRadius: 12,
                padding: '12px 0',
                margin: '10px 0',
                font: '800 25.5px Inter, sans-serif',
                background: closeResult.overShortCents === 0 ? 'var(--green-bg)' : 'var(--red-bg)',
                color: closeResult.overShortCents === 0 ? 'var(--green)' : 'var(--red)',
              }}
            >
              {closeResult.overShortCents === 0
                ? 'Balanced'
                : closeResult.overShortCents > 0
                  ? `Over ${formatCents(closeResult.overShortCents)}`
                  : `Short ${formatCents(-closeResult.overShortCents)}`}
            </div>
            <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>Expected {formatCents(closeResult.expectedCents)}</div>
            <Button variant="primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setCloseResult(null)}>
              Done
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
