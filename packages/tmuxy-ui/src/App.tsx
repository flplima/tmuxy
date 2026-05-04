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
  selectFatalError,
  selectLog,
  selectContainerSize,
} from './machines/AppContext';
import type { LogEntry } from './machines/types';
import { initDebugHelpers } from './utils/debug';

export type RenderTabline = (props: { children: ReactNode }) => ReactNode;

// Initialize debug helpers
initDebugHelpers();

function formatLog(log: LogEntry[]): string {
  if (log.length === 0) return 'No activity yet.';
  return log
    .map((entry) => {
      const time = new Date(entry.timestamp).toISOString().slice(11, 23);
      const tag = entry.kind.toUpperCase().padEnd(7);
      return `[${time}] ${tag} ${entry.message}`;
    })
    .join('\n');
}

interface StatusScreenProps {
  error: string | null;
  fatalError: string | null;
  isConnecting: boolean;
  log: LogEntry[];
}

function StatusScreen({ error, fatalError, isConnecting, log }: StatusScreenProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = formatLog(log);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Auto-scroll to bottom unless the user is selecting text
    if (document.activeElement !== el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  const isFatal = fatalError != null;
  const displayMessage = fatalError ?? error;
  const heading = isFatal
    ? 'Cannot connect to tmux'
    : displayMessage
      ? 'Connection Error'
      : isConnecting
        ? 'Connecting to tmux...'
        : 'Waiting for tmux state...';
  const testId = isFatal ? 'fatal-display' : displayMessage ? 'error-display' : 'loading-display';
  const className = isFatal ? 'error fatal' : displayMessage ? 'error' : 'loading';

  return (
    <div className={className} data-testid={testId}>
      <h2>{heading}</h2>
      {displayMessage && (
        <p className="status-message">
          {displayMessage.length > 0
            ? displayMessage
            : 'Failed to connect to tmux. Make sure tmux is installed and running.'}
        </p>
      )}
      {isFatal && (
        <p className="status-hint">
          The backend has stopped retrying. Restart the app to try again.
        </p>
      )}
      <div className="status-details">
        <label htmlFor="status-log" className="status-details-label">
          Details (commands &amp; errors)
        </label>
        <textarea
          id="status-log"
          ref={textareaRef}
          className="status-details-log"
          data-testid="status-log"
          readOnly
          value={text}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function App({ renderTabline }: { renderTabline?: RenderTabline } = {}) {
  // Select minimal state needed at App level
  const panes = useAppSelector(selectPreviewPanes);
  const error = useAppSelector(selectError);
  const fatalError = useAppSelector(selectFatalError);
  const log = useAppSelector(selectLog);
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
        {!showLayout ? (
          <StatusScreen
            error={error}
            fatalError={fatalError}
            isConnecting={isConnecting}
            log={log}
          />
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
