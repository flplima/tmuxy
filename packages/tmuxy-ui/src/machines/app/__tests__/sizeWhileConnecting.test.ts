/**
 * The size this client reports while its first connection is still being
 * made: the in-browser guest attaches its tmux client at it, long after
 * the page measured itself, instead of at a default it then resizes from. Whether a backend hears it that early is the transport's
 * call (`TmuxTransport.test.ts`); here, what the app sends.
 */
import { describe, it, expect } from 'vitest';
import { recorder, startApp } from '../../../test/app';
import { PHONE_COLS, PHONE_ROWS } from '../../../infra/dom/phoneLayout';

function connectingApp() {
  const tmux = recorder();
  const actor = startApp({ connected: false, actors: { tmuxActor: tmux.logic } });
  const reports = () =>
    tmux.received
      .filter((event) => event.type === 'SET_CLIENT_SIZE')
      .map((event) => [event.cols, event.rows]);
  return { actor, tmux, reports };
}

describe('the size measured while connecting', () => {
  it('is reported each time it is measured, and the state is fetched at it once connected', () => {
    const { actor, tmux, reports } = connectingApp();
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 30 });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 150, rows: 40 });
    expect(reports()).toEqual([
      [120, 30],
      [150, 40],
    ]);

    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 150, rows: 40, resend: true });
    expect(reports()).toHaveLength(2);
    expect(tmux.received.filter((event) => event.type === 'FETCH_INITIAL_STATE')).toEqual([
      { type: 'FETCH_INITIAL_STATE', cols: 150, rows: 40 },
    ]);
  });

  it("is a phone's fixed grid on a phone, whatever the container measures", () => {
    const { actor, reports } = connectingApp();
    actor.send({ type: 'SET_PHONE_LAYOUT', phone: true, landscape: false });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 43, rows: 50 });
    expect(reports()).toEqual([[PHONE_COLS, PHONE_ROWS]]);
  });
});
