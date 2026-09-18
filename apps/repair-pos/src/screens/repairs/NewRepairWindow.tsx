import { useEffect, useMemo, useRef, useState } from 'react';
import { computeTotals, formatCents } from '@fmp/shared';
import { Keypad } from '@fmp/ui';
import { api, CodeField, formatPhoneInput, MoneyKeypadSheet, SecretField, session } from '@fmp/pos-client';
import type { CartCustomer } from '@fmp/pos-client';
import { printTicketLabel } from './labels';

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
  models: Array<{ id: number; brand: string; family: string | null; name: string; kind: string; releaseYear: number | null }>;
  services: CatalogService[];
  technicians: Array<{ id: number; name: string }>;
  nextNumber: string;
}

interface DraftDevice {
  modelId: number | null;
  label: string;
  imei: string;
  /** null until staff explicitly taps a condition */
  powersOn: boolean | null;
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
  customer: CartCustomer;
  deviceSummary: string;
  serviceSummary: string;
  lines: Array<{ description: string; priceCents: number }>;
}

const TAX_RATE_BP = 600;
const DRAFT_KEY = 'fmp.repairDraft';

/** An existing ticket loaded into the window for editing (from the board's detail panel). */
export interface EditTicketSeed {
  id: number;
  number: string;
  status: string;
  paidCents: number;
  callFlag: boolean;
  partsFlag: boolean;
  alertFlag: boolean;
  notesForTech: string | null;
  customer: CartCustomer | null;
  devices: Array<{
    id: number;
    modelId: number | null;
    label: string;
    imei: string | null;
    powersOn: boolean;
    unlockMethod: string | null;
    unlockValue: string | null;
    conditionNotes: string | null;
  }>;
  lines: Array<{
    ticketDeviceId: number | null;
    serviceId: number | null;
    tierLabel: string | null;
    description: string;
    priceCents: number;
    warrantyDays: number;
  }>;
}

/** Completed, picked-up, or paid tickets need a manager code before edits save. */
export const ticketIsLocked = (t: { status: string; paidCents: number }) =>
  t.status === 'completed' || t.status === 'picked_up' || t.paidCents > 0;

const emptyDevice = (): DraftDevice => ({
  modelId: null,
  label: '',
  imei: '',
  powersOn: null,
  unlockMethod: 'passcode',
  unlockValue: '',
  conditionNotes: '',
});

const inputBase =
  'rounded-[10px] border border-line bg-card px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-4 focus:border-orange focus:outline-none';
const inputCls = `w-full ${inputBase}`;
const labelCls = 'mb-1.5 block text-[13px] font-semibold text-ink-3';
const sectionCls = 'text-[11.5px] font-semibold tracking-[0.07em] text-ink-4';

