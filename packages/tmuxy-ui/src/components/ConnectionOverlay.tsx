/**
 * ConnectionOverlay — what the pane area shows while there is nothing live
 * to show.
 *
 *  - `connecting` (first load): a pane placeholder (header bar + terminal
 *    surface in the theme's colours) under a blurred scrim, a spinner and the
 *    single word "Connecting…". No log, no details.
 *  - `reconnecting` (the channel dropped after a frame was shown): the last
 *    snapshot of the panes stays mounted underneath (`hasLayout`), blurred,
 *    with the same spinner and word. The overlay leaves on the first state
 *    update after the channel is back.
 *  - `fatal` (the backend stopped retrying): the one-line reason, a Retry
 *    button, and the command/error log behind a collapsed "Details"
 *    disclosure so support information stays reachable.
 *
 * Presentational: App decides the mode from the machine state and passes
 * everything in, so the three looks can be shown on their own in Storybook.
 */

import type { LogEntry } from '../machines/types';
import './ConnectionOverlay.css';

export type ConnectionOverlayMode = 'connecting' | 'reconnecting' | 'fatal';

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

export function ConnectionOverlay({
  mode,
  hasLayout,
  error,
  fatalError,
  log,
  onRetry,
}: ConnectionOverlayProps) {
  const isFatal = mode === 'fatal';
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
        {!isFatal && <span className="connection-spinner" aria-hidden="true" />}
        <p className="connection-overlay-text">
          {isFatal ? 'Cannot connect to tmux' : 'Connecting…'}
        </p>
        {!isFatal && error && <p className="connection-overlay-note">{error}</p>}
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
