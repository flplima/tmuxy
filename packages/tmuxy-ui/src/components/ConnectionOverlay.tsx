/**
 * What the pane area shows while there is nothing live to show: the first
 * load, a fatal (the backend stopped retrying), a detach, or the end of the
 * attached session. A dropped channel
 * after a frame was shown is not an overlay: the panes stay usable and the
 * snackbar says so (ReconnectNotice).
 */

import type { ReactNode } from 'react';
import type { LogEntry } from '../machines/types/domain';
import './ConnectionOverlay.css';

export type ConnectionOverlayMode = 'connecting' | 'fatal' | 'detached';

export interface ConnectionOverlayProps {
  mode: ConnectionOverlayMode;
  /** True when the pane grid is mounted underneath (a last snapshot to blur). */
  hasLayout: boolean;
  /** A transient error while still connecting — one line, no log. */
  error: string | null;
  /** The reason the backend gave up; shown only in `fatal` mode. */
  fatalError: string | null;
  log: LogEntry[];
  onRetry: () => void;
  /** In `detached` mode: the session ended, rather than this client detaching from it. */
  sessionEnded?: boolean;
  /** What `detached` mode puts on the scrim: the session switcher. */
  children?: ReactNode;
}

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

/** After a detach the session still runs; after it ended there is none to step back in to. */
function overlayTitle(mode: ConnectionOverlayMode, sessionEnded: boolean): string {
  if (mode === 'fatal') return 'Cannot connect to tmux';
  if (mode === 'connecting') return 'Connecting…';
  return sessionEnded ? 'The session ended.' : 'Detached';
}

function detachedNote(sessionEnded: boolean): string {
  return sessionEnded
    ? 'Start a new one, or pick another.'
    : 'tmux is still running. Pick a session to step back in.';
}

export function ConnectionOverlay({
  mode,
  hasLayout,
  error,
  fatalError,
  log,
  onRetry,
  sessionEnded = false,
  children,
}: ConnectionOverlayProps) {
  const isFatal = mode === 'fatal';
  const isDetached = mode === 'detached';
  return (
    <div
      className={`connection-overlay connection-overlay-${mode}${
        hasLayout ? ' connection-overlay-over-layout' : ''
      }`}
      data-testid={isFatal ? 'fatal-display' : 'loading-display'}
      data-mode={mode}
      role="status"
      aria-live="polite"
    >
      {!hasLayout && (
        <div className="connection-placeholder" aria-hidden="true">
          <div className="connection-placeholder-header" />
          <div className="connection-placeholder-surface" />
        </div>
      )}
      <div className="connection-overlay-scrim" aria-hidden="true" />
      <div className="connection-overlay-card">
        {/* Detached is not a wait: there is nothing to spin for, and the way
            back in is the switcher below rather than a retry. */}
        {!isFatal && !isDetached && <span className="connection-spinner" aria-hidden="true" />}
        <p className="connection-overlay-text">{overlayTitle(mode, sessionEnded)}</p>
        {isDetached && <p className="connection-overlay-note">{detachedNote(sessionEnded)}</p>}
        {isDetached && children}
        {!isFatal && !isDetached && error && <p className="connection-overlay-note">{error}</p>}
        {isFatal && (
          <>
            <p className="connection-overlay-note">
              {fatalError && fatalError.length > 0
                ? fatalError
                : 'Failed to connect to tmux. Make sure tmux is installed and running.'}
            </p>
            <button type="button" className="connection-overlay-retry" onClick={onRetry}>
              Retry
            </button>
            <details className="connection-overlay-details">
              <summary>Details</summary>
              <pre className="connection-overlay-log" data-testid="status-log">
                {formatLog(log)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
