import { useState } from 'react';
import { CatalogTab } from '../SettingsScreen';
import { PricebookTab } from './PricebookTab';
import { StaffTab } from './StaffTab';
import { StoreTab } from './StoreTab';
import { TimeClockTab } from './TimeClockTab';

const TABS = [
  { id: 'catalog', label: 'Service catalog', icon: 'bi-wrench-adjustable' },
  { id: 'pricebook', label: 'Trade-in pricebook', icon: 'bi-arrow-left-right' },
  { id: 'timeclock', label: 'Time clock', icon: 'bi-clock-history' },
  { id: 'staff', label: 'Staff', icon: 'bi-people' },
  { id: 'store', label: 'Store & payments', icon: 'bi-shop' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function SettingsHub() {
  const [tab, setTab] = useState<TabId>('catalog');

  return (
    <div style={{ padding: '22px 24px', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <h1 style={{ margin: 0, font: '700 24px Inter, sans-serif' }}>More</h1>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: tab === t.id ? 'var(--navy)' : 'var(--card)',
              color: tab === t.id ? '#fff' : 'var(--ink-2)',
              font: '600 12px Inter, sans-serif',
            }}
          >
            <i className={`bi ${t.icon}`} style={{ fontSize: 12 }} />
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 14, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'pricebook' && <PricebookTab />}
        {tab === 'timeclock' && <TimeClockTab />}
        {tab === 'staff' && <StaffTab />}
        {tab === 'store' && <StoreTab />}
      </div>
    </div>
  );
}
