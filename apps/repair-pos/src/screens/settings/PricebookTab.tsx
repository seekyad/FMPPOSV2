import { useEffect, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, DataTable, Modal } from '@fmp/ui';
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
        <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>
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
      <DataTable
        columns={[
          {
            key: 'device',
            label: 'Device',
            sortValue: (r: Row) => `${r.brand} ${r.modelName}`,
            render: (r: Row) => <span style={{ font: '600 15px Inter, sans-serif' }}>{r.brand} {r.modelName}</span>,
          },
          {
            key: 'storage',
            label: 'Storage',
            sortValue: (r: Row) => r.storage,
            render: (r: Row) => r.storage,
          },
          {
            key: 'base',
            label: 'Base value',
            align: 'right',
            sortValue: (r: Row) => r.baseValueCents,
            render: (r: Row) => <b>{formatCents(r.baseValueCents)}</b>,
          },
          {
            key: 'split',
            label: 'Good / fair / broken',
            render: (r: Row) => (
              <span style={{ color: 'var(--ink-3)', fontSize: 14 }}>
                {formatCents(r.baseValueCents)} / {formatCents(Math.round(r.baseValueCents * 0.75))} / {formatCents(Math.round(r.baseValueCents * 0.4))}
              </span>
            ),
          },
          {
            key: 'edit',
            label: '',
            align: 'right',
            render: (r: Row) => (
              <button
                disabled={!isManager}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing({ modelId: r.modelId, storage: r.storage, value: (r.baseValueCents / 100).toFixed(2), title: `${r.modelName} · ${r.storage}` });
                }}
                style={{ border: 'none', background: 'none', color: isManager ? 'var(--ink-3)' : 'var(--line)' }}
              >
                <i className="bi bi-pencil" />
              </button>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        searchText={(r) => `${r.brand} ${r.modelName} ${r.storage}`}
        searchPlaceholder="Search device or storage"
        initialSort={{ key: 'device', dir: 'asc' }}
        emptyText="No pricebook entries yet."
        footer={<span>{rows.length} entries</span>}
      />

      <Modal open={editing !== null} onClose={() => setEditing(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 19.5px Inter, sans-serif' }}>{editing?.title}</h2>
        <select
          value={editing?.modelId ?? ''}
          onChange={(e) => setEditing((prev) => prev && { ...prev, modelId: e.target.value === '' ? '' : Number(e.target.value) })}
          style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15, background: 'var(--card)' }}
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
            style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
          <input
            value={editing?.value ?? ''}
            onChange={(e) => setEditing((prev) => prev && { ...prev, value: e.target.value })}
            placeholder="Base value $"
            style={{ width: 120, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>Save</Button>
        </div>
      </Modal>
    </div>
  );
}
