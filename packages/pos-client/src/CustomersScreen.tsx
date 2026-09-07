import { useEffect, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Button, DataTable, Modal, StatusChip } from '@fmp/ui';
import { api } from './api';

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  vip: boolean;
  storeCreditCents: number;
  visits: number;
  lifetimeCents: number;
  openTickets: number;
  balanceDueCents: number;
  lastSeen: string | null;
  createdAt: string;
}

interface CustomerDetail {
  customer: CustomerRow & { note: string | null };
  devices: Array<{ id: number; label: string; imei: string | null; detail: string | null }>;
  tickets: Array<{ id: number; number: string; status: string; totalCents: number; createdAt: string }>;
  saleHistory: Array<{ id: number; ticketNumber: string; totalCents: number; createdAt: string }>;
  credit: Array<{ id: number; deltaCents: number; reason: string; createdAt: string }>;
}

function flagFor(row: CustomerRow): { tone: 'green' | 'red' | 'purple' | 'blue' | 'neutral'; label: string } {
  if (row.balanceDueCents > 0) return { tone: 'red', label: 'Balance due' };
  if (row.vip) return { tone: 'purple', label: 'VIP' };
  if (row.visits >= 3) return { tone: 'green', label: 'Repeat' };
  const isNew = Date.now() - new Date(row.createdAt).getTime() < 30 * 86400_000;
  if (isNew) return { tone: 'blue', label: 'New' };
  return { tone: 'neutral', label: '—' };
}

