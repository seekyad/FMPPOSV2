import { useEffect, useState } from 'react';
import { formatCents } from '@fmp/shared';
import { Modal, StatusChip } from '@fmp/ui';
import { api } from './api';

export interface PickableItem {
  id: number;
  kind: 'device' | 'part' | 'accessory';
  name: string;
  sku?: string | null;
  imei?: string | null;
  storage?: string | null;
  conditionGrade?: string | null;
  carrier?: string | null;
  qty: number;
  priceCents: number;
  taxable: boolean;
}

/** Accessory / device picker for the smart-action tiles. */
export function InventoryPickerModal({
  open,
  tab,
  title,
  onClose,
  onPick,
}: {
  open: boolean;
  tab: 'accessories' | 'phones';
  title: string;
  onClose: () => void;
  onPick: (item: PickableItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PickableItem[]>([]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const res = await api<{ rows: PickableItem[] }>(
        `/api/inventory?tab=${tab}&query=${encodeURIComponent(query)}`,
      ).catch(() => ({ rows: [] }));
      setRows(res.rows.filter((r) => r.qty > 0));
    }, 150);
    return () => clearTimeout(t);
  }, [open, tab, query]);

  return (
    <Modal open={open} onClose={onClose} width={520}>
      <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>{title}</h2>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name, SKU, or IMEI"
        style={{ width: '100%', marginTop: 12, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
      />
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflow: 'auto' }}>
        {rows.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              onPick(item);
              onClose();
            }}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: 'var(--card)',
              textAlign: 'left',
            }}
          >
            <div>
              <div style={{ font: '600 13px Inter, sans-serif' }}>
                {item.name}
                {item.storage ? ` · ${item.storage}` : ''}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {item.kind === 'device'
                  ? `IMEI …${(item.imei ?? '').slice(-5)} · ${item.conditionGrade ?? '?'} · ${item.carrier ?? ''}`
                  : `${item.sku ?? ''} · ${item.qty} in stock`}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {item.qty <= 3 && item.kind !== 'device' && <StatusChip tone="amber">Low</StatusChip>}
              <span style={{ font: '700 14px Inter, sans-serif' }}>{formatCents(item.priceCents)}</span>
            </div>
          </button>
        ))}
        {rows.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: 8 }}>Nothing in stock matches.</div>}
      </div>
    </Modal>
  );
}
