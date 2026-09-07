import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fmp/ui/tokens.css';
import './tailwind.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import { adoptSessionFromHash } from '@fmp/pos-client';
import { App } from './App';

adoptSessionFromHash();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/retail">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
