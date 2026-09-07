import { NavLink } from 'react-router-dom';
import { switchSystemUrl } from '@fmp/pos-client';

const NAV = [
  { to: '/sales', icon: 'bi-cash-stack', label: 'Sales' },
  { to: '/activations', icon: 'bi-sim', label: 'Activate' },
  { to: '/bills', icon: 'bi-receipt', label: 'Bills' },
  { to: '/inventory', icon: 'bi-box-seam', label: 'Inventory' },
  { to: '/customers', icon: 'bi-people', label: 'Customers' },
];

export function Sidebar({ onLock }: { onLock: () => void }) {
  return (
    <nav
      style={{
        width: 'var(--sidebar-w)',
        background: 'var(--navy)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 18,
        paddingBottom: 18,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          background: 'var(--orange)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          font: '700 14px Inter, sans-serif',
          color: '#fff',
          lineHeight: 1.1,
        }}
      >
        FMP
        <span style={{ font: '700 8px Inter, sans-serif', letterSpacing: '0.1em' }}>RETAIL</span>
      </div>
      <div style={{ marginTop: 34, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, flex: 1 }}>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={({ isActive }) => ({
              width: 64,
              padding: '10px 0',
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 5,
              textDecoration: 'none',
              background: isActive ? '#fff' : 'transparent',
              color: isActive ? 'var(--navy)' : '#9aa1ad',
            })}
          >
            <i className={`bi ${item.icon}`} style={{ fontSize: 22 }} />
            <span style={{ font: '600 10px Inter, sans-serif', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {item.label}
            </span>
          </NavLink>
        ))}
      </div>
      <button
        onClick={() => {
          window.location.href = switchSystemUrl('repair');
        }}
        title="Switch to Repair shop"
        style={{ background: 'transparent', border: 'none', color: '#9aa1ad', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, marginBottom: 14 }}
      >
        <i className="bi bi-wrench-adjustable" style={{ fontSize: 20.5 }} />
        <span style={{ font: '600 10px Inter, sans-serif', letterSpacing: '0.06em' }}>REPAIR</span>
      </button>
      <button
        onClick={onLock}
        title="Lock / switch user"
        style={{ background: 'transparent', border: 'none', color: '#9aa1ad', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}
      >
        <i className="bi bi-lock" style={{ fontSize: 20.5 }} />
        <span style={{ font: '600 10px Inter, sans-serif', letterSpacing: '0.06em' }}>LOCK</span>
      </button>
    </nav>
  );
}
