import { useEffect, useState } from 'react';
import { formatCents, parseDollars } from '@fmp/shared';
import { Button, DataTable, Modal } from '@fmp/ui';
import { api, CustomerModal, type CartCustomer } from '@fmp/pos-client';

interface BillPayment {
  id: number;
  carrier: string;
  accountNumber: string;
  amountCents: number;
  feeCents: number;
  createdAt: string;
  customerName: string | null;
  userName: string | null;
}

export function BillPaymentsScreen() {
  const [rows, setRows] = useState<BillPayment[]>([]);
  const [today, setToday] = useState({ count: 0, amountCents: 0, feeCents: 0 });
  const [taking, setTaking] = useState(false);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [form, setForm] = useState({ carrier: '', accountNumber: '', amount: '', fee: '', method: 'cash' as 'cash' | 'card' | 'tap', tendered: '' });
  const [result, setResult] = useState<null | { changeCents: number | null }>(null);
  const [error, setError] = useState('');

  async function load() {
    const res = await api<{ rows: BillPayment[]; today: typeof today }>('/api/retail/bill-payments').catch(() => null);
    if (res) {
      setRows(res.rows);
      setToday(res.today);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const amountCents = parseDollars(form.amount || '0') ?? 0;
  const feeCents = parseDollars(form.fee || '0') ?? 0;
  const total = amountCents + feeCents;
  const tenderedCents = parseDollars(form.tendered || '0') ?? 0;
  const change = form.method === 'cash' && tenderedCents > 0 ? tenderedCents - total : null;

  async function take() {
    if (!form.carrier.trim() || !form.accountNumber.trim() || amountCents <= 0) {
      setError('Carrier, account number, and amount are required.');
      return;
    }
    try {
      const res = await api<{ changeCents: number | null }>('/api/retail/bill-payments', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer?.id ?? null,
          carrier: form.carrier.trim(),
          accountNumber: form.accountNumber.trim(),
          amountCents,
          feeCents,
          method: form.method,
          tenderedCents: form.method === 'cash' && tenderedCents > 0 ? tenderedCents : null,
        }),
      });
      setTaking(false);
      setResult(res);
      setForm({ carrier: '', accountNumber: '', amount: '', fee: '', method: 'cash', tendered: '' });
      setCustomer(null);
      setError('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed');
    }
  }

  return (
    <div style={{ padding: '22px 24px', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, font: '700 27.5px Inter, sans-serif' }}>Bill payments</h1>
          <div style={{ color: 'var(--ink-3)', fontSize: 14, marginTop: 2 }}>
            Today: {today.count} payments · {formatCents(today.amountCents)} remitted · {formatCents(today.feeCents)} fees
          </div>
        </div>
        <Button variant="primary" onClick={() => setTaking(true)}>
          <i className="bi bi-plus-lg" /> Take payment
        </Button>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <DataTable
          columns={[
            {
              key: 'date',
              label: 'Date',
              sortValue: (r: BillPayment) => new Date(r.createdAt).getTime(),
              render: (r: BillPayment) => (
                <span style={{ color: 'var(--ink-3)' }}>
                  {new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              ),
            },
            {
              key: 'customer',
              label: 'Customer',
              sortValue: (r: BillPayment) => r.customerName ?? 'Walk-in',
              render: (r: BillPayment) => <span style={{ font: '600 15px Inter, sans-serif' }}>{r.customerName ?? 'Walk-in'}</span>,
            },
            {
              key: 'carrier',
              label: 'Carrier',
              sortValue: (r: BillPayment) => r.carrier,
              render: (r: BillPayment) => r.carrier,
            },
            {
              key: 'account',
              label: 'Account #',
              sortValue: (r: BillPayment) => r.accountNumber,
              render: (r: BillPayment) => <span style={{ color: 'var(--ink-3)' }}>…{r.accountNumber.slice(-4)}</span>,
            },
            {
              key: 'amount',
              label: 'Amount',
              align: 'right',
              sortValue: (r: BillPayment) => r.amountCents,
              render: (r: BillPayment) => <b>{formatCents(r.amountCents)}</b>,
            },
            {
              key: 'fee',
              label: 'Fee',
              align: 'right',
              sortValue: (r: BillPayment) => r.feeCents,
              render: (r: BillPayment) => (r.feeCents > 0 ? formatCents(r.feeCents) : '—'),
            },
            {
              key: 'takenBy',
              label: 'Taken by',
              sortValue: (r: BillPayment) => r.userName ?? '',
              render: (r: BillPayment) => <span style={{ color: 'var(--ink-3)' }}>{r.userName}</span>,
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          searchText={(r) => `${r.customerName ?? ''} ${r.accountNumber} ${r.carrier}`}
          searchPlaceholder="Search customer, account #, or carrier"
          initialSort={{ key: 'date', dir: 'desc' }}
          emptyText="No bill payments recorded."
          footer={
            <span>
              Today: {today.count} payments · {formatCents(today.amountCents)} remitted · {formatCents(today.feeCents)} in fees
            </span>
          }
        />
      </div>

      <Modal open={taking} onClose={() => setTaking(false)} width={420}>
        <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>Take bill payment</h2>
        <button
          onClick={() => setPickingCustomer(true)}
          style={{ width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', textAlign: 'left', fontSize: 15 }}
        >
          {customer ? <span><b>{customer.name}</b> · {customer.phone}</span> : <span style={{ color: 'var(--ink-3)' }}><i className="bi bi-person" /> Attach customer (optional)</span>}
        </button>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
          <input value={form.carrier} onChange={(e) => setForm((p) => ({ ...p, carrier: e.target.value }))} placeholder="Carrier * — Boost" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
          <input value={form.accountNumber} onChange={(e) => setForm((p) => ({ ...p, accountNumber: e.target.value }))} placeholder="Account # *" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
          <input value={form.amount} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} placeholder="Bill amount $ *" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
          <input value={form.fee} onChange={(e) => setForm((p) => ({ ...p, fee: e.target.value }))} placeholder="Service fee $" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {(['cash', 'card', 'tap'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setForm((p) => ({ ...p, method: m }))}
              style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid var(--line)', background: form.method === m ? 'var(--navy)' : 'var(--card)', color: form.method === m ? '#fff' : 'var(--ink-2)', font: '600 14px Inter, sans-serif', textTransform: 'capitalize' }}
            >
              {m}
            </button>
          ))}
        </div>
        {form.method === 'cash' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <input value={form.tendered} onChange={(e) => setForm((p) => ({ ...p, tendered: e.target.value }))} placeholder="Cash tendered $" style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 15 }} />
            {change != null && (
              <span style={{ font: '700 15px Inter, sans-serif', color: change >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {change >= 0 ? `Change ${formatCents(change)}` : `Short ${formatCents(-change)}`}
              </span>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, padding: '10px 14px', background: 'var(--line-soft)', borderRadius: 10 }}>
          <span style={{ font: '600 15px Inter, sans-serif' }}>Total to collect</span>
          <span style={{ font: '800 18.5px Inter, sans-serif' }}>{formatCents(total)}</span>
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 14, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setTaking(false)}>Cancel</Button>
          <Button variant="primary" disabled={total <= 0} onClick={() => void take()}>
            Collect {formatCents(total)}
          </Button>
        </div>
      </Modal>

      <Modal open={result !== null} onClose={() => setResult(null)} width={320}>
        {result && (
          <div style={{ textAlign: 'center' }}>
            <i className="bi bi-check-circle-fill" style={{ fontSize: 39, color: 'var(--green)' }} />
            <h2 style={{ margin: '8px 0 4px', font: '700 20.5px Inter, sans-serif' }}>Payment recorded</h2>
            {result.changeCents != null && result.changeCents > 0 && (
              <div style={{ background: 'var(--green-bg)', color: 'var(--green)', borderRadius: 12, padding: '10px 0', margin: '10px 0', font: '800 25.5px Inter, sans-serif' }}>
                Change {formatCents(result.changeCents)}
              </div>
            )}
            <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>Remember to pay the bill on the carrier portal.</div>
            <Button variant="primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setResult(null)}>Done</Button>
          </div>
        )}
      </Modal>

      <CustomerModal open={pickingCustomer} onClose={() => setPickingCustomer(false)} onPick={setCustomer} />
    </div>
  );
}
