import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { computeTotals, formatCents } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api, session, useNarrow, RingUpPad, type RingUpPadHandle } from '@fmp/pos-client';
import { useRef } from 'react';
import { lineKey, type CartCustomer, type CartLine } from '@fmp/pos-client';
import { CustomerModal } from '@fmp/pos-client';
import { InventoryPickerModal, type PickableItem } from '@fmp/pos-client';
import { type PaymentDraft } from '@fmp/pos-client';
import { NewRepairWindow, type CreatedTicket } from '../repairs/NewRepairWindow';
import { DepositModal } from '../repairs/DepositModal';
import { TradeInModal } from './TradeInModal';
import { PayoutModal } from './PayoutModal';

let cachedTaxRateBp = 600;

interface TakenInToday {
  id: number;
  number: string;
  status: string;
  createdAt: string;
  customerName: string | null;
  customerPhone: string | null;
  deviceSummary: string | null;
}

type OpenModal = null | 'customer' | 'accessory' | 'device' | 'note' | 'tradein' | 'payout';

export function RegisterScreen() {
  const user = session.user;
  const narrow = useNarrow();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [modal, setModal] = useState<OpenModal>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [parkedCount, setParkedCount] = useState(0);
  const [takenIn, setTakenIn] = useState<TakenInToday[]>([]);
  const [repairOpen, setRepairOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [taxRateBp, setTaxRateBp] = useState(cachedTaxRateBp);
  const ringUpRef = useRef<RingUpPadHandle>(null);
  const [depositTicket, setDepositTicket] = useState<{ id: number; number: string; balanceCents: number } | null>(null);
  /** cart line waiting for a price punched on the pad */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [done, setDone] = useState<null | { changeCents: number | null; receiptText: string; printed: boolean }>(null);
  const [error, setError] = useState('');
  const [resumedSaleId, setResumedSaleId] = useState<number | null>(null);

  const totals = useMemo(
    () =>
      computeTotals(
        lines.map((l) => ({ qty: l.qty, unitCents: l.unitCents, taxable: l.taxable, discountCents: l.discountCents })),
        taxRateBp,
      ),
    [lines],
  );

  async function refreshSide() {
    const [parked, taken] = await Promise.all([
      api<unknown[]>('/api/sales/parked').catch(() => []),
      api<TakenInToday[]>('/api/repairs/taken-today').catch(() => []),
    ]);
    setParkedCount(parked.length);
    setTakenIn(taken);
  }

  function handleRepairCreated(ticket: CreatedTicket, exit: 'board' | 'deposit' | 'sale') {
    setRepairOpen(false);
    if (exit === 'deposit') {
      setDepositTicket({ id: ticket.id, number: ticket.number, balanceCents: ticket.totalCents });
    } else if (exit === 'sale') {
      setLines((prev) => [
        ...prev,
        ...ticket.lines.map((l) => ({
          key: lineKey(),
          kind: 'repair' as const,
          description: `${ticket.number} · ${l.description}`,
          qty: 1,
          unitCents: l.priceCents,
          discountCents: 0,
          taxable: true,
          ticketId: ticket.id,
        })),
      ]);
    }
    void refreshSide();
  }

  useEffect(() => {
    void refreshSide();
    void api<{ taxRateBp: number }>('/api/settings/store')
      .then((s) => {
        cachedTaxRateBp = s.taxRateBp;
        setTaxRateBp(s.taxRateBp);
      })
      .catch(() => {});
    // resume support: PendingSales stashes a sale here before navigating over
    const stash = sessionStorage.getItem('fmp.resumeSale');
    if (stash) {
      sessionStorage.removeItem('fmp.resumeSale');
      const parsed = JSON.parse(stash) as {
        id: number;
        customer: CartCustomer | null;
        lines: Array<Omit<CartLine, 'key'>>;
      };
      setLines(parsed.lines.map((l) => ({ ...l, key: lineKey() })));
      setCustomer(parsed.customer);
      setResumedSaleId(parsed.id);
    }
  }, []);

  function addItem(item: PickableItem) {
    setLines((prev) => {
      if (item.kind !== 'device') {
        const existing = prev.find((l) => l.inventoryItemId === item.id);
        if (existing) {
          if (existing.qty >= item.qty) return prev; // no more stock
          return prev.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
        }
      } else if (prev.some((l) => l.inventoryItemId === item.id)) {
        return prev; // serialized device already in cart
      }
      return [
        ...prev,
        {
          key: lineKey(),
          kind: 'product',
          description: item.name + (item.storage ? ` · ${item.storage}` : ''),
          detail: item.kind === 'device' ? `IMEI …${(item.imei ?? '').slice(-5)}` : (item.sku ?? undefined),
          qty: 1,
          unitCents: item.priceCents,
          discountCents: 0,
          taxable: item.taxable,
          inventoryItemId: item.id,
          serialized: item.kind === 'device',
        },
      ];
    });
  }

  function updateQty(key: string, delta: number) {
    setLines((prev) =>
      prev
        .map((l) => (l.key === key && !l.serialized ? { ...l, qty: Math.max(1, l.qty + delta) } : l))
        .filter((l) => l.qty > 0),
    );
  }

  function clearSale() {
    setLines([]);
    setCustomer(null);
    setNote('');
    setResumedSaleId(null);
    setSelectedKey(null);
  }

  /** Accessory / Service fee / typed search text: goes straight into the sale,
   *  selected and waiting for its price from the pad. */
  function addPendingItem(description: string) {
    const key = lineKey();
    setLines((prev) => [
      ...prev,
      { key, kind: 'custom', description, qty: 1, unitCents: 0, discountCents: 0, taxable: true },
    ]);
    setSelectedKey(key);
    ringUpRef.current?.focus();
  }

  async function park() {
    if (lines.length === 0) return;
    setBusy(true);
    try {
      await api('/api/sales/park', {
        method: 'POST',
        body: JSON.stringify({
          lines: lines.map(({ key, detail, serialized, ...l }) => l),
          customerId: customer?.id ?? null,
          note: note || null,
        }),
      });
      clearSale();
      await refreshSide();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not park sale');
    } finally {
      setBusy(false);
    }
  }

  async function complete(payments: PaymentDraft[], useLines: CartLine[] = lines) {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ changeCents: number | null; receiptText: string; printed: boolean }>(
        '/api/sales/complete',
        {
          method: 'POST',
          body: JSON.stringify({
            lines: useLines.map(({ key, detail, serialized, ...l }) => l),
            customerId: customer?.id ?? null,
            payments,
            parkedSaleId: resumedSaleId,
          }),
        },
      );
      setModal(null);
      setDone(res);
      clearSale();
      await refreshSide();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sale failed');
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  /** Punched amount from the pad: prices the selected line, otherwise adds a new custom item. */
  function applyAmount(item: { description: string; unitCents: number; taxable: boolean }): CartLine[] {
    if (selectedKey && lines.some((l) => l.key === selectedKey)) {
      const next = lines.map((l) => (l.key === selectedKey ? { ...l, unitCents: item.unitCents } : l));
      setSelectedKey(null);
      return next;
    }
    return [...lines, { key: lineKey(), kind: 'custom' as const, qty: 1, discountCents: 0, ...item }];
  }

  /** Ring-up pad card fast path: apply the punched amount (if any) and complete as card. */
  function collectCard(item: { description: string; unitCents: number; taxable: boolean } | null) {
    const effective = item ? applyAmount(item) : lines;
    if (effective.length === 0) return;
    setError('');
    setLines(effective);
    const t = computeTotals(
      effective.map((l) => ({ qty: l.qty, unitCents: l.unitCents, taxable: l.taxable, discountCents: l.discountCents })),
      taxRateBp,
    );
    void complete([{ method: 'card', amountCents: t.totalCents }], effective);
  }

  const smartActions: Array<{
    icon: string;
    title: string;
    caption: string;
    bg: string;
    onClick?: () => void;
    disabled?: boolean;
  }> = [
    { icon: 'bi-wrench-adjustable', title: 'New repair', caption: 'Start a repair ticket', bg: 'var(--orange-soft)', onClick: () => setRepairOpen(true) },
    { icon: 'bi-lightning-charge', title: 'Accessory', caption: 'Cases, chargers, glass', bg: 'var(--blue-bg)', onClick: () => setModal('accessory') },
    { icon: 'bi-phone', title: 'Device sale', caption: 'Sell a used or new phone', bg: 'var(--green-bg)', onClick: () => setModal('device') },
    { icon: 'bi-arrow-left-right', title: 'Trade-in', caption: 'Buy or exchange a device', bg: 'var(--purple-bg)', onClick: () => setModal('tradein') },
    { icon: 'bi-search', title: 'Check IMEI', caption: 'Carrier and blacklist status', bg: 'var(--card)', disabled: true },
    { icon: 'bi-cash-coin', title: 'Payout', caption: 'Cash paid from register', bg: 'var(--red-bg)', onClick: () => setModal('payout') },
    { icon: 'bi-pencil-square', title: 'Quick note', caption: 'Add a register note', bg: 'var(--card)', onClick: () => setModal('note') },
    { icon: 'bi-person', title: 'Customer', caption: 'Find or create customer', bg: 'var(--card)', onClick: () => setModal('customer') },
    { icon: 'bi-plus-circle', title: 'Custom item', caption: 'Use the ring-up pad above', bg: 'var(--card)', onClick: () => ringUpRef.current?.focus() },
  ];

  /** Big tiles above the register: icon badge + text filling the row. */
  const renderPrimary = (a: (typeof smartActions)[number], iconColor: string) => (
    <button
      key={a.title}
      onClick={a.onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        textAlign: 'left',
        background: a.bg,
        border: '1px solid var(--line-soft)',
        borderRadius: 14,
        padding: '11px 14px',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <span
        style={{
          width: 46,
          height: 46,
          borderRadius: 13,
          background: 'var(--card)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <i className={`bi ${a.icon}`} style={{ fontSize: 23, color: iconColor }} />
      </span>
      <span style={{ minWidth: 0 }}>
        <div style={{ font: '700 16.5px Inter, sans-serif', whiteSpace: 'nowrap' }}>
          {a.title} <i className="bi bi-chevron-right" style={{ fontSize: 11.5, color: 'var(--ink-4)' }} />
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>{a.caption}</div>
      </span>
    </button>
  );

  const renderAction = (a: (typeof smartActions)[number]) => (
    <button
      key={a.title}
      onClick={a.onClick}
      disabled={a.disabled}
      title={a.disabled ? 'Coming in a later phase' : undefined}
      style={{
        textAlign: 'left',
        background: a.bg,
        border: '1px solid var(--line-soft)',
        borderRadius: 12,
        padding: '10px 13px',
        opacity: a.disabled ? 0.5 : 1,
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <i className={`bi ${a.icon}`} style={{ fontSize: 16.5 }} />
        <span style={{ font: '700 15px Inter, sans-serif' }}>{a.title}</span>
        <i className="bi bi-chevron-right" style={{ fontSize: 11, color: 'var(--ink-4)' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>{a.caption}</div>
    </button>
  );

  return (
    <div
      style={
        narrow
          ? { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'auto' }
          : { display: 'flex', height: '100vh', overflow: 'hidden' }
      }
    >
      {/* Left: actions + search + strip */}
      <div
        style={{
          flex: narrow ? '0 0 auto' : 1,
          minWidth: 0,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          overflow: narrow ? 'visible' : 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>New sale</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {user?.name}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/pending" style={{ textDecoration: 'none' }}>
              <Button variant="secondary">
                On Hold{' '}
                <span style={{ background: 'var(--line-soft)', borderRadius: 999, padding: '1px 8px', fontSize: 12.5 }}>{parkedCount}</span>
              </Button>
            </Link>
            <Link to="/repairs" style={{ textDecoration: 'none' }}>
              <Button variant="dark">
                Repairs <span style={{ background: 'var(--orange)', borderRadius: 999, padding: '1px 8px', fontSize: 12.5 }}>{takenIn.length}</span>
              </Button>
            </Link>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchBar
              onAddItem={addItem}
              onPickCustomer={(c) => setCustomer(c)}
              onUseDescription={(text) => addPendingItem(text)}
            />
          </div>
          {[
            { label: 'Accessory', icon: 'bi-lightning-charge' },
            { label: 'Service fee', icon: 'bi-tools' },
          ].map((preset) => (
            <button
              key={preset.label}
              onClick={() => addPendingItem(preset.label)}
              style={{
                marginTop: 12,
                minHeight: 50,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                borderRadius: 12,
                border: '1px solid var(--line-soft)',
                background: 'var(--card)',
                color: 'var(--ink)',
                padding: '0 18px',
                font: '700 15px Inter, sans-serif',
                whiteSpace: 'nowrap',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <i className={`bi ${preset.icon}`} style={{ fontSize: 16, color: 'var(--orange)' }} />
              {preset.label}
            </button>
          ))}
        </div>

        {/* Primary actions live right above the register */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 12 }}>
          {smartActions.slice(0, 3).map((a, i) => renderPrimary(a, ['var(--orange)', 'var(--navy)', 'var(--green)'][i]!))}
        </div>

        <RingUpPad
          ref={ringUpRef}
          taxRateBp={taxRateBp}
          subtotalCents={totals.subtotalCents}
          taxCents={totals.taxCents}
          totalCents={totals.totalCents}
          customer={customer}
          busy={busy}
          taxRemovedInSale={lines.some((l) => !l.taxable)}
          showItemOptions={false}
          onAdd={(item) => setLines(applyAmount(item))}
          onCollectCard={collectCard}
          onComplete={(p) => void complete(p)}
        />

        <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em', margin: '14px 0 7px' }}>
          SMART ACTIONS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {smartActions.slice(3).map(renderAction)}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', margin: '14px 0 7px' }}>
          <span style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em' }}>
            TAKEN IN TODAY{' '}
            <span style={{ color: 'var(--orange)' }}>
              {takenIn.filter((t) => !['picked_up', 'cancelled', 'abandoned'].includes(t.status)).length} open
            </span>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {takenIn.map((t) => (
            <Link key={t.id} to="/repairs" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div style={{ background: 'var(--card)', borderRadius: 12, border: '1px solid var(--line-soft)', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ font: '600 14px Inter, sans-serif' }}>{t.customerName}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>
                    {new Date(t.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 3 }}>
                  <i className="bi bi-phone" style={{ fontSize: 11.5 }} /> {t.deviceSummary ?? t.number}
                </div>
              </div>
            </Link>
          ))}
          {takenIn.length === 0 && <div style={{ fontSize: 14, color: 'var(--ink-4)' }}>No repairs taken in yet.</div>}
        </div>
      </div>

      {/* Right (portrait: below): current sale */}
      <div
        style={{
          width: narrow ? '100%' : 360,
          flexShrink: 0,
          background: 'var(--card)',
          borderLeft: narrow ? 'none' : '1px solid var(--line-soft)',
          borderTop: narrow ? '1px solid var(--line-soft)' : 'none',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>
            Current sale <span style={{ color: 'var(--orange)' }}>items: {lines.reduce((n, l) => n + l.qty, 0)}</span>
          </h2>
          {customer ? (
            <div
              style={{
                marginTop: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                minHeight: 50,
                borderRadius: 12,
                background: 'var(--blue-bg)',
                padding: '8px 14px',
              }}
            >
              <i className="bi bi-person-fill" style={{ fontSize: 19, color: 'var(--navy)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: '600 15.5px Inter, sans-serif' }}>{customer.name}</div>
                {customer.phone && <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>{customer.phone}</div>}
              </div>
              <button
                onClick={() => setCustomer(null)}
                style={{ border: 'none', background: 'none', color: 'var(--red)', font: '600 14px Inter, sans-serif', padding: '8px 6px' }}
              >
                <i className="bi bi-x-lg" /> Remove
              </button>
            </div>
          ) : (
            <button
              onClick={() => setModal('customer')}
              style={{
                width: '100%',
                marginTop: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 9,
                minHeight: 50,
                borderRadius: 12,
                border: '1px solid var(--line-soft)',
                background: 'var(--card)',
                color: 'var(--ink)',
                font: '700 15.5px Inter, sans-serif',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <i className="bi bi-person-plus" style={{ fontSize: 18 }} /> Add customer
            </button>
          )}
          {note && <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>📝 {note}</div>}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          {lines.map((l) => (
            <div key={l.key} style={{ borderBottom: '1px solid var(--line-soft)', padding: '10px 0' }}>
              <div
                onClick={
                  l.kind === 'custom'
                    ? () => setSelectedKey((k) => (k === l.key ? null : l.key))
                    : undefined
                }
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  cursor: l.kind === 'custom' ? 'pointer' : undefined,
                  background: selectedKey === l.key ? 'var(--orange-soft)' : undefined,
                  borderRadius: 10,
                  margin: '0 -8px',
                  padding: '6px 8px',
                }}
              >
                <span style={{ font: '600 15px Inter, sans-serif' }}>{l.description}</span>
                <span style={{ textAlign: 'right' }}>
                  <span style={{ font: '700 15px Inter, sans-serif' }}>{formatCents(l.qty * l.unitCents - l.discountCents)}</span>
                  {l.kind === 'custom' && l.unitCents === 0 ? (
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--amber)' }}>
                      {selectedKey === l.key ? 'Punch the price on the pad' : 'Needs price — tap to select'}
                    </span>
                  ) : (
                    <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-3)' }}>
                      {l.taxable
                        ? `Tax ${formatCents(Math.round(((l.qty * l.unitCents - l.discountCents) * taxRateBp) / 10000))}`
                        : 'No tax'}
                    </span>
                  )}
                </span>
              </div>
              {l.detail && <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{l.detail}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                {!l.serialized && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <button
                      onClick={() => updateQty(l.key, -1)}
                      style={{ width: 42, height: 42, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', font: '600 21px Inter, sans-serif', color: 'var(--ink)' }}
                    >
                      −
                    </button>
                    <span style={{ minWidth: 32, textAlign: 'center', font: '600 21px Inter, sans-serif' }}>{l.qty}</span>
                    <button
                      onClick={() => updateQty(l.key, 1)}
                      style={{ width: 42, height: 42, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', font: '600 21px Inter, sans-serif', color: 'var(--ink)' }}
                    >
                      +
                    </button>
                  </span>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  <button
                    onClick={() => {
                      setLines((prev) => prev.filter((x) => x.key !== l.key));
                      if (selectedKey === l.key) setSelectedKey(null);
                    }}
                    style={{
                      border: 'none',
                      background: 'var(--red-bg)',
                      color: 'var(--red)',
                      borderRadius: 8,
                      padding: '6px 14px',
                      font: '600 13px Inter, sans-serif',
                    }}
                  >
                    Remove
                  </button>
                  <button
                    onClick={() => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, taxable: !x.taxable } : x)))}
                    title={l.taxable ? 'Tap to remove tax from this item (logged, cash only)' : 'Tax removed — tap to add it back'}
                    style={{
                      border: 'none',
                      background: l.taxable ? 'var(--orange-soft)' : 'var(--line-soft)',
                      color: l.taxable ? 'var(--orange)' : 'var(--ink-4)',
                      borderRadius: 8,
                      padding: '6px 14px',
                      font: '600 13px Inter, sans-serif',
                    }}
                  >
                    {l.taxable ? `Tax ${(taxRateBp / 100).toFixed(taxRateBp % 100 === 0 ? 0 : 2)}%` : 'No tax'}
                  </button>
                </span>
              </div>
            </div>
          ))}
          {lines.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontSize: 15, marginTop: 40 }}>
              <i className="bi bi-bag" style={{ fontSize: 30 }} />
              <div style={{ marginTop: 8 }}>Scan, search, or tap a smart action to start.</div>
            </div>
          )}
          {lines.length > 0 && (
            <button
              onClick={() => ringUpRef.current?.focus()}
              style={{
                width: '100%',
                marginTop: 10,
                padding: '10px 0',
                borderRadius: 10,
                border: '1px dashed var(--line)',
                background: 'var(--card)',
                color: 'var(--ink-2)',
                font: '600 14px Inter, sans-serif',
              }}
            >
              + Add custom item
            </button>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--line-soft)', padding: '12px 20px 16px' }}>
          {error && <div style={{ color: 'var(--red)', fontSize: 14, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={clearSale}
              disabled={lines.length === 0}
              style={{
                flex: 1,
                border: '1px solid var(--line)',
                background: 'var(--card)',
                color: lines.length === 0 ? 'var(--ink-4)' : 'var(--red)',
                borderRadius: 11,
                minHeight: 52,
                font: '600 17px Inter, sans-serif',
                opacity: lines.length === 0 ? 0.5 : 1,
              }}
            >
              Clear
            </button>
            <Button variant="secondary" size="lg" style={{ flex: 1 }} disabled={lines.length === 0 || busy} onClick={() => void park()}>
              Hold sale
            </Button>
          </div>
        </div>
      </div>

      <CustomerModal open={modal === 'customer'} onClose={() => setModal(null)} onPick={setCustomer} />
      <InventoryPickerModal
        open={modal === 'accessory'}
        tab="accessories"
        title="Add accessory"
        onClose={() => setModal(null)}
        onPick={addItem}
      />
      <InventoryPickerModal
        open={modal === 'device'}
        tab="phones"
        title="Device sale"
        onClose={() => setModal(null)}
        onPick={addItem}
      />
      <NewRepairWindow open={repairOpen} onClose={() => setRepairOpen(false)} onCreated={handleRepairCreated} />
      <TradeInModal
        open={modal === 'tradein'}
        customer={customer}
        onClose={() => setModal(null)}
        onDone={(msg) => {
          setToast(msg);
          setTimeout(() => setToast(''), 6000);
        }}
      />
      <PayoutModal
        open={modal === 'payout'}
        onClose={() => setModal(null)}
        onDone={(msg) => {
          setToast(msg);
          setTimeout(() => setToast(''), 6000);
        }}
      />
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--navy)',
            color: '#fff',
            borderRadius: 12,
            padding: '12px 20px',
            font: '600 15px Inter, sans-serif',
            boxShadow: 'var(--shadow)',
            zIndex: 200,
          }}
        >
          <i className="bi bi-check-circle" style={{ color: 'var(--green)', marginRight: 8 }} />
          {toast}
        </div>
      )}
      <DepositModal ticket={depositTicket} onClose={() => setDepositTicket(null)} onDone={() => void refreshSide()} />

      <Modal open={modal === 'note'} onClose={() => setModal(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>Quick note</h2>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Shown on the held sale"
          style={{ width: '100%', marginTop: 12, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15, resize: 'none' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <Button variant="primary" onClick={() => setModal(null)}>Save note</Button>
        </div>
      </Modal>

      {/* Completed-sale confirmation */}
      <Modal open={done !== null} onClose={() => setDone(null)} width={400}>
        {done && (
          <div style={{ textAlign: 'center' }}>
            <i className="bi bi-check-circle-fill" style={{ fontSize: 43, color: 'var(--green)' }} />
            <h2 style={{ margin: '10px 0 4px', font: '700 23px Inter, sans-serif' }}>Sale complete</h2>
            {done.changeCents != null && done.changeCents > 0 && (
              <div style={{ background: 'var(--green-bg)', color: 'var(--green)', borderRadius: 12, padding: '12px 0', margin: '12px 0', font: '800 30px Inter, sans-serif' }}>
                Change {formatCents(done.changeCents)}
              </div>
            )}
            <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>
              {done.printed ? 'Receipt sent to printer.' : 'Print bridge offline — receipt below.'}
            </div>
            {!done.printed && (
              <pre
                style={{
                  textAlign: 'left',
                  background: 'var(--line-soft)',
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 12,
                  fontFamily: 'ui-monospace, monospace',
                  overflow: 'auto',
                  userSelect: 'text',
                }}
              >
                {done.receiptText}
              </pre>
            )}
            <Button variant="primary" size="lg" style={{ width: '100%', marginTop: 12 }} onClick={() => setDone(null)}>
              New sale
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Unified search bar: products add to cart, customers attach to the sale,
 *  and any typed text can become the description of a custom item on the pad. */
function SearchBar({
  onAddItem,
  onPickCustomer,
  onUseDescription,
}: {
  onAddItem: (item: PickableItem) => void;
  onPickCustomer: (c: CartCustomer) => void;
  onUseDescription?: (text: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ customers: CartCustomer[]; items: PickableItem[] } | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(async () => {
      const res = await api<{ customers: CartCustomer[]; items: PickableItem[] }>(
        `/api/sales/search/all?q=${encodeURIComponent(q)}`,
      ).catch(() => null);
      setResults(res);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div style={{ position: 'relative', marginTop: 12 }}>
      <i
        className="bi bi-search"
        style={{ position: 'absolute', left: 15, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-4)', fontSize: 16.5 }}
      />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search phone, customer, product, or IMEI"
        style={{
          width: '100%',
          height: 50,
          padding: '0 14px 0 41px',
          borderRadius: 12,
          border: '1px solid var(--line-soft)',
          background: 'var(--card)',
          fontSize: 15.5,
          boxShadow: 'var(--shadow-card)',
        }}
      />
      {(q.trim().length >= 2 || (results && (results.customers.length > 0 || results.items.length > 0))) && (
        <div
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            right: 0,
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            boxShadow: 'var(--shadow)',
            zIndex: 20,
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {(results?.items ?? []).map((item) => (
            <button
              key={`i${item.id}`}
              onClick={() => {
                onAddItem(item);
                setQ('');
              }}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', padding: '10px 14px', border: 'none', background: 'none', textAlign: 'left' }}
            >
              <span style={{ fontSize: 15 }}>
                <i className="bi bi-box-seam" style={{ color: 'var(--ink-4)', marginRight: 8 }} />
                {item.name}
                {item.storage ? ` · ${item.storage}` : ''}
              </span>
              <span style={{ font: '600 15px Inter, sans-serif' }}>{formatCents(item.priceCents)}</span>
            </button>
          ))}
          {(results?.customers ?? []).map((c) => (
            <button
              key={`c${c.id}`}
              onClick={() => {
                onPickCustomer(c);
                setQ('');
              }}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', padding: '10px 14px', border: 'none', background: 'none', textAlign: 'left' }}
            >
              <span style={{ fontSize: 15 }}>
                <i className="bi bi-person" style={{ color: 'var(--ink-4)', marginRight: 8 }} />
                {c.name}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{c.phone}</span>
            </button>
          ))}
          {onUseDescription && q.trim().length >= 2 && (
            <button
              onClick={() => {
                onUseDescription(q.trim());
                setQ('');
              }}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: 8,
                padding: '12px 14px',
                border: 'none',
                borderTop: '1px solid var(--line-soft)',
                background: 'var(--orange-soft)',
                textAlign: 'left',
                font: '600 15px Inter, sans-serif',
                color: 'var(--orange)',
              }}
            >
              <i className="bi bi-plus-circle" /> Use “{q.trim()}” as custom item — punch the amount on the pad
            </button>
          )}
        </div>
      )}
    </div>
  );
}
