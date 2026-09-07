import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCents } from '@fmp/shared';
import { Button, Modal, StatusChip } from '@fmp/ui';
import { api } from '../../api';
import { DepositModal } from './DepositModal';
import { NewRepairWindow, type CreatedTicket } from './NewRepairWindow';
import { printTicketLabel } from './labels';

interface BoardRow {
  id: number;
  number: string;
  status: string;
  callFlag: boolean;
  promisedAt: string | null;
  totalCents: number;
  paidCents: number;
  createdAt: string;
  customerName: string | null;
  customerPhone: string | null;
  technicianName: string | null;
  deviceSummary: string | null;
  serviceSummary: string | null;
  warrantyOfTicketId: number | null;
}

interface TicketDetail {
  ticket: BoardRow & { notesForTech: string | null; customerId: number };
  customer: { id: number; name: string; phone: string | null } | null;
  devices: Array<{ id: number; label: string; imei: string | null; powersOn: boolean; unlockMethod: string | null; unlockValue: string | null; conditionNotes: string | null }>;
  lines: Array<{ id: number; description: string; priceCents: number; warrantyDays: number }>;
  history: Array<{ id: number; status: string; userName: string | null; createdAt: string }>;
  paidCents: number;
  balanceCents: number;
}

const FILTERS = [
  { id: 'today', label: 'Today' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'waiting_part', label: 'Waiting on part' },
  { id: 'call', label: 'Call' },
  { id: 'ready', label: 'Ready for pickup' },
  { id: 'completed', label: 'Completed' },
] as const;

const STATUS_TONES: Record<string, 'blue' | 'amber' | 'green' | 'neutral' | 'purple' | 'red'> = {
  intake: 'neutral',
  in_progress: 'blue',
  waiting_part: 'amber',
  ready: 'green',
  completed: 'neutral',
  cancelled: 'red',
  abandoned: 'red',
};

