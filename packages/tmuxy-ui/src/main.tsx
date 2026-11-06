import ReactDOM from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { AppProvider } from './machines/AppContext';
import { applyTheme } from './infra/themeManager';
import { loadThemePref } from './infra/prefs';
import { isTauri } from './infra/platform';
import { registerPushWorker } from './infra/pushNotifications';
import './fonts/nerd-font.css';
import './standalone.css';

// In the desktop app the page root is transparent so the OS window (blurred
// on macOS) shows through whatever alpha the surfaces leave; in a browser it
// stays opaque (standalone.css).
if (isTauri()) document.documentElement.dataset.desktop = '';

registerPushWorker();

// Apply saved theme (or defaults) before first render to avoid FOUC
const savedTheme = loadThemePref();
applyTheme(savedTheme.theme, savedTheme.mode);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <AppProvider>
      <App />
    </AppProvider>
  </AppErrorBoundary>,
);
