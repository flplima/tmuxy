/**
 * Snackbar — what the user has to see, stacked in the top-right corner of the
 * app chrome: a dropped channel that has stayed down (ReconnectNotice), the
 * errors, and the messages tmux shows this client (`display-message`).
 *
 * Renders `notifications` from the machine (see states/notifications.ts):
 * oldest at the top, each with a close button; an entry also ages out on its
 * own. An error is an alert with the red edge; a tmux message is a status in
 * the theme's neutral border, so it is neither styled nor announced as a
 * failure. The reconnect notice sits first and has no close button: it goes
 * when the channel is back.
 */

import { useAppSelector, useAppSend, useAppState } from '../machines/appHooks';
import { selectNotifications } from '../machines/selectors/ui';
import { ReconnectNotice } from './ReconnectNotice';
import './Snackbar.css';

export function Snackbar() {
  const notifications = useAppSelector(selectNotifications);
  const reconnecting = useAppState({ reconnecting: 'noticed' });
  const send = useAppSend();
  if (notifications.length === 0 && !reconnecting) return null;

  return (
    <div className="snackbar-stack" data-testid="snackbar" role="region" aria-label="Notifications">
      <ReconnectNotice />
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`snackbar${n.kind === 'info' ? ' is-info' : ''}`}
          role={n.kind === 'info' ? 'status' : 'alert'}
          data-testid="snackbar-item"
        >
          <span className="snackbar-text">{n.text}</span>
          <button
            type="button"
            className="snackbar-close"
            aria-label="Dismiss notification"
            onClick={() => send({ type: 'DISMISS_NOTIFICATION', id: n.id })}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
