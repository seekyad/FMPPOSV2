import { subscribeSessionInvalidation } from '@fmp/pos-client';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomersScreen, DevicesSection, InventoryScreen, PinScreen, session } from '@fmp/pos-client';
import { Sidebar } from './Sidebar';
import { SalesScreen } from './SalesScreen';
import { ActivationsScreen } from './ActivationsScreen';
import { BillPaymentsScreen } from './BillPaymentsScreen';

export function App() {
  const [signedIn, setSignedIn] = useState(() => Boolean(session.token && session.user));

  useEffect(()=>{
    const unsubscribe=subscribeSessionInvalidation(()=>setSignedIn(false));
    const changed=()=>{if(!session.token || !session.user)setSignedIn(false);};
    window.addEventListener('storage',changed);
    return ()=>{unsubscribe();window.removeEventListener('storage',changed);};
  },[]);

  if (!signedIn) {
    return <PinScreen system="retail" onSignedIn={() => setSignedIn(true)} />;
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
          <Route path="/devices" element={<div style={{ padding: 24 }}><h1>Registers &amp; bridges</h1><DevicesSection /></div>} />
        </Routes>
      </main>
    </div>
  );
}
