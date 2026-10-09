/**
 * Action implementations for the notifications state slice.
 *
 * Owns notifications. A notification ages out after NOTIFICATION_DURATION
 * through a delayed DISMISS_NOTIFICATION raise keyed by its id, so closing it
 * early cancels the timer and a stack never dismisses the wrong entry. The
 * same text arriving while it is still on screen refreshes the existing entry
 * (and its timer) instead of stacking a duplicate — a failing command sent
 * on every keystroke must not fill the corner.
 */

import { assign, cancel, raise } from 'xstate';
import { act } from '../actionTypes';
import type { AppNotification } from '../../types';

/** How long a notification stays before dismissing itself. */
export const NOTIFICATION_DURATION = 8000;

/** The most notifications on screen; the oldest goes when another arrives. */
export const MAX_NOTIFICATIONS = 5;

let nextNotificationId = 1;

const timerId = (id: number) => `notificationDismiss:${id}`;

export const notificationsActions = {
  notifications_push: act(({ event, context, enqueue }) => {
    if (event.type !== 'NOTIFY') return;
    const now = Date.now();
    const existing = context.notifications.find((n) => n.text === event.text);
    const entry: AppNotification = existing
      ? { ...existing, timestamp: now }
      : { id: nextNotificationId++, text: event.text, timestamp: now };
    const others = context.notifications.filter((n) => n.id !== entry.id);
    const evicted = others.slice(0, Math.max(0, others.length + 1 - MAX_NOTIFICATIONS));
    for (const n of evicted) enqueue(cancel(timerId(n.id)));
    enqueue(
      assign({
        notifications: [...others.slice(evicted.length), entry],
      }),
    );
    enqueue(cancel(timerId(entry.id)));
    enqueue(
      raise(
        { type: 'DISMISS_NOTIFICATION', id: entry.id },
        { delay: NOTIFICATION_DURATION, id: timerId(entry.id) },
      ),
    );
  }),

  notifications_dismiss: act(({ event, context, enqueue }) => {
    if (event.type !== 'DISMISS_NOTIFICATION') return;
    enqueue(cancel(timerId(event.id)));
    enqueue(
      assign({
        notifications: context.notifications.filter((n) => n.id !== event.id),
      }),
    );
  }),
};
