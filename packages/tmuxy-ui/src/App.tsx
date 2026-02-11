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
import { PopupContainer } from './components/Popup';
import { FloatContainer } from './components/FloatPane';
import {
  useAppSelector,
  useAppSend,
  useAppState,
  selectPreviewPanes,
  selectError,
} from './machines/AppContext';
import { initDebugHelpers } from './utils/debug';

// Initialize debug helpers
initDebugHelpers();

function App() {
  // Select minimal state needed at App level
  const panes = useAppSelector(selectPreviewPanes);
  const error = useAppSelector(selectError);
  const isConnecting = useAppState('connecting');
  const send = useAppSend();

  // Track if we've started observing
  const observingRef = useRef(false);

  // Use callback ref to observe container when it mounts
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    if (element && !observingRef.current) {
      observingRef.current = true;
      send({ type: 'OBSERVE_CONTAINER', element });
    }
  }, [send]);

  // Show loading while connecting OR while we have no panes yet
  if (isConnecting || panes.length === 0) {
    // If there's an error during connection, show it
    if (error) {
      return (
        <div className="error" data-testid="error-display">
          <h2>Error</h2>
          <p>{error}</p>
        </div>
      );
    }
    return (
      <div className="loading" data-testid="loading-display">
        <p>Connecting to tmux...</p>
      </div>
    );
  }

  // Once we have panes, show the UI (ignore transient errors)

  return (
    <div className="app-container">
      <StatusBar />
      <div
        ref={containerRef}
        className="pane-container"
        style={{ position: 'relative' }}
      >
        <PaneLayout>
          {(pane) => <Pane paneId={pane.tmuxId} />}
        </PaneLayout>
        {/* Float panes overlay - renders above tiled panes */}
        <FloatContainer />
        {/* Popup overlay - renders when tmux popup is active */}
        <PopupContainer />
      </div>
      <TmuxStatusBar />
    </div>
  );
}

export default App;
