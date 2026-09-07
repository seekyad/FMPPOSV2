import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { computeTotals, formatCents } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { api, session } from '../../api';
import { lineKey, type CartCustomer, type CartLine } from '../../cart';
import { CustomItemModal } from './CustomItemModal';
import { CustomerModal } from './CustomerModal';
import { InventoryPickerModal, type PickableItem } from './InventoryPickerModal';
import { PaymentModal, type PaymentDraft } from './PaymentModal';
import { NewRepairWindow, type CreatedTicket } from '../repairs/NewRepairWindow';
import { DepositModal } from '../repairs/DepositModal';

const TAX_RATE_BP = 600; // store-configurable in Settings (Phase 3); seed value shown until then

interface TakenInToday {
  id: number;
  number: string;
  status: string;
  createdAt: string;
  customerName: string | null;
  customerPhone: string | null;
  deviceSummary: string | null;
}

type OpenModal = null | 'custom' | 'customer' | 'accessory' | 'device' | 'payment' | 'note';

export function RegisterScreen() {
  const user = session.user;
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [modal, setModal] = useState<OpenModal>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [parkedCount, setParkedCount] = useState(0);
  const [takenIn, setTakenIn] = useState<TakenInToday[]>([]);
  const [repairOpen, setRepairOpen] = useState(false);
  const [depositTicket, setDepositTicket] = useState<{ id: number; number: string; balanceCents: number } | null>(null);
  const [done, setDone] = useState<null | { changeCents: number | null; receiptText: string; printed: boolean }>(null);
  const [error, setError] = useState('');
  const [resumedSaleId, setResumedSaleId] = useState<number | null>(null);

  const totals = useMemo(
    () =>
      computeTotals(
        lines.map((l) => ({ qty: l.qty, unitCents: l.unitCents, taxable: l.taxable, discountCents: l.discountCents })),
        TAX_RATE_BP,
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

  async function complete(payments: PaymentDraft[]) {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ changeCents: number | null; receiptText: string; printed: boolean }>(
        '/api/sales/complete',
        {
          method: 'POST',
          body: JSON.stringify({
            lines: lines.map(({ key, detail, serialized, ...l }) => l),
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
    { icon: 'bi-arrow-left-right', title: 'Trade-in', caption: 'Buy or exchange a device', bg: 'var(--purple-bg)', disabled: true },
    { icon: 'bi-search', title: 'Check IMEI', caption: 'Carrier and blacklist status', bg: 'var(--card)', disabled: true },
    { icon: 'bi-cash-coin', title: 'Payout', caption: 'Cash paid from register', bg: 'var(--red-bg)', disabled: true },
    { icon: 'bi-pencil-square', title: 'Quick note', caption: 'Add a register note', bg: 'var(--card)', onClick: () => setModal('note') },
    { icon: 'bi-person', title: 'Customer', caption: 'Find or create customer', bg: 'var(--card)', onClick: () => setModal('customer') },
    { icon: 'bi-plus-circle', title: 'Custom item', caption: 'Enter description and price', bg: 'var(--card)', onClick: () => setModal('custom') },
  ];

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Left: actions + search + strip */}
      <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 24px Inter, sans-serif' }}>New sale</h1>
            <div style={{ color: 'var(--ink-3)', fontSize: 12, marginTop: 2 }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {user?.name}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/pending" style={{ textDecoration: 'none' }}>
              <Button variant="secondary">
                Pending Sale{' '}
                <span style={{ background: 'var(--line-soft)', borderRadius: 999, padding: '1px 8px', fontSize: 11 }}>{parkedCount}</span>
              </Button>
            </Link>
            <Link to="/repairs" style={{ textDecoration: 'none' }}>
              <Button variant="dark">
                Repairs <span style={{ background: 'var(--orange)', borderRadius: 999, padding: '1px 8px', fontSize: 11 }}>{takenIn.length}</span>
              </Button>
            </Link>
          </div>
        </div>

        <SearchBar onAddItem={addItem} onPickCustomer={(c) => setCustomer(c)} />

        <div style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em', margin: '18px 0 8px' }}>
          SMART ACTIONS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {smartActions.map((a) => (
            <button
              key={a.title}
              onClick={a.onClick}
              disabled={a.disabled}
              title={a.disabled ? 'Coming in a later phase' : undefined}
              style={{
                textAlign: 'left',
                background: a.bg,
                border: '1px solid var(--line-soft)',
                borderRadius: 14,
                padding: '14px 16px',
                opacity: a.disabled ? 0.5 : 1,
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <i className={`bi ${a.icon}`} style={{ fontSize: 17 }} />
              <div style={{ font: '700 14px Inter, sans-serif', marginTop: 8 }}>
                {a.title} <i className="bi bi-chevron-right" style={{ fontSize: 10, color: 'var(--ink-4)' }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{a.caption}</div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', margin: '20px 0 8px' }}>
          <span style={{ font: '600 10px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em' }}>
            TAKEN IN TODAY{' '}
            <span style={{ color: 'var(--orange)' }}>
              {takenIn.filter((t) => !['completed', 'cancelled', 'abandoned'].includes(t.status)).length} open
            </span>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {takenIn.map((t) => (
            <Link key={t.id} to="/repairs" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div style={{ background: 'var(--card)', borderRadius: 12, border: '1px solid var(--line-soft)', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ font: '600 12px Inter, sans-serif' }}>{t.customerName}</span>
                  <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>
                    {new Date(t.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3 }}>
                  <i className="bi bi-phone" style={{ fontSize: 10 }} /> {t.deviceSummary ?? t.number}
                </div>
              </div>
            </Link>
          ))}
          {takenIn.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>No repairs taken in yet.</div>}
        </div>
      </div>

      {/* Right: current sale */}
      <div
        style={{
          width: 360,
          flexShrink: 0,
          background: 'var(--card)',
          borderLeft: '1px solid var(--line-soft)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>Current sale</h2>
            <span style={{ background: 'var(--orange-soft)', color: 'var(--orange)', borderRadius: 999, padding: '2px 10px', font: '700 12px Inter, sans-serif' }}>
              {lines.reduce((n, l) => n + l.qty, 0)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
            {customer ? (
              <span>
                <i className="bi bi-person" /> {customer.name}{' '}
                <button onClick={() => setCustomer(null)} style={{ border: 'none', background: 'none', color: 'var(--red)', fontSize: 11 }}>
                  remove
                </button>
              </span>
            ) : (
              'Walk-in customer'
            )}
            {note && <span> · 📝 {note}</span>}
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          {lines.map((l) => (
            <div key={l.key} style={{ borderBottom: '1px solid var(--line-soft)', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ font: '600 13px Inter, sans-serif' }}>{l.description}</span>
                <span style={{ font: '700 13px Inter, sans-serif' }}>{formatCents(l.qty * l.unitCents - l.discountCents)}</span>
              </div>
              {l.detail && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{l.detail}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                {!l.serialized && (
                  <span style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8 }}>
                    <button onClick={() => updateQty(l.key, -1)} style={{ border: 'none', background: 'none', padding: '3px 9px' }}>−</button>
                    <span style={{ padding: '3px 4px', fontSize: 12, alignSelf: 'center' }}>{l.qty}</span>
                    <button onClick={() => updateQty(l.key, 1)} style={{ border: 'none', background: 'none', padding: '3px 9px' }}>+</button>
                  </span>
                )}
                <button
                  onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  style={{ border: 'none', background: 'none', color: 'var(--red)', fontSize: 11 }}
                >
                  Remove
                </button>
                {!l.taxable && <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>No tax</span>}
              </div>
            </div>
          ))}
          {lines.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontSize: 13, marginTop: 40 }}>
              <i className="bi bi-bag" style={{ fontSize: 26 }} />
              <div style={{ marginTop: 8 }}>Scan, search, or tap a smart action to start.</div>
            </div>
          )}
          {lines.length > 0 && (
            <button
              onClick={() => setModal('custom')}
              style={{
                width: '100%',
                marginTop: 10,
                padding: '10px 0',
                borderRadius: 10,
                border: '1px dashed var(--line)',
                background: 'var(--card)',
                color: 'var(--ink-2)',
                font: '600 12px Inter, sans-serif',
              }}
            >
              + Add custom item
            </button>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--line-soft)', padding: '14px 20px 18px' }}>
          {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)' }}>
            <span>Subtotal</span>
            <span>{formatCents(totals.subtotalCents)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>
            <span>Tax {(TAX_RATE_BP / 100).toFixed(0)}%</span>
            <span>{formatCents(totals.taxCents)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, alignItems: 'baseline' }}>
            <span style={{ font: '700 16px Inter, sans-serif' }}>Total</span>
            <span style={{ font: '800 24px Inter, sans-serif' }}>{formatCents(totals.totalCents)}</span>
          </div>
          <Button
            variant="primary"
            size="lg"
            style={{ width: '100%', marginTop: 12 }}
            disabled={lines.length === 0 || busy}
            onClick={() => setModal('payment')}
          >
            Take payment · {formatCents(totals.totalCents)}
          </Button>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button variant="secondary" style={{ flex: 1 }} disabled={lines.length === 0 || busy} onClick={() => void park()}>
              <i className="bi bi-pause-circle" /> Park sale
            </Button>
            <Button variant="ghost" style={{ flex: 1 }} disabled={lines.length === 0} onClick={clearSale}>
              Clear
            </Button>
          </div>
        </div>
      </div>

      <CustomItemModal
        open={modal === 'custom'}
        taxRateBp={TAX_RATE_BP}
        onClose={() => setModal(null)}
        onAdd={(item) =>
          setLines((prev) => [
            ...prev,
            { key: lineKey(), kind: 'custom', qty: 1, discountCents: 0, ...item },
          ])
        }
      />
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
      <PaymentModal
        open={modal === 'payment'}
        dueCents={totals.totalCents}
        customer={customer}
        busy={busy}
        onClose={() => setModal(null)}
        onComplete={(p) => void complete(p)}
      />

      <NewRepairWindow open={repairOpen} onClose={() => setRepairOpen(false)} onCreated={handleRepairCreated} />
      <DepositModal ticket={depositTicket} onClose={() => setDepositTicket(null)} onDone={() => void refreshSide()} />

      <Modal open={modal === 'note'} onClose={() => setModal(null)} width={380}>
        <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>Quick note</h2>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Shown on the parked sale"
          style={{ width: '100%', marginTop: 12, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13, resize: 'none' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <Button variant="primary" onClick={() => setModal(null)}>Save note</Button>
        </div>
      </Modal>

      {/* Completed-sale confirmation */}
      <Modal open={done !== null} onClose={() => setDone(null)} width={400}>
        {done && (
          <div style={{ textAlign: 'center' }}>
            <i className="bi bi-check-circle-fill" style={{ fontSize: 40, color: 'var(--green)' }} />
            <h2 style={{ margin: '10px 0 4px', font: '700 20px Inter, sans-serif' }}>Sale complete</h2>
            {done.changeCents != null && done.changeCents > 0 && (
              <div style={{ background: 'var(--green-bg)', color: 'var(--green)', borderRadius: 12, padding: '12px 0', margin: '12px 0', font: '800 26px Inter, sans-serif' }}>
                Change {formatCents(done.changeCents)}
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {done.printed ? 'Receipt sent to printer.' : 'Print bridge offline — receipt below.'}
            </div>
            {!done.printed && (
              <pre
                style={{
                  textAlign: 'left',
                  background: 'var(--line-soft)',
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 10.5,
                  fontFamily: 'ui-monospace, monospace',
                  maxHeight: 220,
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

/** Unified search bar: products add to cart, customers attach to the sale. */
function SearchBar({
  onAddItem,
  onPickCustomer,
}: {
  onAddItem: (item: PickableItem) => void;
  onPickCustomer: (c: CartCustomer) => void;
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
    <div style={{ position: 'relative', marginTop: 16 }}>
      <i className="bi bi-search" style={{ position: 'absolute', left: 14, top: 13, color: 'var(--ink-4)', fontSize: 14 }} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search phone, customer, product, or IMEI"
        style={{
          width: '100%',
          padding: '12px 14px 12px 38px',
          borderRadius: 12,
          border: '1px solid var(--line)',
          background: 'var(--card)',
          fontSize: 13,
        }}
      />
      {results && (results.customers.length > 0 || results.items.length > 0) && (
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
          {results.items.map((item) => (
            <button
              key={`i${item.id}`}
              onClick={() => {
                onAddItem(item);
                setQ('');
              }}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', padding: '10px 14px', border: 'none', background: 'none', textAlign: 'left' }}
            >
              <span style={{ fontSize: 13 }}>
                <i className="bi bi-box-seam" style={{ color: 'var(--ink-4)', marginRight: 8 }} />
                {item.name}
                {item.storage ? ` · ${item.storage}` : ''}
              </span>
              <span style={{ font: '600 13px Inter, sans-serif' }}>{formatCents(item.priceCents)}</span>
            </button>
          ))}
          {results.customers.map((c) => (
            <button
              key={`c${c.id}`}
              onClick={() => {
                onPickCustomer(c);
                setQ('');
              }}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', padding: '10px 14px', border: 'none', background: 'none', textAlign: 'left' }}
            >
              <span style={{ fontSize: 13 }}>
                <i className="bi bi-person" style={{ color: 'var(--ink-4)', marginRight: 8 }} />
                {c.name}
              </span>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{c.phone}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
