import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PinScreen } from './PinScreen';
import { Sidebar } from './Sidebar';
import { session } from './api';

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
          <Route path="/register" element={<Placeholder title="Register" />} />
          <Route path="/repairs" element={<Placeholder title="Repairs" />} />
          <Route path="/inventory" element={<Placeholder title="Inventory" />} />
          <Route path="/customers" element={<Placeholder title="Customers" />} />
          <Route path="/reports" element={<Placeholder title="Reports" />} />
          <Route path="/more" element={<Placeholder title="More" />} />
        </Routes>
      </main>
    </div>
  );
}
