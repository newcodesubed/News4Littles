import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AdminAuthProvider } from './admin/AdminAuthContext';
import { SettingsProvider } from './settings/SettingsContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SettingsProvider>
        <AdminAuthProvider>
          <App />
        </AdminAuthProvider>
      </SettingsProvider>
    </BrowserRouter>
  </StrictMode>,
);
