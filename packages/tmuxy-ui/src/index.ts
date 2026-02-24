/**
 * @tmuxy/ui - Public API
 *
 * Import the component, provider, and adapters to embed tmuxy in any React app.
 */

// Component
export { default as TmuxyApp } from './App';
export { TmuxyAppProvider as TmuxyProvider } from './machines/AppContext';

// Adapters
export { FakeTmuxAdapter } from './tmux/fake/fakeTmuxAdapter';
export { HttpAdapter } from './tmux/HttpAdapter';
export { TauriAdapter, createAdapter } from './tmux/adapters';

// Types
export type { TmuxAdapter, ServerState, TmuxPane, TmuxWindow, KeyBindings } from './tmux/types';
