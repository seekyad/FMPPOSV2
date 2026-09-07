import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomersScreen, InventoryScreen, PinScreen, session } from '@fmp/pos-client';
import { Sidebar } from './Sidebar';
import { SalesScreen } from './SalesScreen';
import { ActivationsScreen } from './ActivationsScreen';
import { BillPaymentsScreen } from './BillPaymentsScreen';

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
          <Route path="/" element={<Navigate to="/sales" replace />} />
          <Route path="/sales" element={<SalesScreen />} />
          <Route path="/activations" element={<ActivationsScreen />} />
          <Route path="/bills" element={<BillPaymentsScreen />} />
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/customers" element={<CustomersScreen />} />
        </Routes>
      </main>
    </div>
  );
}
