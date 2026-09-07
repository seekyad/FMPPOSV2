import { useEffect, useMemo, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, Modal, StatusChip } from '@fmp/ui';
import { api, session } from './api';

interface Item {
  id: number;
  kind: 'device' | 'part' | 'accessory';
  name: string;
  sku: string | null;
  imei: string | null;
  storage: string | null;
  conditionGrade: 'A' | 'B' | 'C' | null;
  carrier: string | null;
  fromTradeIn: boolean;
  qty: number;
  costCents: number;
  priceCents: number;
  taxable: boolean;
  status: string;
  receivedAt: string;
}

const TABS = [
  { id: 'phones', label: 'Phones' },
  { id: 'parts', label: 'Parts' },
  { id: 'accessories', label: 'Accessories' },
  { id: 'tradeins', label: 'Trade-ins' },
  { id: 'sold', label: 'Sold' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const AGING_DAYS = 60;

function ageDays(item: Item): number {
  return Math.floor((Date.now() - new Date(item.receivedAt).getTime()) / 86400_000);
}

function statusChip(item: Item) {
  if (item.status === 'sold') return <StatusChip tone="neutral">Sold</StatusChip>;
  if (item.status === 'hold_repair') return <StatusChip tone="blue">Hold · repair</StatusChip>;
  if (item.status === 'needs_intake') return <StatusChip tone="amber">Needs intake</StatusChip>;
  if (item.kind === 'device' && ageDays(item) >= AGING_DAYS) return <StatusChip tone="red">Aging</StatusChip>;
  if (item.kind !== 'device' && item.qty <= 3) return <StatusChip tone="amber">Low stock</StatusChip>;
  return <StatusChip tone="green">In stock</StatusChip>;
}

export function InventoryScreen() {
  const [tab, setTab] = useState<TabId>('phones');
  const [rows, setRows] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const isManager = session.user?.role === 'manager';

  async function load() {
    const res = await api<{ rows: Item[]; counts: Array<{ kind: string; fromTradeIn: boolean; status: string; n: number }> }>(
      `/api/inventory?tab=${tab}&query=${encodeURIComponent(query)}`,
    ).catch(() => ({ rows: [], counts: [] }));
    setRows(res.rows);
    const c = { phones: 0, parts: 0, accessories: 0, tradeins: 0, sold: 0 };
    for (const row of res.counts) {
      const n = Number(row.n);
      if (row.status === 'sold') c.sold += n;
      else if (row.status === 'removed') continue;
      else if (row.fromTradeIn) c.tradeins += n;
      else if (row.kind === 'device') c.phones += n;
      else if (row.kind === 'part') c.parts += n;
      else c.accessories += n;
    }
    setCounts(c);
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [tab, query]);

  const retailValue = useMemo(() => rows.reduce((s, r) => s + r.priceCents * (r.kind === 'device' ? 1 : r.qty), 0), [rows]);

  return (
    <div style={{ padding: '22px 24px', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, font: '700 24px Inter, sans-serif' }}>Inventory</h1>
          <div style={{ color: 'var(--ink-3)', fontSize: 12, marginTop: 2 }}>
            {rows.length} shown · retail value {formatCents(retailValue)}
          </div>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <i className="bi bi-plus-lg" /> Add item
        </Button>
      </div>

      <div style={{ position: 'relative', marginTop: 16 }}>
        <i className="bi bi-search" style={{ position: 'absolute', left: 14, top: 13, color: 'var(--ink-4)', fontSize: 14 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search model, IMEI, SKU, or serial"
          style={{ width: '100%', padding: '12px 14px 12px 38px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 13 }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: tab === t.id ? 'var(--navy)' : 'var(--card)',
              color: tab === t.id ? '#fff' : 'var(--ink-2)',
              font: '600 12px Inter, sans-serif',
            }}
          >
            {t.label}{' '}
            <span style={{ opacity: 0.6, marginLeft: 2 }}>{counts[t.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14, background: 'var(--card)', borderRadius: 14, border: '1px solid var(--line-soft)', overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-4)', font: '600 10px Inter, sans-serif', letterSpacing: '0.06em' }}>
              {['ITEM', tab === 'phones' || tab === 'tradeins' || tab === 'sold' ? 'IMEI' : 'SKU', 'CONDITION', 'QTY', 'COST', 'PRICE', 'AGE', 'STATUS', ''].map((h, i) => (
                <th key={i} style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', position: 'sticky', top: 0, background: 'var(--card)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const age = ageDays(item);
              return (
                <tr key={item.id}>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', font: '600 13px Inter, sans-serif' }}>
                    {item.name}
                    {item.storage ? <span style={{ color: 'var(--ink-3)', fontWeight: 500 }}> · {item.storage}</span> : null}
                  </td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-3)' }}>
                    {item.kind === 'device' ? (item.imei ? `…${item.imei.slice(-5)}` : '—') : (item.sku ?? '—')}
                  </td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-2)' }}>
                    {item.kind === 'device' ? `${item.conditionGrade ?? '?'} · ${item.carrier ?? '—'}` : '—'}
                  </td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)' }}>{item.kind === 'device' ? '1' : item.qty}</td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: 'var(--ink-3)' }}>{formatCents(item.costCents)}</td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', font: '700 13px Inter, sans-serif' }}>{formatCents(item.priceCents)}</td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', color: age >= AGING_DAYS ? 'var(--red)' : 'var(--ink-3)' }}>
                    {age} d
                  </td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)' }}>{statusChip(item)}</td>
                  <td style={{ padding: '11px 16px', borderBottom: '1px solid var(--line-soft)', textAlign: 'right' }}>
                    {item.status !== 'sold' && (
                      <button
                        onClick={() => setAdjusting(item)}
                        title={isManager ? 'Adjust / remove' : 'Manager only'}
                        disabled={!isManager}
                        style={{ border: 'none', background: 'none', color: isManager ? 'var(--ink-3)' : 'var(--line)', fontSize: 14 }}
                      >
                        <i className="bi bi-three-dots" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div style={{ padding: 24, color: 'var(--ink-4)', fontSize: 13 }}>Nothing here.</div>}
      </div>

      <AddItemModal open={adding} onClose={() => setAdding(false)} onSaved={() => void load()} defaultKind={tab === 'parts' ? 'part' : tab === 'accessories' ? 'accessory' : 'device'} />
      <AdjustModal item={adjusting} onClose={() => setAdjusting(null)} onSaved={() => void load()} />
    </div>
  );
}

function AddItemModal({
  open,
  defaultKind,
  onClose,
  onSaved,
}: {
  open: boolean;
  defaultKind: 'device' | 'part' | 'accessory';
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<'device' | 'part' | 'accessory'>(defaultKind);
  const [form, setForm] = useState({ name: '', sku: '', imei: '', storage: '', carrier: '', grade: 'A', qty: '1', cost: '', price: '' });
  const [error, setError] = useState('');

  useEffect(() => setKind(defaultKind), [defaultKind, open]);

  async function save() {
    const costCents = parseDollars(form.cost || '0');
    const priceCents = parseDollars(form.price || '0');
    if (!form.name.trim() || costCents == null || priceCents == null) {
      setError('Name, cost and price are required (numbers).');
      return;
    }
    try {
      await api('/api/inventory', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: form.name.trim(),
          sku: form.sku || null,
          imei: kind === 'device' ? form.imei || null : null,
          storage: kind === 'device' ? form.storage || null : null,
          carrier: kind === 'device' ? form.carrier || null : null,
          conditionGrade: kind === 'device' ? form.grade : null,
          qty: kind === 'device' ? 1 : Math.max(0, parseInt(form.qty, 10) || 0),
          costCents,
          priceCents,
        }),
      });
      setForm({ name: '', sku: '', imei: '', storage: '', carrier: '', grade: 'A', qty: '1', cost: '', price: '' });
      setError('');
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const input = (key: keyof typeof form, placeholder: string, width?: number) => (
    <input
      value={form[key]}
      onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
      placeholder={placeholder}
      style={{ width: width ?? '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
    />
  );

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>Add inventory</h2>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {(['device', 'part', 'accessory'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            style={{
              flex: 1,
              padding: '9px 0',
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: kind === k ? 'var(--navy)' : 'var(--card)',
              color: kind === k ? '#fff' : 'var(--ink-2)',
              font: '600 12px Inter, sans-serif',
              textTransform: 'capitalize',
            }}
          >
            {k}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {input('name', kind === 'device' ? 'Model name — e.g. iPhone 13' : 'Item name')}
        {kind === 'device' ? (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              {input('imei', 'IMEI')}
              {input('storage', 'Storage — 128 GB')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {input('carrier', 'Carrier — Unlocked')}
              <div style={{ display: 'flex', gap: 4 }}>
                {(['A', 'B', 'C'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setForm((prev) => ({ ...prev, grade: g }))}
                    style={{
                      width: 38,
                      padding: '9px 0',
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      background: form.grade === g ? 'var(--orange-soft)' : 'var(--card)',
                      color: form.grade === g ? 'var(--orange)' : 'var(--ink-2)',
                      font: '700 12px Inter, sans-serif',
                    }}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            {input('sku', 'SKU')}
            {input('qty', 'Qty', 90)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {input('cost', 'Cost $')}
          {input('price', 'Sell price $')}
        </div>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>Add to inventory</Button>
      </div>
    </Modal>
  );
}

function AdjustModal({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: () => void }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  async function adjust() {
    const d = parseInt(delta, 10);
    if (!item || !Number.isFinite(d) || d === 0 || reason.trim().length < 2) {
      setError('Enter a non-zero adjustment and a reason.');
      return;
    }
    try {
      await api(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: JSON.stringify({ deltaQty: d, reason: reason.trim() }) });
      close();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adjust failed');
    }
  }

  async function remove() {
    if (!item || reason.trim().length < 2) {
      setError('A reason is required to remove an item.');
      return;
    }
    try {
      await api(`/api/inventory/${item.id}/remove`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      close();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    }
  }

  function close() {
    setDelta('');
    setReason('');
    setError('');
    onClose();
  }

  return (
    <Modal open={item !== null} onClose={close} width={380}>
      <h2 style={{ margin: 0, font: '700 17px Inter, sans-serif' }}>{item?.name}</h2>
      <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 0' }}>
        Manager adjustment — every change is logged with your name.
      </p>
      {item?.kind !== 'device' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13 }}>Qty change</span>
          <input
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            placeholder="+5 or -2"
            style={{ width: 90, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
          <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>now {item?.qty}</span>
        </div>
      )}
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason * — e.g. damaged in store"
        style={{ width: '100%', marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
      />
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
        <Button variant="danger" onClick={() => void remove()}>Remove item</Button>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {item?.kind !== 'device' && <Button variant="primary" onClick={() => void adjust()}>Apply adjustment</Button>}
        </div>
      </div>
    </Modal>
  );
}
