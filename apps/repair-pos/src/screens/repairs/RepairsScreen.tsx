import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatCents } from '@fmp/shared';
import { Button, DataTable, Modal, StatusChip } from '@fmp/ui';
import { api, SidePanel } from '@fmp/pos-client';
import { DepositModal } from './DepositModal';
import { ManagerCodePrompt, NewRepairWindow, ticketIsLocked, type CreatedTicket } from './NewRepairWindow';
import { printTicketLabel } from './labels';

interface BoardRow {
  id: number;
  number: string;
  status: string;
  callFlag: boolean;
  partsFlag: boolean;
  alertFlag: boolean;
  promisedAt: string | null;
  totalCents: number;
  paidCents: number;
  createdAt: string;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  technicianName: string | null;
  deviceSummary: string | null;
  serviceSummary: string | null;
  warrantyOfTicketId: number | null;
}

interface TicketDetail {
  ticket: BoardRow & { notesForTech: string | null; customerId: number };
  customer: { id: number; name: string; phone: string | null; note?: string | null } | null;
  devices: Array<{ id: number; modelId: number | null; label: string; imei: string | null; powersOn: boolean; unlockMethod: string | null; unlockValue: string | null; conditionNotes: string | null }>;
  lines: Array<{ id: number; ticketDeviceId: number | null; serviceId: number | null; tierLabel: string | null; description: string; priceCents: number; warrantyDays: number }>;
  history: Array<{ id: number; status: string; note: string | null; userName: string | null; createdAt: string }>;
  paidCents: number;
  balanceCents: number;
}

/** Status tabs across the top of the board. */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'waiting_part', label: 'Waiting on part' },
  { id: 'call', label: 'Call' },
  { id: 'parts', label: 'Order parts' },
  { id: 'ready', label: 'Ready for pickup' },
  { id: 'picked_up', label: 'Picked up' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Date quick filters next to the search box. "Today" also keeps every open ticket on the board. */
const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom range' },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** [from, to) instants for a quick range, computed on the register's clock so "today" is the store's day. */
function rangeBounds(range: RangeId, custom: { from: string; to: string }): { from: Date | null; to: Date | null } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  if (range === 'today') return { from: start, to: plusDays(start, 1) };
  if (range === 'yesterday') return { from: plusDays(start, -1), to: start };
  if (range === 'week') return { from: plusDays(start, -((start.getDay() + 6) % 7)), to: plusDays(start, 1) };
  if (range === 'month') return { from: new Date(start.getFullYear(), start.getMonth(), 1), to: plusDays(start, 1) };
  if (range === 'custom') {
    const from = custom.from ? new Date(`${custom.from}T00:00:00`) : null;
    const to = custom.to ? plusDays(new Date(`${custom.to}T00:00:00`), 1) : null;
    return { from, to };
  }
  return { from: null, to: null };
}

const STATUS_TONES: Record<string, 'blue' | 'amber' | 'green' | 'neutral' | 'purple' | 'red'> = {
  open: 'neutral',
  in_progress: 'blue',
  waiting_part: 'amber',
  completed: 'green',
  picked_up: 'neutral',
  cancelled: 'red',
  abandoned: 'red',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_part: 'Waiting on part',
  completed: 'Ready for pickup',
  picked_up: 'Picked up',
  cancelled: 'Cancelled',
  abandoned: 'Abandoned',
};

function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}

/** Nothing more happens to these tickets (except a manager reopening a picked-up one). */
const CLOSED_STATUSES = ['picked_up', 'cancelled', 'abandoned'];

function pastPromised(row: { promisedAt: string | null; status: string }): boolean {
  return (
    row.promisedAt != null &&
    !['completed', 'picked_up', 'cancelled', 'abandoned'].includes(row.status) &&
    new Date(row.promisedAt).getTime() < Date.now()
  );
}

/** The slice of a ticket the workflow buttons need; built from a board row or the detail panel. */
interface StepTicket {
  id: number;
  number: string;
  status: string;
  totalCents: number;
  paidCents: number;
  callFlag: boolean;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
}

/**
 * The one obvious thing to do next with a ticket. Open → start work → ready → collect or
 * hand over → (manager) reopen. Everything else stays reachable through the status pills.
 */
interface NextStep {
  id: 'start' | 'ready' | 'resume' | 'collect' | 'pickup' | 'reopen';
  label: string;
  short: string;
  icon: string;
  bg: string;
  fg: string;
  border: string;
}

