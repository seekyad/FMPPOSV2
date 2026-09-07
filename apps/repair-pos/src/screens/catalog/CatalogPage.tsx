import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, DataTable, Modal, StatusChip, type Column } from '@fmp/ui';
import { api, session } from '@fmp/pos-client';

export interface ServiceRow {
  id: number;
  category: string;
  name: string;
  deviceGroup: string;
  timeMinutes: number;
  timeLabel: string | null;
  partsCostCents: number;
  basePriceCents: number;
  warrantyDays: number;
  intakeNotes: string | null;
  active: boolean;
  tiers: Array<{ id: number; label: string; priceCents: number }>;
  performed30d: number;
}

function marginPct(s: { basePriceCents: number; partsCostCents: number }): number {
  if (s.basePriceCents <= 0) return 0;
  return Math.round(((s.basePriceCents - s.partsCostCents) / s.basePriceCents) * 100);
}

function timeText(s: ServiceRow): string {
  if (s.timeLabel) return s.timeLabel;
  return s.timeMinutes >= 60 && s.timeMinutes % 60 === 0 ? `${s.timeMinutes / 60} hr` : `${s.timeMinutes} min`;
}

/** Service catalog — pricing & detail, matching the approved design. */
export function CatalogPage() {
  const navigate = useNavigate();
  const isManager = session.user?.role === 'manager';
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<ServiceRow | 'new' | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  async function load() {
    const data = await api<ServiceRow[]>('/api/catalog/services').catch(() => []);
    setRows(data);
    if (data.length > 0 && !data.some((d) => d.id === selectedId)) setSelectedId(data[0]!.id);
  }

  useEffect(() => {
    void load();
  }, []);

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category))], [rows]);
  const filtered = category === 'all' ? rows : rows.filter((r) => r.category === category);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const avgMargin =
    rows.length > 0 ? Math.round(rows.reduce((s, r) => s + marginPct(r), 0) / rows.length) : 0;

  const columns: Array<Column<ServiceRow>> = [
    {
      key: 'service',
      label: 'Service',
      sortValue: (r) => r.name,
      render: (r) => <span style={{ font: '600 15px Inter, sans-serif' }}>{r.name}</span>,
    },
    {
      key: 'group',
      label: 'Device group',
      sortValue: (r) => r.deviceGroup,
      render: (r) => <span style={{ color: 'var(--ink-2)' }}>{r.deviceGroup}</span>,
    },
    {
      key: 'time',
      label: 'Time',
      sortValue: (r) => r.timeMinutes,
      render: (r) => <span style={{ color: 'var(--ink-3)' }}>{timeText(r)}</span>,
    },
    {
      key: 'parts',
      label: 'Parts',
      align: 'right',
      sortValue: (r) => r.partsCostCents,
      render: (r) => <span style={{ color: 'var(--ink-3)' }}>{formatCents(r.partsCostCents)}</span>,
    },
    {
      key: 'price',
      label: 'Price',
      align: 'right',
      sortValue: (r) => r.basePriceCents,
      render: (r) => <b>{formatCents(r.basePriceCents)}</b>,
    },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      sortValue: (r) => marginPct(r),
      render: (r) => {
        const m = marginPct(r);
        return <span style={{ color: m >= 50 ? 'var(--green)' : 'var(--amber)', fontWeight: 600 }}>{m}%</span>;
      },
    },
  ];

  function addToSale(service: ServiceRow) {
    sessionStorage.setItem(
      'fmp.resumeSale',
      JSON.stringify({
        id: null,
        customer: null,
        lines: [
          {
            kind: 'custom',
            description: service.name,
            qty: 1,
            unitCents: service.basePriceCents,
            discountCents: 0,
            taxable: true,
          },
        ],
      }),
    );
    navigate('/register');
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Service catalog</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
              {rows.length} services · {categories.length} categories · avg margin {avgMargin}%
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" disabled={!isManager} onClick={() => setImportOpen(true)}>
              <i className="bi bi-upload" /> Import data
            </Button>
            <Button variant="secondary" disabled={!isManager} onClick={() => setBulkOpen(true)}>
              <i className="bi bi-arrow-repeat" /> Bulk price update
            </Button>
            <Button variant="primary" disabled={!isManager} onClick={() => setEditing('new')}>
              <i className="bi bi-plus-lg" /> New service
            </Button>
          </div>
        </div>

        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedId(r.id)}
          selectedKey={selectedId}
          searchText={(r) => `${r.name} ${r.deviceGroup} ${r.category}`}
          searchPlaceholder="Search services or devices"
          filters={[
            { id: 'all', label: 'All services', count: rows.length },
            ...categories.map((c) => ({ id: c, label: c, count: rows.filter((r) => r.category === c).length })),
          ]}
          activeFilter={category}
          onFilterChange={setCategory}
          initialSort={{ key: 'service', dir: 'asc' }}
          emptyText="No services match."
          footer={<span>{filtered.length} services shown · tap a row to see pricing detail</span>}
        />
      </div>

      {/* Detail panel */}
      <div style={{ width: 360, flexShrink: 0, background: 'var(--card)', borderLeft: '1px solid var(--line-soft)', overflow: 'auto', padding: '24px 22px', display: 'flex', flexDirection: 'column' }}>
        {selected ? (
          <>
            <div style={{ color: 'var(--orange)', font: '600 13px Inter, sans-serif' }}>{selected.category}</div>
            <h2 style={{ margin: '4px 0 2px', font: '700 22px Inter, sans-serif' }}>{selected.name}</h2>
            <div style={{ color: 'var(--ink-3)', fontSize: 14 }}>{selected.deviceGroup}</div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <span style={{ font: '800 34px Inter, sans-serif' }}>{formatCents(selected.basePriceCents)}</span>
              <StatusChip tone="green">{marginPct(selected)}% margin</StatusChip>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
              {(
                [
                  ['PARTS COST', formatCents(selected.partsCostCents)],
                  ['LABOR VALUE', formatCents(selected.basePriceCents - selected.partsCostCents)],
                  ['BENCH TIME', timeText(selected)],
                  ['WARRANTY', `${selected.warrantyDays} days`],
                ] as const
              ).map(([labelText, value]) => (
                <div key={labelText} style={{ background: 'var(--page)', borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ font: '600 10.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>{labelText}</div>
                  <div style={{ font: '700 18px Inter, sans-serif', marginTop: 3 }}>{value}</div>
                </div>
              ))}
            </div>

            {selected.tiers.length > 0 && (
              <>
                <div style={{ font: '600 11px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '18px 0 8px' }}>
                  PRICE BY MODEL
                </div>
                <div style={{ border: '1px solid var(--line-soft)', borderRadius: 12, overflow: 'hidden' }}>
                  {selected.tiers.map((t) => (
                    <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--line-soft)', fontSize: 15 }}>
                      <span>{t.label}</span>
                      <b>{formatCents(t.priceCents)}</b>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ font: '600 11px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '18px 0 4px' }}>PERFORMED</div>
            <div style={{ fontSize: 15 }}>{selected.performed30d} in the last 30 days</div>

            {selected.intakeNotes && (
              <>
                <div style={{ font: '600 11px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', margin: '16px 0 4px' }}>INTAKE NOTES</div>
                <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.5 }}>{selected.intakeNotes}</div>
              </>
            )}

            <div style={{ marginTop: 'auto', paddingTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Button variant="primary" size="lg" onClick={() => addToSale(selected)}>
                <i className="bi bi-plus-lg" /> Add to sale
              </Button>
              <div style={{ display: 'flex', gap: 10 }}>
                <Button variant="secondary" style={{ flex: 1 }} disabled={!isManager} onClick={() => setEditing(selected)}>
                  <i className="bi bi-pencil" /> Edit
                </Button>
                <Button
                  variant="secondary"
                  style={{ flex: 1 }}
                  disabled={!isManager}
                  onClick={async () => {
                    await api(`/api/catalog/services/${selected.id}/duplicate`, { method: 'POST' });
                    await load();
                  }}
                >
                  <i className="bi bi-copy" /> Duplicate
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--ink-4)', fontSize: 15, marginTop: 40, textAlign: 'center' }}>Select a service.</div>
        )}
      </div>

      <ServiceEditorModal
        editing={editing}
        categories={categories}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
      <BulkPriceModal open={bulkOpen} services={filtered} onClose={() => setBulkOpen(false)} onDone={() => void load()} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={() => void load()} />
    </div>
  );
}

interface ImportPayload {
  devices: Array<{ brand: string; name: string; kind?: string; family?: string; releaseYear?: number }>;
  services: Array<{
    name: string;
    category: string;
    deviceGroup?: string;
    timeMinutes?: number;
    partsCostCents?: number;
    basePriceCents?: number;
    warrantyDays?: number;
  }>;
  pricing: Array<{ serviceName: string; tierLabel: string; priceCents: number; partsCostCents?: number }>;
}

/** Upload a catalog workbook (.xlsx) or flat CSV and bulk-apply it. */
function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [payload, setPayload] = useState<ImportPayload | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  async function parseFile(file: File) {
    setError('');
    setResult('');
    setPayload(null);
    setFileName(file.name);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer());
      const sheet = (name: string) =>
        wb.SheetNames.includes(name)
          ? (XLSX.utils.sheet_to_json(wb.Sheets[name]!, { defval: null }) as Array<Record<string, unknown>>)
          : null;

      const str = (v: unknown) => (v == null ? '' : String(v).trim());
      const num = (v: unknown) => {
        const n = typeof v === 'number' ? v : parseFloat(str(v));
        return Number.isFinite(n) ? n : null;
      };

      const devicesSheet = sheet('Devices');
      const servicesSheet = sheet('Service Types');
      const pricingSheet = sheet('Repair Pricing');

      if (devicesSheet || servicesSheet || pricingSheet) {
        // FMP workbook format
        const devices = (devicesSheet ?? [])
          .filter((r) => str(r.record_status).toLowerCase() !== 'inactive' && str(r.model_name))
          .map((r) => ({
            brand: str(r.brand) || 'Unknown',
            name: str(r.model_name),
            kind: str(r.device_type),
            family: str(r.family) || undefined,
            releaseYear: num(r.release_year) != null ? Math.round(num(r.release_year)!) : undefined,
          }));

        // average part cost per service from the pricing matrix
        const partCosts = new Map<string, number[]>();
        for (const r of pricingSheet ?? []) {
          const cost = num(r.estimated_part_cost);
          const key = str(r.service_name).toLowerCase();
          if (cost != null && key) {
            if (!partCosts.has(key)) partCosts.set(key, []);
            partCosts.get(key)!.push(cost);
          }
        }
        const avgPartCents = (name: string) => {
          const list = partCosts.get(name.toLowerCase());
          if (!list || list.length === 0) return undefined;
          return Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 100);
        };

        const services = (servicesSheet ?? [])
          .filter((r) => str(r.service_name))
          .map((r) => {
            const low = num(r.estimated_minutes_low);
            const high = num(r.estimated_minutes_high);
            return {
              name: str(r.service_name),
              category: str(r.category) || 'General',
              timeMinutes: low != null && high != null ? Math.round((low + high) / 2) : undefined,
              partsCostCents: avgPartCents(str(r.service_name)),
            };
          });

        const pricing = (pricingSheet ?? [])
          .filter((r) => str(r.record_status).toLowerCase() !== 'inactive' && str(r.service_name) && str(r.model_name))
          .flatMap((r) => {
            const retail = num(r.suggested_retail);
            if (retail == null || retail <= 0) return [];
            const parts = num(r.estimated_part_cost);
            return [
              {
                serviceName: str(r.service_name),
                tierLabel: str(r.model_name),
                priceCents: Math.round(retail * 100),
                partsCostCents: parts != null ? Math.round(parts * 100) : undefined,
              },
            ];
          });

        setPayload({ devices, services, pricing });
        return;
      }

      // flat format: one sheet with name/category/price columns
      const first = wb.SheetNames[0];
      const rows = first ? (XLSX.utils.sheet_to_json(wb.Sheets[first]!, { defval: null }) as Array<Record<string, unknown>>) : [];
      const flat = rows
        .filter((r) => str(r.name ?? r.service ?? r.service_name))
        .map((r) => ({
          name: str(r.name ?? r.service ?? r.service_name),
          category: str(r.category) || 'General',
          deviceGroup: str(r.device_group ?? r.deviceGroup ?? r.devices) || undefined,
          basePriceCents: num(r.price ?? r.base_price) != null ? Math.round(num(r.price ?? r.base_price)! * 100) : undefined,
          partsCostCents: num(r.parts ?? r.part_cost) != null ? Math.round(num(r.parts ?? r.part_cost)! * 100) : undefined,
          warrantyDays: num(r.warranty_days ?? r.warranty) != null ? Math.round(num(r.warranty_days ?? r.warranty)!) : undefined,
        }));
      if (flat.length === 0) {
        setError('Could not recognize the file. Expected the FMP workbook (Devices / Service Types / Repair Pricing sheets) or a flat sheet with name, category, and price columns.');
        return;
      }
      setPayload({ devices: [], services: flat, pricing: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file');
    }
  }

  async function runImport() {
    if (!payload) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ devicesCreated: number; servicesCreated: number; servicesUpdated: number; tiersWritten: number }>(
        '/api/catalog/import',
        { method: 'POST', body: JSON.stringify(payload) },
      );
      setResult(
        `Done — ${res.devicesCreated} devices added, ${res.servicesCreated} services added, ${res.servicesUpdated} updated, ${res.tiersWritten} model prices written.`,
      );
      setPayload(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={560}>
      <h2 style={{ margin: 0, font: '700 20px Inter, sans-serif' }}>Import catalog data</h2>
      <p style={{ fontSize: 14, color: 'var(--ink-3)', margin: '6px 0 0', lineHeight: 1.5 }}>
        Upload the FMP catalog workbook (.xlsx with Devices, Service Types, and Repair Pricing sheets) or a flat
        .csv/.xlsx with <code>name</code>, <code>category</code>, <code>price</code> columns. Existing entries are
        matched by name and updated — re-importing an edited sheet applies your changes.
      </p>
      <label
        style={{
          display: 'block',
          marginTop: 14,
          padding: '26px 16px',
          border: '2px dashed var(--line)',
          borderRadius: 14,
          textAlign: 'center',
          cursor: 'pointer',
          color: 'var(--ink-2)',
          fontSize: 15,
        }}
      >
        <i className="bi bi-file-earmark-spreadsheet" style={{ fontSize: 26, display: 'block', marginBottom: 6, color: 'var(--ink-4)' }} />
        {fileName || 'Tap to choose a .xlsx or .csv file'}
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void parseFile(f);
            e.target.value = '';
          }}
        />
      </label>
      {payload && (
        <div style={{ marginTop: 12, background: 'var(--green-bg)', color: 'var(--green)', borderRadius: 12, padding: '12px 16px', fontSize: 14.5 }}>
          Ready to import: <b>{payload.devices.length}</b> devices · <b>{payload.services.length}</b> services ·{' '}
          <b>{payload.pricing.length}</b> model prices
        </div>
      )}
      {result && <div style={{ marginTop: 12, color: 'var(--green)', fontSize: 14.5 }}>{result}</div>}
      {error && <div style={{ marginTop: 12, color: 'var(--red)', fontSize: 14 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <Button variant="ghost" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
        <Button variant="primary" disabled={!payload || busy} onClick={() => void runImport()}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
      </div>
    </Modal>
  );
}

function ServiceEditorModal({
  editing,
  categories,
  onClose,
  onSaved,
}: {
  editing: ServiceRow | 'new' | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = editing === 'new';
  const base = isNew || editing === null ? null : editing;
  const [form, setForm] = useState({ category: '', name: '', deviceGroup: '', time: '', parts: '', price: '', warranty: '90', notes: '' });
  const [tiers, setTiers] = useState<Array<{ label: string; price: string }>>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editing === null) return;
    if (base) {
      setForm({
        category: base.category,
        name: base.name,
        deviceGroup: base.deviceGroup,
        time: base.timeLabel ?? String(base.timeMinutes),
        parts: (base.partsCostCents / 100).toFixed(2),
        price: (base.basePriceCents / 100).toFixed(2),
        warranty: String(base.warrantyDays),
        notes: base.intakeNotes ?? '',
      });
      setTiers(base.tiers.map((t) => ({ label: t.label, price: (t.priceCents / 100).toFixed(2) })));
    } else {
      setForm({ category: categories[0] ?? '', name: '', deviceGroup: 'Any device', time: '45', parts: '', price: '', warranty: '90', notes: '' });
      setTiers([]);
    }
    setError('');
  }, [editing]);

  async function save() {
    const price = parseDollars(form.price || '');
    if (!form.name.trim() || !form.category.trim() || price == null) {
      setError('Category, name and price are required.');
      return;
    }
    const timeNum = parseInt(form.time, 10);
    const payload = {
      category: form.category.trim(),
      name: form.name.trim(),
      deviceGroup: form.deviceGroup.trim() || 'Any device',
      timeMinutes: Number.isFinite(timeNum) ? timeNum : 45,
      timeLabel: Number.isFinite(timeNum) && String(timeNum) === form.time.trim() ? null : form.time.trim() || null,
      partsCostCents: parseDollars(form.parts || '0') ?? 0,
      basePriceCents: price,
      warrantyDays: parseInt(form.warranty, 10) || 90,
      intakeNotes: form.notes.trim() || null,
      tiers: tiers
        .filter((t) => t.label.trim() && parseDollars(t.price || '') != null)
        .map((t) => ({ label: t.label.trim(), priceCents: parseDollars(t.price)! })),
    };
    try {
      if (base) {
        await api(`/api/catalog/services/${base.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/catalog/services', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const input = (key: keyof typeof form, labelText: string, placeholder = '') => (
    <label key={key}>
      <div style={{ font: '600 12px Inter, sans-serif', color: 'var(--ink-3)', marginBottom: 5 }}>{labelText}</div>
      <input
        value={form[key]}
        onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{ width: '100%', padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
      />
    </label>
  );

  return (
    <Modal open={editing !== null} onClose={onClose} width={720}>
      <h2 style={{ margin: 0, font: '700 22px Inter, sans-serif' }}>{isNew ? 'New service' : `Edit · ${base?.name}`}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
        {input('name', 'SERVICE NAME *', 'Screen replacement — iPhone')}
        {input('category', 'CATEGORY *', 'Screens')}
        {input('deviceGroup', 'DEVICE GROUP', 'iPhone 12–16')}
        {input('time', 'BENCH TIME', '45 (minutes) or "24 hr hold"')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
        {input('price', 'BASE PRICE $ *')}
        {input('parts', 'PARTS COST $')}
        {input('warranty', 'WARRANTY DAYS')}
      </div>
      <label style={{ display: 'block', marginTop: 12 }}>
        <div style={{ font: '600 12px Inter, sans-serif', color: 'var(--ink-3)', marginBottom: 5 }}>INTAKE NOTES</div>
        <textarea
          value={form.notes}
          onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          rows={2}
          placeholder="Guidance shown to staff at intake"
          style={{ width: '100%', padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15, resize: 'none' }}
        />
      </label>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 8px' }}>
        <div style={{ font: '600 12px Inter, sans-serif', color: 'var(--ink-3)' }}>PRICE BY MODEL (optional tiers)</div>
        <Button variant="ghost" onClick={() => setTiers((p) => [...p, { label: '', price: '' }])}>
          <i className="bi bi-plus-lg" /> Add tier
        </Button>
      </div>
      {tiers.map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
          <input
            value={t.label}
            onChange={(e) => setTiers((p) => p.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)))}
            placeholder="Model group — iPhone 14 / 15"
            style={{ flex: 2, padding: '10px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
          <input
            value={t.price}
            onChange={(e) => setTiers((p) => p.map((x, xi) => (xi === i ? { ...x, price: e.target.value } : x)))}
            placeholder="Price $"
            style={{ flex: 1, padding: '10px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
          />
          <button onClick={() => setTiers((p) => p.filter((_, xi) => xi !== i))} style={{ border: 'none', background: 'none', color: 'var(--red)', fontSize: 16 }}>
            <i className="bi bi-trash" />
          </button>
        </div>
      ))}

      {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>{isNew ? 'Create service' : 'Save changes'}</Button>
      </div>
    </Modal>
  );
}

function BulkPriceModal({
  open,
  services,
  onClose,
  onDone,
}: {
  open: boolean;
  services: ServiceRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [percent, setPercent] = useState('');
  const [error, setError] = useState('');
  const pct = parseFloat(percent);

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <h2 style={{ margin: 0, font: '700 20px Inter, sans-serif' }}>Bulk price update</h2>
      <p style={{ fontSize: 14, color: 'var(--ink-3)', margin: '6px 0 0' }}>
        Applies to the {services.length} services currently shown (respects the category filter). Prices round to the nearest dollar; tiers move too.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <input
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          placeholder="+10 or -5"
          style={{ flex: 1, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }}
        />
        <span style={{ fontSize: 15, color: 'var(--ink-2)' }}>% change</span>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!Number.isFinite(pct) || pct === 0}
          onClick={async () => {
            try {
              await api('/api/catalog/services/bulk-price', {
                method: 'POST',
                body: JSON.stringify({ percent: pct, serviceIds: services.map((s) => s.id) }),
              });
              setPercent('');
              onDone();
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Update failed');
            }
          }}
        >
          Apply to {services.length} services
        </Button>
      </div>
    </Modal>
  );
}
