import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProvider } from './machines/AppContext';
import { applyTheme } from './utils/themeManager';
import './fonts/nerd-font.css';
import './components/widgets/init';

// Apply default theme before first render to avoid FOUC
applyTheme('default', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
