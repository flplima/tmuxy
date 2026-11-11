/**
 * Shown once, at launch, to someone whose own tmux server (the one a bare
 * `tmux` talks to) has sessions: tmuxy runs on a socket of its own, so the
 * app opens on an empty session and their work looks gone. The desktop offers
 * to switch there; a web server serves the socket it was started on, so the
 * notice says how to start it there instead. Either answer closes it for good
 * (`own_tmux_asked` in the host's state file). Nothing covers the panes.
 */

import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectOwnTmuxNotice } from '../machines/selectors/ui';

/** How a launch is pointed at the user's own server, on the desktop and the web alike. */
const START_THERE = 'TMUX_SOCKET=default';

export function OwnTmuxNotice() {
  const notice = useAppSelector(selectOwnTmuxNotice);
  const send = useAppSend();
  if (!notice) return null;

  const { offer, switched } = notice;
  const answer = (choice: 'use' | 'dismiss') =>
    send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: choice });
  const count = `${offer.sessions} ${offer.sessions === 1 ? 'session' : 'sessions'}`;
  const offersSwitch = offer.canSwitch && !switched;

  return (
    <div
      className="snackbar is-info snackbar-own-tmux"
      role="status"
      data-testid="own-tmux-notice"
      data-stage={switched ? 'switched' : 'ask'}
    >
      <span className="snackbar-text">
        {switched ? (
          <>
            Now on your own tmux server. To start there every time, launch tmuxy with{' '}
            <code>{START_THERE}</code>.
          </>
        ) : (
          <>
            Your tmux has {count} on its default socket. tmuxy runs on a socket of its own, so they
            are not shown here.
            {!offer.canSwitch && (
              <>
                {' '}
                To use them here, start tmuxy with <code>{START_THERE}</code>.
              </>
            )}
          </>
        )}
      </span>
      <span className="snackbar-actions">
        {offersSwitch && (
          <button
            type="button"
            className="snackbar-action is-primary"
            data-testid="own-tmux-use"
            onClick={() => answer('use')}
          >
            Use my tmux
          </button>
        )}
        <button
          type="button"
          className="snackbar-action"
          data-testid="own-tmux-dismiss"
          onClick={() => answer('dismiss')}
        >
          {offersSwitch ? 'Stay here' : 'Got it'}
        </button>
      </span>
    </div>
  );
}
