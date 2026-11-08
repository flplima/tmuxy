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
