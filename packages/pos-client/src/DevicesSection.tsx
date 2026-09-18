import { useEffect, useState } from 'react';
import { Button } from '@fmp/ui';
import { api, session } from './api';
import { SecretField } from './SecretField';

interface Device { id: number; name: string; kind: 'pos' | 'bridge'; revoked: boolean; lastSeenAt: string | null; }

/** Store managers approve devices; pairing approval never changes the customer's shared scope. */
export function DevicesSection() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: string; kind: string } | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const isManager = session.user?.role === 'manager';

  async function load() {
    setLoading(true); setError('');
    try { setDevices(await api<Device[]>('/api/auth/terminals')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Devices could not be loaded'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (isManager) void load(); }, [isManager]);
  if (!isManager) return <p>Manager sign-in is required to manage this store's devices.</p>;

  async function issue(kind: 'pos' | 'bridge') {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { setPairing(await api('/api/auth/pairing', { method: 'POST', body: JSON.stringify({ kind }) })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Pairing code could not be created'); }
    finally { setBusy(false); }
  }
  async function revoke(device: Device) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/auth/terminals/' + device.id + '/revoke', { method: 'POST' });
      setConfirmId(null); setNotice(device.name + ' access revoked.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Access could not be revoked'); }
    finally { setBusy(false); }
  }

  return <section style={{ maxWidth: 720 }}>
    <p style={{ color: 'var(--ink-3)' }}>Pair registers and print bridges with this store. Codes expire after 15 minutes and work once.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Button disabled={busy} onClick={() => void issue('pos')}>Pair a register</Button>
      <Button disabled={busy} onClick={() => void issue('bridge')}>Pair a print bridge</Button>
      <Button disabled={busy || loading} onClick={() => void load()}>Refresh devices</Button>
    </div>
    {pairing && <div style={{ marginTop: 18, padding: 16, border: '1px solid var(--line)', borderRadius: 12 }}>
      <SecretField label={pairing.kind === 'pos' ? 'Register pairing code' : 'Print bridge pairing code'}
        value={pairing.pairingCode} readOnly onChange={() => {}} hint={'Expires ' + new Date(pairing.expiresAt).toLocaleTimeString() + '. Copy this code to the device you are approving.'} />
      <Button variant="ghost" onClick={() => setPairing(null)}>Hide pairing details</Button>
    </div>}
    <div role="status" style={{ minHeight: 24, marginTop: 12, color: 'var(--green)' }}>{notice}</div>
    {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    {loading ? <p role="status">Loading devices…</p> : devices.length === 0 ? <p>No devices paired yet.</p> :
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {devices.map(device => <li key={device.id} style={{ padding: '16px 0', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div><strong>{device.name}</strong><div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              {device.kind === 'bridge' ? 'Print bridge' : 'Register'} · {device.revoked ? 'Revoked' : 'Paired'}
              {device.id === session.user?.terminalId ? ' · This register' : ''}
            </div></div>
            {!device.revoked && device.id !== session.user?.terminalId && <Button variant="danger" disabled={busy}
              onClick={() => setConfirmId(device.id)}>Revoke access</Button>}
          </div>
          {confirmId === device.id && <div style={{ marginTop: 12 }}>
            <p>Revoke access for <strong>{device.name}</strong>? It will need a new pairing code to connect again.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button disabled={busy} onClick={() => setConfirmId(null)}>Keep access</Button>
              <Button variant="danger" disabled={busy} onClick={() => void revoke(device)}>Confirm revoke</Button>
            </div>
          </div>}
        </li>)}
      </ul>}
    <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>Use another authorized register to revoke this register's access.</p>
  </section>;
}
