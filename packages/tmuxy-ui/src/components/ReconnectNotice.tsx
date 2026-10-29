/**
 * ReconnectNotice — the channel dropped while a session was on screen, and
 * has stayed down past RECONNECT_NOTICE_DELAY_MS (machines/constants.ts):
 * a card at the top of the snackbar stack with a spinner, the word, and a
 * "Retry now" that opens a stream at once instead of waiting out the
 * backoff. Nothing covers the panes: they keep their last frame, stay in
 * view and take the pointer, and the notice leaves on its own the moment the
 * channel is back (`reconnecting` → `idle`). A drop that heals inside the
 * delay is never seen at all.
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
