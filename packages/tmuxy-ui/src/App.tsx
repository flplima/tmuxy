/**
 * App - Main application component
 *
 * Composes the main layout: StatusBar, PaneLayout, TmuxStatusBar.
 * All state is accessed via hooks - no prop drilling.
 */

import { useCallback, useRef } from 'react';
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
  selectPreviewPanes,
  selectError,
  selectContainerSize,
} from './machines/AppContext';
import { initDebugHelpers } from './utils/debug';

// Initialize debug helpers
initDebugHelpers();

function TmuxyApp() {
  // Select minimal state needed at App level
  const panes = useAppSelector(selectPreviewPanes);
  const error = useAppSelector(selectError);
  const containerSize = useAppSelector(selectContainerSize);
  const isConnecting = useAppState('connecting');
  const send = useAppSend();

  // Track if we've started observing
  const observingRef = useRef(false);

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

  // Ready when connected, have panes, AND container is measured
  const isReady = !isConnecting && panes.length > 0 && containerSize.width > 0;

  // Always render .tmuxy-app so containerRef is attached and ResizeObserver
  // starts measuring immediately, preventing a layout flash on first pane render.
  return (
    <div className="tmuxy-app">
      <StatusBar />
      <div ref={containerRef} className="tmuxy-pane-container" style={{ position: 'relative' }}>
        {error && !isReady ? (
          <div className="tmuxy-error" data-testid="error-display">
            <h2>Error</h2>
            <p>{error}</p>
          </div>
        ) : !isReady ? (
          <div className="tmuxy-loading" data-testid="loading-display">
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

export default TmuxyApp;