function nextStepFor(t: StepTicket): NextStep | null {
  const balance = t.totalCents - t.paidCents;
  switch (t.status) {
    case 'open':
      return { id: 'start', label: 'Start work', short: 'Start', icon: 'bi-play-fill', bg: 'var(--navy)', fg: '#fff', border: 'var(--navy)' };
    case 'in_progress':
      return { id: 'ready', label: 'Mark ready for pickup', short: 'Ready', icon: 'bi-check2-circle', bg: 'var(--green)', fg: '#fff', border: 'var(--green)' };
    case 'waiting_part':
      return { id: 'resume', label: 'Part arrived — resume work', short: 'Resume', icon: 'bi-box-seam', bg: 'var(--navy)', fg: '#fff', border: 'var(--navy)' };
    case 'completed':
      return balance > 0
        ? { id: 'collect', label: `Collect ${formatCents(balance)} & close`, short: 'Collect', icon: 'bi-cash-coin', bg: 'var(--orange)', fg: '#fff', border: 'var(--orange)' }
        : { id: 'pickup', label: 'Customer picked up — close ticket', short: 'Picked up', icon: 'bi-bag-check', bg: 'var(--green)', fg: '#fff', border: 'var(--green)' };
    case 'picked_up':
      return { id: 'reopen', label: 'Reopen ticket · manager code', short: 'Reopen', icon: 'bi-arrow-counterclockwise', bg: 'var(--card)', fg: 'var(--ink-2)', border: 'var(--line)' };
    default:
      return null;
  }
}

