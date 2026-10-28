/**
 * App - Main application component
 *
 * Composes the main layout: StatusBar, PaneLayout, TmuxStatusBar — or, on a
 * phone, a tab strip, the whole 80 × 25 terminal, the key row and the tree
 * under it.
 * All state is accessed via hooks - no prop drilling.
 */

import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef } from 'react';
import './styles.css';
import { StatusBar } from './components/StatusBar';
import { NativeMenuBar } from './components/menus/NativeMenuBar';
import { isTauri } from './utils/platform';
import { TmuxStatusBar } from './components/TmuxStatusBar';
import { PaneLayout } from './components/PaneLayout';
import { Pane } from './components/Pane';
import { FloatContainer } from './components/FloatPane';
import { KeysView } from './components/KeysView';
import { Sidebar } from './components/Sidebar';
import { TabOverview } from './components/TabOverview';
import { GestureStage } from './components/GestureStage';
import { ConnectionOverlay, type ConnectionOverlayMode } from './components/ConnectionOverlay';
import { SessionList } from './components/SessionList';
import { useAppSelector, useAppSend, useAppState, useAppConfig } from './machines/appHooks';
import {
  selectPreviewPanes,
  selectContainerSize,
  selectCellMetrics,
  selectPhoneLayout,
  selectPhoneLandscape,
  selectGridType,
  selectPhoneZoom,
} from './machines/selectors/layout';
import {
  selectError,
  selectFatalError,
  selectLog,
  selectAnimationsAllowed,
  selectCursorBlink,
  selectSidebarFocused,
} from './machines/selectors/ui';
import { cellMetricsStyle } from './utils/cellMetrics';
import { useSelectionRows } from './hooks/useSelectionRows';
import { latencyTracker } from './infra/latencyTracker';
import { PerfHud } from './components/PerfHud';
import { SmoothCursor } from './components/SmoothCursor';
import { Snackbar } from './components/Snackbar';
import { KeyRow } from './components/KeyRow';
import { PhoneTabStrip } from './components/PhoneTabStrip';
import { useCursorInView, usePhoneZoomScroll, useVisualViewport } from './hooks/usePhoneViewport';
import { PHONE_COLS } from './utils/phoneLayout';
import { PHONE_CONTAINER_PADDING } from './constants/layout';
import { PhoneBottomView } from './components/PhoneBottomView';

export type RenderTabline = (props: { children: ReactNode }) => ReactNode;

