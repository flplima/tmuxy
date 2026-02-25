/**
 * Library entry point for consuming tmuxy-ui as a dependency.
 *
 * Re-exports the public API under names used by the landing page
 * and other external consumers.
 */

export { AppProvider as TmuxyProvider } from './machines/AppContext';
export { default as TmuxyApp } from './App';
export { FakeTmuxAdapter } from './tmux/fake/fakeTmuxAdapter';
export type { TmuxAdapter } from './tmux/types';
