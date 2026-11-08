import ReactDOM from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { SplashScreen } from './components/SplashScreen';
import { AppProvider } from './machines/AppContext';
import { applyTheme } from './infra/themeManager';
import { loadThemePref } from './infra/prefs';
import { isTauri } from './infra/platform';
import { registerPushWorker } from './infra/pushNotifications';
import { windowAttached } from './infra/splashWindow';
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

const root = ReactDOM.createRoot(document.getElementById('root')!);
const renderApp = () =>
  root.render(
    <AppErrorBoundary>
      <AppProvider>
        <App />
      </AppProvider>
    </AppErrorBoundary>,
  );

// A desktop window opened from the Window menu starts on its splash page,
// which attaches it (components/SplashScreen.tsx); the app comes up after.
if (isTauri()) {
  void windowAttached()
    .catch(() => true)
    .then((attached) =>
      attached ? renderApp() : root.render(<SplashScreen onAttached={renderApp} />),
    );
} else {
  renderApp();
}
