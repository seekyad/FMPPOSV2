import { useEffect, useState } from 'react';
import type { AuthResponse } from '@fmp/shared';
import { Button } from '@fmp/ui';
import { api, session, switchSystemUrl, type PosSystem } from './api';

interface Staff {
  id: number;
  name: string;
  initials: string;
  role: string;
}

/** First-run terminal setup + per-shift PIN lock screen + system choice. */
export function PinScreen({ system, onSignedIn }: { system: PosSystem; onSignedIn: () => void }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [stores, setStores] = useState<{ id: number; name: string }[]>([]);
  const [terminalName, setTerminalName] = useState('Front counter');
  const [selected, setSelected] = useState<Staff | null>(null);
  const [pin, setPin] = useState('');
  const [pickingSystem, setPickingSystem] = useState(false);
  const [error, setError] = useState('');

  async function loadStaff() {
    const deviceToken = session.deviceToken;
    if (!deviceToken) {
      setNeedsSetup(true);
      setStores(await api('/api/auth/stores'));
      return;
    }
    try {
      const res = await api<{ staff: Staff[] }>(`/api/auth/staff?deviceToken=${deviceToken}`);
      setStaff(res.staff);
    } catch {
      setNeedsSetup(true);
      setStores(await api('/api/auth/stores'));
    }
  }

  useEffect(() => {
    void loadStaff();
  }, []);

  async function registerTerminal(storeId: number) {
    const res = await api<{ deviceToken: string }>('/api/auth/terminal/register', {
      method: 'POST',
      body: JSON.stringify({ storeId, name: terminalName }),
    });
    session.setDeviceToken(res.deviceToken);
    setNeedsSetup(false);
    await loadStaff();
  }

  async function submitPin(fullPin: string) {
    if (!selected) return;
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
    }
  }

  function pickSystem(target: PosSystem) {
    if (target === system) {
      onSignedIn();
    } else {
      window.location.href = switchSystemUrl(target);
    }
  }

  function press(digit: string) {
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
        <div style={{ background: '#fff', borderRadius: 20, padding: 28, width: 380 }}>
          <h2 style={{ margin: '0 0 4px', font: '700 23px Inter, sans-serif' }}>Register this terminal</h2>
          <p style={{ margin: '0 0 16px', color: 'var(--ink-3)', fontSize: 15 }}>
            One-time setup: pick the store this device belongs to.
          </p>
          <input
            value={terminalName}
            onChange={(e) => setTerminalName(e.target.value)}
            placeholder="Terminal name"
            style={{
              width: '100%',
              padding: '12px 14px',
              borderRadius: 10,
              border: '1px solid var(--line)',
              fontSize: 16,
              marginBottom: 12,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stores.map((s) => (
              <Button key={s.id} variant="dark" size="lg" onClick={() => void registerTerminal(s.id)}>
                {s.name}
              </Button>
            ))}
          </div>
        </div>
      ) : !selected ? (
        <>
          <div style={{ color: '#9aa1ad', font: '600 16px Inter, sans-serif' }}>Who's on the register?</div>
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
          <div style={{ display: 'flex', gap: 10 }}>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: i < pin.length ? 'var(--orange)' : 'rgba(255,255,255,0.15)',
                }}
              />
            ))}
          </div>
          {error && <div style={{ color: '#fca5a5', fontSize: 15 }}>{error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 10 }}>
            {keypadKeys.map((k, i) =>
              k === '' ? (
                <span key={i} />
              ) : (
                <button
                  key={i}
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
