import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProvider } from './machines/AppContext';
import { applyTheme, loadThemeFromStorage } from './utils/themeManager';
import { isTauri } from './tmux/adapters';
import './fonts/nerd-font.css';
import './standalone.css';
import './components/widgets/init';

// In the desktop app the page root is transparent so the OS window (blurred
// on macOS) shows through whatever alpha the surfaces leave; in a browser it
// stays opaque (standalone.css).
if (isTauri()) document.documentElement.dataset.desktop = '';

// Apply saved theme (or defaults) before first render to avoid FOUC
const savedTheme = loadThemeFromStorage();
applyTheme(savedTheme?.theme ?? 'default', savedTheme?.mode ?? 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
