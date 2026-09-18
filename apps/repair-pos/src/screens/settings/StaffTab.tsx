import { useEffect, useState } from 'react';
import { Button, DataTable, Modal, StatusChip } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface Staff {
  id: number;
  name: string;
  initials: string;
  role: 'employee' | 'manager';
  isTechnician: boolean;
  active: boolean;
}

const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 } as const;

/** Users & PINs: add, edit, delete staff, plus the store admin code managers use to approve edits and corrections. */
export function StaffTab() {
  const isManager = session.user?.role === 'manager';
  const me = session.user?.id;
  const [rows, setRows] = useState<Staff[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', pin: '', role: 'employee' as 'employee' | 'manager', tech: false });
  const [editing, setEditing] = useState<Staff | null>(null);
  const [editForm, setEditForm] = useState({ name: '', role: 'employee' as 'employee' | 'manager', tech: false, pin: '' });
  const [deleting, setDeleting] = useState<Staff | null>(null);
  const [pinReset, setPinReset] = useState<Staff | null>(null);
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [codeSet, setCodeSet] = useState<boolean | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeForm, setCodeForm] = useState({ current: '', next: '', confirm: '' });
  const [codeError, setCodeError] = useState('');

  async function load() {
    setRows(await api<Staff[]>('/api/settings/staff').catch(() => []));
    if (isManager) setCodeSet((await api<{ set: boolean }>('/api/settings/admin-code').catch(() => ({ set: false }))).set);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  function startEdit(s: Staff) {
    setEditing(s);
    setEditForm({ name: s.name, role: s.role, tech: s.isTechnician, pin: '' });
    setError('');
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editForm.name.trim()) {
      setError('Name is required.');
      return;
    }
    if (editForm.pin && !/^\d{4}$/.test(editForm.pin)) {
      setError('A new PIN must be 4 digits.');
      return;
    }
    await patch(editing.id, {
      name: editForm.name.trim(),
      role: editForm.role,
      isTechnician: editForm.tech,
      ...(editForm.pin ? { pin: editForm.pin } : {}),
    });
    setEditing(null);
  }

  async function remove() {
    if (!deleting) return;
    try {
      await api(`/api/settings/staff/${deleting.id}`, { method: 'DELETE' });
      setNotice(`${deleting.name} removed.`);
      setDeleting(null);
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(null);
    }
  }

  async function saveCode() {
    setCodeError('');
    if (!/^\d{4,6}$/.test(codeForm.next)) {
      setCodeError('The admin code is 4 to 6 digits.');
      return;
    }
    if (codeForm.next !== codeForm.confirm) {
      setCodeError('The two entries do not match.');
      return;
    }
    if (codeSet && !codeForm.current) {
      setCodeError('Enter the current admin code or your manager PIN first.');
      return;
    }
    try {
      await api('/api/settings/admin-code', {
        method: 'PUT',
        body: JSON.stringify({ currentCode: codeForm.current || null, newCode: codeForm.next }),
      });
      setCodeOpen(false);
      setCodeForm({ current: '', next: '', confirm: '' });
      setNotice(codeSet ? 'Admin code changed.' : 'Admin code set.');
      setCodeSet(true);
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : 'Could not save the code');
    }
  }

  const linkBtn = (label: string, onClick: () => void, color = 'var(--ink-3)') => (
    <button key={label} onClick={onClick} style={{ border: 'none', background: 'none', color, fontSize: 14, padding: 0 }}>
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {isManager && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            background: 'var(--card)',
            border: '1px solid var(--line-soft)',
            borderRadius: 14,
            padding: '14px 16px',
            marginBottom: 12,
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--orange-soft)', color: 'var(--orange)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-shield-lock" style={{ fontSize: 20 }} />
            </span>
            <div>
              <div style={{ font: '700 15.5px Inter, sans-serif' }}>
                Admin code{' '}
                {codeSet === null ? null : (
                  <StatusChip tone={codeSet ? 'green' : 'amber'} style={{ marginLeft: 6 }}>
                    {codeSet ? 'Set' : 'Not set'}
                  </StatusChip>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>
                Approves ticket edits and sale corrections at the register. Manager PINs work too{codeSet ? '' : '; set a code so staff never need a manager’s personal PIN'}.
              </div>
            </div>
          </div>
          <Button variant="secondary" onClick={() => { setCodeForm({ current: '', next: '', confirm: '' }); setCodeError(''); setCodeOpen(true); }}>
            <i className="bi bi-key" /> {codeSet ? 'Change code' : 'Set code'}
          </Button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
        <div style={{ fontSize: 14, color: notice ? 'var(--green)' : 'var(--ink-3)' }}>{notice || `${rows.filter((r) => r.active).length} active staff`}</div>
        <Button variant="primary" disabled={!isManager} onClick={() => setAdding(true)}>
          <i className="bi bi-person-plus" /> Add staff
        </Button>
      </div>
      <DataTable
        columns={[
          {
            key: 'name',
            label: 'Name',
            sortValue: (s: Staff) => s.name,
            render: (s: Staff) => (
              <span style={{ font: '600 15px Inter, sans-serif' }}>
                {s.name}
                {s.id === me && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ink-4)', fontWeight: 500 }}>you</span>}
              </span>
            ),
          },
          {
            key: 'role',
            label: 'Role',
            sortValue: (s: Staff) => s.role,
            render: (s: Staff) => <span style={{ textTransform: 'capitalize' }}>{s.role}</span>,
          },
          {
            key: 'tech',
            label: 'Technician',
            sortValue: (s: Staff) => (s.isTechnician ? 1 : 0),
            render: (s: Staff) => (s.isTechnician ? 'Yes' : '—'),
          },
          {
            key: 'status',
            label: 'Status',
            sortValue: (s: Staff) => (s.active ? 0 : 1),
            render: (s: Staff) => <StatusChip tone={s.active ? 'green' : 'red'}>{s.active ? 'Active' : 'Inactive'}</StatusChip>,
          },
          {
            key: 'actions',
            label: '',
            align: 'right',
            render: (s: Staff) =>
              isManager ? (
                <span style={{ display: 'inline-flex', gap: 14, whiteSpace: 'nowrap' }}>
                  {linkBtn('Edit', () => startEdit(s), 'var(--ink)')}
                  {linkBtn('Reset PIN', () => { setPinReset(s); setNewPin(''); })}
                  {linkBtn(s.active ? 'Deactivate' : 'Reactivate', () => void patch(s.id, { active: !s.active }), s.active ? 'var(--amber)' : 'var(--green)')}
                  {s.id !== me && linkBtn('Delete', () => setDeleting(s), 'var(--red)')}
                </span>
              ) : null,
          },
        ]}
        rows={rows}
        rowKey={(s) => s.id}
        searchText={(s) => `${s.name} ${s.role}`}
        searchPlaceholder="Search staff"
        initialSort={{ key: 'name', dir: 'asc' }}
        emptyText="No staff yet."
      />
      {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}

      <Modal open={adding} onClose={() => setAdding(false)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Add staff</h2>
        <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Full name *" style={{ ...inputStyle, marginTop: 12 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={form.pin}
            onChange={(e) => setForm((p) => ({ ...p, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
            placeholder="4-digit PIN *"
            inputMode="numeric"
            style={{ ...inputStyle, flex: 1, width: undefined }}
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

      <Modal open={editing !== null} onClose={() => setEditing(null)} width={400}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Edit {editing?.name}</h2>
        <input value={editForm.name} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} placeholder="Full name *" style={{ ...inputStyle, marginTop: 12 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <select
            value={editForm.role}
            onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value as 'employee' | 'manager' }))}
            disabled={editing?.id === me}
            title={editing?.id === me ? 'Ask another manager to change your role' : undefined}
            style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15, background: 'var(--card)' }}
          >
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
          </select>
          <input
            value={editForm.pin}
            onChange={(e) => setEditForm((p) => ({ ...p, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
            placeholder="New PIN (optional)"
            inputMode="numeric"
            style={{ ...inputStyle, flex: 1, width: undefined }}
          />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 14, color: 'var(--ink-2)' }}>
          <input type="checkbox" checked={editForm.tech} onChange={(e) => setEditForm((p) => ({ ...p, tech: e.target.checked }))} />
          Works as repair technician
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void saveEdit()}>Save</Button>
        </div>
      </Modal>

      <Modal open={deleting !== null} onClose={() => setDeleting(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Delete {deleting?.name}?</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--ink-3)' }}>
          Removes their sign-in for good. Staff who already rang up sales or worked tickets can’t be deleted, only deactivated, so their history stays intact.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setDeleting(null)}>Keep</Button>
          <Button variant="danger" onClick={() => void remove()}>Delete</Button>
        </div>
      </Modal>

      <Modal open={pinReset !== null} onClose={() => setPinReset(null)} width={320}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>New PIN for {pinReset?.name}</h2>
        <input
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="4 digits"
          inputMode="numeric"
          style={{ ...inputStyle, marginTop: 12 }}
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

      <Modal open={codeOpen} onClose={() => setCodeOpen(false)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>{codeSet ? 'Change admin code' : 'Set admin code'}</h2>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink-3)' }}>
          Staff type this code to approve edits on completed or paid tickets and corrections to completed sales. 4 to 6 digits.
        </p>
        {codeSet && (
          <input
            value={codeForm.current}
            onChange={(e) => setCodeForm((p) => ({ ...p, current: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
            placeholder="Current code or your manager PIN *"
            type="password"
            inputMode="numeric"
            style={{ ...inputStyle, marginTop: 12 }}
          />
        )}
        <input
          value={codeForm.next}
          onChange={(e) => setCodeForm((p) => ({ ...p, next: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
          placeholder="New admin code *"
          type="password"
          inputMode="numeric"
          style={{ ...inputStyle, marginTop: codeSet ? 8 : 12 }}
        />
        <input
          value={codeForm.confirm}
          onChange={(e) => setCodeForm((p) => ({ ...p, confirm: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
          placeholder="Repeat new code *"
          type="password"
          inputMode="numeric"
          style={{ ...inputStyle, marginTop: 8 }}
        />
        {codeError && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{codeError}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setCodeOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void saveCode()}>{codeSet ? 'Change code' : 'Set code'}</Button>
        </div>
      </Modal>
    </div>
  );
}