export function CustomersScreen() {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });

  async function load() {
    const data = await api<CustomerRow[]>('/api/customers').catch(() => []);
    setRows(data);
    if (data.length > 0 && !data.some((d) => d.id === selectedId)) setSelectedId(data[0]!.id);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    void api<CustomerDetail>(`/api/customers/${selectedId}`).then(setDetail).catch(() => setDetail(null));
  }, [selectedId]);

  async function create() {
    if (!form.name.trim()) return;
    const row = await api<CustomerRow>('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ name: form.name.trim(), phone: form.phone || null, email: form.email || null }),
    });
    setCreating(false);
    setForm({ name: '', phone: '', email: '' });
    await load();
    setSelectedId(row.id);
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Customers</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
              {rows.length} shown · {rows.filter((r) => r.openTickets > 0).length} with open tickets
            </div>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <i className="bi bi-plus-lg" /> New customer
          </Button>
        </div>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Name',
                sortValue: (r: CustomerRow) => r.name,
                render: (r: CustomerRow) => <span style={{ font: '600 15px Inter, sans-serif' }}>{r.name}</span>,
              },
              {
                key: 'phone',
                label: 'Phone',
                sortValue: (r: CustomerRow) => r.phone ?? '',
                render: (r: CustomerRow) => <span style={{ color: 'var(--ink-2)' }}>{r.phone ?? '—'}</span>,
              },
              {
                key: 'visits',
                label: 'Visits',
                align: 'right',
                sortValue: (r: CustomerRow) => r.visits,
                render: (r: CustomerRow) => r.visits,
              },
              {
                key: 'open',
                label: 'Open',
                align: 'right',
                sortValue: (r: CustomerRow) => r.openTickets,
                render: (r: CustomerRow) => (
                  <span style={{ color: r.openTickets > 0 ? 'var(--blue)' : 'var(--ink-4)' }}>{r.openTickets || '—'}</span>
                ),
              },
              {
                key: 'lifetime',
                label: 'Lifetime',
                align: 'right',
                sortValue: (r: CustomerRow) => r.lifetimeCents,
                render: (r: CustomerRow) => <b>{formatCents(r.lifetimeCents)}</b>,
              },
              {
                key: 'lastSeen',
                label: 'Last seen',
                sortValue: (r: CustomerRow) => (r.lastSeen ? new Date(r.lastSeen).getTime() : 0),
                render: (r: CustomerRow) => (
                  <span style={{ color: 'var(--ink-3)' }}>
                    {r.lastSeen ? new Date(r.lastSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                  </span>
                ),
              },
              {
                key: 'flag',
                label: 'Flag',
                sortValue: (r: CustomerRow) => flagFor(r).label,
                render: (r: CustomerRow) => {
                  const flag = flagFor(r);
                  return flag.label === '—' ? (
                    <span style={{ color: 'var(--ink-4)' }}>—</span>
                  ) : (
                    <StatusChip tone={flag.tone}>{flag.label}</StatusChip>
                  );
                },
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelectedId(r.id)}
            selectedKey={selectedId}
            searchText={(r) => `${r.name} ${r.phone ?? ''} ${r.email ?? ''}`}
            searchPlaceholder="Search name, phone, or email"
            initialSort={{ key: 'lifetime', dir: 'desc' }}
            emptyText="No customers match."
            footer={<span>Showing {rows.length} customers</span>}
          />
        </div>
      </div>

      {/* Drill-in */}
      <div style={{ width: 340, flexShrink: 0, background: 'var(--card)', borderLeft: '1px solid var(--line-soft)', overflow: 'auto', padding: '22px 20px' }}>
        {detail ? (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ width: 44, height: 44, borderRadius: 999, background: 'var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '700 16px Inter, sans-serif', color: 'var(--ink-2)' }}>
                {detail.customer.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
              </span>
              <div>
                <div style={{ font: '700 18.5px Inter, sans-serif' }}>{detail.customer.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                  {detail.customer.phone ?? 'no phone'} · {detail.customer.email ?? 'no email'}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 14, textAlign: 'center' }}>
              {[
                { label: 'Visits', value: String(detail.customer.visits) },
                { label: 'Lifetime', value: formatCents(detail.customer.lifetimeCents) },
                { label: 'Credit', value: formatCents(detail.customer.storeCreditCents) },
              ].map((s) => (
                <div key={s.label} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: '8px 4px' }}>
                  <div style={{ font: '700 17.5px Inter, sans-serif' }}>{s.value}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            <Section title="DEVICES ON FILE">
              {detail.devices.map((d) => (
                <div key={d.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: '9px 12px', marginBottom: 6 }}>
                  <div style={{ font: '600 14px Inter, sans-serif' }}>{d.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>
                    {d.imei ? `IMEI …${d.imei.slice(-5)}` : ''} {d.detail ? `· ${d.detail}` : ''}
                  </div>
                </div>
              ))}
              {detail.devices.length === 0 && <Empty>No devices saved.</Empty>}
            </Section>

            <Section title="OPEN TICKETS">
              {detail.tickets.filter((t) => !['completed', 'cancelled', 'abandoned'].includes(t.status)).map((t) => (
                <div key={t.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: '9px 12px', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ font: '600 14px Inter, sans-serif' }}>{t.number}</span>
                  <StatusChip tone="blue">{t.status.replace('_', ' ')}</StatusChip>
                </div>
              ))}
              {detail.tickets.filter((t) => !['completed', 'cancelled', 'abandoned'].includes(t.status)).length === 0 && (
                <Empty>No open repairs.</Empty>
              )}
            </Section>

            <Section title="HISTORY">
              {detail.saleHistory.slice(0, 8).map((s) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '5px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <span style={{ color: 'var(--ink-3)' }}>
                    {new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · #{s.ticketNumber}
                  </span>
                  <span style={{ font: '600 14px Inter, sans-serif', color: s.totalCents < 0 ? 'var(--red)' : 'var(--ink)' }}>
                    {formatCents(s.totalCents)}
                  </span>
                </div>
              ))}
              {detail.saleHistory.length === 0 && <Empty>No purchases yet.</Empty>}
            </Section>
          </>
        ) : (
          <div style={{ color: 'var(--ink-4)', fontSize: 15, marginTop: 40, textAlign: 'center' }}>Select a customer.</div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} width={400}>
        <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>New customer</h2>
        {(['name', 'phone', 'email'] as const).map((f) => (
          <input
            key={f}
            value={form[f]}
            onChange={(e) => setForm((prev) => ({ ...prev, [f]: e.target.value }))}
            placeholder={f === 'name' ? 'Full name *' : f[0]!.toUpperCase() + f.slice(1)}
            style={{ width: '100%', marginTop: 10, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          <Button variant="primary" disabled={!form.name.trim()} onClick={() => void create()}>Create</Button>
        </div>
      </Modal>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>{children}</div>;
}
