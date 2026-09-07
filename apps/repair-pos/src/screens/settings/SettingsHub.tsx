import { useState } from 'react';
import { PricebookTab } from './PricebookTab';
import { StaffTab } from './StaffTab';
import { TimeClockTab } from './TimeClockTab';
import { PaymentsSection, ReceiptsPrintingSection, StoreProfileSection, TaxesSection } from './StoreSections';

const SECTIONS = [
  { id: 'store', label: 'Store profile', icon: 'bi-shop' },
  { id: 'taxes', label: 'Taxes', icon: 'bi-percent' },
  { id: 'printing', label: 'Receipts & printing', icon: 'bi-printer' },
  { id: 'payments', label: 'Payments & terminal', icon: 'bi-credit-card' },
  { id: 'staff', label: 'Users & PINs', icon: 'bi-person-badge' },
  { id: 'timeclock', label: 'Time clock', icon: 'bi-clock-history' },
  { id: 'pricebook', label: 'Trade-in pricebook', icon: 'bi-arrow-left-right' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** Settings: vertical sections navigation, matching the approved design. */
export function SettingsHub() {
  const [section, setSection] = useState<SectionId>('store');
  const active = SECTIONS.find((s) => s.id === section)!;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ width: 264, flexShrink: 0, borderRight: '1px solid var(--line-soft)', background: 'var(--card)', padding: '24px 16px', overflow: 'auto' }}>
        <div style={{ font: '600 11.5px Inter, sans-serif', color: 'var(--ink-4)', letterSpacing: '0.08em', padding: '0 12px', marginBottom: 10 }}>
          SECTIONS
        </div>
        {SECTIONS.map((s) => {
          const isActive = section === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '13px 12px',
                borderRadius: 12,
                border: 'none',
                background: isActive ? 'var(--orange-soft)' : 'transparent',
                color: isActive ? 'var(--orange)' : 'var(--ink-2)',
                font: `600 15px Inter, sans-serif`,
                textAlign: 'left',
                marginBottom: 2,
              }}
            >
              <i className={`bi ${s.icon}`} style={{ fontSize: 17 }} />
              {s.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minWidth: 0, padding: '24px 28px', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <h1 style={{ margin: '0 0 18px', font: '700 26px Inter, sans-serif' }}>{active.label}</h1>
        {section === 'store' && <StoreProfileSection />}
        {section === 'taxes' && <TaxesSection />}
        {section === 'printing' && <ReceiptsPrintingSection />}
        {section === 'payments' && <PaymentsSection />}
        {section === 'staff' && <StaffTab />}
        {section === 'timeclock' && <TimeClockTab />}
        {section === 'pricebook' && <PricebookTab />}
      </div>
    </div>
  );
}
