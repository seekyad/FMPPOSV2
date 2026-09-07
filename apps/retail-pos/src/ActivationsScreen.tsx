import { useEffect, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, DataTable, Modal, StatusChip } from '@fmp/ui';
import { api, CustomerModal, type CartCustomer } from '@fmp/pos-client';

interface Activation {
  id: number;
  kind: string;
  carrier: string;
  planName: string | null;
  accountNumber: string | null;
  phoneNumber: string | null;
  monthlyCents: number;
  status: 'active' | 'pending' | 'cancelled';
  notes: string | null;
  createdAt: string;
  customerName: string;
  customerPhone: string | null;
  deviceName: string | null;
  userName: string | null;
}

const KIND_LABELS: Record<string, string> = {
  new_line: 'New line',
  upgrade: 'Upgrade',
  port_in: 'Port-in',
  wifi_box: 'Wifi box',
  tablet: 'Tablet',
};

export function ActivationsScreen() {
  const [rows, setRows] = useState<Activation[]>([]);
  const [creating, setCreating] = useState(false);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [form, setForm] = useState({
    kind: 'new_line',
    carrier: '',
    planName: '',
    accountNumber: '',
    phoneNumber: '',
    monthly: '',
    notes: '',
  });
  const [error, setError] = useState('');

  async function load() {
    setRows(await api<Activation[]>('/api/retail/activations').catch(() => []));
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (!customer || !form.carrier.trim()) {
      setError('Customer and carrier are required.');
      return;
    }
    try {
      await api('/api/retail/activations', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          kind: form.kind,
          carrier: form.carrier.trim(),
          planName: form.planName || null,
          accountNumber: form.accountNumber || null,
          phoneNumber: form.phoneNumber || null,
          monthlyCents: parseDollars(form.monthly || '0') ?? 0,
          notes: form.notes || null,
        }),
      });
      setCreating(false);
      setCustomer(null);
      setForm({ kind: 'new_line', carrier: '', planName: '', accountNumber: '', phoneNumber: '', monthly: '', notes: '' });
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const input = (key: keyof typeof form, placeholder: string) => (
    <input
      value={form[key]}
      onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
      placeholder={placeholder}
      style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
    />
  );

  return (
    <div style={{ padding: '22px 24px', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Activations</h1>
          <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
            {rows.filter((r) => r.status === 'active').length} active accounts tracked
          </div>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <i className="bi bi-plus-lg" /> New activation
        </Button>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <DataTable
          columns={[
            {
              key: 'customer',
              label: 'Customer',
              sortValue: (r: Activation) => r.customerName,
              render: (r: Activation) => <span style={{ font: '600 15px Inter, sans-serif' }}>{r.customerName}</span>,
            },
            {
              key: 'type',
              label: 'Type',
              sortValue: (r: Activation) => KIND_LABELS[r.kind] ?? r.kind,
              render: (r: Activation) => KIND_LABELS[r.kind] ?? r.kind,
            },
            {
              key: 'carrier',
              label: 'Carrier / plan',
              sortValue: (r: Activation) => `${r.carrier} ${r.planName ?? ''}`,
              render: (r: Activation) => (
                <span style={{ color: 'var(--ink-2)' }}>
                  {r.carrier}
                  {r.planName ? ` · ${r.planName}` : ''}
                </span>
              ),
            },
            {
              key: 'account',
              label: 'Account #',
              sortValue: (r: Activation) => r.accountNumber ?? '',
              render: (r: Activation) => <span style={{ color: 'var(--ink-3)' }}>{r.accountNumber ?? '—'}</span>,
            },
            {
              key: 'line',
              label: 'Line',
              sortValue: (r: Activation) => r.phoneNumber ?? '',
              render: (r: Activation) => <span style={{ color: 'var(--ink-3)' }}>{r.phoneNumber ?? '—'}</span>,
            },
            {
              key: 'monthly',
              label: 'Monthly',
              align: 'right',
              sortValue: (r: Activation) => r.monthlyCents,
              render: (r: Activation) => (r.monthlyCents > 0 ? `${formatCents(r.monthlyCents)}/mo` : '—'),
            },
            {
              key: 'date',
              label: 'Date',
              sortValue: (r: Activation) => new Date(r.createdAt).getTime(),
              render: (r: Activation) => (
                <span style={{ color: 'var(--ink-3)' }}>
                  {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              sortValue: (r: Activation) => r.status,
              render: (r: Activation) => (
                <StatusChip tone={r.status === 'active' ? 'green' : r.status === 'pending' ? 'amber' : 'red'}>
                  {r.status}
                </StatusChip>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          searchText={(r) => `${r.customerName} ${r.accountNumber ?? ''} ${r.phoneNumber ?? ''} ${r.carrier} ${r.planName ?? ''}`}
          searchPlaceholder="Search customer, account #, phone, or carrier"
          initialSort={{ key: 'date', dir: 'desc' }}
          emptyText="No activations yet."
          footer={<span>Showing {rows.length} activations</span>}
        />
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} width={460}>
        <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>New activation</h2>
        <button
          onClick={() => setPickingCustomer(true)}
          style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${customer ? 'var(--line)' : 'var(--orange)'}`, background: customer ? 'var(--card)' : 'var(--orange-soft)', textAlign: 'left', fontSize: 15 }}
        >
          {customer ? (
            <span><b>{customer.name}</b> · {customer.phone}</span>
          ) : (
            <span><i className="bi bi-person-plus" /> Pick or create customer *</span>
          )}
        </button>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {Object.entries(KIND_LABELS).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setForm((p) => ({ ...p, kind: id }))}
              style={{
                flex: 1,
                padding: '8px 0',
                borderRadius: 10,
                border: '1px solid var(--line)',
                background: form.kind === id ? 'var(--navy)' : 'var(--card)',
                color: form.kind === id ? '#fff' : 'var(--ink-2)',
                font: '600 12.5px Inter, sans-serif',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
          {input('carrier', 'Carrier * — T-Mobile')}
          {input('planName', 'Plan')}
          {input('accountNumber', 'Account #')}
          {input('phoneNumber', 'Line phone #')}
          {input('monthly', 'Monthly $')}
        </div>
        <textarea
          value={form.notes}
          onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          rows={2}
          placeholder="Notes — ported from, promos, autopay…"
          style={{ width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15, resize: 'none' }}
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>Save activation</Button>
        </div>
      </Modal>

      <CustomerModal open={pickingCustomer} onClose={() => setPickingCustomer(false)} onPick={setCustomer} />
    </div>
  );
}
