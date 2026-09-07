import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PinScreen } from '@fmp/pos-client';
import { Sidebar } from './Sidebar';
import { session } from '@fmp/pos-client';
import { RegisterScreen } from './screens/register/RegisterScreen';
import { PendingSalesScreen } from './screens/PendingSalesScreen';
import { CustomersScreen } from '@fmp/pos-client';
import { InventoryScreen } from '@fmp/pos-client';
import { RepairsScreen } from './screens/repairs/RepairsScreen';
import { SettingsHub } from './screens/settings/SettingsHub';
import { ReportsScreen } from './screens/ReportsScreen';

function Placeholder({ title }: { title: string }) {
  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ margin: 0, font: '700 26px Inter, sans-serif' }}>{title}</h1>
      <p style={{ color: 'var(--ink-3)' }}>Coming in the next phase.</p>
    </div>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => Boolean(session.token));

  if (!signedIn) {
    return <PinScreen onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        onLock={() => {
          session.clear();
          setSignedIn(false);
        }}
      />
      <main style={{ flex: 1, minWidth: 0 }}>
        <Routes>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={<RegisterScreen />} />
          <Route path="/pending" element={<PendingSalesScreen />} />
          <Route path="/repairs" element={<RepairsScreen />} />
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/customers" element={<CustomersScreen />} />
          <Route path="/reports" element={<ReportsScreen />} />
          <Route path="/more" element={<SettingsHub />} />
        </Routes>
      </main>
    </div>
  );
}
