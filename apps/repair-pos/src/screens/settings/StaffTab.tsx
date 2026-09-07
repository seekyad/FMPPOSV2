import { useEffect, useState } from 'react';
import { Button, Modal, StatusChip } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface Staff {
  id: number;
  name: string;
  initials: string;
  role: 'employee' | 'manager';
  isTechnician: boolean;
  active: boolean;
}

export function StaffTab() {
  const isManager = session.user?.role === 'manager';
  const [rows, setRows] = useState<Staff[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', pin: '', role: 'employee' as 'employee' | 'manager', tech: false });
  const [pinReset, setPinReset] = useState<Staff | null>(null);
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setRows(await api<Staff[]>('/api/settings/staff').catch(() => []));
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (!/^\d{4}$/.test(form.pin) || !form.name.trim()) {
      setError('Name and a 4-digit PIN are required.');
      return;
    }
    try {
      await api('/api/settings/staff', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), pin: form.pin, role: form.role, isTechnician: form.tech }),
      });
      setAdding(false);
      setForm({ name: '', pin: '', role: 'employee', tech: false });
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    try {
      await api(`/api/settings/staff/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button variant="primary" disabled={!isManager} onClick={() => setAdding(true)}>
          <i className="bi bi-person-plus" /> Add staff
        </Button>
      </div>
      <div style={{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 11.5px Inter, sans-serif', letterSpacing: '0.06em' }}>
              {['NAME', 'ROLE', 'TECHNICIAN', 'STATUS', ''].map((h, i) => (
                <th key={i} style={{ padding: '15px 16px', borderBottom: '1px solid var(--line-soft)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', font: '600 15px Inter, sans-serif' }}>
                  {s.name}
                </td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', textTransform: 'capitalize' }}>{s.role}</td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>{s.isTechnician ? 'Yes' : '—'}</td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                  <StatusChip tone={s.active ? 'green' : 'red'}>{s.active ? 'Active' : 'Inactive'}</StatusChip>
                </td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', textAlign: 'right' }}>
                  {isManager && (
                    <span style={{ display: 'inline-flex', gap: 10 }}>
                      <button onClick={() => { setPinReset(s); setNewPin(''); }} style={{ border: 'none', background: 'none', color: 'var(--ink-3)', fontSize: 14 }}>
                        Reset PIN
                      </button>
                      <button
                        onClick={() => void patch(s.id, { role: s.role === 'manager' ? 'employee' : 'manager' })}
                        style={{ border: 'none', background: 'none', color: 'var(--ink-3)', fontSize: 14 }}
                      >
                        Make {s.role === 'manager' ? 'employee' : 'manager'}
                      </button>
                      <button
                        onClick={() => void patch(s.id, { active: !s.active })}
                        style={{ border: 'none', background: 'none', color: s.active ? 'var(--red)' : 'var(--green)', fontSize: 14 }}
                      >
                        {s.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}

      <Modal open={adding} onClose={() => setAdding(false)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Add staff</h2>
        <input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="Full name *"
          style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={form.pin}
            onChange={(e) => setForm((p) => ({ ...p, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
            placeholder="4-digit PIN *"
            style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
          <select
            value={form.role}
            onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as 'employee' | 'manager' }))}
            style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15, background: 'var(--card)' }}
          >
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
          </select>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 14, color: 'var(--ink-2)' }}>
          <input type="checkbox" checked={form.tech} onChange={(e) => setForm((p) => ({ ...p, tech: e.target.checked }))} />
          Works as repair technician (shows in tech assignment & reports)
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>Add</Button>
        </div>
      </Modal>

      <Modal open={pinReset !== null} onClose={() => setPinReset(null)} width={320}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>New PIN for {pinReset?.name}</h2>
        <input
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="4 digits"
          style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setPinReset(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!/^\d{4}$/.test(newPin)}
            onClick={async () => {
              await patch(pinReset!.id, { pin: newPin });
              setPinReset(null);
            }}
          >
            Set PIN
          </Button>
        </div>
      </Modal>
    </div>
  );
}
