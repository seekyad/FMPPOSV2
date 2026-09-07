import { useEffect, useState } from 'react';
import { Button } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface Store {
  name: string;
  address: string | null;
  phone: string | null;
  taxRateBp: number;
  receiptHeader: string | null;
  receiptFooter: string | null;
  settings: { drawerFloatCents?: number; dejavoo?: { tpn?: string; authKey?: string; registerId?: string } };
}

export function StoreTab() {
  const isManager = session.user?.role === 'manager';
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Store>('/api/settings/store').then((s) => {
      setForm({
        name: s.name,
        address: s.address ?? '',
        phone: s.phone ?? '',
        taxPct: (s.taxRateBp / 100).toString(),
        receiptHeader: s.receiptHeader ?? '',
        receiptFooter: s.receiptFooter ?? '',
        drawerFloat: s.settings.drawerFloatCents != null ? (s.settings.drawerFloatCents / 100).toFixed(2) : '200.00',
        tpn: s.settings.dejavoo?.tpn ?? '',
        authKey: s.settings.dejavoo?.authKey ?? '',
        registerId: s.settings.dejavoo?.registerId ?? '',
      });
    });
  }, []);

  async function save() {
    setError('');
    setSaved('');
    const taxRateBp = Math.round(parseFloat(form.taxPct ?? '6') * 100);
    const drawerFloatCents = Math.round(parseFloat(form.drawerFloat ?? '200') * 100);
    if (!Number.isFinite(taxRateBp) || !Number.isFinite(drawerFloatCents)) {
      setError('Tax rate and drawer float must be numbers.');
      return;
    }
    try {
      await api('/api/settings/store', {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          address: form.address || null,
          phone: form.phone || null,
          taxRateBp,
          receiptHeader: form.receiptHeader || null,
          receiptFooter: form.receiptFooter || null,
          settings: {
            drawerFloatCents,
            dejavoo:
              form.tpn || form.authKey
                ? { tpn: form.tpn, authKey: form.authKey, registerId: form.registerId }
                : undefined,
          },
        }),
      });
      setSaved('Saved.');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const field = (key: string, label: string, placeholder = '') => (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ font: '600 11px Inter, sans-serif', color: 'var(--ink-3)', marginBottom: 4 }}>{label}</div>
      <input
        value={form[key] ?? ''}
        disabled={!isManager}
        onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
      />
    </label>
  );

  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, maxWidth: 860 }}>
        <div>
          <h3 style={{ font: '700 14px Inter, sans-serif', margin: '0 0 10px' }}>Store</h3>
          {field('name', 'Store name')}
          {field('address', 'Address')}
          {field('phone', 'Phone')}
          {field('taxPct', 'Sales tax %', '6')}
          {field('drawerFloat', 'Default drawer float $', '200.00')}
        </div>
        <div>
          <h3 style={{ font: '700 14px Inter, sans-serif', margin: '0 0 10px' }}>Receipts</h3>
          {field('receiptHeader', 'Receipt header', 'FMP — Phone Repair & Sales')}
          {field('receiptFooter', 'Receipt footer', 'Thank you! 90-day warranty on repairs.')}
          <h3 style={{ font: '700 14px Inter, sans-serif', margin: '16px 0 10px' }}>
            Dejavoo terminal <span style={{ font: '500 10px Inter, sans-serif', color: 'var(--ink-4)' }}>(leave empty for manual card entry)</span>
          </h3>
          {field('tpn', 'TPN')}
          {field('authKey', 'Auth key')}
          {field('registerId', 'Register ID')}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <Button variant="primary" disabled={!isManager} onClick={() => void save()}>Save settings</Button>
        {saved && <span style={{ color: 'var(--green)', fontSize: 12 }}>{saved}</span>}
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
        {!isManager && <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>Manager sign-in required to edit.</span>}
      </div>
    </div>
  );
}
