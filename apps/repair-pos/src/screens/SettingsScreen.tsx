import { useEffect, useMemo, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api, session } from '../api';

interface Model {
  id: number;
  brand: string;
  name: string;
  kind: string;
  active: boolean;
}
interface RepairType {
  id: number;
  category: string;
  name: string;
}
interface ServiceRow {
  id: number;
  modelId: number;
  repairTypeId: number;
  priceCents: number;
  partCostCents: number;
  laborCents: number;
  warrantyDays: number;
}

/** Settings → catalog administration: device models, repair types, per-model pricing. */
export function CatalogTab() {
  const isManager = session.user?.role === 'manager';
  const [models, setModels] = useState<Model[]>([]);
  const [types, setTypes] = useState<RepairType[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [modelId, setModelId] = useState<number | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [newBrand, setNewBrand] = useState('');
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<RepairType | null>(null);
  const [form, setForm] = useState({ price: '', part: '', labor: '', warranty: '90' });
  const [error, setError] = useState('');

  async function load() {
    const [m, t] = await Promise.all([api<Model[]>('/api/catalog/models'), api<RepairType[]>('/api/catalog/repair-types')]);
    setModels(m);
    setTypes(t);
    if (m.length > 0 && modelId == null) setModelId(m[0]!.id);
  }

  async function loadServices(id: number) {
    setServices(await api<ServiceRow[]>(`/api/catalog/services?modelId=${id}`));
  }

  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (modelId != null) void loadServices(modelId);
  }, [modelId]);

  const serviceFor = useMemo(() => new Map(services.map((s) => [s.repairTypeId, s])), [services]);

  function openEditor(t: RepairType) {
    const existing = serviceFor.get(t.id);
    setEditing(t);
    setForm({
      price: existing ? (existing.priceCents / 100).toFixed(2) : '',
      part: existing ? (existing.partCostCents / 100).toFixed(2) : '',
      labor: existing ? (existing.laborCents / 100).toFixed(2) : '',
      warranty: existing ? String(existing.warrantyDays) : '90',
    });
    setError('');
  }

  async function saveService() {
    const price = parseDollars(form.price || '0');
    if (editing == null || modelId == null || price == null) {
      setError('Enter a valid price.');
      return;
    }
    try {
      await api('/api/catalog/services', {
        method: 'PUT',
        body: JSON.stringify({
          modelId,
          repairTypeId: editing.id,
          priceCents: price,
          partCostCents: parseDollars(form.part || '0') ?? 0,
          laborCents: parseDollars(form.labor || '0') ?? 0,
          warrantyDays: parseInt(form.warranty, 10) || 90,
        }),
      });
      setEditing(null);
      await loadServices(modelId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function addModel() {
    if (!newBrand.trim() || !newName.trim()) return;
    try {
      const row = await api<Model>('/api/catalog/models', {
        method: 'POST',
        body: JSON.stringify({ brand: newBrand.trim(), name: newName.trim() }),
      });
      setAddingModel(false);
      setNewBrand('');
      setNewName('');
      await load();
      setModelId(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const categories = useMemo(() => {
    const byCat = new Map<string, RepairType[]>();
    for (const t of types) {
      if (!byCat.has(t.category)) byCat.set(t.category, []);
      byCat.get(t.category)!.push(t);
    }
    return [...byCat.entries()];
  }, [types]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          Prices, part costs, labor and warranty per device model{isManager ? '' : ' — read-only (manager sign-in to edit)'}
        </div>
        <Button variant="secondary" disabled={!isManager} onClick={() => setAddingModel(true)}>
          <i className="bi bi-plus-lg" /> Add device model
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {models.map((m) => (
          <button
            key={m.id}
            onClick={() => setModelId(m.id)}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: modelId === m.id ? 'var(--navy)' : 'var(--card)',
              color: modelId === m.id ? '#fff' : 'var(--ink-2)',
              font: '600 12px Inter, sans-serif',
            }}
          >
            {m.name}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14, background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1, padding: '6px 0' }}>
        {categories.map(([cat, catTypes]) => (
          <div key={cat}>
            <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em', padding: '12px 18px 4px' }}>
              {cat.toUpperCase()}
            </div>
            {catTypes.map((t) => {
              const s = serviceFor.get(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => isManager && openEditor(t)}
                  disabled={!isManager}
                  style={{
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '9px 18px',
                    border: 'none',
                    background: 'transparent',
                    borderBottom: '1px solid var(--line-soft)',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ color: 'var(--ink)' }}>{t.name}</span>
                  <span style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
                    {s ? (
                      <>
                        <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>
                          part {formatCents(s.partCostCents)} · labor {formatCents(s.laborCents)} · {s.warrantyDays}d
                        </span>
                        <span style={{ font: '700 13px Inter, sans-serif' }}>{formatCents(s.priceCents)}</span>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>not priced — quoted manually</span>
                    )}
                    {isManager && <i className="bi bi-pencil" style={{ color: 'var(--ink-4)', fontSize: 12 }} />}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <Modal open={editing !== null} onClose={() => setEditing(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>
          {models.find((m) => m.id === modelId)?.name} · {editing?.name}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          {(
            [
              ['price', 'Sell price $ *'],
              ['part', 'Part cost $'],
              ['labor', 'Labor $'],
              ['warranty', 'Warranty days'],
            ] as const
          ).map(([key, placeholder]) => (
            <input
              key={key}
              value={form[key]}
              onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder={placeholder}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
            />
          ))}
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void saveService()}>Save pricing</Button>
        </div>
      </Modal>

      <Modal open={addingModel} onClose={() => setAddingModel(false)} width={360}>
        <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>Add device model</h2>
        <input value={newBrand} onChange={(e) => setNewBrand(e.target.value)} placeholder="Brand — Apple" style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }} />
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Model — iPhone 16" style={{ width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setAddingModel(false)}>Cancel</Button>
          <Button variant="primary" disabled={!newBrand.trim() || !newName.trim()} onClick={() => void addModel()}>Add model</Button>
        </div>
      </Modal>
    </div>
  );
}
