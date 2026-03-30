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
import {
  useAppSelector,
  useAppSend,
  useAppState,
  useAppConfig,
  selectPreviewPanes,
  selectError,
  selectContainerSize,
} from './machines/AppContext';
import { initDebugHelpers } from './utils/debug';

export type RenderTabline = (props: { children: ReactNode }) => ReactNode;

// Initialize debug helpers
initDebugHelpers();

function App({ renderTabline }: { renderTabline?: RenderTabline } = {}) {
  // Select minimal state needed at App level
  const panes = useAppSelector(selectPreviewPanes);
  const error = useAppSelector(selectError);
  const containerSize = useAppSelector(selectContainerSize);
  const isConnecting = useAppState('connecting');
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

  // Always render .app-container so containerRef is attached and ResizeObserver
  // starts measuring immediately, preventing a layout flash on first pane render.
  return (
    <div ref={appContainerRef} className="app-container">
      <StatusBar renderTabline={renderTabline} />
      <div ref={containerRef} className="pane-container" style={{ position: 'relative' }}>
        {error && !showLayout ? (
          <div className="error" data-testid="error-display">
            <h2>Error</h2>
            <p>{error}</p>
          </div>
        ) : !showLayout ? (
          <div className="loading" data-testid="loading-display">
            <p>Connecting to tmux...</p>
          </div>
        ) : (
          <>
            <PaneLayout>{(pane) => <Pane paneId={pane.tmuxId} />}</PaneLayout>
            {/* Float panes overlay - renders above tiled panes */}
            <FloatContainer />
          </>
        )}
      </div>
      <TmuxStatusBar />
    </div>
  );
}

export default App;
