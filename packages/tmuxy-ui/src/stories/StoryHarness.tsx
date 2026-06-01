/**
 * Story harness — wires AppProvider with a DemoAdapter so component stories
 * can render against a live XState machine without booting the real backend.
 *
 * Components that read from useAppSelector / useAppSend need this wrapper.
 * Pure presentational components (Modal, RichContent, ConnectionStatus) do
 * not.
 */

import { useMemo, useEffect, type ReactNode } from 'react';
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
  /**
   * Artificial delay (ms) applied to every run_tmux_command. Used to verify
   * optimistic updates remain smooth while the backend is slow.
   */
  commandDelayMs?: number;
  /**
   * Callback consulted before each tmux command. Returning a string causes the
   * adapter to reject the command with that error, simulating a real tmux
   * stderr response. Used to verify optimistic-state rollback behaviour.
   */
  failCommand?: (command: string) => string | false | null | undefined;
  /**
   * Exposes the live DemoAdapter back to the test so it can call helpers like
   * `emitClipboard` for OSC 52 verification without needing a real backend.
   */
  onAdapterReady?: (adapter: DemoAdapter) => void;
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
  commandDelayMs,
  failCommand,
  onAdapterReady,
}: AppHarnessProps) {
  const adapter = useMemo(
    () => new DemoAdapter({ initCommands, commandDelayMs, failCommand }),
    [initCommands, commandDelayMs, failCommand],
  );
  useEffect(() => {
    if (onAdapterReady) onAdapterReady(adapter);
  }, [adapter, onAdapterReady]);
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
