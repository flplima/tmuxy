import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProvider } from './machines/AppContext';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <App />
  </AppProvider>
);
