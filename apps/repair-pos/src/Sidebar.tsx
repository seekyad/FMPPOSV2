import { NavLink } from 'react-router-dom';
import { switchSystemUrl } from '@fmp/pos-client';

const NAV = [
  { to: '/register', icon: 'bi-cash-stack', label: 'Register' },
  { to: '/repairs', icon: 'bi-wrench-adjustable', label: 'Repairs' },
  { to: '/inventory', icon: 'bi-box-seam', label: 'Inventory' },
  { to: '/customers', icon: 'bi-people', label: 'Customers' },
  { to: '/reports', icon: 'bi-bar-chart', label: 'Reports' },
  { to: '/more', icon: 'bi-three-dots', label: 'More' },
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
          background: '#fff',
          borderRadius: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '700 13px Inter, sans-serif',
          color: 'var(--navy)',
        }}
      >
        FMP
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
            <i className={`bi ${item.icon}`} style={{ fontSize: 19 }} />
            <span style={{ font: '600 8.5px Inter, sans-serif', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {item.label}
            </span>
          </NavLink>
        ))}
      </div>
      <button
        onClick={() => {
          window.location.href = switchSystemUrl('retail');
        }}
        title="Switch to Retail store"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#9aa1ad',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 5,
          marginBottom: 14,
        }}
      >
        <i className="bi bi-shop" style={{ fontSize: 18 }} />
        <span style={{ font: '600 8.5px Inter, sans-serif', letterSpacing: '0.06em' }}>RETAIL</span>
      </button>
      <button
        onClick={onLock}
        title="Lock / switch user"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#9aa1ad',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <i className="bi bi-lock" style={{ fontSize: 18 }} />
        <span style={{ font: '600 8.5px Inter, sans-serif', letterSpacing: '0.06em' }}>LOCK</span>
      </button>
    </nav>
  );
}
