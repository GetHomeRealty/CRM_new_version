import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/desk.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    {/*
      Last resort. The boundary inside DeskLayout handles a page failing to render and keeps the
      navigation usable; this one exists for what sits above it — the router, the auth provider,
      the layout shell itself. There is no navigation left to offer at that point, so its
      fallback can only explain and offer a reload, which still beats a blank document.
    */}
    <ErrorBoundary what="The application">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
