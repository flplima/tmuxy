/**
 * App - Main application component
 *
 * Composes the main layout: StatusBar, PaneLayout, TmuxStatusBar.
 * All state is accessed via hooks - no prop drilling.
 */

import { StatusBar } from './components/StatusBar';
import { TmuxStatusBar } from './components/TmuxStatusBar';
import { PaneLayout } from './components/PaneLayout';
import { PopupContainer } from './components/Popup';
import { FloatContainer } from './components/FloatPane';
import {
  useAppSelector,
  useAppState,
  selectPreviewPanes,
  selectIsConnected,
  selectError,
  selectIsPrimary,
  selectGridDimensions,
  selectStatusLine,
  selectPopup,
} from './machines/AppContext';
import { initDebugHelpers } from './utils/debug';

// Initialize debug helpers
initDebugHelpers();

function App() {
  // Select minimal state needed at App level
  const panes = useAppSelector(selectPreviewPanes);
  const connected = useAppSelector(selectIsConnected);
  const error = useAppSelector(selectError);
  const isPrimary = useAppSelector(selectIsPrimary);
  const isConnecting = useAppState('connecting');
  const gridDimensions = useAppSelector(selectGridDimensions);
  const statusLine = useAppSelector(selectStatusLine);
  const popup = useAppSelector(selectPopup);

  // Expose state for debugging
  if (typeof window !== 'undefined' && window.setAppState) {
    window.setAppState(() => ({
      panes,
      connected,
      error,
      isPrimary,
      isConnecting,
      totalWidth: gridDimensions.totalWidth,
      totalHeight: gridDimensions.totalHeight,
      statusLine,
      popup,
    }));
  }

  if (error) {
    return (
      <div className="error" data-testid="error-display">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (isConnecting || panes.length === 0) {
    return (
      <div className="loading" data-testid="loading-display">
        <p>Connecting to tmux...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <StatusBar />
      <div
        className={`pane-container${isPrimary ? '' : ' secondary-client'}`}
        style={{ position: 'relative' }}
      >
        <PaneLayout />
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