/** The design's "New repair — 3-column window over Register". */
export function NewRepairWindow({
  open,
  onClose,
  onCreated,
  edit = null,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticket: CreatedTicket, exit: 'board' | 'deposit' | 'sale') => void;
  /** when set, the window edits this ticket instead of creating one */
  edit?: EditTicketSeed | null;
  onSaved?: () => void;
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
  const [partsFlag, setPartsFlag] = useState(false);
  const [alertFlag, setAlertFlag] = useState(false);
  const [notesForTech, setNotesForTech] = useState('');
  const [typeQuery, setTypeQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [deviceQuery, setDeviceQuery] = useState('');
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [activeFamily, setActiveFamily] = useState<string | null>(null);
  const [showPasscode, setShowPasscode] = useState(false);
  const [printLabel, setPrintLabel] = useState(true);
  const [draftSaved, setDraftSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const restoredRef = useRef(false);
  const seededRef = useRef<number | null>(null);
  const [codePrompt, setCodePrompt] = useState(false);
  /** the repair line whose price is being punched in on the numpad */
  const [pricingLine, setPricingLine] = useState<DraftLine | null>(null);
  const [codeError, setCodeError] = useState('');
  const locked = edit != null && ticketIsLocked(edit);

  useEffect(() => {
    if (open && !meta) void api<RepairMeta>('/api/repairs/meta').then(setMeta).catch(() => {});
  }, [open, meta]);

  // restore + autosave draft
  useEffect(() => {
    if (!open || edit || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.devices?.length) setDevices(d.devices);
      if (d.lines?.length) setLines(d.lines);
      if (d.customer) setCustomer(d.customer);
      if (d.custName) setCustName(d.custName);
      if (d.custPhone) setCustPhone(d.custPhone);
      if (d.callFlag) setCallFlag(d.callFlag);
      if (d.partsFlag) setPartsFlag(d.partsFlag);
      if (d.alertFlag) setAlertFlag(d.alertFlag);
      if (d.notesForTech) setNotesForTech(d.notesForTech);
    } catch {
      /* corrupt draft — start fresh */
    }
  }, [open]);

  useEffect(() => {
    if (!open || edit) return;
    const t = setTimeout(() => {
      const isEmpty = lines.length === 0 && !custName && !custPhone && !customer && devices.every((d) => !d.label && !d.imei);
      if (isEmpty) {
        sessionStorage.removeItem(DRAFT_KEY);
        setDraftSaved(false);
        return;
      }
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ devices, lines, customer, custName, custPhone, callFlag, partsFlag, alertFlag, notesForTech }));
      setDraftSaved(true);
    }, 700);
    return () => clearTimeout(t);
  }, [open, devices, lines, customer, custName, custPhone, callFlag, partsFlag, alertFlag, notesForTech]);

  // live match on typed name/phone
  useEffect(() => {
    if (customer || (custName.length < 2 && custPhone.length < 4)) {
      setMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      const q = custPhone.length >= 4 ? custPhone : custName;
      const res = await api<{ customers: Array<CartCustomer & { visits?: number }> }>(
        `/api/sales/search/all?q=${encodeURIComponent(q)}`,
      ).catch(() => ({ customers: [] }));
      setMatches(res.customers.slice(0, 2));
    }, 250);
    return () => clearTimeout(t);
  }, [custName, custPhone, customer]);

  const device = devices[activeDevice] ?? devices[0]!;
  const user = session.user;
  const deviceChosen = device.label.trim().length > 0;

  // ---- tap-first device picker data ----
  const brands = useMemo(() => {
    if (!meta) return [];
    const seen = new Map<string, number>();
    for (const m of meta.models) seen.set(m.brand, (seen.get(m.brand) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([brand]) => brand);
  }, [meta]);

  const families = useMemo(() => {
    if (!meta || !activeBrand) return [];
    const seen = new Map<string, number>();
    for (const m of meta.models) {
      if (m.brand !== activeBrand) continue;
      const fam = m.family ?? 'Other';
      seen.set(fam, (seen.get(fam) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([fam]) => fam);
  }, [meta, activeBrand]);

  const pickableModels = useMemo(() => {
    if (!meta) return [];
    let list = meta.models;
    const q = deviceQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => `${m.brand} ${m.family ?? ''} ${m.name}`.toLowerCase().includes(q));
    } else {
      if (activeBrand) list = list.filter((m) => m.brand === activeBrand);
      if (activeFamily) list = list.filter((m) => (m.family ?? 'Other') === activeFamily);
      else if (!activeBrand) list = [];
    }
    return [...list].sort((a, b) => (b.releaseYear ?? 0) - (a.releaseYear ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [meta, deviceQuery, activeBrand, activeFamily]);

  function chooseModel(m: RepairMeta['models'][number]) {
    patchDeviceAt(activeDevice, { modelId: m.id, label: m.name });
    setDeviceQuery('');
  }

  function patchDeviceAt(index: number, patch: Partial<DraftDevice>) {
    setDevices((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  // the shop's frequent jobs, pinned as the default group
  const commonServices = useMemo(() => {
    if (!meta) return [];
    const patterns = [/screen replacement/i, /charge port|charging port/i, /diagnostic/i, /battery replacement/i];
    const list: CatalogService[] = [];
    for (const p of patterns) {
      for (const s of meta.services) if (p.test(s.name) && !list.includes(s)) list.push(s);
    }
    return list.slice(0, 8);
  }, [meta]);

  const categories = useMemo(() => {
    if (!meta) return [] as Array<[string, CatalogService[]]>;
    const byCat = new Map<string, CatalogService[]>();
    for (const s of meta.services) {
      if (!byCat.has(s.category)) byCat.set(s.category, []);
      byCat.get(s.category)!.push(s);
    }
    const out: Array<[string, CatalogService[]]> = [...byCat.entries()];
    if (commonServices.length > 0) out.unshift(['Common repairs', commonServices]);
    return out;
  }, [meta, commonServices]);

  const searching = typeQuery.trim().length > 0;
  const shownCategory = activeCategory ?? categories[0]?.[0] ?? null;
  const shownServices = useMemo(() => {
    if (!meta) return [];
    if (searching) {
      const q = typeQuery.trim().toLowerCase();
      return meta.services.filter((s) => `${s.name} ${s.deviceGroup} ${s.category}`.toLowerCase().includes(q));
    }
    return categories.find(([cat]) => cat === shownCategory)?.[1] ?? [];
  }, [meta, searching, typeQuery, shownCategory, categories]);

  /** Warranty rework: a $0 line linked at intake by description. */
  function addWarrantyLine() {
    if (lines.some((l) => l.deviceIndex === activeDevice && l.serviceId === null && l.description.startsWith('Warranty rework'))) return;
    setLines((prev) => [
      ...prev,
      {
        deviceIndex: activeDevice,
        serviceId: null,
        tierLabel: null,
        description: 'Warranty rework',
        priceCents: 0,
        warrantyDays: 90,
        tiers: [],
      },
    ]);
  }

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
    // then the closest partial match so "iPhone 13" never grabs "iPhone 13 mini"
    const deviceName = device.label.toLowerCase().trim();
    let matched: (typeof service.tiers)[number] | undefined;
    if (deviceName.length > 2) {
      matched = service.tiers.find((t) => t.label.toLowerCase().trim() === deviceName);
      if (!matched) {
        const partials = service.tiers.filter((t) => {
          const label = t.label.toLowerCase().trim();
          return deviceName.includes(label) || label.includes(deviceName);
        });
        matched = partials.sort(
          (a, b) => Math.abs(a.label.length - deviceName.length) - Math.abs(b.label.length - deviceName.length),
        )[0];
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

  /** Load an existing ticket's devices, lines and customer into the draft state. */
  function seedFromTicket(t: EditTicketSeed, m: RepairMeta) {
    setDevices(
      t.devices.length > 0
        ? t.devices.map((d) => ({
            modelId: d.modelId,
            label: d.label,
            imei: d.imei ?? '',
            powersOn: d.powersOn,
            unlockMethod: (d.unlockMethod as DraftDevice['unlockMethod'] | null) ?? 'none',
            unlockValue: d.unlockValue ?? '',
            conditionNotes: d.conditionNotes ?? '',
          }))
        : [emptyDevice()],
    );
    setActiveDevice(0);
    setLines(
      t.lines.map((l) => {
        const service = m.services.find((sv) => sv.id === l.serviceId);
        const suffix = l.tierLabel ? ` (${l.tierLabel})` : '';
        const deviceIndex = t.devices.findIndex((d) => d.id === l.ticketDeviceId);
        return {
          deviceIndex: deviceIndex < 0 ? 0 : deviceIndex,
          serviceId: l.serviceId,
          tierLabel: l.tierLabel,
          description: suffix && l.description.endsWith(suffix) ? l.description.slice(0, -suffix.length) : l.description,
          priceCents: l.priceCents,
          warrantyDays: l.warrantyDays,
          tiers: service?.tiers.map((x) => ({ label: x.label, priceCents: x.priceCents })) ?? [],
        };
      }),
    );
    setCustomer(t.customer);
    setCustName('');
    setCustPhone('');
    setCallFlag(t.callFlag);
    setPartsFlag(t.partsFlag);
    setAlertFlag(t.alertFlag);
    setNotesForTech(t.notesForTech ?? '');
    setError('');
    setPrintLabel(false);
    setCodePrompt(false);
    setCodeError('');
  }

  useEffect(() => {
    if (!open) {
      seededRef.current = null;
      return;
    }
    if (!edit || !meta || seededRef.current === edit.id) return;
    seededRef.current = edit.id;
    seedFromTicket(edit, meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edit?.id, meta]);

  function reset() {
    if (edit && meta) {
      seedFromTicket(edit, meta);
      return;
    }
    setDevices([emptyDevice()]);
    setActiveDevice(0);
    setLines([]);
    setCustomer(null);
    setCustName('');
    setCustPhone('');
    setCallFlag(false);
    setPartsFlag(false);
    setAlertFlag(false);
    setNotesForTech('');
    setError('');
    setDraftSaved(false);
    sessionStorage.removeItem(DRAFT_KEY);
  }

  function validateDraft(): boolean {
    if (!customer && custName.trim().length < 2) {
      setError('Enter or pick a customer first.');
      return false;
    }
    if (lines.length === 0) {
      setError('Pick at least one repair.');
      return false;
    }
    if (devices.some((d) => !d.label.trim())) {
      setError('Every device needs a model.');
      return false;
    }
    if (devices.some((d) => d.powersOn === null)) {
      setError('Tap Powers on or Dead on arrival for every device.');
      return false;
    }
    return true;
  }

  function ticketPayload() {
    return {
      customerId: customer?.id ?? null,
      newCustomer: customer ? null : { name: custName.trim(), phone: custPhone.trim() || null },
      callFlag,
      partsFlag,
      alertFlag,
      notesForTech: notesForTech || null,
      devices: devices.map((d) => ({
        modelId: d.modelId,
        label: d.label,
        imei: d.imei || null,
        powersOn: d.powersOn === null ? true : d.powersOn,
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
    };
  }

  /** Edit mode: save the whole ticket; locked tickets first collect a manager code. */
  async function saveEdit(managerPin?: string) {
    if (!edit) return;
    setError('');
    if (!validateDraft()) return;
    if (locked && !managerPin) {
      setCodeError('');
      setCodePrompt(true);
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ ticket: { totalCents: number } }>(`/api/repairs/${edit.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...ticketPayload(), managerPin: managerPin ?? null }),
      });
      setCodePrompt(false);
      if (printLabel) {
        printTicketLabel({
          number: edit.number,
          customer: customer?.name ?? custName.trim(),
          phone: customer?.phone ?? (custPhone.trim() || null),
          device: devices.map((d) => d.label).join(' + '),
          issue: lines.map((l) => (l.tierLabel ? `${l.description} (${l.tierLabel})` : l.description)).join(', '),
          passcode: devices[0]?.unlockValue || null,
          notes: devices[0]?.conditionNotes || null,
          priceText: formatCents(Math.max(0, res.ticket.totalCents - edit.paidCents)),
          paid: res.ticket.totalCents - edit.paidCents <= 0,
        });
      }
      seededRef.current = null;
      onSaved?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save ticket';
      if (managerPin) setCodeError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(exit: 'board' | 'deposit' | 'sale') {
    setError('');
    if (!validateDraft()) return;
    setBusy(true);
    try {
      const res = await api<{ ticket: { id: number; number: string; totalCents: number; customerId: number } }>('/api/repairs', {
        method: 'POST',
        body: JSON.stringify(ticketPayload()),
      });
      const cust: CartCustomer =
        customer ?? { id: res.ticket.customerId, name: custName.trim(), phone: custPhone.trim() || null };
      const deviceSummary = devices.map((d) => d.label).join(' + ');
      const serviceSummary = lines
        .map((l) => (l.tierLabel ? `${l.description} (${l.tierLabel})` : l.description))
        .join(', ');
      if (printLabel) {
        printTicketLabel({
          number: res.ticket.number,
          customer: cust.name,
          phone: cust.phone,
          device: deviceSummary,
          issue: serviceSummary,
          passcode: devices[0]?.unlockValue || null,
          notes: devices[0]?.conditionNotes || null,
          priceText: formatCents(res.ticket.totalCents),
          paid: false,
        });
      }
      onCreated(
        {
          id: res.ticket.id,
          number: res.ticket.number,
          totalCents: res.ticket.totalCents,
          customer: cust,
          deviceSummary,
          serviceSummary,
          lines: lines.map((l) => ({
            description: l.tierLabel ? `${l.description} (${l.tierLabel})` : l.description,
            priceCents: l.priceCents,
          })),
        },
        exit,
      );
      reset();
      restoredRef.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save ticket');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const patchDevice = (patch: Partial<DraftDevice>) =>
    setDevices((prev) => prev.map((d, i) => (i === activeDevice ? { ...d, ...patch } : d)));

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-navy/60 p-3">
      <div className="flex h-full w-full max-w-[1680px] flex-col overflow-hidden rounded-2xl bg-card shadow-2xl">
        {/* Header */}
        <div className="border-b border-line-soft px-6 pt-5 pb-4">
          <div className="flex items-center gap-4">
            <h2 className="text-[22px] font-bold text-ink">{edit ? 'Edit ticket' : 'New repair'}</h2>
            <div className="hidden border-l border-line pl-4 text-[14px] text-ink-3 sm:block">
              {edit ? `#${edit.number}` : `Ticket will be #${meta?.nextNumber ?? '…'}`} · {user?.name}
            </div>
            <div className="ml-auto flex items-center gap-2.5">
              {draftSaved && (
                <span className="flex items-center gap-1.5 rounded-full bg-line-soft px-3.5 py-2 text-[13px] font-semibold text-ink-3">
                  <i className="bi bi-clock" /> Draft saved
                </span>
              )}
              <button
                onClick={() => {
                  reset();
                }}
                className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3.5 py-2 text-[13px] font-semibold text-ink-2"
              >
                <i className="bi bi-arrow-counterclockwise" /> {edit ? 'Reset' : 'Clear'}
              </button>
              <button
                onClick={() => {
                  onClose();
                }}
                className="flex size-9 items-center justify-center rounded-full bg-line-soft text-ink-2"
                aria-label="Close"
              >
                <i className="bi bi-x-lg text-[13px]" />
              </button>
            </div>
          </div>
          {/* Device tabs */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {devices.map((d, i) => (
              <button
                key={i}
                onClick={() => setActiveDevice(i)}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13.5px] font-semibold ${
                  activeDevice === i ? 'bg-navy text-white' : 'bg-line-soft text-ink-2'
                }`}
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
                    className="opacity-60"
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
              className="rounded-lg bg-orange-soft px-3.5 py-2 text-[13.5px] font-semibold text-orange"
            >
              + Add device
            </button>
          </div>
        </div>

        {/* Body — stacks vertically on tablet portrait */}
        <div className="flex min-h-0 flex-1 max-[1080px]:flex-col max-[1080px]:overflow-y-auto">
          {/* 1 · Customer + condition */}
          <div className="w-[360px] shrink-0 overflow-y-auto border-r border-line-soft p-5 max-xl:w-[300px] max-xl:p-4 max-[1080px]:w-full max-[1080px]:overflow-visible max-[1080px]:border-r-0 max-[1080px]:border-b">
            <div className={sectionCls}>1 · CUSTOMER</div>
            {customer ? (
              <div className="mt-3 flex items-center justify-between rounded-[10px] border border-line px-3.5 py-3">
                <div>
                  <div className="text-[15px] font-semibold text-ink">{customer.name}</div>
                  <div className="text-[13px] text-ink-3">{customer.phone}</div>
                </div>
                <button onClick={() => setCustomer(null)} className="text-[13px] font-semibold text-red">
                  change
                </button>
              </div>
            ) : (
              <>
                <label className="mt-3 block">
                  <span className={labelCls}>Name *</span>
                  <input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="First and last name" className={inputCls} />
                </label>
                <label className="mt-3 block">
                  <span className={labelCls}>Phone number *</span>
                  <div className="relative">
                    <input
                      value={custPhone}
                      onChange={(e) => setCustPhone(formatPhoneInput(e.target.value))}
                      inputMode="tel"
                      placeholder="(___) ___-____"
                      className={inputCls}
                    />
                    <i className="bi bi-search absolute top-1/2 right-3.5 -translate-y-1/2 text-[14px] text-ink-4" />
                  </div>
                </label>
                {matches.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setCustomer(m)}
                    className="mt-2 flex w-full items-center justify-between rounded-[10px] bg-line-soft px-3.5 py-2.5 text-left text-[13.5px]"
                  >
                    <span className="text-ink-2">
                      <i className="bi bi-person-check mr-1.5" />
                      {m.name}
                    </span>
                    <span className="font-bold text-orange">Use</span>
                  </button>
                ))}
              </>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setCallFlag((v) => !v)}
                aria-pressed={callFlag}
                className={`flex flex-1 items-center justify-center gap-2 rounded-[10px] border px-3 py-3 text-[13.5px] font-semibold ${
                  callFlag ? 'border-purple bg-purple text-white' : 'border-line bg-card text-ink-2'
                }`}
              >
                <i className={`bi ${callFlag ? 'bi-telephone-fill' : 'bi-telephone'}`} />
                {callFlag ? 'Call · on' : 'Call'}
              </button>
              <button
                onClick={() => setPartsFlag((v) => !v)}
                aria-pressed={partsFlag}
                className={`flex flex-1 items-center justify-center gap-2 rounded-[10px] border px-3 py-3 text-[13.5px] font-semibold ${
                  partsFlag ? 'border-amber bg-amber text-white' : 'border-line bg-card text-ink-2'
                }`}
              >
                <i className={`bi ${partsFlag ? 'bi-box-seam-fill' : 'bi-box-seam'}`} />
                {partsFlag ? 'Order parts · on' : 'Order parts'}
              </button>
              <button
                onClick={() => setAlertFlag((v) => !v)}
                aria-pressed={alertFlag}
                title="Alert: check the notes on this repair or customer first"
                className={`flex flex-1 items-center justify-center gap-2 rounded-[10px] border px-3 py-3 text-[13.5px] font-semibold ${
                  alertFlag ? 'border-red bg-red text-white' : 'border-line bg-card text-ink-2'
                }`}
              >
                <i className={`bi ${alertFlag ? 'bi-exclamation-triangle-fill' : 'bi-exclamation-triangle'}`} />
                {alertFlag ? 'Alert · on' : 'Alert'}
              </button>
            </div>

            <div className={`${sectionCls} mt-5`}>2 · CONDITION *</div>
            <div className="mt-3 flex overflow-hidden rounded-[10px] border border-line">
              {(
                [
                  { v: true, label: 'Powers on', icon: 'bi-power' },
                  { v: false, label: 'Dead on arrival', icon: 'bi-slash-circle' },
                ] as const
              ).map((o) => (
                <button
                  key={String(o.v)}
                  onClick={() => patchDevice({ powersOn: o.v })}
                  className={`flex flex-1 items-center justify-center gap-1.5 py-3 text-[13.5px] font-semibold ${
                    device.powersOn === o.v ? 'bg-navy text-white' : 'bg-card text-ink-3'
                  }`}
                >
                  <i className={`bi ${o.icon}`} /> {o.label}
                </button>
              ))}
            </div>
            {device.powersOn !== null && (
              <label className="mt-3 block">
                <span className={labelCls}>Anything else</span>
                <textarea
                  value={device.conditionNotes}
                  onChange={(e) => patchDevice({ conditionNotes: e.target.value })}
                  rows={2}
                  placeholder="Cracked back glass, missing SIM tray, prior repair…"
                  className={`${inputCls} resize-none`}
                />
              </label>
            )}

            <label className="mt-3 block">
              <span className={labelCls}>Device unlock</span>
              <div className="flex overflow-hidden rounded-[10px] border border-line">
                {(['passcode', 'password', 'pattern', 'none'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => patchDevice({ unlockMethod: m })}
                    className={`flex-1 py-2.5 text-[12.5px] font-semibold capitalize ${
                      device.unlockMethod === m ? 'bg-navy text-white' : 'bg-card text-ink-2'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </label>
            {device.unlockMethod !== 'none' && (
              <div className="relative mt-2.5">
                <input
                  type={showPasscode ? 'text' : 'password'}
                  value={device.unlockValue}
                  onChange={(e) => patchDevice({ unlockValue: e.target.value })}
                  placeholder="Enter 4 or 6-digit passcode"
                  className={inputCls}
                />
                <button
                  onClick={() => setShowPasscode((v) => !v)}
                  className="absolute top-1/2 right-3.5 -translate-y-1/2 text-ink-4"
                  aria-label="Show passcode"
                >
                  <i className={`bi ${showPasscode ? 'bi-eye-slash' : 'bi-eye'}`} />
                </button>
              </div>
            )}

          </div>

          {/* 2 · Device picker → repair types (tap-first flow) */}
          <div className="flex min-w-0 flex-1 flex-col border-r border-line-soft max-[1080px]:min-h-[540px] max-[1080px]:border-r-0 max-[1080px]:border-b">
            {!deviceChosen ? (
              <>
                <div className="flex items-center justify-between px-5 pt-5">
                  <div className={sectionCls}>3 · PICK THE DEVICE</div>
                  <div className="text-[13px] text-ink-4">Device {activeDevice + 1}</div>
                </div>
                <div className="relative px-5 pt-3">
                  <i className="bi bi-search absolute top-1/2 left-9 mt-1.5 -translate-y-1/2 text-[14px] text-ink-4" />
                  <input
                    value={deviceQuery}
                    onChange={(e) => setDeviceQuery(e.target.value)}
                    placeholder={`Type to search ${meta?.models.length ?? ''} devices — or tap below`}
                    className={`${inputCls} bg-line-soft pl-10`}
                  />
                </div>
                {!deviceQuery.trim() && (
                  <>
                    <div className="flex flex-wrap gap-2 px-5 pt-3">
                      {brands.map((b) => (
                        <button
                          key={b}
                          onClick={() => {
                            setActiveBrand((prev) => (prev === b ? null : b));
                            setActiveFamily(null);
                          }}
                          className={`rounded-full px-5 py-2.5 text-[14.5px] font-semibold ${
                            activeBrand === b ? 'bg-navy text-white' : 'border border-line bg-card text-ink-2'
                          }`}
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                    {activeBrand && families.length > 1 && (
                      <div className="flex flex-wrap gap-2 px-5 pt-2.5">
                        {families.map((f) => (
                          <button
                            key={f}
                            onClick={() => setActiveFamily((prev) => (prev === f ? null : f))}
                            className={`rounded-full px-4 py-2 text-[13.5px] font-semibold ${
                              activeFamily === f ? 'bg-orange-soft text-orange' : 'border border-line-soft bg-line-soft text-ink-3'
                            }`}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-5 pb-4">
                  {pickableModels.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2.5">
                      {pickableModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => chooseModel(m)}
                          className="rounded-xl border border-line bg-card px-3 py-3.5 text-left hover:border-orange"
                        >
                          <span className="block text-[14.5px] leading-tight font-semibold text-ink">{m.name}</span>
                          <span className="mt-0.5 block text-[12px] text-ink-4">
                            {deviceQuery.trim() ? m.brand : (m.releaseYear ?? m.brand)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : !deviceQuery.trim() && !activeBrand ? (
                    <div className="py-10 text-center text-[14.5px] text-ink-4">
                      Tap a brand above, or start typing the device name.
                    </div>
                  ) : (
                    <div className="py-8 text-center text-[14.5px] text-ink-4">No devices match.</div>
                  )}
                  {deviceQuery.trim().length > 1 && (
                    <button
                      onClick={() => {
                        patchDevice({ modelId: null, label: deviceQuery.trim() });
                        setDeviceQuery('');
                      }}
                      className="mt-3 w-full rounded-xl border-2 border-dashed border-line px-4 py-3.5 text-[14.5px] font-semibold text-ink-2 hover:border-orange hover:text-orange"
                    >
                      <i className="bi bi-plus-lg mr-1.5" /> Use “{deviceQuery.trim()}” — not in the list
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 px-5 pt-5">
                  <div className={sectionCls}>3 · REPAIR TYPE</div>
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-full bg-line-soft px-3.5 py-1.5 text-[13px] font-semibold text-ink-2">
                      <i className="bi bi-phone mr-1" /> {device.label}
                    </span>
                    <button
                      onClick={() => {
                        patchDevice({ modelId: null, label: '' });
                        setActiveBrand(null);
                        setActiveFamily(null);
                      }}
                      className="text-[13px] font-semibold text-orange"
                    >
                      change
                    </button>
                  </div>
                </div>
                <div className="flex gap-3 px-5 pt-3">
                  <div className="relative min-w-0 flex-1">
                    <i className="bi bi-search absolute top-1/2 left-3.5 -translate-y-1/2 text-[14px] text-ink-4" />
                    <input
                      value={typeQuery}
                      onChange={(e) => setTypeQuery(e.target.value)}
                      placeholder={`Search ${meta?.services.length ?? ''} services`}
                      className={`${inputCls} bg-line-soft pl-10`}
                    />
                  </div>
                  <CodeField
                    kind="serial"
                    label="IMEI / serial"
                    value={device.imei}
                    onChange={(imei) => patchDevice({ imei })}
                    placeholder="IMEI / serial"
                    style={{ width: 236, flexShrink: 0 }}
                    inputClassName={inputBase}
                    inputStyle={{ padding: undefined, borderRadius: undefined, border: undefined, fontSize: undefined, background: undefined }}
                  />
                </div>
                <div className="mt-3 flex min-h-0 flex-1">
              {!searching && (
                <div className="w-[190px] shrink-0 overflow-y-auto border-r border-line-soft max-xl:w-[150px]">
                  {categories.map(([cat, list]) => {
                    const active = shownCategory === cat;
                    return (
                      <button
                        key={cat}
                        onClick={() => setActiveCategory(cat)}
                        className={`flex w-full items-center justify-between px-5 py-3 text-left text-[14px] font-semibold ${
                          active ? 'border-l-[3px] border-orange bg-line-soft text-ink' : 'border-l-[3px] border-transparent text-ink-3'
                        }`}
                      >
                        <span>
                          {cat === 'Common repairs' && <i className="bi bi-star-fill mr-1.5 text-[11px] text-orange" />}
                          {cat}
                        </span>
                        <span className="text-[13px] font-medium text-ink-4">{list.length}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="min-w-0 flex-1 overflow-y-auto px-4 py-1">
                {shownServices.map((s) => {
                  const selected = lines.some((l) => l.deviceIndex === activeDevice && l.serviceId === s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggleLine(s)}
                      className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3 py-3.5 text-left ${
                        selected ? 'rounded-[10px] border-transparent bg-orange-soft' : ''
                      }`}
                    >
                      <span
                        className={`flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 ${
                          selected ? 'border-orange bg-orange text-white' : 'border-line'
                        }`}
                      >
                        {selected && <i className="bi bi-check text-[13px]" />}
                      </span>
                      <span className="min-w-[150px] flex-1">
                        <span className="block text-[15px] font-semibold text-ink">{s.name}</span>
                        <span className="block text-[12.5px] text-ink-4">
                          {s.deviceGroup}
                          {searching ? ` · ${s.category}` : ''}
                        </span>
                      </span>
                      <span className="ml-auto whitespace-nowrap text-[13.5px] font-semibold text-ink-3">
                        {s.tiers.length > 0
                          ? `from ${formatCents(Math.min(...s.tiers.map((t) => t.priceCents)))}`
                          : formatCents(s.basePriceCents)}
                      </span>
                    </button>
                  );
                })}
                {shownCategory === 'Common repairs' && !searching && (
                  <button
                    onClick={addWarrantyLine}
                    className="flex w-full items-center gap-3 border-b border-line-soft px-3 py-3.5 text-left"
                  >
                    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-line">
                      <i className="bi bi-shield-check text-[12px] text-ink-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-ink">Warranty rework</span>
                      <span className="block text-[12.5px] text-ink-4">Free redo of a covered repair</span>
                    </span>
                    <span className="shrink-0 text-[13.5px] font-semibold text-green">$0.00</span>
                  </button>
                )}
                {shownServices.length === 0 && shownCategory !== 'Common repairs' && (
                  <div className="px-3 py-8 text-center text-[14px] text-ink-4">No services match.</div>
                )}
              </div>
            </div>
              </>
            )}
          </div>

          {/* 3 · Ticket summary */}
          <div className="flex w-[400px] shrink-0 flex-col overflow-y-auto p-5 max-xl:w-[330px] max-xl:p-4 max-[1080px]:w-full max-[1080px]:overflow-visible">
            <div className={sectionCls}>4 · TICKET SUMMARY</div>
            <div className="min-h-0 flex-1">
              {devices.map((d, di) => {
                const deviceLines = lines.filter((l) => l.deviceIndex === di);
                if (deviceLines.length === 0) return null;
                return (
                  <div key={di} className="mt-4">
                    <div className={sectionCls}>
                      DEVICE {di + 1} · {(d.label || 'DEVICE').toUpperCase()}
                    </div>
                    {deviceLines.map((l, li) => (
                      <div key={li} className="border-b border-line-soft py-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[16px] font-bold text-ink">{l.description}</span>
                          <button
                            type="button"
                            onClick={() => setPricingLine(l)}
                            title="Tap to punch a price on the numpad"
                            className={`min-w-[86px] rounded-lg border px-2 py-0.5 text-right text-[16px] font-bold text-ink hover:border-line focus:border-orange focus:outline-none ${
                              pricingLine === l ? 'border-orange bg-orange-soft' : 'border-transparent'
                            }`}
                          >
                            {formatCents(l.priceCents)}
                          </button>
                        </div>
                        {l.tiers.length > 0 ? (
                          <select
                            value={l.tierLabel ?? ''}
                            onChange={(e) => {
                              const tier = l.tiers.find((t) => t.label === e.target.value);
                              setLines((prev) =>
                                prev.map((x) =>
                                  x === l ? { ...x, tierLabel: tier?.label ?? null, priceCents: tier?.priceCents ?? x.priceCents } : x,
                                ),
                              );
                            }}
                            className="mt-1 w-full rounded-md border-none bg-transparent p-0 text-[13px] text-ink-4 focus:outline-none"
                          >
                            {l.tierLabel === null && <option value="">Custom price · {l.warrantyDays}-day warranty</option>}
                            {l.tiers.map((t) => (
                              <option key={t.label} value={t.label}>
                                {t.label} · {l.warrantyDays}-day warranty — {formatCents(t.priceCents)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="mt-1 text-[13px] text-ink-4">{l.warrantyDays}-day warranty</div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
              {lines.length === 0 && (
                <div className="mt-10 text-center text-[14px] text-ink-4">Pick repairs to build the ticket.</div>
              )}
            </div>
            <label className="mt-3 block">
              <span className={labelCls}>Notes for tech</span>
              <textarea
                value={notesForTech}
                onChange={(e) => setNotesForTech(e.target.value)}
                rows={2}
                placeholder="Touch dead in top-right corner after drop…"
                className={`${inputCls} resize-none`}
              />
            </label>
            <div className="mt-3 rounded-xl bg-page p-4">
              <div className="flex justify-between text-[14px] text-ink-3">
                <span>Parts + labor</span>
                <span>{formatCents(totals.subtotalCents)}</span>
              </div>
              <div className="mt-1 flex justify-between text-[14px] text-ink-3">
                <span>Tax {(TAX_RATE_BP / 100).toFixed(0)}%</span>
                <span>{formatCents(totals.taxCents)}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-[16px] font-bold text-ink">Ticket total</span>
                <span className="text-[24px] font-extrabold text-ink">{formatCents(totals.totalCents)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer: edit mode saves in place; create mode picks how the customer pays */}
        {edit ? (
          <div className="flex items-center gap-3 border-t border-line-soft px-6 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-bold text-ink">
                {locked ? (
                  <>
                    <i className="bi bi-shield-lock text-orange" /> Admin code required
                  </>
                ) : (
                  'Editing ticket'
                )}
              </div>
              <div className="text-[12.5px] leading-snug text-ink-3">
                {locked
                  ? 'This ticket is completed or already paid, so a manager must approve the change.'
                  : 'Saving updates the ticket total and adds a note to its history.'}
              </div>
              {error && <div className="mt-1 text-[13px] font-semibold text-red">{error}</div>}
            </div>
            <button
              onClick={() => setPrintLabel((v) => !v)}
              className="flex items-center gap-2.5 rounded-xl border border-line bg-card px-4 py-3 text-left"
            >
              <i className={`bi ${printLabel ? 'bi-check-square-fill text-orange' : 'bi-square text-ink-4'} text-[17px]`} />
              <span>
                <span className="block text-[14.5px] font-bold text-ink">
                  <i className="bi bi-tag" /> Reprint label
                </span>
                <span className="block text-[12px] text-ink-4">New device tag when saved</span>
              </span>
            </button>
            <button
              onClick={() => onClose()}
              disabled={busy}
              className="rounded-xl border border-line bg-card px-5 py-3 text-[14.5px] font-bold text-ink-2 disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={() => void saveEdit()}
              disabled={busy}
              className="flex items-center gap-3 rounded-xl bg-orange px-5 py-3 text-left text-white disabled:opacity-50"
            >
              <i className={`bi ${locked ? 'bi-shield-lock' : 'bi-check2-circle'} text-[18px]`} />
              <span>
                <span className="block text-[14.5px] font-bold">Save changes · {formatCents(totals.totalCents)}</span>
                <span className="block text-[12px] text-white/80">
                  {edit.paidCents > 0 ? `${formatCents(edit.paidCents)} already paid` : 'Ticket stays ' + edit.status.replace('_', ' ')}
                </span>
              </span>
            </button>
          </div>
        ) : (
        <div className="flex items-center gap-3 border-t border-line-soft px-6 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-ink">How is the customer paying?</div>
            <div className="text-[12.5px] leading-snug text-ink-3">
              Paying now adds the devices to the current sale. Paying at pickup sends it to the Repairs board as unpaid.
            </div>
            {error && <div className="mt-1 text-[13px] font-semibold text-red">{error}</div>}
          </div>
          <button
            onClick={() => setPrintLabel((v) => !v)}
            className="flex items-center gap-2.5 rounded-xl border border-line bg-card px-4 py-3 text-left"
          >
            <i className={`bi ${printLabel ? 'bi-check-square-fill text-orange' : 'bi-square text-ink-4'} text-[17px]`} />
            <span>
              <span className="block text-[14.5px] font-bold text-ink">
                <i className="bi bi-tag" /> Print label
              </span>
              <span className="block text-[12px] text-ink-4">Device tag when saved</span>
            </span>
          </button>
          <button
            onClick={() => void submit('board')}
            disabled={busy}
            className="flex items-center gap-3 rounded-xl border border-line bg-card px-5 py-3 text-left disabled:opacity-50"
          >
            <i className="bi bi-kanban text-[17px] text-ink-2" />
            <span>
              <span className="block text-[14.5px] font-bold text-ink">Send to Repairs board</span>
              <span className="block text-[12px] text-ink-4">Unpaid · collect at pickup</span>
            </span>
          </button>
          <button
            onClick={() => void submit('deposit')}
            disabled={busy}
            className="flex items-center gap-3 rounded-xl border border-line bg-card px-5 py-3 text-left disabled:opacity-50"
          >
            <i className="bi bi-percent text-[17px] text-ink-2" />
            <span>
              <span className="block text-[14.5px] font-bold text-ink">Take deposit</span>
              <span className="block text-[12px] text-ink-4">Part paid now, rest at pickup</span>
            </span>
          </button>
          <button
            onClick={() => void submit('sale')}
            disabled={busy}
            className="flex items-center gap-3 rounded-xl bg-orange px-5 py-3 text-left text-white disabled:opacity-50"
          >
            <i className="bi bi-cart-plus text-[18px]" />
            <span>
              <span className="block text-[14.5px] font-bold">Add to current sale · {formatCents(totals.totalCents)}</span>
              <span className="block text-[12px] text-white/80">Paid up front · ticket opens as paid</span>
            </span>
          </button>
        </div>
        )}
        <MoneyKeypadSheet
          open={pricingLine !== null}
          label={pricingLine?.description ?? ''}
          cents={pricingLine?.priceCents ?? 0}
          onCommit={(cents) => {
            const target = pricingLine;
            setLines((prev) => prev.map((x) => (x === target ? { ...x, priceCents: cents, tierLabel: null } : x)));
          }}
          onClose={() => setPricingLine(null)}
        />
        {edit && (
          <ManagerCodePrompt
            open={codePrompt}
            busy={busy}
            error={codeError}
            ticketNumber={edit.number}
            onCancel={() => setCodePrompt(false)}
            onSubmit={(pin) => void saveEdit(pin)}
          />
        )}
      </div>
    </div>
  );
}

/** Four-digit manager code sheet shown before a locked ticket (or a completed sale) is saved. */
export function ManagerCodePrompt({
  open,
  busy,
  error,
  ticketNumber,
  message = "This ticket is completed or already paid. Enter the store admin code or a manager's PIN to save the edit; the approval is recorded on the ticket.",
  onCancel,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  ticketNumber: string;
  message?: string;
  onCancel: () => void;
  onSubmit: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (open) setPin('');
  }, [open]);
  if (!open) return null;
  const submit = () => {
    if (pin.length >= 4 && !busy) onSubmit(pin);
  };
  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-navy/60 p-4" onClick={onCancel}>
      <div className="w-[380px] max-w-full rounded-[20px] bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-orange-soft text-orange">
            <i className="bi bi-shield-lock text-[18px]" />
          </span>
          <div>
            <h3 className="text-[18px] font-bold text-ink">Admin code</h3>
            <div className="text-[13px] text-ink-3">Approve changes to {ticketNumber}</div>
          </div>
        </div>
        <p className="mt-3 text-[13.5px] leading-snug text-ink-3">{message}</p>
        <div className="mt-4">
          <SecretField
            label="Admin code"
            value={pin}
            onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            maxLength={6}
            error={error}
            disabled={busy}
          />
        </div>
        <div className="mt-4">
          <Keypad
            onDigit={(d) => setPin((p) => (p + d).slice(0, 6))}
            onDoubleZero={() => setPin((p) => (p + '00').slice(0, 6))}
            onBackspace={() => setPin((p) => p.slice(0, -1))}
            onClear={() => setPin('')}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-xl border border-line bg-card px-4 py-2.5 text-[14px] font-semibold text-ink-2">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pin.length < 4 || busy}
            className="rounded-xl bg-orange px-4 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            Approve and save
          </button>
        </div>
      </div>
    </div>
  );
}
