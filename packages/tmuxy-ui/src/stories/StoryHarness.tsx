/**
 * Story harness — wires AppProvider with a DemoAdapter so component stories
 * can render against a live XState machine without booting the real backend.
 *
 * Components that read from useAppSelector / useAppSend need this wrapper.
 * Pure presentational components (Modal, ConnectionStatus) do
 * not.
 */

import { useMemo, useEffect, type ReactNode } from 'react';
import { TmuxyProvider, TmuxyApp, DemoAdapter, type AppConfig, type RenderTabline } from '../lib';
import { V86TmuxAdapter } from '../tmux/v86/V86TmuxAdapter';
import {
  CHAR_HEIGHT,
  CONTAINER_PADDING_BOTTOM,
  CONTAINER_PADDING_X,
  STATUS_BAR_HEIGHT,
  TMUX_STATUS_BAR_HEIGHT,
} from '../constants';
import { measureCellMetrics } from '../utils/cellMetrics';
import { V86_DEFAULT_COLS, V86_DEFAULT_ROWS } from '../tmux/v86/V86Engine';

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
 * Pixel box that makes the app settle on exactly `cols` x `rows`.
 *
 * The app does not take a terminal size — it MEASURES one, from the pane
 * container's content box (`calculateTargetSize`). So a story asks for a grid
 * by handing the harness a box that measures back to it:
 *
 *   cols = floor(containerContentWidth  / cellWidth)
 *   rows = floor(containerContentHeight / CHAR_HEIGHT)
 *
 * The width has to come from the MEASURED cell, not a constant: the terminal
 * font's advance is ~9px at one font size and ~9.6px at another, so a fixed
 * pixel width is 80 columns on one machine and 79 or 81 on the next. The
 * height is safe in constants — rows are always CHAR_HEIGHT tall.
 */
function gridBox(cols: number, rows: number): { width: number; height: number } {
  const { cellWidth } = measureCellMetrics();
  return {
    width: cols * cellWidth + CONTAINER_PADDING_X * 2,
    height:
      rows * CHAR_HEIGHT + CONTAINER_PADDING_BOTTOM + STATUS_BAR_HEIGHT + TMUX_STATUS_BAR_HEIGHT,
  };
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
  const adapter = useMemo(
    () => new V86TmuxAdapter({ initCommands, shared }),
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
        // Theme window background — black by default (matches the terminal's
        // --window-bg-rgb 0,0,0), so the app box reads as one dark surface and
        // no chrome gap shows a lighter frame colour behind it.
        background: 'var(--bg-base, #000)',
      }}
    >
      <TmuxyProvider adapter={adapter}>
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
