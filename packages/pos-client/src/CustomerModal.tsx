import { useEffect, useState } from 'react';
import { Button, Modal } from '@fmp/ui';
import { api } from './api';
import type { CartCustomer } from './cart';

/** Find-or-create customer, used to attach a customer to the sale. */
export function CustomerModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (customer: CartCustomer) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CartCustomer[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const res = await api<{ customers: CartCustomer[] }>(
        `/api/sales/search/all?q=${encodeURIComponent(query)}`,
      ).catch(() => ({ customers: [] }));
      setResults(res.customers);
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);

  async function create() {
    if (!name.trim()) return;
    const row = await api<CartCustomer>('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), phone: phone.trim() || null }),
    });
    onPick(row);
    setCreating(false);
    setName('');
    setPhone('');
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} width={420}>
      <h2 style={{ margin: 0, font: '700 18px Inter, sans-serif' }}>Customer</h2>
      {!creating ? (
        <>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or phone"
            style={{ width: '100%', marginTop: 12, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
            {results.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  onPick(c);
                  onClose();
                }}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                }}
              >
                <div style={{ font: '600 13px Inter, sans-serif' }}>{c.name}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{c.phone ?? 'no phone'}</div>
              </button>
            ))}
            {query.length >= 2 && results.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: 8 }}>No matches.</div>
            )}
          </div>
          <Button variant="secondary" style={{ marginTop: 12, width: '100%' }} onClick={() => setCreating(true)}>
            <i className="bi bi-person-plus" /> New customer
          </Button>
        </>
      ) : (
        <>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name *"
            style={{ width: '100%', marginTop: 12, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            style={{ width: '100%', marginTop: 8, padding: '11px 13px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
              Create & attach
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