/** The phone's terminal type, scoped to the terminal so the chrome keeps its own. */
function gridTypeStyle(type: { fontSize: number; rowHeight: number } | null): CSSProperties {
  if (!type) return {};
  return {
    '--tmuxy-font-size': `${type.fontSize}px`,
    '--line-height-terminal': `${type.rowHeight}px`,
    '--pane-header-height': `${type.rowHeight}px`,
  } as CSSProperties;
}

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
  const isDetached = useAppState('detached');
  const tabOverviewOpen = useAppSelector((ctx) => ctx.tabOverviewOpen);
  const animationsAllowed = useAppSelector(selectAnimationsAllowed);
  const cursorBlink = useAppSelector(selectCursorBlink);
  const sidebarFocused = useAppSelector(selectSidebarFocused);
  const phone = useAppSelector(selectPhoneLayout);
  const landscape = useAppSelector(selectPhoneLandscape);
  const gridType = useAppSelector(selectGridType);
  const charWidth = useAppSelector((ctx) => ctx.charWidth);
  // Where the cursor is, for the phone terminal to keep it in view.
  const cursorKey = useAppSelector((ctx) => {
    const pane = ctx.panes.find((p) => p.tmuxId === ctx.activePaneId);
    return pane ? `${pane.tmuxId} ${pane.y} ${pane.cursorY} ${pane.inMode}` : '';
  });
  const ptyRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const phoneZoom = useAppSelector(selectPhoneZoom);
  useVisualViewport(phone);
  useCursorInView(ptyRef, phone, cursorKey);
  usePhoneZoomScroll(zoomRef, phoneZoom);
  const send = useAppSend();
  const { requireFocus } = useAppConfig();
  useSelectionRows();

  // The container being observed. Switching to or from the phone layout
  // mounts it somewhere else, and the new element is observed in its place.
  const observedRef = useRef<HTMLDivElement | null>(null);
  const appContainerRef = useRef<HTMLDivElement>(null);

  // Use callback ref to observe container when it mounts
  const containerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && element !== observedRef.current) {
        observedRef.current = element;
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
  // `detached` sits above `reconnecting`: the user asked to step away, and
  // presenting that as a retry is the thing comparable clients get wrong.
  const overlayMode: ConnectionOverlayMode | null =
    fatalError != null
      ? 'fatal'
      : isDetached
        ? 'detached'
        : isReconnecting
          ? 'reconnecting'
          : !showLayout
            ? 'connecting'
            : null;
  const retry = useCallback(() => window.location.reload(), []);
  const reconnectNow = useCallback(() => send({ type: 'RECONNECT_NOW' }), [send]);

  const paneContainer = (
    <div
      ref={containerRef}
      // While the Tab Overview is open the live pane grid is FLIP-scaled
      // into its slot (custom properties set by TabOverview, applied by
      // the `.tab-overview-open .pane-layout` rule). A trackpad gesture in
      // progress is drawn the same way, by GestureStage.
      className={`pane-container${tabOverviewOpen ? ' tab-overview-open' : ''}`}
      // A grid fitted to a window sized for someone else (`@tmuxy-size`)
      // carries its own font here; the phone's is on its terminal below.
      style={{ position: 'relative', ...(phone ? {} : gridTypeStyle(gridType)) }}
    >
      {showLayout && (
        <>
          <PaneLayout>{(pane) => <Pane paneId={pane.tmuxId} />}</PaneLayout>
          {/* Trackpad slides and pinches, applied to this container per step */}
          <GestureStage />
          {/* Float panes overlay - renders above tiled panes */}
          <FloatContainer />
          {/* The "all tabs" view, over panes and floats alike */}
          <TabOverview />
        </>
      )}
      {/* Every binding, table by table (prefix ?) */}
      {showLayout && <KeysView />}
      {overlayMode && (
        <ConnectionOverlay
          mode={overlayMode}
          hasLayout={showLayout}
          error={error}
          fatalError={fatalError}
          log={log}
          onRetry={retry}
          onReconnectNow={reconnectNow}
        >
          {/* Detached: the way back in, the session switcher's list over the
              blurred session the user stepped out of. */}
          <SessionList />
        </ConnectionOverlay>
      )}
    </div>
  );

  // The phone layout: the tab strip, the terminal, the key row and the tree,
  // top to bottom — or, held sideways, the terminal on the right and the
  // rest stacked in the column left of it.
  const phoneTabs = showLayout && <PhoneTabStrip />;
  const phoneKeys = showLayout && <KeyRow />;
  // Every tab and pane, where the tab strip would be on a desktop — or the
  // dock, after a sideways swipe (PhoneBottomView).
  const phoneTree = showLayout && <PhoneBottomView />;
  // The terminal at the phone's cell: the grid, then tmux's status line
  // under it. Sideways, it is as wide as its 80 columns and the chrome takes
  // the column beside it. A double tap zooms the grid in the browser
  // (`phoneZoom`): the viewport around it scrolls, and is scrolled to the
  // point tapped.
  const phonePty = (
    <div
      ref={ptyRef}
      className={`phone-pty${phoneZoom ? ' is-zoomed' : ''}`}
      style={{
        ...gridTypeStyle(gridType),
        ...(landscape ? { width: PHONE_COLS * charWidth + 2 * PHONE_CONTAINER_PADDING } : {}),
      }}
    >
      <div ref={zoomRef} className="phone-zoom-viewport" data-testid="phone-zoom-viewport">
        {paneContainer}
      </div>
      {showLayout && <TmuxStatusBar />}
    </div>
  );
  const phoneBody = landscape ? (
    <>
      <div className="phone-side">
        {phoneTabs}
        {phoneKeys}
        {phoneTree}
      </div>
      {phonePty}
    </>
  ) : (
    <>
      {phoneTabs}
      {phonePty}
      {phoneKeys}
      {phoneTree}
    </>
  );

  // Always render .app-container so containerRef is attached and ResizeObserver
  // starts measuring immediately, preventing a layout flash on first pane render.
  return (
    <div
      ref={appContainerRef}
      className={`app-container has-smooth-cursor${sidebarFocused ? ' has-sidebar-focus' : ''}${
        cursorBlink ? ' app-cursor-blink' : ''
      }${animationsAllowed ? '' : ' app-no-animations'}`}
      // Publish the measured cell grid (--cell-w / --cell-gap) to every
      // terminal text run and cell-addressed box below — see utils/cellMetrics.ts.
      style={cellMetricsStyle(cellMetrics) as React.CSSProperties}
    >
      {!phone && <StatusBar renderTabline={renderTabline} />}
      {isTauri() && <NativeMenuBar />}
      <div
        className={`app-body${phone ? ' app-body-phone' : ''}${landscape ? ' is-landscape' : ''}`}
      >
        {/* Sidebars: fixed-width, full-height columns when open, each holding
            one real tmux pane. As flex siblings they shrink the pane container,
            whose ResizeObserver then reports the reduced width so tmux re-tiles
            the panes into the space that's left — never under a sidebar. Left is
            the tree widget, right the pinned terminal. */}
        {showLayout && !phone && <Sidebar side="left" />}
        {phone ? phoneBody : paneContainer}
        {showLayout && !phone && <Sidebar side="right" />}
      </div>
      {!phone && <TmuxStatusBar />}
      {/* First run: what this is and what it can do, before anything is typed. */}
      {/* Errors, top-right, over everything but the cursor. */}
      <Snackbar />
      {/* The cursor itself: one overlay gliding between the panes' anchors. */}
      <SmoothCursor />
      {/* Dev-only latency overlay; mounted only when enabled via ?perf /
          localStorage so it and its store subscription cost nothing otherwise. */}
      {latencyTracker.isEnabled() && <PerfHud />}
    </div>
  );
}

export default App;
