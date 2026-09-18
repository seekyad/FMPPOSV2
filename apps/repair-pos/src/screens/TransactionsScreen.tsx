import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatCents } from '@fmp/shared';
import { Button, DataTable, Modal, StatusChip, type Column } from '@fmp/ui';
import { api, ReceiptView, session } from '@fmp/pos-client';
import { printTicketLabel } from './repairs/labels';

type Kind = 'sale' | 'refund' | 'voided' | 'deposit' | 'deposit_refund' | 'payout' | 'paid_in' | 'drop' | 'tradein';

interface Row {
  key: string;
  kind: Kind;
  number: string;
  at: string;
  customerName: string | null;
  customerPhone: string | null;
  description: string;
  note: string | null;
  method: string | null;
  amountCents: number;
  status: string | null;
  userName: string | null;
  saleId: number | null;
  ticketId: number | null;
}

/** The linked repair ticket, as the detail endpoint returns it. */
interface TicketInfo {
  ticket: { id: number; number: string; status: string; callFlag: boolean; partsFlag: boolean; alertFlag: boolean; notesForTech: string | null; totalCents: number };
  customer: { name: string; phone: string | null; note: string | null } | null;
  devices: Array<{ label: string; unlockValue: string | null; conditionNotes: string | null }>;
  lines: Array<{ description: string }>;
  balanceCents: number;
}

/** Type tabs beside the search box; each maps to a server-side kind filter. */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'sale', label: 'Sales' },
  { id: 'refund', label: 'Refunds' },
  { id: 'repair', label: 'Repair deposits' },
  { id: 'payout', label: 'Payouts' },
  { id: 'tradein', label: 'Trade-ins' },
  { id: 'voided', label: 'Voided' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom range' },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const KIND_META: Record<Kind, { label: string; tone: 'green' | 'red' | 'blue' | 'purple' | 'amber' | 'orange' | 'neutral'; icon: string }> = {
  sale: { label: 'Sale', tone: 'green', icon: 'bi-receipt' },
  refund: { label: 'Refund', tone: 'red', icon: 'bi-arrow-counterclockwise' },
  voided: { label: 'Voided', tone: 'neutral', icon: 'bi-x-circle' },
  deposit: { label: 'Repair deposit', tone: 'blue', icon: 'bi-wrench-adjustable' },
  deposit_refund: { label: 'Deposit refund', tone: 'red', icon: 'bi-wrench-adjustable' },
  payout: { label: 'Payout', tone: 'amber', icon: 'bi-cash-coin' },
  paid_in: { label: 'Paid in', tone: 'green', icon: 'bi-cash-coin' },
  drop: { label: 'Cash drop', tone: 'neutral', icon: 'bi-safe' },
  tradein: { label: 'Trade-in', tone: 'purple', icon: 'bi-arrow-left-right' },
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  tap: 'Tap',
  zelle: 'Zelle',
  cash_app: 'Cash App',
  store_credit: 'Store credit',
};
const methodLabel = (m: string | null) =>
  m
    ? m
        .split(',')
        .map((x) => METHOD_LABELS[x.trim()] ?? x.trim())
        .join(', ')
    : '—';

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function rangeBounds(range: RangeId, custom: { from: string; to: string }): { from: Date | null; to: Date | null } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  if (range === 'today') return { from: start, to: plusDays(start, 1) };
  if (range === 'yesterday') return { from: plusDays(start, -1), to: start };
  if (range === 'week') return { from: plusDays(start, -((start.getDay() + 6) % 7)), to: plusDays(start, 1) };
  if (range === 'month') return { from: new Date(start.getFullYear(), start.getMonth(), 1), to: plusDays(start, 1) };
  if (range === 'custom') {
    return {
      from: custom.from ? new Date(`${custom.from}T00:00:00`) : null,
      to: custom.to ? plusDays(new Date(`${custom.to}T00:00:00`), 1) : null,
    };
  }
  return { from: null, to: null };
}

