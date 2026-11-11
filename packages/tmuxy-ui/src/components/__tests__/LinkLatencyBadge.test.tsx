import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LinkLatencyBadge } from '../LinkLatencyBadge';
import { AppActorContext } from '../../machines/appContexts';
import { linkLatency } from '../../infra/linkLatency';
import { startApp } from '../../test/app';

function mounted(props: { explainOnTap?: boolean } = {}) {
  const actor = startApp();
  render(
    <AppActorContext.Provider value={actor}>
      <LinkLatencyBadge {...props} />
    </AppActorContext.Provider>,
  );
  return actor;
}

/** Three answers, the fewest the estimate is read from. */
const answersIn = (ms: number) =>
  act(() => {
    for (let i = 0; i < 3; i++) linkLatency.record(ms);
  });

describe('LinkLatencyBadge', () => {
  beforeEach(() => linkLatency.reset());

  it('is not there on a fast link, and names the round trip on a slow one', () => {
    mounted();
    answersIn(2);
    expect(screen.queryByTestId('link-latency')).toBeNull();

    answersIn(172);
    // The estimate is the fastest recent answer, so the fast ones leave first.
    act(() => {
      for (let i = 0; i < 9; i++) linkLatency.record(172);
    });
    expect(screen.getByTestId('link-latency').textContent).toBe('170 ms');
    expect(screen.getByTestId('link-latency').className).toContain('is-slow');
  });

  it('on a phone explains itself in the snackbar when tapped', () => {
    const actor = mounted({ explainOnTap: true });
    const sent = vi.spyOn(actor, 'send');
    answersIn(340);
    const badge = screen.getByRole('button', { name: /Slow link/ });
    expect(badge.className).toContain('is-very-slow');

    fireEvent.click(badge);
    expect(sent).toHaveBeenCalledWith({
      type: 'NOTIFY',
      text: 'Slow link: every key takes at least 340 ms to show',
      kind: 'info',
    });
  });

  it('goes when the connection does: the reconnect notice speaks for a dead link', () => {
    const actor = mounted();
    answersIn(172);
    expect(screen.getByTestId('link-latency')).toBeTruthy();
    act(() => actor.send({ type: 'TMUX_FATAL', message: 'gone' }));
    expect(screen.queryByTestId('link-latency')).toBeNull();
  });
});
