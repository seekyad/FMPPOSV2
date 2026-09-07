import { useEffect, useMemo, useState } from 'react';
import { computeTotals, formatCents } from '@fmp/shared';
import { Button, Modal } from '@fmp/ui';
import { useRef } from 'react';
import {
  api,
  session,
  lineKey,
  CustomerModal,
  InventoryPickerModal,
  RingUpPad,
  useNarrow,
  type CartCustomer,
  type CartLine,
  type PaymentDraft,
  type PickableItem,
  type RingUpPadHandle,
} from '@fmp/pos-client';

type OpenModal = null | 'customer' | 'accessory' | 'device';

/** Retail register: device & accessory sales on the shared inventory. */
export function SalesScreen() {
  const user = session.user;
  const narrow = useNarrow();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [modal, setModal] = useState<OpenModal>(null);
  const [busy, setBusy] = useState(false);
  const [taxRateBp, setTaxRateBp] = useState(600);
  const ringUpRef = useRef<RingUpPadHandle>(null);
  const [done, setDone] = useState<null | { changeCents: number | null; receiptText: string; printed: boolean }>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<{ taxRateBp: number }>('/api/settings/store')
      .then((s) => setTaxRateBp(s.taxRateBp))
      .catch(() => {});
  }, []);

  const totals = useMemo(
    () =>
      computeTotals(
        lines.map((l) => ({ qty: l.qty, unitCents: l.unitCents, taxable: l.taxable, discountCents: l.discountCents })),
        taxRateBp,
      ),
    [lines, taxRateBp],
  );

  function addItem(item: PickableItem) {
    setLines((prev) => {
      if (item.kind !== 'device') {
        const existing = prev.find((l) => l.inventoryItemId === item.id);
        if (existing) {
          if (existing.qty >= item.qty) return prev;
          return prev.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
        }
      } else if (prev.some((l) => l.inventoryItemId === item.id)) {
        return prev;
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
          }),
        },
      );
      setModal(null);
      setDone(res);
      setLines([]);
      setCustomer(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sale failed');
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  /** Ring-up pad card fast path: add the punched amount (if any) and complete as card. */
  function collectCard(item: { description: string; unitCents: number; taxable: boolean } | null) {
    const effective = item
      ? [...lines, { key: lineKey(), kind: 'custom' as const, qty: 1, discountCents: 0, ...item }]
      : lines;
    if (effective.length === 0) return;
    setError('');
    setLines(effective);
    const t = computeTotals(
      effective.map((l) => ({ qty: l.qty, unitCents: l.unitCents, taxable: l.taxable, discountCents: l.discountCents })),
      taxRateBp,
    );
    void complete([{ method: 'card', amountCents: t.totalCents }], effective);
  }

  const tiles = [
    { icon: 'bi-phone', title: 'Device sale', caption: 'Phones, tablets, wifi boxes', bg: 'var(--green-bg)', onClick: () => setModal('device') },
    { icon: 'bi-lightning-charge', title: 'Accessory', caption: 'Cases, chargers, glass', bg: 'var(--blue-bg)', onClick: () => setModal('accessory') },
    { icon: 'bi-person', title: 'Customer', caption: 'Find or create customer', bg: 'var(--card)', onClick: () => setModal('customer') },
    { icon: 'bi-plus-circle', title: 'Custom item', caption: 'Use the ring-up pad above', bg: 'var(--card)', onClick: () => ringUpRef.current?.focus() },
  ];

  const renderTile = (a: (typeof tiles)[number]) => (
    <button
      key={a.title}
      onClick={a.onClick}
      style={{ textAlign: 'left', background: a.bg, border: '1px solid var(--line-soft)', borderRadius: 14, padding: '16px 18px', boxShadow: 'var(--shadow-card)' }}
    >
      <i className={`bi ${a.icon}`} style={{ fontSize: 20.5 }} />
      <div style={{ font: '700 17.5px Inter, sans-serif', marginTop: 8 }}>{a.title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>{a.caption}</div>
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
      <div style={{ flex: narrow ? '0 0 auto' : 1, minWidth: 0, padding: '22px 24px', overflow: narrow ? 'visible' : 'auto' }}>
        <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>New sale</h1>
        <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {user?.name}
        </div>
        {/* Primary selling tiles live right above the register */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 16 }}>
          {tiles.slice(0, 2).map(renderTile)}
        </div>
        <RingUpPad
          ref={ringUpRef}
          taxRateBp={taxRateBp}
          subtotalCents={totals.subtotalCents}
          taxCents={totals.taxCents}
          totalCents={totals.totalCents}
          customer={customer}
          busy={busy}
          onAdd={(item) =>
            setLines((prev) => [...prev, { key: lineKey(), kind: 'custom', qty: 1, discountCents: 0, ...item }])
          }
          onCollectCard={collectCard}
          onComplete={(p) => void complete(p)}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 16 }}>
          {tiles.slice(2).map(renderTile)}
        </div>
      </div>

      <div
        style={{
          width: narrow ? '100%' : 340,
          flexShrink: 0,
          background: 'var(--card)',
          borderLeft: narrow ? 'none' : '1px solid var(--line-soft)',
          borderTop: narrow ? '1px solid var(--line-soft)' : 'none',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>Current sale</h2>
            <button
              onClick={() => {
                setLines([]);
                setCustomer(null);
              }}
              disabled={lines.length === 0}
              style={{
                border: '1px solid var(--line)',
                background: 'var(--card)',
                color: lines.length === 0 ? 'var(--ink-4)' : 'var(--red)',
                borderRadius: 10,
                padding: '7px 14px',
                font: '600 13.5px Inter, sans-serif',
                opacity: lines.length === 0 ? 0.5 : 1,
              }}
            >
              <i className="bi bi-x-circle" /> Clear
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>
            {customer ? (
              <span>
                <i className="bi bi-person" /> {customer.name}{' '}
                <button onClick={() => setCustomer(null)} style={{ border: 'none', background: 'none', color: 'var(--red)', fontSize: 12.5 }}>remove</button>
              </span>
            ) : (
              'Walk-in customer'
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          {lines.map((l) => (
            <div key={l.key} style={{ borderBottom: '1px solid var(--line-soft)', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ font: '600 15px Inter, sans-serif' }}>{l.description}</span>
                <span style={{ font: '700 15px Inter, sans-serif' }}>{formatCents(l.qty * l.unitCents)}</span>
              </div>
              {l.detail && <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{l.detail}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                {!l.serialized && (
                  <span style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8 }}>
                    <button onClick={() => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} style={{ border: 'none', background: 'none', padding: '3px 9px' }}>−</button>
                    <span style={{ padding: '3px 4px', fontSize: 14 }}>{l.qty}</span>
                    <button onClick={() => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))} style={{ border: 'none', background: 'none', padding: '3px 9px' }}>+</button>
                  </span>
                )}
                <button onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))} style={{ border: 'none', background: 'none', color: 'var(--red)', fontSize: 12.5 }}>Remove</button>
              </div>
            </div>
          ))}
          {lines.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontSize: 15, marginTop: 40 }}>
              <i className="bi bi-bag" style={{ fontSize: 30 }} />
              <div style={{ marginTop: 8 }}>Tap a tile to start the sale.</div>
            </div>
          )}
        </div>
        {error && (
          <div style={{ borderTop: '1px solid var(--line-soft)', padding: '10px 20px', color: 'var(--red)', fontSize: 14 }}>
            {error}
          </div>
        )}
      </div>

      <CustomerModal open={modal === 'customer'} onClose={() => setModal(null)} onPick={setCustomer} />
      <InventoryPickerModal open={modal === 'accessory'} tab="accessories" title="Add accessory" onClose={() => setModal(null)} onPick={addItem} />
      <InventoryPickerModal open={modal === 'device'} tab="phones" title="Device sale" onClose={() => setModal(null)} onPick={addItem} />

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
            {!done.printed && (
              <pre style={{ textAlign: 'left', background: 'var(--line-soft)', borderRadius: 10, padding: 12, fontSize: 12, fontFamily: 'ui-monospace, monospace', overflow: 'auto', userSelect: 'text' }}>
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
