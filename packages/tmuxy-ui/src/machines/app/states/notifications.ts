/**
 * notifications state — what the user has to see in the snackbar. Errors
 * raise NOTIFY (kind `error`, the default); a message tmux shows this client
 * (`display-message`, arriving as `%message`) raises it with kind `info`. The
 * client's own status ("Copied …") stays on the status line (commandUi).
 */

export const notificationsState = {
  on: {
    NOTIFY: { actions: 'notifications_push' },
    DISMISS_NOTIFICATION: { actions: 'notifications_dismiss' },
  },
} as const;
