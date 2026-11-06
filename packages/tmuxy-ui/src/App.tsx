/**
 * App - Main application component
 *
 * Composes the main layout: StatusBar, PaneLayout, TmuxStatusBar — or, on a
 * phone, the whole 80 × 25 terminal, the key row and the tree under it.
 * All state is accessed via hooks - no prop drilling.
 */

import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef } from 'react';
import './styles.css';
import { StatusBar } from './components/StatusBar';
import { NativeMenuBar } from './components/menus/NativeMenuBar';
import { isTauri } from './infra/platform';
import { usePluginLinks } from './components/terminal/usePluginLinks';
import { TmuxStatusBar } from './components/TmuxStatusBar';
import { PaneLayout } from './components/PaneLayout';
import { Pane } from './components/Pane';
import { FloatContainer } from './components/FloatPane';
import { KeysView } from './components/KeysView';
import { Sidebar } from './components/Sidebar';
import { TabOverview } from './components/TabOverview';
import { GestureStage } from './components/gestures/GestureStage';
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
import { selectSidebarHoldsKeyboard } from './machines/selectors/keyboard';
import { cellMetricsStyle } from './infra/dom/cellMetrics';
import { useSelectionRows } from './components/terminal/useSelectionRows';
import { latencyTracker } from './infra/latencyTracker';
import { PerfHud } from './components/PerfHud';
import { SmoothCursor } from './components/terminal/SmoothCursor';
import { Snackbar } from './components/Snackbar';
import { KeyRow } from './components/phone/KeyRow';
import {
  useCursorInView,
  usePhoneZoomScroll,
  useVisualViewport,
} from './components/phone/usePhoneViewport';
import { PHONE_COLS } from './infra/dom/phoneLayout';
import { PHONE_CONTAINER_PADDING } from './constants/layout';
import { PhoneBottomView } from './components/phone/PhoneBottomView';

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
  const panes = useAppSelector(selectPreviewPanes);
  const error = useAppSelector(selectError);
  const fatalError = useAppSelector(selectFatalError);
  const log = useAppSelector(selectLog);
  const containerSize = useAppSelector(selectContainerSize);
  const cellMetrics = useAppSelector(selectCellMetrics);
  const isConnecting = useAppState('connecting');
  const isDetached = useAppState('detached');
  const tabOverviewOpen = useAppSelector((ctx) => ctx.tabOverviewOpen);
  const animationsAllowed = useAppSelector(selectAnimationsAllowed);
  const cursorBlink = useAppSelector(selectCursorBlink);
  const sidebarFocused = useAppSelector(selectSidebarFocused);
  const sidebarPeek = useAppSelector((ctx) => ctx.sidebarPeek !== null);
  const phone = useAppSelector(selectPhoneLayout);
  const landscape = useAppSelector(selectPhoneLandscape);
  const gridType = useAppSelector(selectGridType);
  const charWidth = useAppSelector((ctx) => ctx.charWidth);
  const cursorKey = useAppSelector((ctx) => {
    const pane = ctx.panes.find((p) => p.tmuxId === ctx.activePaneId);
    return pane ? `${pane.tmuxId} ${pane.y} ${pane.cursorY} ${pane.inMode}` : '';
  });
  const ptyRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const phoneZoom = useAppSelector(selectPhoneZoom);
  // The side pane holds the keyboard: with the phone's keyboard up the
  // terminal above gives up its room first (styles/phone.css).
  const dockTyping = useAppSelector(
    (ctx) => ctx.phoneBottomView === 'dock' && selectSidebarHoldsKeyboard(ctx, 'right'),
  );
  useVisualViewport(phone);
  useCursorInView(ptyRef, phone, cursorKey, phoneZoom ? zoomRef : null);
  usePhoneZoomScroll(zoomRef, ptyRef, phoneZoom);
  const send = useAppSend();
  const { requireFocus } = useAppConfig();
  useSelectionRows();
  usePluginLinks();

  const observedRef = useRef<HTMLDivElement | null>(null);
  const appContainerRef = useRef<HTMLDivElement>(null);

  const containerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && element !== observedRef.current) {
        observedRef.current = element;
        send({ type: 'OBSERVE_CONTAINER', element });
      }
    },
    [send],
  );

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

  const isReady = !isConnecting && panes.length > 0 && containerSize.width > 0;

  // Stays mounted through the empty-pane frames of a window create/switch/kill,
  // where activeWindowId changes before the new panes arrive.
  const hasBeenReadyRef = useRef(false);
  if (isReady) hasBeenReadyRef.current = true;
  const showLayout = isReady || hasBeenReadyRef.current;

  // The layout stays mounted under the overlay as the blurred last snapshot,
  // even through a fatal, so a Retry has something to come back to. A dropped
  // channel (`reconnecting`) covers nothing: the panes keep their last frame
  // and ReconnectNotice says so once the drop has lasted.
  const overlayMode: ConnectionOverlayMode | null =
    fatalError != null ? 'fatal' : isDetached ? 'detached' : !showLayout ? 'connecting' : null;
  const retry = useCallback(() => window.location.reload(), []);

  const paneContainer = (
    <div
      ref={containerRef}
      className={`pane-container${tabOverviewOpen ? ' tab-overview-open' : ''}`}
      // A grid fitted to a window sized for someone else (`@tmuxy-size`)
      // carries its own font.
      style={{ position: 'relative', ...(phone ? {} : gridTypeStyle(gridType)) }}
    >
      {showLayout && (
        <>
          <PaneLayout>{(pane) => <Pane paneId={pane.tmuxId} />}</PaneLayout>
          <GestureStage />
          <FloatContainer />
          <TabOverview />
        </>
      )}
      {showLayout && <KeysView />}
      {overlayMode && (
        <ConnectionOverlay
          mode={overlayMode}
          hasLayout={showLayout}
          error={error}
          fatalError={fatalError}
          log={log}
          onRetry={retry}
        >
          <SessionList />
        </ConnectionOverlay>
      )}
    </div>
  );

  // The phone layout: the terminal, the key row and the bottom view, top to
  // bottom — or, held sideways, the terminal on the right and the rest
  // stacked in the column left of it. No tab strip: the tree lists the tabs
  // and a slide on the terminal switches them, and the strip's height goes
  // to the bottom view.
  const phoneKeys = showLayout && <KeyRow />;
  // The app menu, every tab and pane, or the dock, picked by the tab bar
  // under them or a sideways swipe (PhoneBottomView). Zoomed and upright, it
  // makes way: the doubled grid takes its place, every row in view.
  const phoneTree = showLayout && !(phoneZoom && !landscape) && <PhoneBottomView />;
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
        {phoneKeys}
        {phoneTree}
      </div>
      {phonePty}
    </>
  ) : (
    <>
      {phonePty}
      {phoneKeys}
      {phoneTree}
    </>
  );

  return (
    <div
      ref={appContainerRef}
      className={`app-container has-smooth-cursor${sidebarFocused ? ' has-sidebar-focus' : ''}${
        sidebarPeek ? ' has-sidebar-peek' : ''
      }${cursorBlink ? ' app-cursor-blink' : ''}${animationsAllowed ? '' : ' app-no-animations'}`}
      style={cellMetricsStyle(cellMetrics) as React.CSSProperties}
    >
      {!phone && <StatusBar renderTabline={renderTabline} />}
      {isTauri() && <NativeMenuBar />}
      <div
        className={`app-body${phone ? ' app-body-phone' : ''}${landscape ? ' is-landscape' : ''}${dockTyping ? ' is-dock-typing' : ''}`}
      >
        {/* Flex siblings of the pane container: an open sidebar shrinks it, so
            tmux re-tiles the panes into what is left, never under a sidebar. */}
        {showLayout && !phone && <Sidebar side="left" />}
        {phone ? phoneBody : paneContainer}
        {showLayout && !phone && <Sidebar side="right" />}
      </div>
      {!phone && <TmuxStatusBar />}
      {/* Installed on a phone: the solid bands over the status bar and the
          home indicator (standalone.css says why). */}
      {phone && <div className="edge-band edge-band-top" aria-hidden="true" />}
      {phone && <div className="edge-band edge-band-bottom" aria-hidden="true" />}
      <Snackbar />
      <SmoothCursor />
      {latencyTracker.isEnabled() && <PerfHud />}
    </div>
  );
}

export default App;