export function RepairsScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<TabId>('all');
  const [range, setRange] = useState<RangeId>('today');
  const [custom, setCustom] = useState({ from: localDay(new Date()), to: localDay(new Date()) });
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [openTotal, setOpenTotal] = useState(0);
  const [counts, setCounts] = useState<Record<TabId, number>>({ all: 0, open: 0, in_progress: 0, waiting_part: 0, call: 0, parts: 0, ready: 0, picked_up: 0, cancelled: 0 });
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  // deep link from the Transactions log: /repairs?ticket=<id> opens that ticket's panel
  useEffect(() => {
    const id = Number(params.get('ticket'));
    if (id) setDetailId(id);
  }, [params]);
  const [newOpen, setNewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [depositTicket, setDepositTicket] = useState<{ id: number; number: string; balanceCents: number } | null>(null);
  const cancelInFlight = useRef(false);
  const [cancelBusy,setCancelBusy] = useState(false);
  const [cancelError,setCancelError] = useState('');
  const [cancelRefund,setCancelRefund] = useState<'cash'|'store_credit'|''>('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [error, setError] = useState('');
  /** ticket id with a PATCH in flight — its buttons are disabled so a double tap cannot skip a step */
  const [busyId, setBusyId] = useState<number | null>(null);
  /** The status pills are the "jump to any status" escape hatch; hidden by default so the next step stands alone. */
  const [pillsOpen, setPillsOpen] = useState(() => {
    try {
      return localStorage.getItem('fmp.repairs.pills') === '1';
    } catch {
      return false;
    }
  });
  const togglePills = () =>
    setPillsOpen((open) => {
      try {
        localStorage.setItem('fmp.repairs.pills', open ? '0' : '1');
      } catch {
        /* private mode: the choice just lasts the session */
      }
      return !open;
    });

  // reopen flow: reason first, then the manager code sheet
  const [reopen, setReopen] = useState<{ id: number; number: string } | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenPin, setReopenPin] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenError, setReopenError] = useState('');

  async function load() {
    const { from, to } = rangeBounds(range, custom);
    const params = new URLSearchParams({ status: tab });
    if (from) params.set('from', from.toISOString());
    if (to) params.set('to', to.toISOString());
    if (range === 'today') params.set('withOpen', '1');
    const res = await api<{ rows: BoardRow[]; counts: Array<{ status: string; callFlag: boolean; partsFlag: boolean; n: number }>; openCount: number }>(
      `/api/repairs?${params}`,
    ).catch(() => null);
    if (!res) return;
    setRows(res.rows);
    setOpenTotal(res.openCount);
    const open = ['open', 'in_progress', 'waiting_part', 'completed'];
    const sum = (pred: (c: { status: string; callFlag: boolean; partsFlag: boolean; n: number }) => boolean) =>
      res.counts.filter(pred).reduce((s, c) => s + Number(c.n), 0);
    setCounts({
      all: sum(() => true),
      open: sum((c) => open.includes(c.status)),
      in_progress: sum((c) => c.status === 'in_progress'),
      waiting_part: sum((c) => c.status === 'waiting_part'),
      call: sum((c) => c.callFlag && open.includes(c.status)),
      parts: sum((c) => c.partsFlag && open.includes(c.status)),
      ready: sum((c) => c.status === 'completed'),
      picked_up: sum((c) => c.status === 'picked_up'),
      cancelled: sum((c) => c.status === 'cancelled' || c.status === 'abandoned'),
    });
  }

  useEffect(() => {
    if (range === 'custom' && (!custom.from || !custom.to)) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, range, custom.from, custom.to]);

  /** null = note box hidden; a string = drafting the waiting-on-part note */
  const [partNote, setPartNote] = useState<string | null>(null);

  useEffect(() => {
    setPartNote(null);
    if (detailId == null) {
      setDetail(null);
      return;
    }
    void api<TicketDetail>(`/api/repairs/${detailId}`).then(setDetail).catch(() => setDetail(null));
  }, [detailId]);

  async function refreshAll() {
    await load();
    if (detailId != null) {
      await api<TicketDetail>(`/api/repairs/${detailId}`).then(setDetail).catch(() => {});
    }
  }

  async function patchTicket(id: number, body: Record<string, unknown>) {
    setError('');
    setBusyId(id);
    try {
      await api(`/api/repairs/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  /** Ready for pickup also raises the Call flag, so the board's Call tab becomes the "who to phone" list. */
  const markReady = (id: number) => patchTicket(id, { status: 'completed', callFlag: true });

  /** Hand the balance to the register; the sale closes the ticket as picked up once it is paid in full. */
  function collectAtRegister(t: StepTicket) {
    const balance = t.totalCents - t.paidCents;
    if (balance <= 0) return;
    sessionStorage.setItem(
      'fmp.resumeSale',
      JSON.stringify({
        id: null,
        customer: t.customerId ? { id: t.customerId, name: t.customerName ?? '', phone: t.customerPhone } : null,
        lines: [],
        collectTicket: { id: t.id, number: t.number, balanceCents: balance },
      }),
    );
    navigate('/register');
  }

  function runStep(t: StepTicket, step: NextStep) {
    switch (step.id) {
      case 'start':
        return void patchTicket(t.id, { status: 'in_progress' });
      case 'ready':
        return void markReady(t.id);
      case 'resume':
        return void patchTicket(t.id, { status: 'in_progress', statusNote: 'Part arrived' });
      case 'pickup':
        return void patchTicket(t.id, { status: 'picked_up' });
      case 'collect':
        return collectAtRegister(t);
      case 'reopen':
        setReopenReason('');
        setReopenPin(false);
        setReopenError('');
        setReopen({ id: t.id, number: t.number });
        return;
    }
  }

  /** Call outcomes land on the history; "notified" also clears the flag so the ticket leaves the Call tab. */
  const customerNotified = (t: StepTicket) =>
    patchTicket(t.id, { callFlag: false, statusNote: t.status === 'completed' ? 'Customer notified — ready for pickup' : 'Customer notified' });
  const leftMessage = (t: StepTicket) => patchTicket(t.id, { statusNote: 'Left a message for the customer' });

  async function submitReopen(pin: string) {
    if (!reopen) return;
    setReopenBusy(true);
    setReopenError('');
    try {
      await api(`/api/repairs/${reopen.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: reopenReason.trim(), managerPin: pin }) });
      setReopen(null);
      setReopenPin(false);
      await refreshAll();
    } catch (e) {
      setReopenError(e instanceof Error ? e.message : 'Could not reopen the ticket');
    } finally {
      setReopenBusy(false);
    }
  }

  function handleCreated(ticket: CreatedTicket, exit: 'board' | 'deposit' | 'sale') {
    setNewOpen(false);
    if (exit === 'deposit') {
      setDepositTicket({ id: ticket.id, number: ticket.number, balanceCents: ticket.totalCents });
    } else if (exit === 'sale') {
      sessionStorage.setItem(
        'fmp.resumeSale',
        JSON.stringify({
          id: null,
          customer: ticket.customer,
          lines: ticket.lines.map((l) => ({
            kind: 'repair',
            description: `${ticket.number} · ${l.description}`,
            qty: 1,
            unitCents: l.priceCents,
            discountCents: 0,
            taxable: true,
            ticketId: ticket.id,
          })),
        }),
      );
      navigate('/register');
      return;
    }
    void load();
  }

  /** Segmented status tabs, sized to sit inline beside the search box. */
  const tabStrip = (
    <div
      role="tablist"
      aria-label="Ticket status"
      style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 12, background: 'var(--line-soft)', overflowX: 'auto', flex: '1 1 100%', order: -1 }}
    >
      {TABS.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => setTab(t.id)}
            style={{
              flex: '1 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
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
            {(active || counts[t.id] > 0) && (
            <span
              style={{
                minWidth: 20,
                padding: '0 6px',
                borderRadius: 999,
                background: active ? 'var(--orange-soft)' : 'transparent',
                color: active ? 'var(--orange)' : 'var(--ink-4)',
                font: '600 12px Inter, sans-serif',
                textAlign: 'center',
              }}
            >
              {counts[t.id]}
            </span>
            )}
          </button>
        );
      })}
    </div>
  );

  /** Date range dropdown (native select: opens the iPad picker wheel). */
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
          padding: '10px 34px 10px 34px',
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

  const dateInput = (key: 'from' | 'to') => (
    <input
      type="date"
      aria-label={key === 'from' ? 'From date' : 'To date'}
      value={custom[key]}
      max={key === 'from' ? custom.to || undefined : undefined}
      min={key === 'to' ? custom.from || undefined : undefined}
      onChange={(e) => setCustom((prev) => ({ ...prev, [key]: e.target.value }))}
      style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', font: '500 14px Inter, sans-serif', color: 'var(--ink)' }}
    />
  );

  /** Small pill button used for the per-row quick actions on the board. */
  const rowButton = (opts: { label: string; icon: string; title: string; bg: string; fg: string; border: string; disabled: boolean; onClick: () => void }) => (
    <button
      type="button"
      title={opts.title}
      aria-label={opts.title}
      disabled={opts.disabled}
      onClick={(e) => {
        e.stopPropagation();
        opts.onClick();
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: opts.label ? 5 : 0,
        padding: opts.label ? '6px 10px' : '6px 9px',
        borderRadius: 999,
        border: `1px solid ${opts.border}`,
        background: opts.bg,
        color: opts.fg,
        font: '600 12.5px Inter, sans-serif',
        whiteSpace: 'nowrap',
        cursor: opts.disabled ? 'default' : 'pointer',
        opacity: opts.disabled ? 0.5 : 1,
      }}
    >
      <i className={`bi ${opts.icon}`} style={{ fontSize: 12 }} />
      {opts.label}
    </button>
  );

  const panelTicket: StepTicket | null = detail
    ? {
        id: detail.ticket.id,
        number: detail.ticket.number,
        status: detail.ticket.status,
        totalCents: detail.ticket.totalCents,
        paidCents: detail.paidCents,
        callFlag: detail.ticket.callFlag,
        customerId: detail.customer?.id ?? detail.ticket.customerId ?? null,
        customerName: detail.customer?.name ?? null,
        customerPhone: detail.customer?.phone ?? null,
      }
    : null;
  const panelStep = panelTicket ? nextStepFor(panelTicket) : null;
  const panelBusy = detail != null && busyId === detail.ticket.id;
  const panelClosed = detail != null && CLOSED_STATUSES.includes(detail.ticket.status);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Repairs</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
              {openTotal} open · {rows.filter(pastPromised).length} past promised
            </div>
          </div>
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <i className="bi bi-plus-lg" /> New repair
          </Button>
        </div>
        {error && detailId === null && (
          <div role="alert" style={{ marginTop: 10, color: 'var(--red)', fontSize: 14 }}>
            <i className="bi bi-exclamation-circle" /> {error}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <DataTable
            columns={[
              {
                key: 'ticket',
                label: 'Ticket & customer',
                sortValue: (r: BoardRow) => r.number,
                render: (r: BoardRow) => (
                  <div style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ font: '700 14.5px Inter, sans-serif' }}>{r.number}</div>
                    <div style={{ fontWeight: 600, marginTop: 3 }}>{r.customerName}</div>
                    {r.customerPhone && <div style={{ color: 'var(--ink-4)', fontSize: 12.5, marginTop: 1 }}>{r.customerPhone}</div>}
                  </div>
                ),
              },
              {
                key: 'device',
                label: 'Device & service',
                sortValue: (r: BoardRow) => r.deviceSummary ?? '',
                render: (r: BoardRow) => (
                  <div style={{ minWidth: 200, maxWidth: 320 }}>
                    <div style={{ fontWeight: 600 }}>{r.deviceSummary}</div>
                    <div style={{ color: 'var(--ink-3)', fontSize: 13, marginTop: 2 }}>{r.serviceSummary}</div>
                  </div>
                ),
              },
              {
                key: 'when',
                label: 'Date & time',
                sortValue: (r: BoardRow) => new Date(r.promisedAt ?? r.createdAt).getTime(),
                render: (r: BoardRow) => {
                  const late = pastPromised(r);
                  return (
                    <div style={{ color: late ? 'var(--red)' : 'var(--ink-2)', fontWeight: late ? 600 : 500, whiteSpace: 'nowrap' }}>
                      {new Date(r.promisedAt ?? r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      <div style={{ color: late ? 'var(--red)' : 'var(--ink-4)', fontSize: 12.5, fontWeight: 400, marginTop: 2 }}>
                        {new Date(r.promisedAt ?? r.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                  );
                },
              },
              {
                key: 'total',
                label: 'Total',
                align: 'right',
                sortValue: (r: BoardRow) => r.totalCents,
                render: (r: BoardRow) => {
                  const balance = r.totalCents - r.paidCents;
                  return (
                    <div style={{ whiteSpace: 'nowrap' }}>
                      <b>{formatCents(r.totalCents)}</b>
                      <div style={{ color: balance > 0 ? 'var(--red)' : 'var(--green)', fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>
                        {balance > 0 ? `${formatCents(balance)} due` : 'Paid'}
                      </div>
                    </div>
                  );
                },
              },
              {
                key: 'status',
                label: 'Status',
                sortValue: (r: BoardRow) => (pastPromised(r) ? 'zz past promised' : r.status),
                render: (r: BoardRow) => {
                  const late = pastPromised(r);
                  const balance = r.totalCents - r.paidCents;
                  return (
                    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                      {late && <StatusChip tone="red">Past promised</StatusChip>}
                      {r.callFlag && !['picked_up', 'cancelled'].includes(r.status) && (
                        <StatusChip tone="purple">
                          <i className="bi bi-telephone-fill" style={{ fontSize: 10.5 }} /> Call
                        </StatusChip>
                      )}
                      {r.partsFlag && !['picked_up', 'cancelled'].includes(r.status) && (
                        <StatusChip tone="amber">
                          <i className="bi bi-box-seam" style={{ fontSize: 10.5 }} /> Order parts
                        </StatusChip>
                      )}
                      {r.alertFlag && !['picked_up', 'cancelled'].includes(r.status) && (
                        <StatusChip tone="red">
                          <i className="bi bi-exclamation-triangle-fill" style={{ fontSize: 10.5 }} /> Alert
                        </StatusChip>
                      )}
                      {!late &&
                        (r.status === 'completed' ? (
                          <StatusChip tone={balance > 0 ? 'amber' : 'green'}>
                            Ready · {balance > 0 ? 'Unpaid' : 'Paid'}
                          </StatusChip>
                        ) : (
                          <StatusChip tone={STATUS_TONES[r.status] ?? 'neutral'}>{statusLabel(r.status)}</StatusChip>
                        ))}
                    </span>
                  );
                },
              },
              {
                key: 'actions',
                label: '',
                render: (r: BoardRow) => {
                  const step = nextStepFor(r);
                  const closed = CLOSED_STATUSES.includes(r.status);
                  const busy = busyId === r.id;
                  return (
                    <span style={{ display: 'inline-flex', gap: 6, whiteSpace: 'nowrap' }}>
                      {step && step.id !== 'reopen' &&
                        rowButton({
                          label: step.short,
                          icon: step.icon,
                          title: `${step.label} · ${r.number}`,
                          bg: step.bg,
                          fg: step.fg,
                          border: step.border,
                          disabled: busy,
                          onClick: () => runStep(r, step),
                        })}
                      {!closed &&
                        (r.callFlag
                          ? rowButton({
                              label: '',
                              icon: 'bi-telephone-fill',
                              title: `Call flagged · ${r.number} — open to log the call`,
                              bg: 'var(--purple)',
                              fg: '#fff',
                              border: 'var(--purple)',
                              disabled: busy,
                              onClick: () => setDetailId(r.id),
                            })
                          : rowButton({
                              label: '',
                              icon: 'bi-telephone',
                              title: `Flag ${r.number} to call the customer`,
                              bg: 'var(--card)',
                              fg: 'var(--ink-2)',
                              border: 'var(--line)',
                              disabled: busy,
                              onClick: () => void patchTicket(r.id, { callFlag: true }),
                            }))}
                    </span>
                  );
                },
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetailId(r.id)}
            selectedKey={detailId}
            searchText={(r) =>
              `${r.number} ${r.customerName ?? ''} ${r.customerPhone ?? ''} ${r.deviceSummary ?? ''} ${r.serviceSummary ?? ''}`
            }
            searchPlaceholder="Search ticket #, customer, phone, or device"
            toolbarStart={tabStrip}
            toolbar={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
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
            initialSort={{ key: 'when', dir: 'desc' }}
            emptyText={range === 'today' ? 'Nothing open and no tickets touched today.' : 'No tickets in this view.'}
            footer={<span>Showing {rows.length} tickets · {rows.filter(pastPromised).length} past promised</span>}
          />
        </div>
      </div>

      {/* Detail panel */}
      <SidePanel open={detailId !== null} onClose={() => setDetailId(null)}>
        <div style={{ padding: '22px 20px' }}>
        {detail && panelTicket ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>{detail.ticket.number}</h2>
              <StatusChip tone={STATUS_TONES[detail.ticket.status] ?? 'neutral'}>{statusLabel(detail.ticket.status)}</StatusChip>
            </div>
            <div style={{ fontSize: 14, color: 'var(--ink-3)', marginTop: 4 }}>
              {detail.customer?.name} · {detail.customer?.phone}
            </div>
            {detail.ticket.warrantyOfTicketId && (
              <div style={{ marginTop: 6 }}><StatusChip tone="blue">Warranty rework</StatusChip></div>
            )}

            {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}

            {panelStep && (
              <>
                <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '14px 0 6px' }}>NEXT STEP</div>
                <button
                  onClick={() => runStep(panelTicket, panelStep)}
                  disabled={panelBusy}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '13px 0',
                    borderRadius: 12,
                    border: `1px solid ${panelStep.border}`,
                    background: panelStep.bg,
                    color: panelStep.fg,
                    font: '700 15.5px Inter, sans-serif',
                    opacity: panelBusy ? 0.6 : 1,
                  }}
                >
                  <i className={`bi ${panelStep.icon}`} /> {panelStep.label}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={togglePills}
              aria-expanded={pillsOpen}
              style={{ marginTop: 12, padding: 0, border: 'none', background: 'none', color: 'var(--ink-3)', font: '600 12.5px Inter, sans-serif', cursor: 'pointer' }}
            >
              <i className={`bi ${pillsOpen ? 'bi-chevron-up' : 'bi-chevron-down'}`} style={{ fontSize: 11 }} />{' '}
              {pillsOpen ? 'Hide status buttons' : 'Change status'}
            </button>
            {pillsOpen && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {(
                [
                  ['open', 'Open'],
                  ['in_progress', 'In progress'],
                  ['waiting_part', 'Waiting on part'],
                  ['completed', 'Completed'],
                ] as const
              ).map(([s, label]) => (
                <button
                  key={s}
                  onClick={() => {
                    if (s === 'waiting_part') {
                      setPartNote('');
                    } else if (s === 'completed') {
                      setPartNote(null);
                      void markReady(detail.ticket.id);
                    } else {
                      setPartNote(null);
                      void patchTicket(detail.ticket.id, { status: s });
                    }
                  }}
                  disabled={panelBusy || detail.ticket.status === s || panelClosed}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 999,
                    border: '1px solid var(--line)',
                    background: detail.ticket.status === s ? 'var(--navy)' : 'var(--card)',
                    color: detail.ticket.status === s ? '#fff' : 'var(--ink-2)',
                    font: '600 12.5px Inter, sans-serif',
                    opacity: panelClosed && detail.ticket.status !== s ? 0.4 : 1,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            )}
            {partNote !== null && (
              <div style={{ marginTop: 10, border: '1px solid var(--amber)', background: 'var(--amber-bg)', borderRadius: 12, padding: '12px 14px' }}>
                <div style={{ font: '600 14px Inter, sans-serif', color: 'var(--amber)' }}>
                  <i className="bi bi-box-seam" /> Waiting on which part?
                </div>
                <textarea
                  value={partNote}
                  onChange={(e) => setPartNote(e.target.value)}
                  rows={2}
                  autoFocus
                  placeholder="Part, supplier, ETA — e.g. iPhone 11 screen from MobileSentrix, lands Thursday"
                  style={{ width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 14.5, resize: 'none', background: 'var(--card)' }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <Button variant="ghost" onClick={() => setPartNote(null)}>Cancel</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      const note = partNote.trim();
                      setPartNote(null);
                      void patchTicket(detail.ticket.id, { status: 'waiting_part', statusNote: note || null });
                    }}
                  >
                    Mark waiting on part
                  </Button>
                </div>
              </div>
            )}

            {detail.ticket.status === 'waiting_part' &&
              partNote === null &&
              (() => {
                const last = [...detail.history].reverse().find((h) => h.status === 'waiting_part');
                return last?.note ? (
                  <div style={{ marginTop: 10, background: 'var(--amber-bg)', color: 'var(--amber)', borderRadius: 10, padding: '10px 13px', font: '600 13.5px Inter, sans-serif' }}>
                    <i className="bi bi-box-seam" /> Waiting on: {last.note}
                  </div>
                ) : null;
              })()}

            {detail.ticket.callFlag && !panelClosed && (
              <div style={{ marginTop: 10, border: '1px solid var(--purple)', background: 'var(--purple-bg)', borderRadius: 12, padding: '12px 14px' }}>
                <div style={{ font: '700 14px Inter, sans-serif', color: 'var(--purple)' }}>
                  <i className="bi bi-telephone-fill" />{' '}
                  {detail.ticket.status === 'completed'
                    ? `Tell ${detail.customer?.name ?? 'the customer'} it's ready`
                    : `Call ${detail.customer?.name ?? 'the customer'}`}
                </div>
                <div style={{ marginTop: 4, font: '700 20px Inter, sans-serif', color: 'var(--ink)' }}>
                  {detail.customer?.phone ? (
                    <a href={`tel:${detail.customer.phone.replace(/[^\d+]/g, '')}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {detail.customer.phone}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--ink-4)', font: '500 14px Inter, sans-serif' }}>No phone number on file — add one on the customer.</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => void customerNotified(panelTicket)}
                    disabled={panelBusy}
                    style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: 'none', background: 'var(--purple)', color: '#fff', font: '700 14px Inter, sans-serif' }}
                  >
                    <i className="bi bi-check2" /> Customer notified
                  </button>
                  <button
                    onClick={() => void leftMessage(panelTicket)}
                    disabled={panelBusy}
                    style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--purple)', background: 'var(--card)', color: 'var(--purple)', font: '600 14px Inter, sans-serif' }}
                  >
                    <i className="bi bi-voicemail" /> Left a message
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                onClick={() => void patchTicket(detail.ticket.id, { callFlag: !detail.ticket.callFlag })}
                aria-pressed={detail.ticket.callFlag}
                disabled={panelBusy || panelClosed}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 12px',
                  borderRadius: 10, border: `1px solid ${detail.ticket.callFlag ? 'var(--purple)' : 'var(--line)'}`,
                  background: detail.ticket.callFlag ? 'var(--purple)' : 'var(--card)',
                  color: detail.ticket.callFlag ? '#fff' : 'var(--ink-2)', font: '600 14px Inter, sans-serif',
                }}
              >
                <i className={`bi ${detail.ticket.callFlag ? 'bi-telephone-fill' : 'bi-telephone'}`} />
                {detail.ticket.callFlag ? 'Call · on' : 'Call'}
              </button>
              <button
                onClick={() => void patchTicket(detail.ticket.id, { partsFlag: !detail.ticket.partsFlag })}
                aria-pressed={detail.ticket.partsFlag}
                disabled={panelBusy || panelClosed}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 12px',
                  borderRadius: 10, border: `1px solid ${detail.ticket.partsFlag ? 'var(--amber)' : 'var(--line)'}`,
                  background: detail.ticket.partsFlag ? 'var(--amber)' : 'var(--card)',
                  color: detail.ticket.partsFlag ? '#fff' : 'var(--ink-2)', font: '600 14px Inter, sans-serif',
                }}
              >
                <i className={`bi ${detail.ticket.partsFlag ? 'bi-box-seam-fill' : 'bi-box-seam'}`} />
                {detail.ticket.partsFlag ? 'Order parts · on' : 'Order parts'}
              </button>
              <button
                onClick={() => void patchTicket(detail.ticket.id, { alertFlag: !detail.ticket.alertFlag })}
                aria-pressed={detail.ticket.alertFlag}
                disabled={panelBusy || panelClosed}
                title="Alert: check the notes on this repair or customer first"
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 12px',
                  borderRadius: 10, border: `1px solid ${detail.ticket.alertFlag ? 'var(--red)' : 'var(--line)'}`,
                  background: detail.ticket.alertFlag ? 'var(--red)' : 'var(--card)',
                  color: detail.ticket.alertFlag ? '#fff' : 'var(--ink-2)', font: '600 14px Inter, sans-serif',
                }}
              >
                <i className={`bi ${detail.ticket.alertFlag ? 'bi-exclamation-triangle-fill' : 'bi-exclamation-triangle'}`} />
                {detail.ticket.alertFlag ? 'Alert · on' : 'Alert'}
              </button>
            </div>
            {detail.ticket.alertFlag && (
              <div style={{ marginTop: 8, border: '1px solid var(--red-line)', background: 'var(--red-bg)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, color: 'var(--red)' }}>
                <div style={{ font: '700 13px Inter, sans-serif' }}>
                  <i className="bi bi-exclamation-triangle-fill" /> Check the notes before working on this
                </div>
                {detail.ticket.notesForTech && <div style={{ marginTop: 4, color: 'var(--ink)' }}>Repair: {detail.ticket.notesForTech}</div>}
                {detail.customer?.note && <div style={{ marginTop: 4, color: 'var(--ink)' }}>Customer: {detail.customer.note}</div>}
                {!detail.ticket.notesForTech && !detail.customer?.note && <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>No notes written yet — add one in Edit ticket or on the customer.</div>}
              </div>
            )}

            <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '16px 0 6px' }}>DEVICES & WORK</div>
            {detail.devices.map((d) => (
              <div key={d.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: '9px 12px', marginBottom: 6 }}>
                <div style={{ font: '600 14.5px Inter, sans-serif' }}>
                  {d.label} {!d.powersOn && <StatusChip tone="red" style={{ marginLeft: 4 }}>DOA</StatusChip>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
                  {d.imei ? `IMEI …${d.imei.slice(-5)} · ` : ''}
                  {d.unlockMethod && d.unlockMethod !== 'none' ? `${d.unlockMethod}: ${d.unlockValue ?? '—'}` : 'no lock'}
                </div>
                {d.conditionNotes && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{d.conditionNotes}</div>}
              </div>
            ))}
            {detail.lines.map((l) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 2px' }}>
                <span>{l.description}</span>
                <span style={{ fontWeight: 700 }}>{formatCents(l.priceCents)}</span>
              </div>
            ))}
            {detail.ticket.notesForTech && (
              <div style={{ background: 'var(--amber-bg)', color: 'var(--amber)', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, marginTop: 6 }}>
                <i className="bi bi-sticky" /> {detail.ticket.notesForTech}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 12, paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--ink-3)' }}>
                <span>Total (incl. tax)</span><span>{formatCents(detail.ticket.totalCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 3 }}>
                <span style={{ color: 'var(--ink-3)' }}>Paid</span>
                <span style={{ color: 'var(--green)', fontWeight: 600 }}>{formatCents(detail.paidCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ font: '700 16px Inter, sans-serif' }}>Balance</span>
                <span style={{ font: '800 20.5px Inter, sans-serif', color: detail.balanceCents > 0 ? 'var(--red)' : 'var(--green)' }}>
                  {formatCents(detail.balanceCents)}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {detail.balanceCents > 0 && !panelClosed && (
                <>
                  {panelStep?.id !== 'collect' && (
                    <Button variant="primary" onClick={() => collectAtRegister(panelTicket)}>
                      Collect balance at register
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => setDepositTicket({ id: detail.ticket.id, number: detail.ticket.number, balanceCents: detail.balanceCents })}>
                    Take deposit
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                onClick={() =>
                  printTicketLabel({
                    number: detail.ticket.number,
                    customer: detail.customer?.name ?? '',
                    phone: detail.customer?.phone,
                    device: detail.devices.map((d) => d.label).join(' + '),
                    issue: detail.lines.map((l) => l.description).join(', '),
                    priceText: formatCents(detail.balanceCents > 0 ? detail.balanceCents : detail.ticket.totalCents),
                    paid: detail.balanceCents <= 0,
                  })
                }
              >
                <i className="bi bi-tag" /> Print label
              </Button>
              {!['cancelled', 'abandoned'].includes(detail.ticket.status) && (
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  <i className={`bi ${ticketIsLocked({ status: detail.ticket.status, paidCents: detail.paidCents }) ? 'bi-shield-lock' : 'bi-pencil'}`} /> Edit ticket
                  {ticketIsLocked({ status: detail.ticket.status, paidCents: detail.paidCents }) && <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}>· manager code</span>}
                </Button>
              )}
              {!panelClosed && (
                <Button variant="danger" onClick={() => { setCancelError(''); setCancelRefund(''); setCancelling(true); }}>Cancel ticket</Button>
              )}
            </div>

            <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '16px 0 6px' }}>HISTORY</div>
            {detail.history.map((h) => (
              <div key={h.id} style={{ padding: '3px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--ink-3)' }}>
                  <span>{statusLabel(h.status)} · {h.userName}</span>
                  <span>{new Date(h.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                {h.note && <div style={{ fontSize: 12.5, color: 'var(--amber)', fontWeight: 600 }}>— {h.note}</div>}
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: 'var(--ink-4)', fontSize: 15, marginTop: 40, textAlign: 'center' }}>Select a ticket.</div>
        )}
        </div>
      </SidePanel>

      <NewRepairWindow open={newOpen} onClose={() => setNewOpen(false)} onCreated={handleCreated} />
      <NewRepairWindow
        open={editOpen && detail !== null}
        edit={
          detail && {
            id: detail.ticket.id,
            number: detail.ticket.number,
            status: detail.ticket.status,
            paidCents: detail.paidCents,
            callFlag: detail.ticket.callFlag,
            partsFlag: detail.ticket.partsFlag,
            alertFlag: detail.ticket.alertFlag,
            notesForTech: detail.ticket.notesForTech,
            customer: detail.customer ? { id: detail.customer.id, name: detail.customer.name, phone: detail.customer.phone } : null,
            devices: detail.devices,
            lines: detail.lines,
          }
        }
        onClose={() => setEditOpen(false)}
        onCreated={handleCreated}
        onSaved={() => {
          setEditOpen(false);
          void refreshAll();
        }}
      />
      <DepositModal ticket={depositTicket} onClose={() => setDepositTicket(null)} onDone={() => void refreshAll()} />

      <Modal open={reopen !== null && !reopenPin} onClose={() => setReopen(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Reopen {reopen?.number}?</h2>
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>
          The ticket goes back to In progress so the tech can work on it again. A manager code is needed and the approval is written to the ticket history.
        </p>
        <label style={{ display: 'block' }}>Reason
          <input
            value={reopenReason}
            autoFocus
            onChange={(e) => setReopenReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && reopenReason.trim().length >= 2) setReopenPin(true); }}
            placeholder="For example, screen lifting again after pickup"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button variant="ghost" onClick={() => setReopen(null)}>Keep closed</Button>
          <Button variant="primary" disabled={reopenReason.trim().length < 2} onClick={() => { setReopenError(''); setReopenPin(true); }}>
            Continue
          </Button>
        </div>
      </Modal>
      <ManagerCodePrompt
        open={reopen !== null && reopenPin}
        busy={reopenBusy}
        error={reopenError}
        ticketNumber={reopen?.number ?? ''}
        message="Enter the store admin code or a manager's PIN to reopen this ticket. The approval and your reason are recorded on the ticket."
        onCancel={() => setReopenPin(false)}
        onSubmit={(pin) => void submitReopen(pin)}
      />

      <Modal open={cancelling} onClose={() => { if(!cancelInFlight.current) setCancelling(false); }} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Cancel {detail?.ticket.number}?</h2>
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>This closes the repair and returns its consumed parts to stock. Register payments must be refunded from their original sale first.</p>
        {(detail?.paidCents ?? 0) > 0 && <fieldset disabled={cancelBusy} style={{ border: '1px solid var(--line)', borderRadius: 10, margin: '12px 0', padding: 12 }}>
          <legend>Return {formatCents(detail!.paidCents)} in deposits</legend>
          <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Choose the return you will record. This does not reverse a card charge at the terminal.</p>
          {([['cash','Give cash back'],['store_credit','Issue shared store credit']] as const).map(([value,label])=>
            <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
              <input type="radio" name="cancel-refund" value={value} checked={cancelRefund===value} onChange={()=>setCancelRefund(value)} />{label}
            </label>)}
        </fieldset>}
        <label style={{ display: 'block' }}>Reason
          <input value={cancelReason} disabled={cancelBusy} onChange={e=>setCancelReason(e.target.value)}
            placeholder="For example, customer declined quote" style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
        </label>
        {cancelError && <p role="alert" style={{ color: 'var(--red)', fontSize: 14 }}>{cancelError}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button variant="ghost" disabled={cancelBusy} onClick={()=>setCancelling(false)}>Keep ticket</Button>
          <Button variant="danger" disabled={cancelBusy || cancelReason.trim().length<2 || ((detail?.paidCents ?? 0)>0 && !cancelRefund)}
            onClick={async()=>{
              if(cancelInFlight.current || !detail)return;
              cancelInFlight.current=true;setCancelBusy(true);setCancelError('');
              try {
                await api('/api/repairs/'+detail.ticket.id+'/cancel',{method:'POST',body:JSON.stringify({reason:cancelReason.trim(),refundMethod:cancelRefund || undefined})});
                setCancelling(false);setCancelReason('');setCancelRefund('');await refreshAll();
              } catch(e) {setCancelError(e instanceof Error ? e.message : 'Cancellation failed');}
              finally {cancelInFlight.current=false;setCancelBusy(false);}
            }}>Cancel ticket</Button>
        </div>
      </Modal>
    </div>
  );
}
