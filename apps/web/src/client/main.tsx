// Gateway bootstrap MUST be first — it captures the session token from the
// URL fragment (before HashRouter treats it as a route) and installs
// window.accomplish before store modules evaluate their subscriptions.
import './lib/gateway-bootstrap-init';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { initI18n } from './i18n';
import { router } from './router';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);

initI18n().then(() => {
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
