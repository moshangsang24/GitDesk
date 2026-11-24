import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ContextMenuHost } from './features/menus/ContextMenuHost';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ContextMenuHost />
  </StrictMode>,
);
