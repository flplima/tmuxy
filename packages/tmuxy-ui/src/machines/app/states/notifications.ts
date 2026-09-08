/**
 * notifications state — the errors the user has to see.
 *
 * Owns context field: notifications. Anything that used to put an error on
 * the status line raises NOTIFY instead; the Snackbar component renders the
 * list in the top-right corner of the app chrome, newest at the bottom, each
 * with a close button. Status that is not an error ("Copied …",
 * `display-message` output) stays on the status line (commandUi).
 * Action implementations live in ../actions/notifications.ts.
 */

export const notificationsState = {
  on: {
    NOTIFY: { actions: 'notifications_push' },
    DISMISS_NOTIFICATION: { actions: 'notifications_dismiss' },
  },
} as const;
