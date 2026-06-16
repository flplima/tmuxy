import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProvider } from './machines/AppContext';
import { applyTheme, loadThemeFromStorage } from './utils/themeManager';
import './fonts/nerd-font.css';
import './standalone.css';
import './components/widgets/init';

// Apply saved theme (or defaults) before first render to avoid FOUC
const savedTheme = loadThemeFromStorage();
applyTheme(savedTheme?.theme ?? 'default', savedTheme?.mode ?? 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
