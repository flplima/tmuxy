/**
 * Snackbar — the errors the user has to see, stacked in the top-right corner
 * of the app chrome.
 *
 * Renders `notifications` from the machine (see states/notifications.ts):
 * oldest at the top, each with a close button; an entry also ages out on its
 * own. Nothing here decides what is an error — anything that raises NOTIFY
 * ends up in this corner, and status that is not an error stays on the
 * status line.
 */

import { useAppSelector, useAppSend, selectNotifications } from '../machines/AppContext';
import './Snackbar.css';

export function Snackbar() {
  const notifications = useAppSelector(selectNotifications);
  const send = useAppSend();
  if (notifications.length === 0) return null;

  return (
    <div className="snackbar-stack" data-testid="snackbar" role="region" aria-label="Notifications">
      {notifications.map((n) => (
        <div key={n.id} className="snackbar" role="alert" data-testid="snackbar-item">
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
