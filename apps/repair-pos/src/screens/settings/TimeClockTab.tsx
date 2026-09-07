import { useEffect, useState } from 'react';
import { Button, Modal, StatusChip } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface Entry {
  id: number;
  userId: number;
  userName: string;
  clockIn: string;
  clockOut: string | null;
  flagged: boolean;
  editNote: string | null;
}

function hours(entry: Entry): string {
  const end = entry.clockOut ? new Date(entry.clockOut).getTime() : Date.now();
  const h = (end - new Date(entry.clockIn).getTime()) / 3600_000;
  return `${h.toFixed(2)} h`;
}

export function TimeClockTab() {
  const isManager = session.user?.role === 'manager';
  const [entries, setEntries] = useState<Entry[]>([]);
  const [openEntry, setOpenEntry] = useState<Entry | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [editIn, setEditIn] = useState('');
  const [editOut, setEditOut] = useState('');
  const [editNote, setEditNote] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const res = await api<{ entries: Entry[]; openEntry: Entry | null }>('/api/timeclock').catch(() => null);
    if (res) {
      setEntries(res.entries);
      setOpenEntry(res.openEntry);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function clock(action: 'clock-in' | 'clock-out') {
    setError('');
    try {
      await api(`/api/timeclock/${action}`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  function toLocalInput(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function saveEdit() {
    if (!editing || editNote.trim().length < 2) {
      setError('An edit note is required.');
      return;
    }
    try {
      await api(`/api/timeclock/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          clockIn: editIn ? new Date(editIn).toISOString() : undefined,
          clockOut: editOut ? new Date(editOut).toISOString() : null,
          editNote: editNote.trim(),
        }),
      });
      setEditing(null);
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  function exportCsv() {
    const lines = [
      'name,clock_in,clock_out,hours,flagged,edit_note',
      ...entries.map((e) =>
        [e.userName, e.clockIn, e.clockOut ?? '', hours(e), e.flagged ? 'yes' : '', e.editNote ?? ''].join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fmp-hours-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 15 }}>
          {openEntry ? (
            <span>
              <StatusChip tone="green">Clocked in</StatusChip>{' '}
              since {new Date(openEntry.clockIn).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          ) : (
            <StatusChip tone="neutral">Not clocked in</StatusChip>
          )}
          {error && <span style={{ color: 'var(--red)', marginLeft: 10, fontSize: 14 }}>{error}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={exportCsv}>
            <i className="bi bi-download" /> Hours CSV
          </Button>
          {openEntry ? (
            <Button variant="dark" onClick={() => void clock('clock-out')}>
              <i className="bi bi-box-arrow-right" /> Clock out
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void clock('clock-in')}>
              <i className="bi bi-box-arrow-in-right" /> Clock in
            </Button>
          )}
        </div>
      </div>

      <div style={{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 11.5px Inter, sans-serif', letterSpacing: '0.06em' }}>
              {['STAFF', 'CLOCK IN', 'CLOCK OUT', 'HOURS', 'FLAGS', ''].map((h, i) => (
                <th key={i} style={{ padding: '15px 16px', borderBottom: '1px solid var(--line-soft)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', font: '600 15px Inter, sans-serif' }}>{e.userName}</td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                  {new Date(e.clockIn).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                  {e.clockOut
                    ? new Date(e.clockOut).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                    : '—'}
                </td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>{hours(e)}</td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    {e.flagged && <StatusChip tone="red">Check</StatusChip>}
                    {e.editNote && <StatusChip tone="amber" style={{ cursor: 'help' }}>Edited</StatusChip>}
                  </span>
                </td>
                <td style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)', textAlign: 'right' }}>
                  {isManager && (
                    <button
                      onClick={() => {
                        setEditing(e);
                        setEditIn(toLocalInput(e.clockIn));
                        setEditOut(toLocalInput(e.clockOut));
                        setEditNote('');
                      }}
                      style={{ border: 'none', background: 'none', color: 'var(--ink-3)' }}
                    >
                      <i className="bi bi-pencil" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <div style={{ padding: 24, color: 'var(--ink-4)', fontSize: 15 }}>No time entries in the last 14 days.</div>}
      </div>

      <Modal open={editing !== null} onClose={() => setEditing(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>Edit entry · {editing?.userName}</h2>
        <label style={{ display: 'block', marginTop: 12, fontSize: 12.5, color: 'var(--ink-3)' }}>
          Clock in
          <input type="datetime-local" value={editIn} onChange={(e) => setEditIn(e.target.value)} style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
        </label>
        <label style={{ display: 'block', marginTop: 8, fontSize: 12.5, color: 'var(--ink-3)' }}>
          Clock out (empty = still in)
          <input type="datetime-local" value={editOut} onChange={(e) => setEditOut(e.target.value)} style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
        </label>
        <input
          value={editNote}
          onChange={(e) => setEditNote(e.target.value)}
          placeholder="Edit note * — e.g. forgot to clock out"
          style={{ width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void saveEdit()}>Save</Button>
        </div>
      </Modal>
    </div>
  );
}
