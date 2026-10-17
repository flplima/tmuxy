/**
 * notifications state — what the user has to see in the snackbar.
 *
 * Owns context field: notifications. Errors raise NOTIFY (kind `error`, the
 * default); a message tmux shows this client (`display-message`, arriving as
 * `%message`) raises it with kind `info`. The Snackbar component renders the
 * list in the top-right corner of the app chrome, newest at the bottom, each
 * with a close button. The client's own status ("Copied …") stays on the
 * status line (commandUi).
 * Action implementations live in ../actions/notifications.ts.
 */

export const notificationsState = {
  on: {
    NOTIFY: { actions: 'notifications_push' },
    DISMISS_NOTIFICATION: { actions: 'notifications_dismiss' },
  },
} as const;
