import { useAppSelector, useAppSend, useAppState } from '../machines/appHooks';
import { selectNotifications, selectOwnTmuxNotice } from '../machines/selectors/ui';
import { OwnTmuxNotice } from './OwnTmuxNotice';
import { ReconnectNotice } from './ReconnectNotice';
import './Snackbar.css';

export function Snackbar() {
  const notifications = useAppSelector(selectNotifications);
  const reconnecting = useAppState({ reconnecting: 'noticed' });
  const ownTmux = useAppSelector(selectOwnTmuxNotice);
  const send = useAppSend();
  if (notifications.length === 0 && !reconnecting && !ownTmux) return null;

  return (
    <div className="snackbar-stack" data-testid="snackbar" role="region" aria-label="Notifications">
      <ReconnectNotice />
      <OwnTmuxNotice />
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
