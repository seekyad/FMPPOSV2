import { useEffect, useRef, useState } from 'react';
import type { AuthResponse } from '@fmp/shared';
import { Button } from '@fmp/ui';
import { api, ApiError, session, switchSystemUrl, type PosSystem } from './api';
import { SecretField } from './SecretField';
import { refreshBridgeStatus } from './labels';

interface Staff {
  id: number;
  name: string;
  initials: string;
  role: string;
}

/** First-run terminal setup + per-shift PIN lock screen + system choice. */
export function PinScreen({ system, onSignedIn }: { system: PosSystem; onSignedIn: () => void }) {
  const [loadingStaff, setLoadingStaff] = useState(true);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [terminalName, setTerminalName] = useState('Front counter');
  const [selected, setSelected] = useState<Staff | null>(null);
  const [pin, setPin] = useState('');
  const [pickingSystem, setPickingSystem] = useState(false);
  const [error, setError] = useState('');

  async function loadStaff() {
    setError('');
    const deviceToken = session.deviceToken;
    if (!deviceToken) { setNeedsSetup(true); setLoadingStaff(false); return; }
    setLoadingStaff(true);
    try {
      const res = await api<{ staff: Staff[] }>('/api/auth/staff', { headers: { 'X-Device-Token': deviceToken } });
      setNeedsSetup(false); setStaff(res.staff);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNeedsSetup(true);
      setError(e instanceof Error ? e.message : 'Staff could not be loaded');
    } finally { setLoadingStaff(false); }
  }

  useEffect(() => {
    void loadStaff();
  }, []);

  async function registerTerminal() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const res = await api<{ deviceToken: string; kind: string }>('/api/auth/terminal/register', {
        method: 'POST', body: JSON.stringify({ pairingCode, name: terminalName }),
      });
      if (res.kind !== 'pos') { setError('This code is for a print bridge. Ask for a register pairing code.'); return; }
      session.setDeviceToken(res.deviceToken); setPairingCode(''); setNeedsSetup(false);
      await loadStaff();
    } catch (e) { setError(e instanceof Error ? e.message : 'Device could not be paired'); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function submitPin(fullPin: string) {
    if (!selected || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const auth = await api<AuthResponse>('/api/auth/pin', {
        method: 'POST',
        body: JSON.stringify({ deviceToken: session.deviceToken, userId: selected.id, pin: fullPin }),
      });
      session.set(auth);
      setPickingSystem(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
      setPin('');
    } finally { inFlight.current = false; setBusy(false); }
  }

  function pickSystem(target: PosSystem) {
    if (target === system) {
      void refreshBridgeStatus();
      onSignedIn();
    } else {
      window.location.href = switchSystemUrl(target);
    }
  }

  function press(digit: string) {
    if (inFlight.current) return;
    setError('');
    const next = (pin + digit).slice(0, 4);
    setPin(next);
    if (next.length === 4) void submitPin(next);
  }

  const keypadKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--navy)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          background: '#fff',
          borderRadius: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '800 19.5px Inter, sans-serif',
          color: 'var(--navy)',
        }}
      >
        FMP
      </div>

      {pickingSystem ? (
        <>
          <div style={{ color: '#fff', font: '700 19.5px Inter, sans-serif' }}>
            Welcome, {session.user?.name?.split(' ')[0]} — which system?
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            {(
              [
                { id: 'repair' as const, icon: 'bi-wrench-adjustable', title: 'Repair shop', caption: 'Register · Repairs · Trade-ins' },
                { id: 'retail' as const, icon: 'bi-shop', title: 'Retail store', caption: 'Sales · Activations · Bill pay' },
              ]
            ).map((s) => (
              <button
                key={s.id}
                onClick={() => pickSystem(s.id)}
                style={{
                  width: 210,
                  padding: '26px 0 22px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  borderRadius: 18,
                  color: '#fff',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: 16,
                    background: s.id === 'repair' ? 'var(--orange)' : '#fff',
                    color: s.id === 'repair' ? '#fff' : 'var(--navy)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 25.5,
                  }}
                >
                  <i className={`bi ${s.icon}`} />
                </span>
                <span style={{ font: '700 17.5px Inter, sans-serif' }}>{s.title}</span>
                <span style={{ font: '500 12.5px Inter, sans-serif', color: '#9aa1ad' }}>{s.caption}</span>
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              session.clear();
              setPickingSystem(false);
              setSelected(null);
              setPin('');
            }}
            style={{ background: 'none', border: 'none', color: '#9aa1ad', font: '600 15px Inter, sans-serif' }}
          >
            ← Not you? Back to staff
          </button>
        </>
      ) : needsSetup ? (
        <form noValidate onSubmit={e => { e.preventDefault(); void registerTerminal(); }}
          style={{ background: '#fff', borderRadius: 20, padding: 28, width: 420, maxWidth: 'calc(100vw - 32px)' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 23 }}>Register this terminal</h2>
          <p style={{ color: 'var(--ink-3)' }}>Enter a register pairing code from your store manager. The code determines the store.</p>
          <label style={{ display: 'block', marginBottom: 12 }}>Terminal name
            <input value={terminalName} disabled={busy} onChange={e => setTerminalName(e.target.value)}
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 16, marginTop: 5 }} />
          </label>
          <SecretField label="Pairing code" value={pairingCode} onChange={setPairingCode} disabled={busy} error={error}
            hint="Codes expire after 15 minutes and can be used once." />
          <Button type="submit" variant="dark" size="lg" disabled={busy || !terminalName.trim() || !pairingCode.trim()}>
            {busy ? 'Pairing…' : 'Pair this register'}
          </Button>
        </form>
      ) : !selected ? (
        <>
          <div style={{ color: '#9aa1ad', font: '600 16px Inter, sans-serif' }}>Who's on the register?</div>
          {loadingStaff && <div role="status" style={{ color: '#fff' }}>Loading staff…</div>}
          {!loadingStaff && !error && staff.length === 0 && <div role="status" style={{ color: '#fff' }}>No active staff. Contact your manager to restore access.</div>}
          {error && <div role="alert" style={{ color: '#fca5a5' }}>{error} <Button disabled={loadingStaff} onClick={() => void loadStaff()}>Retry</Button></div>}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
            {staff.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s)}
                style={{
                  width: 120,
                  padding: '18px 0',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 16,
                  color: '#fff',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 999,
                    background: 'var(--orange)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    font: '700 17.5px Inter, sans-serif',
                  }}
                >
                  {s.initials}
                </span>
                <span style={{ font: '600 15px Inter, sans-serif' }}>{s.name}</span>
                <span style={{ font: '500 11.5px Inter, sans-serif', color: '#9aa1ad', textTransform: 'capitalize' }}>
                  {s.role}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
          <div style={{ color: '#fff', font: '600 17.5px Inter, sans-serif' }}>
            {selected.name} — enter PIN
          </div>
          <div style={{ background: 'var(--card)', color: 'var(--ink)', borderRadius: 12, padding: 12, width: 280 }}>
            <SecretField label="PIN" value={pin} disabled={busy} autoComplete="current-password" inputMode="numeric" maxLength={4}
              error={error} onChange={value => {
                if (inFlight.current) return;
                const digits = value.replace(/[^0-9]/g, '').slice(0, 4);
                setError(''); setPin(digits);
                if (digits.length === 4) void submitPin(digits);
              }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 10 }}>
            {keypadKeys.map((k, i) =>
              k === '' ? (
                <span key={i} />
              ) : (
                <button
                  key={i}
                  disabled={busy}
                  onClick={() => (k === '⌫' ? setPin((p) => p.slice(0, -1)) : press(k))}
                  style={{
                    height: 60,
                    borderRadius: 14,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#fff',
                    font: '600 23px Inter, sans-serif',
                  }}
                >
                  {k}
                </button>
              ),
            )}
          </div>
          <button
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setPin('');
              setError('');
            }}
            style={{ background: 'none', border: 'none', color: '#9aa1ad', font: '600 15px Inter, sans-serif' }}
          >
            ← Back to staff
          </button>
        </div>
      )}
    </div>
  );
}
