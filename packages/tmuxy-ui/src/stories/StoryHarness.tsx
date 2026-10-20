/**
 * Story harness — wires AppProvider with a DemoAdapter so component stories
 * can render against a live XState machine without booting the real backend.
 *
 * Components that read from useAppSelector / useAppSend need this wrapper.
 * Pure presentational components (Modal, ConnectionStatus) do
 * not.
 */

import { useMemo, useEffect, type ReactNode } from 'react';
import {
  TmuxyProvider,
  TmuxyApp,
  V86TmuxAdapter,
  V86TransportLive,
  type AppConfig,
  type RenderTabline,
} from '../lib';
import { DemoTransportLive } from '../infra/transport/layers';
import { DemoAdapter } from '../infra/transport/drivers/demo/DemoAdapter';
import { gridBox } from './gridBox';
import { V86_DEFAULT_COLS, V86_DEFAULT_ROWS } from '../infra/transport/drivers/v86/V86Engine';

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
  const transport = useMemo(() => DemoTransportLive(adapter), [adapter]);
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
        background: 'rgb(var(--window-bg-rgb))',
      }}
    >
      <TmuxyProvider transport={transport} config={config}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}

/**
 * Renders the full TmuxyApp against REAL tmux — running inside a v86 x86
 * emulator, parsed by the tmuxy-core Rust engine compiled to WASM. No lifo.sh,
 * no simulation. Boots from a pre-restored snapshot (~4s); browser-only, so
 * these stories are `v86`-tagged and excluded from the deterministic CI probe.
 *
 * Sized in CELLS rather than pixels, defaulting to a plain 80x30 terminal — the
 * size the guest's tmux is actually running at is what these stories assert
 * against (pane geometry, wrapping, captures), so it is the thing worth pinning,
 * and pinning it keeps every story comparable regardless of the host's font.
 */
export function V86AppHarness({
  initCommands,
  cols = V86_DEFAULT_COLS,
  rows = V86_DEFAULT_ROWS,
  shared = false,
}: {
  initCommands?: string[];
  /** Terminal width in columns. */
  cols?: number;
  /** Terminal height in rows. */
  rows?: number;
  /** Reuse one process-wide v86 engine across stories (fast snapshot-restore
   *  between stories) instead of cold-booting a private engine per story. */
  shared?: boolean;
}) {
  const transport = useMemo(
    () => V86TransportLive(new V86TmuxAdapter({ initCommands, shared })),
    [initCommands, shared],
  );
  // Measured once per mount: the font is loaded by then, and a story never
  // changes size mid-play.
  const box = useMemo(() => gridBox(cols, rows), [cols, rows]);
  return (
    <div
      style={{
        height: box.height,
        width: box.width,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        // The theme's window background, as the page root paints it, so the
        // chrome around the panes shows the colour the app gives it.
        background: 'rgb(var(--window-bg-rgb))',
      }}
    >
      <TmuxyProvider transport={transport}>
        <TmuxyApp />
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
  const transport = useMemo(
    () => DemoTransportLive(new DemoAdapter({ initCommands })),
    [initCommands],
  );
  return (
    <div
      style={{
        height,
        width,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgb(var(--window-bg-rgb))',
      }}
    >
      <TmuxyProvider transport={transport} config={config}>
        {children}
      </TmuxyProvider>
    </div>
  );
}