/** Every money movement in one searchable log: invoices, refunds, repair deposits, payouts, trade-ins. */
export function TransactionsScreen() {
  const [tab, setTab] = useState<TabId>('all');
  const [range, setRange] = useState<RangeId>('today');
  const [custom, setCustom] = useState({ from: localDay(new Date()), to: localDay(new Date()) });
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  /** the row whose sheet is open, its receipt text (sales), and its linked repair ticket */
  const [open, setOpen] = useState<{ row: Row; text: string | null } | null>(null);
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [msg, setMsg] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const isManager = session.user?.role === 'manager';

  async function load() {
    const { from, to } = rangeBounds(range, custom);
    const params = new URLSearchParams({ kind: tab });
    if (from) params.set('from', from.toISOString());
    if (to) params.set('to', to.toISOString());
    setLoading(true);
    const res = await api<{ rows: Row[] }>(`/api/transactions?${params}`).catch(() => null);
    setLoading(false);
    if (res) setRows(res.rows);
  }

  useEffect(() => {
    if (range === 'custom' && (!custom.from || !custom.to)) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, range, custom.from, custom.to]);

  async function loadTicket(id: number) {
    const t = await api<TicketInfo>(`/api/repairs/${id}`).catch(() => null);
    setTicket(t);
  }

  async function openRow(r: Row) {
    if (!r.saleId && !r.ticketId) return;
    setMsg('');
    setVoiding(false);
    setCancelling(false);
    setReason('');
    setTicket(null);
    const text = r.saleId ? (await api<{ receiptText: string }>(`/api/sales/${r.saleId}/receipt`).catch(() => null))?.receiptText ?? null : null;
    setOpen({ row: r, text });
    if (r.ticketId) void loadTicket(r.ticketId);
  }

  function close() {
    setOpen(null);
    setTicket(null);
  }

  /** Flip a ticket tag from the sheet and refresh both the sheet and the log. */
  async function toggleTag(flag: 'callFlag' | 'partsFlag' | 'alertFlag') {
    if (!ticket) return;
    try {
      await api(`/api/repairs/${ticket.ticket.id}`, { method: 'PATCH', body: JSON.stringify({ [flag]: !ticket.ticket[flag] }) });
      await loadTicket(ticket.ticket.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function voidSale() {
    if (!open?.row.saleId) return;
    setBusy(true);
    try {
      await api(`/api/sales/${open.row.saleId}/void`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() || undefined }) });
      setMsg('Sale voided.');
      setVoiding(false);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not void sale');
    } finally {
      setBusy(false);
    }
  }

  async function cancelTicket() {
    if (!ticket || reason.trim().length < 2) {
      setMsg('Give a reason for cancelling.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/repairs/${ticket.ticket.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      setMsg(`Ticket #${ticket.ticket.number} cancelled.`);
      setCancelling(false);
      await loadTicket(ticket.ticket.id);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not cancel ticket');
    } finally {
      setBusy(false);
    }
  }

  function editSale() {
    if (!open?.row.saleId) return;
    sessionStorage.setItem('fmp.editSale', JSON.stringify({ id: open.row.saleId, number: open.row.number }));
    navigate('/register');
  }

  function printLabel() {
    if (!ticket) return;
    printTicketLabel({
      number: ticket.ticket.number,
      customer: ticket.customer?.name ?? '',
      phone: ticket.customer?.phone,
      device: ticket.devices.map((d) => d.label).join(' + '),
      issue: ticket.lines.map((l) => l.description).join(', '),
      passcode: ticket.devices[0]?.unlockValue || null,
      notes: ticket.devices[0]?.conditionNotes || null,
      priceText: formatCents(ticket.balanceCents > 0 ? ticket.balanceCents : ticket.ticket.totalCents),
      paid: ticket.balanceCents <= 0,
    });
    setMsg('Ticket label sent to the label printer.');
  }

  const columns: Array<Column<Row>> = [
    {
      key: 'at',
      label: 'Date',
      sortValue: (r) => new Date(r.at).getTime(),
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>
            {new Date(r.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
        </span>
      ),
    },
    {
      key: 'details',
      label: 'Details',
      sortValue: (r) => `${KIND_META[r.kind].label} ${r.description}`,
      render: (r) => (
        <span style={{ display: 'inline-block', maxWidth: 340 }}>
          <StatusChip tone={KIND_META[r.kind].tone}>
            <i className={`bi ${KIND_META[r.kind].icon}`} style={{ fontSize: 10.5 }} /> {KIND_META[r.kind].label}
          </StatusChip>
          {r.description && (
            <span style={{ display: 'block', marginTop: 3, color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>{r.description}</span>
          )}
        </span>
      ),
    },
    {
      key: 'customer',
      label: 'Customer',
      sortValue: (r) => r.customerName ?? '',
      render: (r) =>
        r.customerName ? (
          <span>
            {r.customerName}
            {r.customerPhone && <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>{r.customerPhone}</span>}
          </span>
        ) : (
          <span style={{ color: 'var(--ink-4)' }}>{['payout', 'paid_in', 'drop'].includes(r.kind) ? '—' : 'Walk-in'}</span>
        ),
    },
    { key: 'method', label: 'Tender', sortValue: (r) => r.method ?? '', render: (r) => <span style={{ color: 'var(--ink-2)' }}>{methodLabel(r.method)}</span> },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      sortValue: (r) => r.amountCents,
      render: (r) => (
        <b style={{ color: r.kind === 'voided' ? 'var(--ink-4)' : r.amountCents < 0 ? 'var(--red)' : 'var(--ink)', textDecoration: r.kind === 'voided' ? 'line-through' : undefined }}>
          {r.amountCents < 0 ? `−${formatCents(-r.amountCents)}` : formatCents(r.amountCents)}
        </b>
      ),
    },
    {
      key: 'notes',
      label: 'Notes',
      sortValue: (r) => r.note ?? '',
      render: (r) => (
        <span style={{ display: 'inline-block', maxWidth: 260 }}>
          {r.note && <span style={{ display: 'block', color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>{r.note}</span>}
          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>by {r.userName ?? '—'}</span>
        </span>
      ),
    },
    {
      key: 'txn',
      label: 'Transaction ID',
      sortValue: (r) => r.number,
      render: (r) => <span style={{ font: '700 14px "SF Mono", Menlo, Consolas, ui-monospace, monospace', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>#{r.number}</span>,
    },
  ];

  const netCents = rows.filter((r) => r.kind !== 'voided').reduce((s, r) => s + r.amountCents, 0);

  const tabStrip = (
    <div role="tablist" aria-label="Transaction type" style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 12, background: 'var(--line-soft)', overflowX: 'auto', flexShrink: 0 }}>
      {TABS.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 12px',
              borderRadius: 9,
              border: 'none',
              background: active ? 'var(--card)' : 'transparent',
              boxShadow: active ? 'var(--shadow-card)' : 'none',
              color: active ? 'var(--ink)' : 'var(--ink-3)',
              font: `${active ? 700 : 600} 13.5px Inter, sans-serif`,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );

  const dateInput = (key: 'from' | 'to') => (
    <input
      type="date"
      aria-label={key === 'from' ? 'From date' : 'To date'}
      value={custom[key]}
      onChange={(e) => setCustom((prev) => ({ ...prev, [key]: e.target.value }))}
      style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', font: '500 14px Inter, sans-serif', color: 'var(--ink)' }}
    />
  );

  const rangeSelect = (
    <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <i className="bi bi-calendar3" style={{ position: 'absolute', left: 12, color: 'var(--ink-3)', fontSize: 14, pointerEvents: 'none' }} />
      <select
        aria-label="Date range"
        value={range}
        onChange={(e) => setRange(e.target.value as RangeId)}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          padding: '10px 34px',
          borderRadius: 999,
          border: '1px solid var(--line)',
          background: 'var(--navy)',
          color: '#fff',
          font: '600 13.5px Inter, sans-serif',
          cursor: 'pointer',
        }}
      >
        {RANGES.map((r) => (
          <option key={r.id} value={r.id} style={{ color: 'var(--ink)', background: 'var(--card)' }}>
            {r.label}
          </option>
        ))}
      </select>
      <i className="bi bi-chevron-down" style={{ position: 'absolute', right: 13, color: '#fff', fontSize: 12, pointerEvents: 'none' }} />
    </label>
  );

  return (
    <div style={{ height: '100vh', overflow: 'hidden', padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Transactions</h1>
          <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
            {loading ? 'Loading…' : `${rows.length} in view · net ${netCents < 0 ? '−' : ''}${formatCents(Math.abs(netCents))}`}
          </div>
        </div>
        <Link to="/register" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">
            <i className="bi bi-cash-stack" /> Back to register
          </Button>
        </Link>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          onRowClick={(r) => void openRow(r)}
          searchText={(r) => `${r.number} ${r.customerName ?? ''} ${r.customerPhone ?? ''} ${r.description} ${r.note ?? ''} ${r.userName ?? ''} ${methodLabel(r.method)}`}
          searchPlaceholder="Search transaction ID, number, customer, phone, item, or tender"
          toolbarStart={tabStrip}
          toolbar={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {range === 'custom' && (
                <>
                  {dateInput('from')}
                  <span style={{ color: 'var(--ink-4)', fontSize: 14 }}>to</span>
                  {dateInput('to')}
                </>
              )}
              {rangeSelect}
            </div>
          }
          initialSort={{ key: 'at', dir: 'desc' }}
          emptyText={loading ? 'Loading…' : 'No transactions in this view.'}
          footer={<span>Tap a row for its receipt, edit or void, and the linked repair's tags and label · payouts and trade-ins show where the cash went</span>}
        />
      </div>

      <Modal open={open !== null} onClose={close} width={470}>
        {open && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div>
                <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>#{open.row.number}</h2>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>
                  {KIND_META[open.row.kind].label} · {new Date(open.row.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · by {open.row.userName ?? '—'}
                </div>
              </div>
              <button onClick={close} aria-label="Close" style={{ border: 'none', background: 'var(--line-soft)', width: 34, height: 34, borderRadius: 999, fontSize: 14, flexShrink: 0 }}>
                <i className="bi bi-x-lg" />
              </button>
            </div>
            {msg && <div role="status" style={{ marginTop: 8, fontSize: 14, color: 'var(--ink-2)' }}>{msg}</div>}

            {open.text && <ReceiptView text={open.text} style={{ marginTop: 12 }} />}

            {open.row.saleId && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const r = await api<{ printed: boolean }>(`/api/sales/${open.row.saleId}/print`, { method: 'POST' });
                      setMsg(r.printed ? 'Receipt sent to printer.' : 'Print bridge offline.');
                    } catch {
                      setMsg('Could not print.');
                    }
                  }}
                >
                  <i className="bi bi-printer" /> Print receipt
                </Button>
                {open.row.kind === 'sale' && open.row.status === 'completed' && (
                  <Button variant="secondary" onClick={editSale}>
                    <i className="bi bi-pencil-square" /> Edit sale
                  </Button>
                )}
                {open.row.kind === 'sale' && open.row.status === 'completed' && !voiding && (
                  <Button
                    variant="danger"
                    disabled={!isManager}
                    title={isManager ? undefined : 'Manager sign-in required to void'}
                    onClick={() => {
                      setCancelling(false);
                      setReason('');
                      setVoiding(true);
                    }}
                  >
                    <i className="bi bi-x-octagon" /> Void sale
                  </Button>
                )}
              </div>
            )}
            {voiding && (
              <div style={{ marginTop: 10, border: '1px solid var(--red-line)', background: 'var(--red-bg)', borderRadius: 12, padding: '12px 14px' }}>
                <div style={{ font: '700 14px Inter, sans-serif', color: 'var(--red)' }}>Void this sale? Tenders are reversed and stock returns.</div>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (optional)"
                  style={{ width: '100%', marginTop: 8, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 14 }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                  <Button variant="ghost" onClick={() => setVoiding(false)}>Keep sale</Button>
                  <Button variant="danger" disabled={busy} onClick={() => void voidSale()}>Confirm void</Button>
                </div>
              </div>
            )}

            {open.row.ticketId && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
                <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>LINKED REPAIR</div>
                {!ticket ? (
                  <div style={{ marginTop: 6, fontSize: 14, color: 'var(--ink-3)' }}>Loading ticket…</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6, gap: 8 }}>
                      <span style={{ font: '700 15.5px Inter, sans-serif' }}>#{ticket.ticket.number}</span>
                      <StatusChip tone={ticket.ticket.status === 'cancelled' ? 'red' : ticket.ticket.status === 'completed' ? 'green' : 'neutral'}>
                        {ticket.ticket.status.replace('_', ' ')}
                      </StatusChip>
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--ink-2)', marginTop: 2 }}>
                      {ticket.devices.map((d) => d.label).join(' + ')} — {ticket.lines.map((l) => l.description).join(', ')}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 10 }}>
                      {(
                        [
                          ['callFlag', 'bi-telephone-fill', 'Call', 'var(--purple)', 'var(--purple-bg)'],
                          ['partsFlag', 'bi-box-seam', 'Awaiting parts', 'var(--amber)', 'var(--amber-bg)'],
                          ['alertFlag', 'bi-exclamation-triangle-fill', 'Alert', 'var(--red)', 'var(--red-bg)'],
                        ] as const
                      ).map(([flag, icon, label, color, bg]) => {
                        const on = ticket.ticket[flag];
                        return (
                          <button
                            key={flag}
                            onClick={() => void toggleTag(flag)}
                            aria-pressed={on}
                            title={flag === 'alertFlag' ? 'Alert: check the notes on this repair or customer first' : on ? `${label} tag on — tap to clear` : `Tag: ${label}`}
                            style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 10px', borderRadius: 10,
                              border: `1px solid ${on ? color : 'var(--line)'}`, background: on ? bg : 'var(--card)', color: on ? color : 'var(--ink-3)',
                              font: '600 13px Inter, sans-serif', whiteSpace: 'nowrap',
                            }}
                          >
                            <i className={`bi ${icon}`} style={{ fontSize: 12 }} /> {label}
                          </button>
                        );
                      })}
                    </div>
                    {ticket.ticket.alertFlag && (
                      <div style={{ marginTop: 8, border: '1px solid var(--red-line)', background: 'var(--red-bg)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5 }}>
                        <div style={{ font: '700 13px Inter, sans-serif', color: 'var(--red)' }}>
                          <i className="bi bi-exclamation-triangle-fill" /> Check the notes before working on this
                        </div>
                        {ticket.ticket.notesForTech && <div style={{ marginTop: 4 }}>Repair: {ticket.ticket.notesForTech}</div>}
                        {ticket.customer?.note && <div style={{ marginTop: 4 }}>Customer: {ticket.customer.note}</div>}
                        {!ticket.ticket.notesForTech && !ticket.customer?.note && <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>No notes written yet.</div>}
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                      <Button variant="secondary" onClick={printLabel}>
                        <i className="bi bi-tag" /> Print ticket label
                      </Button>
                      <Button variant="secondary" onClick={() => navigate(`/repairs?ticket=${ticket.ticket.id}`)}>
                        <i className="bi bi-wrench-adjustable" /> Open on board
                      </Button>
                      {!['picked_up', 'cancelled', 'abandoned'].includes(ticket.ticket.status) && !cancelling && (
                        <Button
                          variant="danger"
                          onClick={() => {
                            setVoiding(false);
                            setReason('');
                            setCancelling(true);
                          }}
                        >
                          Cancel ticket
                        </Button>
                      )}
                    </div>
                    {cancelling && (
                      <div style={{ marginTop: 10, border: '1px solid var(--red-line)', background: 'var(--red-bg)', borderRadius: 12, padding: '12px 14px' }}>
                        <div style={{ font: '700 14px Inter, sans-serif', color: 'var(--red)' }}>Cancel ticket #{ticket.ticket.number}?</div>
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Reason * — e.g. customer changed their mind"
                          style={{ width: '100%', marginTop: 8, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 14 }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                          <Button variant="ghost" onClick={() => setCancelling(false)}>Keep ticket</Button>
                          <Button variant="danger" disabled={busy} onClick={() => void cancelTicket()}>Confirm cancel</Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="ghost" onClick={close}>Close</Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
