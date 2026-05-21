/**
 * ConnectionStatus — small chip mounted in the status bar.
 *
 * Renders only while the adapter's SSE/Tauri channel is dropped and retrying.
 * The `disconnected` and `connecting` states already use the full-screen
 * StatusScreen instead, so this chip is specifically for the live → degraded
 * transition: layout stays on screen, banner overlays it.
 */

import './ConnectionStatus.css';

export interface ConnectionStatusProps {
  reconnecting: boolean;
  reconnectAttempt: number;
}

export function ConnectionStatus({ reconnecting, reconnectAttempt }: ConnectionStatusProps) {
  if (!reconnecting) return null;
  const suffix = reconnectAttempt > 1 ? ` (attempt ${reconnectAttempt})` : '';
  return (
    <div
      className="connection-status connection-status-reconnecting"
      role="status"
      aria-live="polite"
      data-testid="connection-status"
    >
      <span className="connection-status-dot" aria-hidden="true" />
      <span className="connection-status-text">Reconnecting{suffix}…</span>
    </div>
  );
}
