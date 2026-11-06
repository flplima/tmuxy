// The library entry: the demo site and other consumers import these names.

export { AppProvider as TmuxyProvider } from './machines/AppContext';
export { useAppFocused } from './machines/appHooks';
export { phoneMediaQuery } from './infra/dom/phoneLayout';
export type { AppConfig } from './machines/appContexts';
export { default as TmuxyApp } from './App';
export type { RenderTabline } from './components/StatusBar';
export { V86TmuxAdapter } from './infra/transport/drivers/v86/V86TmuxAdapter';
export type { V86TmuxAdapterOptions } from './infra/transport/drivers/v86/V86TmuxAdapter';
export { CheerpXTmuxAdapter } from './infra/transport/drivers/cheerpx/CheerpXTmuxAdapter';
export { cheerpxAvailable } from './infra/transport/drivers/cheerpx/CheerpXEngine';
export { GuestTransportLive } from './infra/transport/layers';
export type { TmuxTransport } from './infra/transport/TmuxTransport';
