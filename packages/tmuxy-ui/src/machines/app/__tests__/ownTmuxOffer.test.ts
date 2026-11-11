/**
 * The launch notice about the user's own tmux server.
 *
 * Someone with tmux sessions running opens tmuxy, sees an empty session and
 * takes their work for gone: tmuxy runs on a socket of its own. On connect
 * the app asks the host about that server, shows what it answers, and either
 * answer from the user closes the offer for good on the host.
 */

import { describe, it, expect } from 'vitest';
import { startApp, recorder } from '../../../test/app';
import type { OwnTmuxOffer } from '../../../domain/servers';

const desktopOffer: OwnTmuxOffer = {
  serverId: 'my-tmux',
  sessions: 3,
  session: 'work',
  canSwitch: true,
};
const webOffer: OwnTmuxOffer = { serverId: 'my-tmux', sessions: 1, canSwitch: false };

function app() {
  const tmux = recorder();
  const servers = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic, serversActor: servers.logic } });
  const calls = () =>
    tmux.received.flatMap((event) => (event.type === 'INVOKE' ? [[event.cmd, event.args]] : []));
  return { actor, calls, servers };
}

describe('the launch notice about the user’s own tmux', () => {
  it('asks the host once the app has connected', () => {
    const { actor, servers } = app();
    expect(servers.received).toEqual([]);

    actor.send({ type: 'CONNECTION_INFO', defaultShell: 'zsh', hostname: null });

    expect(servers.received).toEqual([{ type: 'LOOK_FOR_OWN_TMUX' }]);
  });

  it('shows the offer the host makes, and nothing when it makes none', () => {
    const { actor } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: null });
    expect(actor.getSnapshot().context.ownTmuxNotice).toBeNull();

    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });
    expect(actor.getSnapshot().context.ownTmuxNotice).toEqual({
      offer: desktopOffer,
      switched: false,
    });
  });

  it('taking it switches to that server and its session, and keeps the notice to say how to stay', () => {
    const { actor, calls } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });

    expect(calls()).toEqual([
      ['close_own_tmux_offer', {}],
      ['connect_server', { id: 'my-tmux', session: 'work' }],
    ]);
    const { ownTmuxNotice, currentServerId } = actor.getSnapshot().context;
    expect(currentServerId).toBe('my-tmux');
    expect(ownTmuxNotice).toEqual({ offer: desktopOffer, switched: true });

    // The switch reconnects, and the host is asked nothing new by an answer
    // that arrives late: the notice on screen is the user's, not the host's.
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });
    expect(actor.getSnapshot().context.ownTmuxNotice?.switched).toBe(true);

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'dismiss' });
    expect(actor.getSnapshot().context.ownTmuxNotice).toBeNull();
    expect(calls()).toHaveLength(2);
  });

  it('declining it closes the offer on the host and connects nowhere', () => {
    const { actor, calls } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'dismiss' });

    expect(calls()).toEqual([['close_own_tmux_offer', {}]]);
    expect(actor.getSnapshot().context.ownTmuxNotice).toBeNull();
    expect(actor.getSnapshot().context.currentServerId).toBeNull();
  });

  it('a host that cannot switch servers is never asked to', () => {
    const { actor, calls } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: webOffer });

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });

    expect(calls()).toEqual([['close_own_tmux_offer', {}]]);
    expect(actor.getSnapshot().context.ownTmuxNotice).toBeNull();
  });

  it('an answer with no notice on screen does nothing', () => {
    const { actor, calls } = app();
    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });
    expect(calls()).toEqual([]);
  });
});
