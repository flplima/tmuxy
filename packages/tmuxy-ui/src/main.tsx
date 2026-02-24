import ReactDOM from 'react-dom/client';
import TmuxyApp from './App';
import { TmuxyAppProvider } from './machines/AppContext';
import './components/widgets/init';

// Global styles only needed for standalone app mode
document.body.style.margin = '0';
document.body.style.padding = '0';
document.body.style.overflow = 'hidden';
document.body.style.backgroundColor = 'var(--bg-black)';

const root = document.getElementById('root')!;
root.style.display = 'flex';
root.style.flexDirection = 'column';
root.style.minHeight = '100vh';
root.style.boxSizing = 'border-box';

ReactDOM.createRoot(root).render(
  <TmuxyAppProvider>
    <TmuxyApp />
  </TmuxyAppProvider>,
);
