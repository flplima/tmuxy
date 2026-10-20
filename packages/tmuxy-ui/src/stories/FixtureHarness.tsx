/**
 * Story harnesses over a recording of real tmux (`fixtures/FixtureAdapter.ts`).
 *
 * `FixtureApp` is the whole app, sized in cells to the grid the recording was
 * made at, so the app measures the size tmux drew and never asks for another.
 * `FixtureProvider` puts a single component inside the app's context, for a
 * story about that component alone.
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { Layer } from 'effect';
import { TmuxyProvider, TmuxyApp, type AppConfig, type RenderTabline } from '../lib';
import { TmuxTransport, makeTransport } from '../infra/transport/TmuxTransport';
import { FixtureAdapter, type FixtureAdapterOptions } from './fixtures/FixtureAdapter';
import { useGridBox } from './gridBox';

export interface FixtureAppProps extends FixtureAdapterOptions {
  config?: AppConfig;
  renderTabline?: RenderTabline;
  /** The adapter, for a story that pushes an update or reads what was sent. */
  onAdapterReady?: (adapter: FixtureAdapter) => void;
}

function useFixtureTransport(
  options: FixtureAdapterOptions,
  onReady?: FixtureAppProps['onAdapterReady'],
) {
  const { fixture, start, transitions, commandDelayMs, failCommand } = options;
  const adapter = useMemo(
    () => new FixtureAdapter({ fixture, start, transitions, commandDelayMs, failCommand }),
    [fixture, start, transitions, commandDelayMs, failCommand],
  );
  const transport = useMemo(() => Layer.scoped(TmuxTransport, makeTransport(adapter)), [adapter]);
  useEffect(() => {
    onReady?.(adapter);
  }, [adapter, onReady]);
  return transport;
}

const chrome = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  // The theme's window background, as the page root paints it.
  background: 'rgb(var(--window-bg-rgb))',
} as const;

export function FixtureApp({ config, renderTabline, onAdapterReady, ...options }: FixtureAppProps) {
  const transport = useFixtureTransport(options, onAdapterReady);
  const box = useGridBox(options.fixture.cols, options.fixture.rows);
  if (!box) return null;
  return (
    <div style={{ ...chrome, width: box.width, height: box.height }}>
      <TmuxyProvider transport={transport} config={config}>
        <TmuxyApp renderTabline={renderTabline} />
      </TmuxyProvider>
    </div>
  );
}

export function FixtureProvider({
  children,
  config,
  height = 200,
  width = '100%',
  ...options
}: FixtureAdapterOptions & {
  children: ReactNode;
  config?: AppConfig;
  height?: number | string;
  width?: number | string;
}) {
  const transport = useFixtureTransport(options);
  return (
    <div style={{ ...chrome, width, height }}>
      <TmuxyProvider transport={transport} config={config}>
        {children}
      </TmuxyProvider>
    </div>
  );
}