function statusLabel(s: string): string {
  return s === 'intake' ? 'Intake' : s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function pastPromised(row: { promisedAt: string | null; status: string }): boolean {
  return (
    row.promisedAt != null &&
    !['completed', 'cancelled', 'abandoned'].includes(row.status) &&
    new Date(row.promisedAt).getTime() < Date.now()
  );
}

export function RepairsScreen() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>('today');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [counts, setCounts] = useState<{ open: number; inProgress: number; waiting: number; call: number; ready: number; completed: number; today: number }>({ open: 0, inProgress: 0, waiting: 0, call: 0, ready: 0, completed: 0, today: 0 });
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [depositTicket, setDepositTicket] = useState<{ id: number; number: string; balanceCents: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const res = await api<{ rows: BoardRow[]; counts: Array<{ status: string; callFlag: boolean; n: number }>; todayCount: number }>(
      `/api/repairs?filter=${filter}&query=${encodeURIComponent(query)}`,
    ).catch(() => null);
    if (!res) return;
    setRows(res.rows);
    const open = ['intake', 'in_progress', 'waiting_part', 'ready'];
    const sum = (pred: (c: { status: string; callFlag: boolean; n: number }) => boolean) =>
      res.counts.filter(pred).reduce((s, c) => s + Number(c.n), 0);
    setCounts({
      today: res.todayCount,
      open: sum((c) => open.includes(c.status)),
      inProgress: sum((c) => c.status === 'in_progress'),
      waiting: sum((c) => c.status === 'waiting_part'),
      call: sum((c) => c.callFlag && open.includes(c.status)),
      ready: sum((c) => c.status === 'ready'),
      completed: sum((c) => c.status === 'completed'),
    });
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [filter, query]);

  useEffect(() => {
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

  async function patchTicket(body: Record<string, unknown>) {
    if (detailId == null) return;
    setError('');
    try {
      await api(`/api/repairs/${detailId}`, { method: 'PATCH', body: JSON.stringify(body) });
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
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
          customer: null,
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

  const filterCount = (id: string): number =>
    id === 'today' ? counts.today
    : id === 'open' ? counts.open
    : id === 'in_progress' ? counts.inProgress
    : id === 'waiting_part' ? counts.waiting
    : id === 'call' ? counts.call
    : id === 'ready' ? counts.ready
    : counts.completed;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 24px Inter, sans-serif' }}>Repairs</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 12, marginTop: 2 }}>
              {counts.open} open · {rows.filter(pastPromised).length} past promised
            </div>
          </div>
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <i className="bi bi-plus-lg" /> New repair
          </Button>
        </div>

        <div style={{ position: 'relative', marginTop: 16 }}>
          <i className="bi bi-search" style={{ position: 'absolute', left: 14, top: 13, color: 'var(--ink-4)', fontSize: 14 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticket #, customer, phone, IMEI, or device"
            style={{ width: '100%', padding: '12px 14px 12px 38px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 13 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                padding: '8px 14px',
                borderRadius: 999,
                border: '1px solid var(--line)',
                background: filter === f.id ? 'var(--navy)' : 'var(--card)',
                color: filter === f.id ? '#fff' : 'var(--ink-2)',
                font: '600 12px Inter, sans-serif',
              }}
            >
              {f.id === 'call' && <i className="bi bi-telephone-fill" style={{ marginRight: 4, fontSize: 10 }} />}
              {f.label} <span style={{ opacity: 0.6, marginLeft: 2 }}>{filterCount(f.id)}</span>
            </button>
          ))}
        </div>

        <div style={{ marginTop: 14, background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 10px Inter, sans-serif', letterSpacing: '0.06em' }}>
                {['TICKET', 'CUSTOMER', 'DEVICE', 'SERVICE', 'DATE & TIME', 'TOTAL', 'BALANCE', 'STATUS'].map((h) => (
                  <th key={h} style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', position: 'sticky', top: 0, background: 'var(--card)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const late = pastPromised(row);
                const balance = row.totalCents - row.paidCents;
                return (
                  <tr key={row.id} onClick={() => setDetailId(row.id)} style={{ cursor: 'pointer', background: detailId === row.id ? 'var(--orange-soft)' : 'transparent' }}>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', font: '700 13px Inter, sans-serif' }}>{row.number}</td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)' }}>{row.customerName}</td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-2)' }}>{row.deviceSummary}</td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-2)', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.serviceSummary}</td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: late ? 'var(--red)' : 'var(--ink-3)', fontWeight: late ? 600 : 400 }}>
                      {row.promisedAt
                        ? new Date(row.promisedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                        : new Date(row.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', font: '700 13px Inter, sans-serif' }}>{formatCents(row.totalCents)}</td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: balance > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                      {balance > 0 ? `${formatCents(balance)} due` : 'Paid'}
                    </td>
                    <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        {late && <StatusChip tone="red">Past promised</StatusChip>}
                        {row.callFlag && !['completed', 'cancelled'].includes(row.status) && (
                          <StatusChip tone="purple"><i className="bi bi-telephone-fill" style={{ fontSize: 9 }} /> Call</StatusChip>
                        )}
                        {!late && <StatusChip tone={STATUS_TONES[row.status] ?? 'neutral'}>{statusLabel(row.status)}</StatusChip>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div style={{ padding: 24, color: 'var(--ink-4)', fontSize: 13 }}>No tickets in this view.</div>}
        </div>
      </div>

      {/* Detail panel */}
      <div style={{ width: 340, flexShrink: 0, background: 'var(--card)', borderLeft: '1px solid var(--line-soft)', overflow: 'auto', padding: '22px 20px' }}>
        {detail ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>{detail.ticket.number}</h2>
              <StatusChip tone={STATUS_TONES[detail.ticket.status] ?? 'neutral'}>{statusLabel(detail.ticket.status)}</StatusChip>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
              {detail.customer?.name} · {detail.customer?.phone}
            </div>
            {detail.ticket.warrantyOfTicketId && (
              <div style={{ marginTop: 6 }}><StatusChip tone="blue">Warranty rework</StatusChip></div>
            )}

            {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              {(['intake', 'in_progress', 'waiting_part', 'ready', 'completed'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => void patchTicket({ status: s })}
                  disabled={detail.ticket.status === s || ['completed', 'cancelled', 'abandoned'].includes(detail.ticket.status)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 999,
                    border: '1px solid var(--line)',
                    background: detail.ticket.status === s ? 'var(--navy)' : 'var(--card)',
                    color: detail.ticket.status === s ? '#fff' : 'var(--ink-2)',
                    font: '600 11px Inter, sans-serif',
                    opacity: ['completed', 'cancelled', 'abandoned'].includes(detail.ticket.status) && detail.ticket.status !== s ? 0.4 : 1,
                  }}
                >
                  {statusLabel(s)}
                </button>
              ))}
            </div>

            <button
              onClick={() => void patchTicket({ callFlag: !detail.ticket.callFlag })}
              style={{
                width: '100%', marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
                borderRadius: 10, border: `1px solid ${detail.ticket.callFlag ? 'var(--purple)' : 'var(--line)'}`,
                background: detail.ticket.callFlag ? 'var(--purple)' : 'var(--card)',
                color: detail.ticket.callFlag ? '#fff' : 'var(--ink-2)', font: '600 12px Inter, sans-serif',
              }}
            >
              <i className={`bi ${detail.ticket.callFlag ? 'bi-telephone-fill' : 'bi-telephone'}`} />
              {detail.ticket.callFlag ? 'Customer waiting on our call' : 'Flag: customer wants a call'}
            </button>

            <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '16px 0 6px' }}>DEVICES & WORK</div>
            {detail.devices.map((d) => (
              <div key={d.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: '9px 12px', marginBottom: 6 }}>
                <div style={{ font: '600 12.5px Inter, sans-serif' }}>
                  {d.label} {!d.powersOn && <StatusChip tone="red" style={{ marginLeft: 4 }}>DOA</StatusChip>}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>
                  {d.imei ? `IMEI …${d.imei.slice(-5)} · ` : ''}
                  {d.unlockMethod && d.unlockMethod !== 'none' ? `${d.unlockMethod}: ${d.unlockValue ?? '—'}` : 'no lock'}
                </div>
                {d.conditionNotes && <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2 }}>{d.conditionNotes}</div>}
              </div>
            ))}
            {detail.lines.map((l) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 2px' }}>
                <span>{l.description}</span>
                <span style={{ fontWeight: 700 }}>{formatCents(l.priceCents)}</span>
              </div>
            ))}
            {detail.ticket.notesForTech && (
              <div style={{ background: 'var(--amber-bg)', color: 'var(--amber)', borderRadius: 10, padding: '8px 12px', fontSize: 11, marginTop: 6 }}>
                <i className="bi bi-sticky" /> {detail.ticket.notesForTech}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 12, paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)' }}>
                <span>Total (incl. tax)</span><span>{formatCents(detail.ticket.totalCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 3 }}>
                <span style={{ color: 'var(--ink-3)' }}>Paid</span>
                <span style={{ color: 'var(--green)', fontWeight: 600 }}>{formatCents(detail.paidCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ font: '700 14px Inter, sans-serif' }}>Balance</span>
                <span style={{ font: '800 18px Inter, sans-serif', color: detail.balanceCents > 0 ? 'var(--red)' : 'var(--green)' }}>
                  {formatCents(detail.balanceCents)}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {detail.balanceCents > 0 && (
                <>
                  <Button variant="primary" onClick={() => {
                    sessionStorage.setItem('fmp.resumeSale', JSON.stringify({
                      id: null,
                      customer: detail.customer ? { id: detail.customer.id, name: detail.customer.name } : null,
                      lines: [{
                        kind: 'repair',
                        description: `${detail.ticket.number} · balance`,
                        qty: 1,
                        unitCents: Math.round(detail.balanceCents / 1.06),
                        discountCents: 0,
                        taxable: true,
                        ticketId: detail.ticket.id,
                      }],
                    }));
                    navigate('/register');
                  }}>
                    Collect balance at register
                  </Button>
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
                    device: detail.devices.map((d) => d.label).join(' + '),
                    issue: detail.lines.map((l) => l.description).join(', '),
                  })
                }
              >
                <i className="bi bi-tag" /> Print label
              </Button>
              {!['completed', 'cancelled', 'abandoned'].includes(detail.ticket.status) && (
                <Button variant="danger" onClick={() => setCancelling(true)}>Cancel ticket</Button>
              )}
            </div>

            <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '16px 0 6px' }}>HISTORY</div>
            {detail.history.map((h) => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', padding: '3px 0' }}>
                <span>{statusLabel(h.status)} · {h.userName}</span>
                <span>{new Date(h.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: 'var(--ink-4)', fontSize: 13, marginTop: 40, textAlign: 'center' }}>Select a ticket.</div>
        )}
      </div>

      <NewRepairWindow open={newOpen} onClose={() => setNewOpen(false)} onCreated={handleCreated} />
      <DepositModal ticket={depositTicket} onClose={() => setDepositTicket(null)} onDone={() => void refreshAll()} />

      <Modal open={cancelling} onClose={() => setCancelling(false)} width={380}>
        <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>Cancel {detail?.ticket.number}?</h2>
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          Consumed parts go back to stock. {detail && detail.paidCents > 0 ? `Deposits of ${formatCents(detail.paidCents)} were taken — refund them from the register.` : ''}
        </p>
        <input
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="Reason * — e.g. customer declined quote"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button variant="ghost" onClick={() => setCancelling(false)}>Keep ticket</Button>
          <Button
            variant="danger"
            disabled={cancelReason.trim().length < 2}
            onClick={async () => {
              try {
                await api(`/api/repairs/${detail!.ticket.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: cancelReason.trim() }) });
                setCancelling(false);
                setCancelReason('');
                await refreshAll();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Cancel failed');
                setCancelling(false);
              }
            }}
          >
            Cancel ticket
          </Button>
        </div>
      </Modal>
    </div>
  );
}
