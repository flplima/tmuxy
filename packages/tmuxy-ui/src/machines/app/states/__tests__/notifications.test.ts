import { describe, it, expect, vi, afterEach } from 'vitest';
import { notificationsState } from '../notifications';
import {
  notificationsActions,
  NOTIFICATION_DURATION,
  MAX_NOTIFICATIONS,
} from '../../actions/notifications';
import { mountState, sendAndGetContext } from './testHarness';
import type { AppNotification } from '../../../types';

const texts = (notifications: AppNotification[]) => notifications.map((n) => n.text);

const mount = () => mountState(notificationsState, notificationsActions);

describe('notifications state', () => {
  afterEach(() => vi.useRealTimers());

  it('NOTIFY appends an entry with the text', () => {
    const actor = mount();
    const ctx = sendAndGetContext(actor, { type: 'NOTIFY', text: "can't find window: @9" });
    expect(ctx.notifications.map((n) => n.text)).toEqual(["can't find window: @9"]);
  });

  it('notifications stack oldest first', () => {
    const actor = mount();
    actor.send({ type: 'NOTIFY', text: 'first' });
    const ctx = sendAndGetContext(actor, { type: 'NOTIFY', text: 'second' });
    expect(ctx.notifications.map((n) => n.text)).toEqual(['first', 'second']);
    expect(ctx.notifications[0].id).not.toBe(ctx.notifications[1].id);
  });

  it('DISMISS_NOTIFICATION removes only that entry', () => {
    const actor = mount();
    actor.send({ type: 'NOTIFY', text: 'first' });
    actor.send({ type: 'NOTIFY', text: 'second' });
    const first = actor.getSnapshot().context.notifications[0];
    const ctx = sendAndGetContext(actor, { type: 'DISMISS_NOTIFICATION', id: first.id });
    expect(ctx.notifications.map((n) => n.text)).toEqual(['second']);
  });

  it('the same text while still on screen refreshes the entry instead of stacking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const actor = mount();
    actor.send({ type: 'NOTIFY', text: 'pane too small' });
    const before = actor.getSnapshot().context.notifications[0];
    vi.setSystemTime(2_000);
    const ctx = sendAndGetContext(actor, { type: 'NOTIFY', text: 'pane too small' });
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].id).toBe(before.id);
    expect(ctx.notifications[0].timestamp).toBe(2_000);
  });

  it('the oldest entry goes when the stack is full', () => {
    const actor = mount();
    for (let i = 0; i <= MAX_NOTIFICATIONS; i++) actor.send({ type: 'NOTIFY', text: `e${i}` });
    const shown = texts(actor.getSnapshot().context.notifications);
    expect(shown).toHaveLength(MAX_NOTIFICATIONS);
    expect(shown[0]).toBe('e1');
    expect(shown[shown.length - 1]).toBe(`e${MAX_NOTIFICATIONS}`);
  });

  describe('ageing out (delayed raise per entry)', () => {
    it('an entry dismisses itself after NOTIFICATION_DURATION', () => {
      vi.useFakeTimers();
      const actor = mount();
      actor.send({ type: 'NOTIFY', text: 'gone soon' });
      vi.advanceTimersByTime(NOTIFICATION_DURATION - 1);
      expect(actor.getSnapshot().context.notifications).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(actor.getSnapshot().context.notifications).toHaveLength(0);
    });

    it('each entry keeps its own timer', () => {
      vi.useFakeTimers();
      const actor = mount();
      actor.send({ type: 'NOTIFY', text: 'first' });
      vi.advanceTimersByTime(NOTIFICATION_DURATION / 2);
      actor.send({ type: 'NOTIFY', text: 'second' });
      vi.advanceTimersByTime(NOTIFICATION_DURATION / 2);
      expect(texts(actor.getSnapshot().context.notifications)).toEqual(['second']);
      vi.advanceTimersByTime(NOTIFICATION_DURATION / 2);
      expect(actor.getSnapshot().context.notifications).toHaveLength(0);
    });

    it('a refreshed entry restarts its timer', () => {
      vi.useFakeTimers();
      const actor = mount();
      actor.send({ type: 'NOTIFY', text: 'again' });
      vi.advanceTimersByTime(NOTIFICATION_DURATION - 100);
      actor.send({ type: 'NOTIFY', text: 'again' });
      vi.advanceTimersByTime(100);
      expect(actor.getSnapshot().context.notifications).toHaveLength(1);
      vi.advanceTimersByTime(NOTIFICATION_DURATION - 100);
      expect(actor.getSnapshot().context.notifications).toHaveLength(0);
    });

    it('closing an entry early does not fire its stale timer on a later one', () => {
      vi.useFakeTimers();
      const actor = mount();
      actor.send({ type: 'NOTIFY', text: 'first' });
      const first = actor.getSnapshot().context.notifications[0];
      actor.send({ type: 'DISMISS_NOTIFICATION', id: first.id });
      actor.send({ type: 'NOTIFY', text: 'second' });
      vi.advanceTimersByTime(NOTIFICATION_DURATION - 1);
      expect(texts(actor.getSnapshot().context.notifications)).toEqual(['second']);
    });
  });
});
