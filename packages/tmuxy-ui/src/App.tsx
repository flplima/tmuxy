import { type CSSProperties, useCallback, useEffect, useRef } from 'react';
import './styles.css';
// The widgets panes can draw, registered once (components/widgets/builtins.ts).
import './components/widgets/builtins';
import { StatusBar, type RenderTabline } from './components/StatusBar';
import { NativeMenuBar } from './components/menus/NativeMenuBar';
import { isTauri } from './infra/platform';
import { usePluginLinks } from './components/terminal/usePluginLinks';
import { TmuxStatusBar } from './components/TmuxStatusBar';
import { PaneLayout } from './components/PaneLayout';
import { Pane } from './components/Pane';
import { FloatContainer } from './components/FloatPane';
import { KeysView } from './components/KeysView';
import { ActivityInbox } from './components/ActivityInbox';
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
  selectPhoneZoomed,
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
import { CommandPalette } from './components/palette/CommandPalette';
import { KeyRow } from './components/phone/KeyRow';
import {
  useCursorInView,
  usePhoneZoomScroll,
  useVisualViewport,
} from './components/phone/usePhoneViewport';
import {
  PHONE_COLS,
  PHONE_LANDSCAPE_KEYS,
  PHONE_ROWS,
  PHONE_STATUS_HEIGHT,
} from './infra/dom/phoneLayout';
import { PHONE_CONTAINER_PADDING } from './constants/layout';
import { PhoneBottomView } from './components/phone/PhoneBottomView';
import { PhoneDivider } from './components/phone/PhoneDivider';
import { PhoneDock } from './components/phone/PhoneDock';
import { PhoneLeftSide } from './components/phone/PhoneLeftSide';

/** The phone layout's geometry, for styles/phone.css. */
const PHONE_GRID_STYLE = {
  '--phone-rows': PHONE_ROWS,
  '--phone-container-padding': `${PHONE_CONTAINER_PADDING}px`,
  '--phone-status-row': `${PHONE_STATUS_HEIGHT}px`,
  '--phone-landscape-keys': `${PHONE_LANDSCAPE_KEYS}px`,
} as CSSProperties;

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
  const lowerRef = useRef<HTMLDivElement>(null);
  const phoneZoom = useAppSelector(selectPhoneZoom);
  const phoneZoomed = useAppSelector(selectPhoneZoomed);
  const phoneZoomAt = useAppSelector((ctx) => ctx.phoneZoomAt);
  const phoneCollapsed = useAppSelector((ctx) => ctx.phoneCollapsed);
  // While the side pane types, the terminal above folds away and the keys
  // stay (styles/phone.css).
  const dockTyping = useAppSelector(
    (ctx) => ctx.phoneBottomView === 'dock' && selectSidebarHoldsKeyboard(ctx, 'right'),
  );
  useVisualViewport(phone);
  useCursorInView(ptyRef, phone, cursorKey, phoneZoomed ? zoomRef : null);
  usePhoneZoomScroll(zoomRef, ptyRef, phoneZoom, phoneZoomAt);
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
      {showLayout && <ActivityInbox />}
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

  // No tab strip on a phone: the tree lists the tabs, a slide on the terminal
  // switches them. Upright, the bar under the keys zooms the terminal or
  // folds it and the keys away (PhoneDivider).
  const phoneKeys = showLayout && <KeyRow />;
  // The grid and tmux's status line are one picture: zoomed (`phoneZoom`
  // past 1) it is scaled in the browser inside a viewport that scrolls
  // sideways, and the terminal box scrolls up and down when it does not fit.
  const phonePty = (
    <div
      ref={ptyRef}
      className={`phone-pty${phoneZoomed ? ' is-zoomed' : ''}`}
      style={
        {
          ...gridTypeStyle(gridType),
          '--phone-zoom': phoneZoom,
          ...(landscape ? { width: PHONE_COLS * charWidth + 2 * PHONE_CONTAINER_PADDING } : {}),
        } as CSSProperties
      }
    >
      <div ref={zoomRef} className="phone-zoom-viewport" data-testid="phone-zoom-viewport">
        <div className="phone-picture">
          {paneContainer}
          {showLayout && <TmuxStatusBar />}
        </div>
      </div>
    </div>
  );
  const phoneBody = landscape ? (
    <>
      <div className="phone-side phone-side-left">{showLayout && <PhoneLeftSide />}</div>
      {phonePty}
      <div className="phone-side phone-side-right">{showLayout && <PhoneDock autoStart />}</div>
      {phoneKeys}
    </>
  ) : (
    <>
      <div className="phone-top" data-testid="phone-top">
        {phonePty}
        {phoneKeys}
      </div>
      <PhoneDivider ptyRef={ptyRef} lowerRef={lowerRef} />
      <div ref={lowerRef} className="phone-lower">
        {showLayout && <PhoneBottomView />}
      </div>
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
        className={`app-body${phone ? ' app-body-phone' : ''}${landscape ? ' is-landscape' : ''}${dockTyping ? ' is-dock-typing' : ''}${phoneCollapsed && !landscape ? ' is-collapsed' : ''}`}
        style={phone ? PHONE_GRID_STYLE : undefined}
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
      {showLayout && <CommandPalette />}
      <Snackbar />
      <SmoothCursor />
      {latencyTracker.isEnabled() && <PerfHud />}
    </div>
  );
}

export default App;
