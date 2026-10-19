/**
 * Snackbar — what the user has to see, stacked in the top-right corner of the
 * app chrome: the errors, and the messages tmux shows this client
 * (`display-message`).
 *
 * Renders `notifications` from the machine (see states/notifications.ts):
 * oldest at the top, each with a close button; an entry also ages out on its
 * own. An error is an alert with the red edge; a tmux message is a status in
 * the theme's neutral border, so it is neither styled nor announced as a
 * failure.
 */

import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectNotifications } from '../machines/selectors/ui';
import './Snackbar.css';

export function Snackbar() {
  const notifications = useAppSelector(selectNotifications);
  const send = useAppSend();
  if (notifications.length === 0) return null;

  return (
    <div className="snackbar-stack" data-testid="snackbar" role="region" aria-label="Notifications">
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
