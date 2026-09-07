import { useEffect, useState } from 'react';
import { Button } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

interface StoreData {
  name: string;
  address: string | null;
  phone: string | null;
  taxRateBp: number;
  receiptHeader: string | null;
  receiptFooter: string | null;
  settings: {
    drawerFloatCents?: number;
    dejavoo?: { tpn?: string; authKey?: string; registerId?: string };
    printing?: { autoPrintReceipt?: boolean; labelNote?: string };
  };
}

/** Shared load/save for the store-backed settings sections. */
function useStore() {
  const [store, setStore] = useState<StoreData | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const isManager = session.user?.role === 'manager';

  useEffect(() => {
    void api<StoreData>('/api/settings/store').then(setStore).catch(() => {});
  }, []);

  async function save(patch: Record<string, unknown>) {
    setError('');
    setSaved('');
    try {
      const updated = await api<StoreData>('/api/settings/store', { method: 'PUT', body: JSON.stringify(patch) });
      setStore(updated);
      setSaved('Saved.');
      setTimeout(() => setSaved(''), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return { store, save, saved, error, isManager };
}

const fieldLabel = { font: '600 12px Inter, sans-serif', color: 'var(--ink-3)', marginBottom: 5 } as const;
const inputStyle = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid var(--line)',
  fontSize: 15,
} as const;

function SaveRow({ saved, error, isManager, onSave }: { saved: string; error: string; isManager: boolean; onSave: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
      <Button variant="primary" disabled={!isManager} onClick={onSave}>
        Save changes
      </Button>
      {saved && <span style={{ color: 'var(--green)', fontSize: 14 }}>{saved}</span>}
      {error && <span style={{ color: 'var(--red)', fontSize: 14 }}>{error}</span>}
      {!isManager && <span style={{ color: 'var(--ink-4)', fontSize: 14 }}>Manager sign-in required to edit.</span>}
    </div>
  );
}

export function StoreProfileSection() {
  const { store, save, saved, error, isManager } = useStore();
  const [form, setForm] = useState({ name: '', address: '', phone: '' });
  useEffect(() => {
    if (store) setForm({ name: store.name, address: store.address ?? '', phone: store.phone ?? '' });
  }, [store]);
  if (!store) return null;
  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ margin: '0 0 16px', color: 'var(--ink-3)', fontSize: 14 }}>
        Shown on receipts, labels, and reports.
      </p>
      {(
        [
          ['name', 'STORE NAME'],
          ['address', 'ADDRESS'],
          ['phone', 'PHONE'],
        ] as const
      ).map(([key, labelText]) => (
        <label key={key} style={{ display: 'block', marginBottom: 12 }}>
          <div style={fieldLabel}>{labelText}</div>
          <input
            value={form[key]}
            disabled={!isManager}
            onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
            style={inputStyle}
          />
        </label>
      ))}
      <SaveRow saved={saved} error={error} isManager={isManager} onSave={() => void save({ name: form.name, address: form.address || null, phone: form.phone || null })} />
    </div>
  );
}

export function TaxesSection() {
  const { store, save, saved, error, isManager } = useStore();
  const [taxPct, setTaxPct] = useState('');
  useEffect(() => {
    if (store) setTaxPct((store.taxRateBp / 100).toString());
  }, [store]);
  if (!store) return null;
  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ margin: '0 0 16px', color: 'var(--ink-3)', fontSize: 14 }}>
        Applied to taxable items at checkout across both systems. Bill-payment remittances are never taxed.
      </p>
      <label style={{ display: 'block', maxWidth: 220 }}>
        <div style={fieldLabel}>SALES TAX %</div>
        <input value={taxPct} disabled={!isManager} onChange={(e) => setTaxPct(e.target.value)} style={inputStyle} />
      </label>
      <SaveRow
        saved={saved}
        error={error}
        isManager={isManager}
        onSave={() => {
          const bp = Math.round(parseFloat(taxPct) * 100);
          if (!Number.isFinite(bp) || bp < 0) return;
          void save({ taxRateBp: bp });
        }}
      />
    </div>
  );
}

