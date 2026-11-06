/**
 * Shown once the channel has stayed down past RECONNECT_NOTICE_DELAY_MS;
 * "Retry now" skips the backoff. Nothing covers the panes: they keep their
 * last frame and take the pointer.
 */

import { useAppSend, useAppState } from '../machines/appHooks';

export function ReconnectNotice() {
  const send = useAppSend();
  const noticed = useAppState({ reconnecting: 'noticed' });
  if (!noticed) return null;
  return (
    <div
      className="snackbar is-info snackbar-reconnect"
      role="status"
      data-testid="reconnect-notice"
      data-mode="reconnecting"
    >
      <span className="connection-spinner snackbar-spinner" aria-hidden="true" />
      <span className="snackbar-text">Reconnecting…</span>
      <button
        type="button"
        className="snackbar-action"
        onClick={() => send({ type: 'RECONNECT_NOW' })}
      >
        Retry now
      </button>
    </div>
  );
}
