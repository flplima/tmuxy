/**
 * Library entry point for consuming tmuxy-ui as a dependency.
 *
 * Re-exports the public API under names used by the demo site
 * and other external consumers.
 */

import './components/widgets/init';

export { AppProvider as TmuxyProvider } from './machines/AppContext';
export { useAppFocused } from './machines/appHooks';
export type { AppConfig } from './machines/appContexts';
export { default as TmuxyApp } from './App';
export type { RenderTabline } from './App';
export { V86TmuxAdapter } from './infra/transport/drivers/v86/V86TmuxAdapter';
export type { V86TmuxAdapterOptions } from './infra/transport/drivers/v86/V86TmuxAdapter';
export { CheerpXTmuxAdapter } from './infra/transport/drivers/cheerpx/CheerpXTmuxAdapter';
export { cheerpxAvailable } from './infra/transport/drivers/cheerpx/CheerpXEngine';
export { GuestTransportLive } from './infra/transport/layers';
export type { TmuxTransport } from './infra/transport/TmuxTransport';
