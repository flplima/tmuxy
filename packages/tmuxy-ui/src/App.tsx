/**
 * App - Main application component
 *
 * Composes the main layout: StatusBar, PaneLayout, TmuxStatusBar.
 * All state is accessed via hooks - no prop drilling.
 */

import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import './styles.css';
import { StatusBar } from './components/StatusBar';
import { TmuxStatusBar } from './components/TmuxStatusBar';
import { PaneLayout } from './components/PaneLayout';
import { Pane } from './components/Pane';
import { FloatContainer } from './components/FloatPane';
import { Sidebar } from './components/Sidebar';
import { SidebarBackdrop } from './components/SidebarBackdrop';
import { RightSidebar } from './components/RightSidebar';
import { TabOverview } from './components/TabOverview';
import { ConnectionOverlay, type ConnectionOverlayMode } from './components/ConnectionOverlay';
import {
  useAppSelector,
  useAppSend,
  useAppState,
  useAppConfig,
  selectPreviewPanes,
  selectError,
  selectFatalError,
  selectLog,
  selectContainerSize,
  selectCellMetrics,
} from './machines/AppContext';
import { cellMetricsStyle } from './utils/cellMetrics';
import { latencyTracker } from './tmux/latencyTracker';
import { PerfHud } from './components/PerfHud';

export type RenderTabline = (props: { children: ReactNode }) => ReactNode;

function App({ renderTabline }: { renderTabline?: RenderTabline } = {}) {
  // Select minimal state needed at App level
  const panes = useAppSelector(selectPreviewPanes);
  const error = useAppSelector(selectError);
  const fatalError = useAppSelector(selectFatalError);
  const log = useAppSelector(selectLog);
  const containerSize = useAppSelector(selectContainerSize);
  const cellMetrics = useAppSelector(selectCellMetrics);
  const isConnecting = useAppState('connecting');
  const isReconnecting = useAppState('reconnecting');
  const tabOverviewOpen = useAppSelector((ctx) => ctx.tabOverviewOpen);
  const send = useAppSend();
  const { requireFocus } = useAppConfig();

  // Track if we've started observing
  const observingRef = useRef(false);
  const appContainerRef = useRef<HTMLDivElement>(null);

  // Use callback ref to observe container when it mounts
  const containerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && !observingRef.current) {
        observingRef.current = true;
        send({ type: 'OBSERVE_CONTAINER', element });
      }
    },
    [send],
  );

  // Focus gating: when requireFocus is set, track clicks inside/outside container
  useEffect(() => {
    if (!requireFocus) return;

    const handleMouseDown = (event: MouseEvent) => {
      const container = appContainerRef.current;
      if (container && container.contains(event.target as Node)) {
        send({ type: 'APP_FOCUS' });
      } else {
        send({ type: 'APP_BLUR' });
      }
    };

    document.addEventListener('mousedown', handleMouseDown, true);
    return () => document.removeEventListener('mousedown', handleMouseDown, true);
  }, [requireFocus, send]);

  // Ready when connected, have panes, AND container is measured
  const isReady = !isConnecting && panes.length > 0 && containerSize.width > 0;

  // Once we've been ready, keep the pane layout mounted through transient
  // empty-pane states (e.g., window create/switch/kill cycles where
  // activeWindowId changes before new panes arrive). This prevents the
  // layout from being unmounted and replaced with a loading div for ~55ms.
  const hasBeenReadyRef = useRef(false);
  if (isReady) hasBeenReadyRef.current = true;
  const showLayout = isReady || hasBeenReadyRef.current;

  // What covers the pane area while nothing live is on it: a fatal (the
  // backend gave up) wins, then a dropped channel, then the first connection.
  // The layout, once shown, stays mounted underneath as the blurred last
  // snapshot — even through a fatal, so a Retry has something to come back to.
  const overlayMode: ConnectionOverlayMode | null =
    fatalError != null
      ? 'fatal'
      : isReconnecting
        ? 'reconnecting'
        : !showLayout
          ? 'connecting'
          : null;
  const retry = useCallback(() => window.location.reload(), []);

  // Always render .app-container so containerRef is attached and ResizeObserver
  // starts measuring immediately, preventing a layout flash on first pane render.
  return (
    <div
      ref={appContainerRef}
      className="app-container"
      // Publish the measured cell grid (--cell-w / --cell-gap) to every
      // terminal text run and cell-addressed box below — see utils/cellMetrics.ts.
      style={cellMetricsStyle(cellMetrics) as React.CSSProperties}
    >
      <StatusBar renderTabline={renderTabline} />
      <div className="app-body">
        {/* Sidebars: fixed-width, full-height columns when open, each holding
            one real tmux pane. As flex siblings they shrink the pane container,
            whose ResizeObserver then reports the reduced width so tmux re-tiles
            the panes into the space that's left — never under a sidebar. Left is
            the tree widget, right the pinned terminal. In a window too narrow to
            share, `selectSidebarLayout` switches them to overlaying the panes
            over this backdrop instead. */}
        {showLayout && <SidebarBackdrop />}
        {showLayout && <Sidebar />}
        <div
          ref={containerRef}
          // While the Tab Overview is open the live pane grid is FLIP-scaled
          // into its slot (custom properties set by TabOverview, applied by
          // the `.tab-overview-open .pane-layout` rule).
          className={`pane-container${tabOverviewOpen ? ' tab-overview-open' : ''}`}
          style={{ position: 'relative' }}
        >
          {showLayout && (
            <>
              <PaneLayout>{(pane) => <Pane paneId={pane.tmuxId} />}</PaneLayout>
              {/* Float panes overlay - renders above tiled panes */}
              <FloatContainer />
              {/* The "all tabs" view, over panes and floats alike */}
              <TabOverview />
            </>
          )}
          {overlayMode && (
            <ConnectionOverlay
              mode={overlayMode}
              hasLayout={showLayout}
              error={error}
              fatalError={fatalError}
              log={log}
              onRetry={retry}
            />
          )}
        </div>
        {showLayout && <RightSidebar />}
      </div>
      <TmuxStatusBar />
      {/* Dev-only latency overlay; mounted only when enabled via ?perf /
          localStorage so it and its store subscription cost nothing otherwise. */}
      {latencyTracker.isEnabled() && <PerfHud />}
    </div>
  );
}

export default App;
