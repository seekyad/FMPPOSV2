import { useEffect, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal, StatusChip } from '@fmp/ui';
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
  const [query, setQuery] = useState('');
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
    setRows(await api<Activation[]>(`/api/retail/activations?query=${encodeURIComponent(query)}`).catch(() => []));
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [query]);

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

      <div style={{ position: 'relative', marginTop: 16 }}>
        <i className="bi bi-search" style={{ position: 'absolute', left: 14, top: 13, color: 'var(--ink-4)', fontSize: 16 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search customer, account #, phone, or carrier"
          style={{ width: '100%', padding: '12px 14px 12px 38px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 15 }}
        />
      </div>

      <div style={{ marginTop: 14, background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 11.5px Inter, sans-serif', letterSpacing: '0.06em' }}>
              {['CUSTOMER', 'TYPE', 'CARRIER / PLAN', 'ACCOUNT #', 'LINE', 'MONTHLY', 'DATE', 'STATUS'].map((h) => (
                <th key={h} style={{ padding: '15px 16px', borderBottom: '1px solid var(--line-soft)', position: 'sticky', top: 0, background: 'var(--card)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', font: '600 15px Inter, sans-serif' }}>{r.customerName}</td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)' }}>{KIND_LABELS[r.kind] ?? r.kind}</td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-2)' }}>
                  {r.carrier}{r.planName ? ` · ${r.planName}` : ''}
                </td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-3)' }}>{r.accountNumber ?? '—'}</td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-3)' }}>{r.phoneNumber ?? '—'}</td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)' }}>{r.monthlyCents > 0 ? `${formatCents(r.monthlyCents)}/mo` : '—'}</td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-3)' }}>
                  {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
                <td style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                  <StatusChip tone={r.status === 'active' ? 'green' : r.status === 'pending' ? 'amber' : 'red'}>
                    {r.status}
                  </StatusChip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div style={{ padding: 24, color: 'var(--ink-4)', fontSize: 15 }}>No activations yet.</div>}
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
