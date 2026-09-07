import { useEffect, useMemo, useState } from 'react';
import { computeTotals, formatCents } from '@fmp/shared';
import { Button } from '@fmp/ui';
import { api } from '@fmp/pos-client';
import type { CartCustomer } from '@fmp/pos-client';

export interface CatalogService {
  id: number;
  category: string;
  name: string;
  deviceGroup: string;
  basePriceCents: number;
  warrantyDays: number;
  intakeNotes: string | null;
  tiers: Array<{ id: number; label: string; priceCents: number }>;
}

export interface RepairMeta {
  models: Array<{ id: number; brand: string; name: string; kind: string }>;
  services: CatalogService[];
  technicians: Array<{ id: number; name: string }>;
}

interface DraftDevice {
  modelId: number | null;
  label: string;
  imei: string;
  powersOn: boolean;
  unlockMethod: 'passcode' | 'password' | 'pattern' | 'none';
  unlockValue: string;
  conditionNotes: string;
}

interface DraftLine {
  deviceIndex: number;
  serviceId: number | null;
  tierLabel: string | null;
  description: string;
  priceCents: number;
  warrantyDays: number;
  tiers: Array<{ label: string; priceCents: number }>;
}

export interface CreatedTicket {
  id: number;
  number: string;
  totalCents: number;
  lines: Array<{ description: string; priceCents: number }>;
}

const TAX_RATE_BP = 600;

const emptyDevice = (): DraftDevice => ({
  modelId: null,
  label: '',
  imei: '',
  powersOn: true,
  unlockMethod: 'passcode',
  unlockValue: '',
  conditionNotes: '',
});

