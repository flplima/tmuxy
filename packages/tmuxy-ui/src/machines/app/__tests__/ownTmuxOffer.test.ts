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
  /** What the tmux actor was asked for, less the bookkeeping every app start sends. */
  const asked = () =>
    tmux.received.flatMap((event) =>
      event.type === 'INVOKE'
        ? [[event.cmd, event.args]]
        : event.type === 'TAKE_OWN_TMUX_OFFER'
          ? [['take', event.serverId, event.session]]
          : [],
    );
  const notice = () => actor.getSnapshot().context.ownTmuxNotice;
  return { actor, asked, notice, servers };
}

describe('the launch notice about the user’s own tmux', () => {
  it('asks the host once the app has connected', () => {
    const { actor, servers } = app();
    expect(servers.received).toEqual([]);

    actor.send({ type: 'CONNECTION_INFO', defaultShell: 'zsh', hostname: null });

    expect(servers.received).toEqual([{ type: 'LOOK_FOR_OWN_TMUX' }]);
  });

  it('shows the offer the host makes, and nothing when it makes none', () => {
    const { actor, notice } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: null });
    expect(notice()).toBeNull();

    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });
    expect(notice()).toEqual({ offer: desktopOffer, stage: 'ask' });
  });

  it('taking it asks the host to switch, and says it is there only once the host took it', () => {
    const { actor, asked, notice } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });

    // Nothing is claimed yet, and nothing is closed on the host from here:
    // the tmux actor closes the offer when the switch is taken.
    expect(asked()).toEqual([['take', 'my-tmux', 'work']]);
    expect(notice()?.stage).toBe('switching');
    expect(actor.getSnapshot().context.currentServerId).toBeNull();
    // A second click, or a late answer from the host, changes nothing.
    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });
    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'dismiss' });
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });
    expect(asked()).toHaveLength(1);
    expect(notice()?.stage).toBe('switching');

    actor.send({ type: 'OWN_TMUX_OFFER_TAKEN', taken: true });

    expect(notice()).toEqual({ offer: desktopOffer, stage: 'switched' });
    expect(actor.getSnapshot().context.currentServerId).toBe('my-tmux');

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'dismiss' });
    expect(notice()).toBeNull();
    expect(asked()).toHaveLength(1);
  });

  // That server went away between the offer and the click: the host refuses,
  // and "Now on your own tmux" over the old session would be a lie that also
  // cost the user the offer.
  it('a switch the host refused leaves the offer open', () => {
    const { actor, asked, notice } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });
    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });

    actor.send({ type: 'OWN_TMUX_OFFER_TAKEN', taken: false });

    expect(notice()).toEqual({ offer: desktopOffer, stage: 'ask' });
    expect(actor.getSnapshot().context.currentServerId).toBeNull();
    expect(asked()).toEqual([['take', 'my-tmux', 'work']]);
  });

  it('declining it closes the offer on the host and connects nowhere', () => {
    const { actor, asked, notice } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: desktopOffer });

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'dismiss' });

    expect(asked()).toEqual([['close_own_tmux_offer', {}]]);
    expect(notice()).toBeNull();
    expect(actor.getSnapshot().context.currentServerId).toBeNull();
  });

  it('a host that cannot switch servers is never asked to', () => {
    const { actor, asked, notice } = app();
    actor.send({ type: 'OWN_TMUX_OFFERED', offer: webOffer });

    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });

    expect(asked()).toEqual([['close_own_tmux_offer', {}]]);
    expect(notice()).toBeNull();
  });

  it('an answer with no notice on screen does nothing', () => {
    const { actor, asked } = app();
    actor.send({ type: 'ANSWER_OWN_TMUX_OFFER', answer: 'use' });
    actor.send({ type: 'OWN_TMUX_OFFER_TAKEN', taken: true });
    expect(asked()).toEqual([]);
  });
});
