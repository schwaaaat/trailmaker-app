import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { getWorker } from './worker/client';

const worker = getWorker();
if (import.meta.env.MODE === 'test') Object.assign(window, { __trailmakerWorker: worker });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