/** The design's "New repair — 3-column window over Register". */
export function NewRepairWindow({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticket: CreatedTicket, exit: 'board' | 'deposit' | 'sale') => void;
}) {
  const [meta, setMeta] = useState<RepairMeta | null>(null);
  const [devices, setDevices] = useState<DraftDevice[]>([emptyDevice()]);
  const [activeDevice, setActiveDevice] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [matches, setMatches] = useState<CartCustomer[]>([]);
  const [callFlag, setCallFlag] = useState(false);
  const [technicianId, setTechnicianId] = useState<number | ''>('');
  const [notesForTech, setNotesForTech] = useState('');
  const [typeQuery, setTypeQuery] = useState('');
  const [openCategory, setOpenCategory] = useState<string | null>('Screens');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && !meta) void api<RepairMeta>('/api/repairs/meta').then(setMeta).catch(() => {});
  }, [open, meta]);

  // live match on typed name/phone
  useEffect(() => {
    if (customer || (custName.length < 2 && custPhone.length < 4)) {
      setMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      const q = custPhone.length >= 4 ? custPhone : custName;
      const res = await api<{ customers: CartCustomer[] }>(`/api/sales/search/all?q=${encodeURIComponent(q)}`).catch(
        () => ({ customers: [] }),
      );
      setMatches(res.customers.slice(0, 3));
    }, 250);
    return () => clearTimeout(t);
  }, [custName, custPhone, customer]);

  const device = devices[activeDevice] ?? devices[0]!;

  const categories = useMemo(() => {
    if (!meta) return [];
    const q = typeQuery.trim().toLowerCase();
    const filtered = q
      ? meta.services.filter((s) => `${s.name} ${s.deviceGroup} ${s.category}`.toLowerCase().includes(q))
      : meta.services;
    const byCat = new Map<string, typeof filtered>();
    for (const t of filtered) {
      if (!byCat.has(t.category)) byCat.set(t.category, []);
      byCat.get(t.category)!.push(t);
    }
    return [...byCat.entries()];
  }, [meta, typeQuery]);

  const totals = computeTotals(
    lines.map((l) => ({ qty: 1, unitCents: l.priceCents, taxable: true })),
    TAX_RATE_BP,
  );

  function toggleLine(service: CatalogService) {
    const existing = lines.find((l) => l.deviceIndex === activeDevice && l.serviceId === service.id);
    if (existing) {
      setLines((prev) => prev.filter((l) => l !== existing));
      return;
    }
    // auto-pick the tier matching the active device's model: exact name first,
    // then the longest partial match so "iPhone 13" never grabs "iPhone 13 mini"
    const deviceName = device.label.toLowerCase().trim();
    let matched: (typeof service.tiers)[number] | undefined;
    if (deviceName.length > 2) {
      matched = service.tiers.find((t) => t.label.toLowerCase().trim() === deviceName);
      if (!matched) {
        const partials = service.tiers.filter((t) => {
          const label = t.label.toLowerCase().trim();
          return deviceName.includes(label) || label.includes(deviceName);
        });
        matched = partials.sort((a, b) => Math.abs(a.label.length - deviceName.length) - Math.abs(b.label.length - deviceName.length))[0];
      }
    }
    const chosen = matched ?? service.tiers[0];
    setLines((prev) => [
      ...prev,
      {
        deviceIndex: activeDevice,
        serviceId: service.id,
        tierLabel: chosen?.label ?? null,
        description: service.name,
        priceCents: chosen?.priceCents ?? service.basePriceCents,
        warrantyDays: service.warrantyDays,
        tiers: service.tiers.map((t) => ({ label: t.label, priceCents: t.priceCents })),
      },
    ]);
  }

  function reset() {
    setDevices([emptyDevice()]);
    setActiveDevice(0);
    setLines([]);
    setCustomer(null);
    setCustName('');
    setCustPhone('');
    setCallFlag(false);
    setTechnicianId('');
    setNotesForTech('');
    setError('');
  }

  async function submit(exit: 'board' | 'deposit' | 'sale') {
    setError('');
    if (!customer && custName.trim().length < 2) {
      setError('Enter or pick a customer first.');
      return;
    }
    if (lines.length === 0) {
      setError('Pick at least one repair type.');
      return;
    }
    if (devices.some((d) => !d.label.trim())) {
      setError('Every device needs a model.');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ ticket: { id: number; number: string; totalCents: number } }>('/api/repairs', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer?.id ?? null,
          newCustomer: customer ? null : { name: custName.trim(), phone: custPhone.trim() || null },
          callFlag,
          technicianId: technicianId === '' ? null : technicianId,
          notesForTech: notesForTech || null,
          devices: devices.map((d) => ({
            modelId: d.modelId,
            label: d.label,
            imei: d.imei || null,
            powersOn: d.powersOn,
            unlockMethod: d.unlockMethod,
            unlockValue: d.unlockValue || null,
            conditionNotes: d.conditionNotes || null,
          })),
          lines: lines.map((l) => ({
            deviceIndex: l.deviceIndex,
            serviceId: l.serviceId,
            tierLabel: l.tierLabel,
            description: l.tierLabel ? `${l.description} (${l.tierLabel})` : l.description,
            priceCents: l.priceCents,
            warrantyDays: l.warrantyDays,
          })),
        }),
      });
      onCreated(
        {
          id: res.ticket.id,
          number: res.ticket.number,
          totalCents: res.ticket.totalCents,
          lines: lines.map((l) => ({ description: l.description, priceCents: l.priceCents })),
        },
        exit,
      );
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save ticket');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const col = { flex: 1, minWidth: 0, padding: '16px 18px', overflow: 'auto' as const };
  const label = { font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em', marginBottom: 6 };
  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--line)',
    fontSize: 15,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.6)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 'min(1240px, calc(100vw - 32px))', height: 'min(780px, calc(100vh - 32px))', background: 'var(--card)', borderRadius: 18, boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderBottom: '1px solid var(--line-soft)' }}>
          <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>New repair</h2>
          <div style={{ display: 'flex', gap: 6, flex: 1, overflow: 'auto' }}>
            {devices.map((d, i) => (
              <button
                key={i}
                onClick={() => setActiveDevice(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: 'none',
                  background: activeDevice === i ? 'var(--navy)' : 'var(--line-soft)',
                  color: activeDevice === i ? '#fff' : 'var(--ink-2)',
                  font: '600 14px Inter, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                {d.label || `Device ${i + 1}`}
                {devices.length > 1 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setDevices((prev) => prev.filter((_, x) => x !== i));
                      setLines((prev) =>
                        prev
                          .filter((l) => l.deviceIndex !== i)
                          .map((l) => (l.deviceIndex > i ? { ...l, deviceIndex: l.deviceIndex - 1 } : l)),
                      );
                      setActiveDevice(0);
                    }}
                    style={{ opacity: 0.7 }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <button
              onClick={() => {
                setDevices((prev) => [...prev, emptyDevice()]);
                setActiveDevice(devices.length);
              }}
              style={{ padding: '6px 12px', borderRadius: 999, border: 'none', background: 'var(--orange-soft)', color: 'var(--orange)', font: '600 14px Inter, sans-serif', whiteSpace: 'nowrap' }}
            >
              + Add device
            </button>
          </div>
          <Button variant="ghost" onClick={reset}>Clear</Button>
          <button onClick={() => { reset(); onClose(); }} style={{ border: 'none', background: 'var(--line-soft)', borderRadius: 999, width: 30, height: 30 }}>
            <i className="bi bi-x-lg" style={{ fontSize: 14 }} />
          </button>
        </div>

        {/* Columns */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 1 — customer + condition */}
          <div style={{ ...col, maxWidth: 320, borderRight: '1px solid var(--line-soft)' }}>
            <div style={label}>1 · CUSTOMER</div>
            {customer ? (
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ font: '600 15px Inter, sans-serif' }}>{customer.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{customer.phone}</div>
                </div>
                <button onClick={() => setCustomer(null)} style={{ border: 'none', background: 'none', color: 'var(--red)', fontSize: 12.5 }}>
                  change
                </button>
              </div>
            ) : (
              <>
                <input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="First and last name *" style={inputStyle} />
                <input value={custPhone} onChange={(e) => setCustPhone(e.target.value)} placeholder="Phone number" style={{ ...inputStyle, marginTop: 8 }} />
                {matches.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setCustomer(m)}
                    style={{ width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 10, border: '1px dashed var(--orange)', background: 'var(--orange-soft)', textAlign: 'left', fontSize: 14 }}
                  >
                    <b>{m.name}</b> · {m.phone} — <span style={{ color: 'var(--orange)' }}>Use</span>
                  </button>
                ))}
              </>
            )}
            <button
              onClick={() => setCallFlag((v) => !v)}
              style={{
                width: '100%',
                marginTop: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 10,
                border: `1px solid ${callFlag ? 'var(--purple)' : 'var(--line)'}`,
                background: callFlag ? 'var(--purple)' : 'var(--card)',
                color: callFlag ? '#fff' : 'var(--ink-2)',
                font: '600 14px Inter, sans-serif',
              }}
            >
              <i className={`bi ${callFlag ? 'bi-telephone-fill' : 'bi-telephone'}`} />
              {callFlag ? 'Call priority on' : 'Flag as call priority'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 4 }}>
              {callFlag ? 'Ticket will show a Call flag on the Repairs board' : 'Customer wants a call as soon as it’s done'}
            </div>

            <div style={{ ...label, marginTop: 18 }}>2 · CONDITION</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { v: true, label: 'Powers on', icon: 'bi-power' },
                { v: false, label: 'Dead on arrival', icon: 'bi-x-octagon' },
              ].map((o) => (
                <button
                  key={String(o.v)}
                  onClick={() => setDevices((prev) => prev.map((d, i) => (i === activeDevice ? { ...d, powersOn: o.v } : d)))}
                  style={{
                    flex: 1,
                    padding: '9px 0',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: device.powersOn === o.v ? 'var(--navy)' : 'var(--card)',
                    color: device.powersOn === o.v ? '#fff' : 'var(--ink-2)',
                    font: '600 14px Inter, sans-serif',
                  }}
                >
                  <i className={`bi ${o.icon}`} /> {o.label}
                </button>
              ))}
            </div>
            <textarea
              value={device.conditionNotes}
              onChange={(e) => setDevices((prev) => prev.map((d, i) => (i === activeDevice ? { ...d, conditionNotes: e.target.value } : d)))}
              rows={2}
              placeholder="Anything else — cracked back glass, missing SIM tray, prior repair…"
              style={{ ...inputStyle, marginTop: 8, resize: 'none' }}
            />

            <div style={{ ...label, marginTop: 14 }}>DEVICE UNLOCK</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['passcode', 'password', 'pattern', 'none'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setDevices((prev) => prev.map((d, i) => (i === activeDevice ? { ...d, unlockMethod: m } : d)))}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    background: device.unlockMethod === m ? 'var(--navy)' : 'var(--card)',
                    color: device.unlockMethod === m ? '#fff' : 'var(--ink-2)',
                    font: '600 12.5px Inter, sans-serif',
                    textTransform: 'capitalize',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            {device.unlockMethod !== 'none' && (
              <input
                value={device.unlockValue}
                onChange={(e) => setDevices((prev) => prev.map((d, i) => (i === activeDevice ? { ...d, unlockValue: e.target.value } : d)))}
                placeholder="Enter 4 or 6-digit passcode"
                style={{ ...inputStyle, marginTop: 8 }}
              />
            )}

            <div style={{ ...label, marginTop: 14 }}>NOTES FOR TECH</div>
            <textarea
              value={notesForTech}
              onChange={(e) => setNotesForTech(e.target.value)}
              rows={2}
              placeholder="Customer reports touch dead in top-right corner after drop."
              style={{ ...inputStyle, resize: 'none' }}
            />
            <div style={{ ...label, marginTop: 14 }}>TECHNICIAN</div>
            <select
              value={technicianId}
              onChange={(e) => setTechnicianId(e.target.value === '' ? '' : Number(e.target.value))}
              style={{ ...inputStyle, background: 'var(--card)' }}
            >
              <option value="">Unassigned</option>
              {meta?.technicians.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          {/* 2 — device model + repair types */}
          <div style={{ ...col, borderRight: '1px solid var(--line-soft)' }}>
            <div style={label}>3 · DEVICE & REPAIR TYPE</div>
            <select
              value={device.modelId ?? ''}
              onChange={(e) => {
                const id = e.target.value === '' ? null : Number(e.target.value);
                const m = meta?.models.find((x) => x.id === id);
                setDevices((prev) =>
                  prev.map((d, i) => (i === activeDevice ? { ...d, modelId: id, label: m ? m.name : d.label } : d)),
                );
              }}
              style={{ ...inputStyle, background: 'var(--card)' }}
            >
              <option value="">Pick device model…</option>
              {meta?.models.map((m) => (
                <option key={m.id} value={m.id}>{m.brand} {m.name}</option>
              ))}
            </select>
            <input
              value={device.imei}
              onChange={(e) => setDevices((prev) => prev.map((d, i) => (i === activeDevice ? { ...d, imei: e.target.value } : d)))}
              placeholder="IMEI / serial (optional)"
              style={{ ...inputStyle, marginTop: 8 }}
            />
            <div style={{ position: 'relative', marginTop: 10 }}>
              <i className="bi bi-search" style={{ position: 'absolute', left: 12, top: 11, color: 'var(--ink-4)', fontSize: 15 }} />
              <input
                value={typeQuery}
                onChange={(e) => setTypeQuery(e.target.value)}
                placeholder={`Search ${meta?.services.length ?? ''} services`}
                style={{ ...inputStyle, paddingLeft: 34 }}
              />
            </div>
            <div style={{ marginTop: 10 }}>
              {categories.map(([cat, catServices]) => {
                const expanded = typeQuery.trim() !== '' || openCategory === cat;
                return (
                  <div key={cat} style={{ marginBottom: 4 }}>
                    <button
                      onClick={() => setOpenCategory((prev) => (prev === cat ? null : cat))}
                      style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, border: 'none', background: expanded ? 'var(--line-soft)' : 'transparent', font: '600 14.5px Inter, sans-serif', color: 'var(--ink)' }}
                    >
                      {cat}
                      <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}>{catServices.length}</span>
                    </button>
                    {expanded &&
                      catServices.map((s) => {
                        const selected = lines.some((l) => l.deviceIndex === activeDevice && l.serviceId === s.id);
                        return (
                          <button
                            key={s.id}
                            onClick={() => toggleLine(s)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                              padding: '9px 10px 9px 22px',
                              borderRadius: 8,
                              border: 'none',
                              background: selected ? 'var(--orange-soft)' : 'transparent',
                              fontSize: 14.5,
                              color: 'var(--ink-2)',
                              textAlign: 'left',
                            }}
                          >
                            <span style={{ minWidth: 0 }}>
                              <i className={`bi ${selected ? 'bi-check-circle-fill' : 'bi-circle'}`} style={{ color: selected ? 'var(--orange)' : 'var(--line)', marginRight: 8 }} />
                              {s.name}
                              <span style={{ display: 'block', marginLeft: 24, fontSize: 12, color: 'var(--ink-4)' }}>{s.deviceGroup}</span>
                            </span>
                            <span style={{ font: '600 13px Inter, sans-serif', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                              {s.tiers.length > 0 ? `from ${formatCents(Math.min(...s.tiers.map((t) => t.priceCents)))}` : formatCents(s.basePriceCents)}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3 — summary */}
          <div style={{ ...col, maxWidth: 330, display: 'flex', flexDirection: 'column' }}>
            <div style={label}>4 · TICKET SUMMARY</div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {devices.map((d, di) => {
                const deviceLines = lines.filter((l) => l.deviceIndex === di);
                if (deviceLines.length === 0) return null;
                return (
                  <div key={di} style={{ marginBottom: 14 }}>
                    <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.06em' }}>
                      DEVICE {di + 1} · {(d.label || 'Device').toUpperCase()}
                    </div>
                    {deviceLines.map((l, li) => (
                      <div key={li} style={{ marginTop: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ font: '600 15px Inter, sans-serif' }}>{l.description}</div>
                            <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
                              {l.serviceId ? `${l.warrantyDays}-day warranty` : 'Custom price'}
                            </div>
                          </div>
                          <input
                            value={(l.priceCents / 100).toFixed(2)}
                            onChange={(e) => {
                              const v = Math.round(parseFloat(e.target.value || '0') * 100);
                              setLines((prev) => prev.map((x) => (x === l ? { ...x, priceCents: Number.isFinite(v) ? Math.max(0, v) : 0, tierLabel: null } : x)));
                            }}
                            style={{ width: 78, textAlign: 'right', padding: '5px 8px', borderRadius: 8, border: '1px solid var(--line)', font: '700 15px Inter, sans-serif' }}
                          />
                        </div>
                        {l.tiers.length > 0 && (
                          <select
                            value={l.tierLabel ?? ''}
                            onChange={(e) => {
                              const tier = l.tiers.find((t) => t.label === e.target.value);
                              setLines((prev) =>
                                prev.map((x) =>
                                  x === l
                                    ? { ...x, tierLabel: tier?.label ?? null, priceCents: tier?.priceCents ?? x.priceCents }
                                    : x,
                                ),
                              );
                            }}
                            style={{ width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 13.5, background: 'var(--card)' }}
                          >
                            {l.tierLabel === null && <option value="">Custom price</option>}
                            {l.tiers.map((t) => (
                              <option key={t.label} value={t.label}>
                                {t.label} — {formatCents(t.priceCents)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
              {lines.length === 0 && (
                <div style={{ color: 'var(--ink-4)', fontSize: 14, marginTop: 20, textAlign: 'center' }}>
                  Pick repair types to build the ticket.
                </div>
              )}
            </div>
            <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--ink-3)' }}>
                <span>Parts + labor</span>
                <span>{formatCents(totals.subtotalCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--ink-3)', marginTop: 3 }}>
                <span>Tax 6%</span>
                <span>{formatCents(totals.taxCents)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ font: '700 16px Inter, sans-serif' }}>Ticket total</span>
                <span style={{ font: '800 23px Inter, sans-serif' }}>{formatCents(totals.totalCents)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer — payment exits */}
        <div style={{ borderTop: '1px solid var(--line-soft)', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-3)' }}>
            <b style={{ color: 'var(--ink)' }}>How is the customer paying?</b>
            <br />
            Paying now adds the devices to the current sale. Paying at pickup sends it to the Repairs board as unpaid.
            {error && <div style={{ color: 'var(--red)', marginTop: 3 }}>{error}</div>}
          </div>
          <Button variant="secondary" disabled={busy} onClick={() => void submit('board')}>
            <i className="bi bi-kanban" /> Send to Repairs board
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void submit('deposit')}>
            <i className="bi bi-cash-coin" /> Take deposit
          </Button>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void submit('sale')}>
            <i className="bi bi-bag-plus" /> Add to current sale · {formatCents(totals.totalCents)}
          </Button>
        </div>
      </div>
    </div>
  );
}
