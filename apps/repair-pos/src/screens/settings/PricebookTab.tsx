import { useEffect, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface Row {
  id: number;
  modelId: number;
  storage: string;
  baseValueCents: number;
  modelName: string;
  brand: string;
  active: boolean;
}
interface Model {
  id: number;
  brand: string;
  name: string;
}

export function PricebookTab() {
  const isManager = session.user?.role === 'manager';
  const [rows, setRows] = useState<Row[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [editing, setEditing] = useState<null | { modelId: number | ''; storage: string; value: string; title: string }>(null);
  const [error, setError] = useState('');

  async function load() {
    const [book, m] = await Promise.all([
      api<{ rows: Row[] }>('/api/tradein/pricebook'),
      api<Model[]>('/api/catalog/models'),
    ]);
    setRows(book.rows);
    setModels(m);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!editing || editing.modelId === '') return;
    const cents = parseDollars(editing.value || '');
    if (cents == null) {
      setError('Enter a valid base value.');
      return;
    }
    try {
      await api('/api/tradein/pricebook', {
        method: 'PUT',
        body: JSON.stringify({ modelId: editing.modelId, storage: editing.storage.trim(), baseValueCents: cents }),
      });
      setEditing(null);
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          Base values before condition multipliers (Good 100% · Fair 75% · Broken 40%) and the store-credit bonus.
        </div>
        <Button
          variant="primary"
          disabled={!isManager}
          onClick={() => setEditing({ modelId: models[0]?.id ?? '', storage: '', value: '', title: 'Add pricebook entry' })}
        >
          <i className="bi bi-plus-lg" /> Add entry
        </Button>
      </div>
      <div style={{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 10px Inter, sans-serif', letterSpacing: '0.06em' }}>
              {['DEVICE', 'STORAGE', 'BASE VALUE', 'GOOD / FAIR / BROKEN', ''].map((h, i) => (
                <th key={i} style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', position: 'sticky', top: 0, background: 'var(--card)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', font: '600 13px Inter, sans-serif' }}>
                  {r.brand} {r.modelName}
                </td>
                <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)' }}>{r.storage}</td>
                <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', font: '700 13px Inter, sans-serif' }}>
                  {formatCents(r.baseValueCents)}
                </td>
                <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-3)', fontSize: 12 }}>
                  {formatCents(r.baseValueCents)} / {formatCents(Math.round(r.baseValueCents * 0.75))} / {formatCents(Math.round(r.baseValueCents * 0.4))}
                </td>
                <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', textAlign: 'right' }}>
                  <button
                    disabled={!isManager}
                    onClick={() =>
                      setEditing({ modelId: r.modelId, storage: r.storage, value: (r.baseValueCents / 100).toFixed(2), title: `${r.modelName} · ${r.storage}` })
                    }
                    style={{ border: 'none', background: 'none', color: isManager ? 'var(--ink-3)' : 'var(--line)' }}
                  >
                    <i className="bi bi-pencil" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={editing !== null} onClose={() => setEditing(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>{editing?.title}</h2>
        <select
          value={editing?.modelId ?? ''}
          onChange={(e) => setEditing((prev) => prev && { ...prev, modelId: e.target.value === '' ? '' : Number(e.target.value) })}
          style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13, background: 'var(--card)' }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.brand} {m.name}</option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={editing?.storage ?? ''}
            onChange={(e) => setEditing((prev) => prev && { ...prev, storage: e.target.value })}
            placeholder="Storage — 128 GB"
            style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
          <input
            value={editing?.value ?? ''}
            onChange={(e) => setEditing((prev) => prev && { ...prev, value: e.target.value })}
            placeholder="Base value $"
            style={{ width: 120, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>Save</Button>
        </div>
      </Modal>
    </div>
  );
}
