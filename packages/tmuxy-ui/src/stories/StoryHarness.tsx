/**
 * Story harness — wires AppProvider with a DemoAdapter so component stories
 * can render against a live XState machine without booting the real backend.
 *
 * Components that read from useAppSelector / useAppSend need this wrapper.
 * Pure presentational components (Modal, RichContent, ConnectionStatus) do
 * not.
 */

import { useMemo, type ReactNode } from 'react';
import { TmuxyProvider, TmuxyApp, DemoAdapter, type AppConfig, type RenderTabline } from '../lib';

export interface AppHarnessProps {
  /** Tmux commands run after the initial state loads (splits, new-window, etc) */
  initCommands?: string[];
  /** Forwarded to TmuxyProvider's config */
  config?: AppConfig;
  /** Height of the surrounding container in CSS pixels (default 600) */
  height?: number;
  /** Width of the surrounding container in CSS pixels (defaults to full width) */
  width?: number | string;
  /** Optional tabline renderer (e.g. for traffic-light mocks) */
  renderTabline?: RenderTabline;
}

/**
 * Renders the full TmuxyApp against a DemoAdapter. Useful for the App-level
 * story and for any component story that wants to demonstrate behaviour
 * within the real layout.
 */
export function AppHarness({
  initCommands,
  config,
  height = 600,
  width = '100%',
  renderTabline,
}: AppHarnessProps) {
  const adapter = useMemo(() => new DemoAdapter({ initCommands }), [initCommands]);
  return (
    <div
      style={{
        height,
        width,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-base, #0f0f12)',
      }}
    >
      <TmuxyProvider adapter={adapter} config={config}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}

/**
 * Wraps arbitrary children inside an AppProvider backed by a DemoAdapter.
 * Use for stories that render a single component which depends on the
 * AppContext (e.g. WindowTabs in isolation).
 */
export function ProviderHarness({
  children,
  initCommands,
  config,
  height = 200,
  width = '100%',
}: {
  children: ReactNode;
  initCommands?: string[];
  config?: AppConfig;
  height?: number | string;
  width?: number | string;
}) {
  const adapter = useMemo(() => new DemoAdapter({ initCommands }), [initCommands]);
  return (
    <div
      style={{
        height,
        width,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-base, #0f0f12)',
      }}
    >
      <TmuxyProvider adapter={adapter} config={config}>
        {children}
      </TmuxyProvider>
    </div>
  );
}