export function ReceiptsPrintingSection() {
  const { store, save, saved, error, isManager } = useStore();
  const [form, setForm] = useState({ header: '', footer: '', float: '' });
  useEffect(() => {
    if (store)
      setForm({
        header: store.receiptHeader ?? '',
        footer: store.receiptFooter ?? '',
        float: store.settings.drawerFloatCents != null ? (store.settings.drawerFloatCents / 100).toFixed(2) : '200.00',
      });
  }, [store]);
  if (!store) return null;
  return (
    <div style={{ maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 4px', font: '700 17px Inter, sans-serif' }}>Receipts</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--ink-3)', fontSize: 14 }}>
        Printed on the Rongta receipt printer through the store print bridge.
      </p>
      <label style={{ display: 'block', marginBottom: 12 }}>
        <div style={fieldLabel}>RECEIPT HEADER</div>
        <input value={form.header} disabled={!isManager} onChange={(e) => setForm((p) => ({ ...p, header: e.target.value }))} style={inputStyle} />
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        <div style={fieldLabel}>RECEIPT FOOTER</div>
        <input value={form.footer} disabled={!isManager} onChange={(e) => setForm((p) => ({ ...p, footer: e.target.value }))} style={inputStyle} />
      </label>
      <label style={{ display: 'block', marginBottom: 12, maxWidth: 220 }}>
        <div style={fieldLabel}>DEFAULT DRAWER FLOAT $</div>
        <input value={form.float} disabled={!isManager} onChange={(e) => setForm((p) => ({ ...p, float: e.target.value }))} style={inputStyle} />
      </label>

      <h3 style={{ margin: '20px 0 4px', font: '700 17px Inter, sans-serif' }}>Printers</h3>
      <div style={{ background: 'var(--page)', borderRadius: 12, padding: '14px 16px', fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6 }}>
        <div>
          <i className="bi bi-printer" style={{ marginRight: 8 }} />
          <b>Receipts — Rongta:</b> configured on the store PC in <code>bridge/config.json</code> (printer IP for network models, or the Windows share name for USB). The bridge shows as connected once it's running.
        </div>
        <div style={{ marginTop: 8 }}>
          <i className="bi bi-tag" style={{ marginRight: 8 }} />
          <b>Labels — Niimbot:</b> labels print through the browser's print dialog sized 50×30 mm. Native Niimbot printing is added to the bridge after validating with your printer model.
        </div>
      </div>
      <SaveRow
        saved={saved}
        error={error}
        isManager={isManager}
        onSave={() => {
          const floatCents = Math.round(parseFloat(form.float || '200') * 100);
          void save({
            receiptHeader: form.header || null,
            receiptFooter: form.footer || null,
            settings: { drawerFloatCents: Number.isFinite(floatCents) ? floatCents : 20000 },
          });
        }}
      />
    </div>
  );
}

export function PaymentsSection() {
  const { store, save, saved, error, isManager } = useStore();
  const [form, setForm] = useState({ tpn: '', authKey: '', registerId: '' });
  useEffect(() => {
    if (store)
      setForm({
        tpn: store.settings.dejavoo?.tpn ?? '',
        authKey: store.settings.dejavoo?.authKey ?? '',
        registerId: store.settings.dejavoo?.registerId ?? '',
      });
  }, [store]);
  if (!store) return null;
  const configured = Boolean(form.tpn && form.authKey);
  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ margin: '0 0 16px', color: 'var(--ink-3)', fontSize: 14 }}>
        Dejavoo terminal credentials. When set, the payment screen sends the amount straight to the terminal;
        leave empty to confirm card payments manually. Currently: <b>{configured ? 'connected' : 'manual entry'}</b>.
      </p>
      {(
        [
          ['tpn', 'TPN'],
          ['authKey', 'AUTH KEY'],
          ['registerId', 'REGISTER ID'],
        ] as const
      ).map(([key, labelText]) => (
        <label key={key} style={{ display: 'block', marginBottom: 12 }}>
          <div style={fieldLabel}>{labelText}</div>
          <input value={form[key]} disabled={!isManager} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} style={inputStyle} />
        </label>
      ))}
      <SaveRow
        saved={saved}
        error={error}
        isManager={isManager}
        onSave={() => void save({ settings: { dejavoo: { tpn: form.tpn, authKey: form.authKey, registerId: form.registerId } } })}
      />
    </div>
  );
}
