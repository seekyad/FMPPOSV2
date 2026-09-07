import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCents } from '@fmp/shared';
import { Button, DataTable, Modal, StatusChip } from '@fmp/ui';
import { api, SidePanel } from '@fmp/pos-client';
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
  { id: 'picked_up', label: 'Picked up' },
] as const;

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

function pastPromised(row: { promisedAt: string | null; status: string }): boolean {
  return (
    row.promisedAt != null &&
    !['completed', 'picked_up', 'cancelled', 'abandoned'].includes(row.status) &&
    new Date(row.promisedAt).getTime() < Date.now()
  );
}

export function RepairsScreen() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>('today');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [counts, setCounts] = useState<{ open: number; inProgress: number; waiting: number; call: number; ready: number; completed: number; today: number }>({ open: 0, inProgress: 0, waiting: 0, call: 0, ready: 0, completed: 0, today: 0 });
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [depositTicket, setDepositTicket] = useState<{ id: number; number: string; balanceCents: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const res = await api<{ rows: BoardRow[]; counts: Array<{ status: string; callFlag: boolean; n: number }>; todayCount: number }>(
      `/api/repairs?filter=${filter}`,
    ).catch(() => null);
    if (!res) return;
    setRows(res.rows);
    const open = ['open', 'in_progress', 'waiting_part', 'completed'];
    const sum = (pred: (c: { status: string; callFlag: boolean; n: number }) => boolean) =>
      res.counts.filter(pred).reduce((s, c) => s + Number(c.n), 0);
    setCounts({
      today: res.todayCount,
      open: sum((c) => open.includes(c.status)),
      inProgress: sum((c) => c.status === 'in_progress'),
      waiting: sum((c) => c.status === 'waiting_part'),
      call: sum((c) => c.callFlag && open.includes(c.status)),
      ready: sum((c) => c.status === 'completed'),
      completed: sum((c) => c.status === 'picked_up'),
    });
  }

  useEffect(() => {
    void load();
  }, [filter]);

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
            <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Repairs</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
              {counts.open} open · {rows.filter(pastPromised).length} past promised
            </div>
          </div>
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <i className="bi bi-plus-lg" /> New repair
          </Button>
        </div>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <DataTable
            columns={[
              {
                key: 'ticket',
                label: 'Ticket',
                sortValue: (r: BoardRow) => r.number,
                render: (r: BoardRow) => <span style={{ font: '700 15px Inter, sans-serif' }}>{r.number}</span>,
              },
              {
                key: 'customer',
                label: 'Customer',
                sortValue: (r: BoardRow) => r.customerName ?? '',
                render: (r: BoardRow) => r.customerName,
              },
              {
                key: 'device',
                label: 'Device',
                sortValue: (r: BoardRow) => r.deviceSummary ?? '',
                render: (r: BoardRow) => <span style={{ color: 'var(--ink-2)' }}>{r.deviceSummary}</span>,
              },
              {
                key: 'service',
                label: 'Service',
                sortValue: (r: BoardRow) => r.serviceSummary ?? '',
                render: (r: BoardRow) => (
                  <span style={{ color: 'var(--ink-2)', display: 'inline-block', maxWidth: 260, overflowWrap: 'anywhere' }}>
                    {r.serviceSummary}
                  </span>
                ),
              },
              {
                key: 'when',
                label: 'Date & time',
                sortValue: (r: BoardRow) => new Date(r.promisedAt ?? r.createdAt).getTime(),
                render: (r: BoardRow) => {
                  const late = pastPromised(r);
                  return (
                    <span style={{ color: late ? 'var(--red)' : 'var(--ink-3)', fontWeight: late ? 600 : 400 }}>
                      {new Date(r.promisedAt ?? r.createdAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  );
                },
              },
              {
                key: 'total',
                label: 'Total',
                align: 'right',
                sortValue: (r: BoardRow) => r.totalCents,
                render: (r: BoardRow) => <b>{formatCents(r.totalCents)}</b>,
              },
              {
                key: 'balance',
                label: 'Balance',
                align: 'right',
                sortValue: (r: BoardRow) => r.totalCents - r.paidCents,
                render: (r: BoardRow) => {
                  const balance = r.totalCents - r.paidCents;
                  return (
                    <span style={{ color: balance > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                      {balance > 0 ? `${formatCents(balance)} due` : 'Paid'}
                    </span>
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
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetailId(r.id)}
            selectedKey={detailId}
            searchText={(r) =>
              `${r.number} ${r.customerName ?? ''} ${r.customerPhone ?? ''} ${r.deviceSummary ?? ''} ${r.serviceSummary ?? ''}`
            }
            searchPlaceholder="Search ticket #, customer, phone, or device"
            filters={FILTERS.map((f) => ({ id: f.id, label: f.label, count: filterCount(f.id) }))}
            activeFilter={filter}
            onFilterChange={setFilter}
            initialSort={{ key: 'when', dir: 'desc' }}
            emptyText="No tickets in this view."
            footer={<span>Showing {rows.length} tickets · {rows.filter(pastPromised).length} past promised</span>}
          />
        </div>
      </div>

      {/* Detail panel */}
      <SidePanel open={detailId !== null} onClose={() => setDetailId(null)}>
        <div style={{ padding: '22px 20px' }}>
        {detail ? (
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

            {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
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
                  onClick={() => void patchTicket({ status: s })}
                  disabled={detail.ticket.status === s || ['picked_up', 'cancelled', 'abandoned'].includes(detail.ticket.status)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 999,
                    border: '1px solid var(--line)',
                    background: detail.ticket.status === s ? 'var(--navy)' : 'var(--card)',
                    color: detail.ticket.status === s ? '#fff' : 'var(--ink-2)',
                    font: '600 12.5px Inter, sans-serif',
                    opacity:
                      ['picked_up', 'cancelled', 'abandoned'].includes(detail.ticket.status) && detail.ticket.status !== s
                        ? 0.4
                        : 1,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {detail.ticket.status === 'completed' && detail.balanceCents <= 0 && (
              <button
                onClick={() => void patchTicket({ status: 'picked_up' })}
                style={{
                  width: '100%',
                  marginTop: 10,
                  padding: '12px 0',
                  borderRadius: 10,
                  border: 'none',
                  background: 'var(--green)',
                  color: '#fff',
                  font: '700 15px Inter, sans-serif',
                }}
              >
                <i className="bi bi-bag-check" /> Customer picked up — close ticket
              </button>
            )}

            <button
              onClick={() => void patchTicket({ callFlag: !detail.ticket.callFlag })}
              style={{
                width: '100%', marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
                borderRadius: 10, border: `1px solid ${detail.ticket.callFlag ? 'var(--purple)' : 'var(--line)'}`,
                background: detail.ticket.callFlag ? 'var(--purple)' : 'var(--card)',
                color: detail.ticket.callFlag ? '#fff' : 'var(--ink-2)', font: '600 14px Inter, sans-serif',
              }}
            >
              <i className={`bi ${detail.ticket.callFlag ? 'bi-telephone-fill' : 'bi-telephone'}`} />
              {detail.ticket.callFlag ? 'Customer waiting on our call' : 'Flag: customer wants a call'}
            </button>

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
              {!['picked_up', 'cancelled', 'abandoned'].includes(detail.ticket.status) && (
                <Button variant="danger" onClick={() => setCancelling(true)}>Cancel ticket</Button>
              )}
            </div>

            <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '16px 0 6px' }}>HISTORY</div>
            {detail.history.map((h) => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--ink-3)', padding: '3px 0' }}>
                <span>{statusLabel(h.status)} · {h.userName}</span>
                <span>{new Date(h.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: 'var(--ink-4)', fontSize: 15, marginTop: 40, textAlign: 'center' }}>Select a ticket.</div>
        )}
        </div>
      </SidePanel>

      <NewRepairWindow open={newOpen} onClose={() => setNewOpen(false)} onCreated={handleCreated} />
      <DepositModal ticket={depositTicket} onClose={() => setDepositTicket(null)} onDone={() => void refreshAll()} />

      <Modal open={cancelling} onClose={() => setCancelling(false)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Cancel {detail?.ticket.number}?</h2>
        <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>
          Consumed parts go back to stock. {detail && detail.paidCents > 0 ? `Deposits of ${formatCents(detail.paidCents)} were taken — refund them from the register.` : ''}
        </p>
        <input
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="Reason * — e.g. customer declined quote"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
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
