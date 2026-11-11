import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { OwnTmuxNotice } from '../OwnTmuxNotice';
import { AppActorContext } from '../../machines/appContexts';
import { startApp, recorder } from '../../test/app';
import type { OwnTmuxOffer } from '../../domain/servers';

const offer = (over: Partial<OwnTmuxOffer> = {}): OwnTmuxOffer => ({
  serverId: 'my-tmux',
  sessions: 3,
  session: 'work',
  canSwitch: true,
  ...over,
});

function mount(offered: OwnTmuxOffer | null) {
  const tmux = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic } });
  render(
    <AppActorContext.Provider value={actor}>
      <OwnTmuxNotice />
    </AppActorContext.Provider>,
  );
  act(() => actor.send({ type: 'OWN_TMUX_OFFERED', offer: offered }));
  return { actor, tmux };
}

const notice = () => screen.queryByTestId('own-tmux-notice');

describe('OwnTmuxNotice', () => {
  it('draws nothing when the host offered nothing', () => {
    mount(null);
    expect(notice()).toBeNull();
  });

  it('on the desktop says where the sessions are and offers to switch', () => {
    mount(offer());
    expect(notice()?.textContent).toContain('Your tmux has 3 sessions on its default socket');
    expect(notice()?.textContent).toContain('tmuxy runs on a socket of its own');
    expect(notice()?.textContent).not.toContain('TMUX_SOCKET');
    expect(screen.getByTestId('own-tmux-use').textContent).toBe('Use my tmux');
    expect(screen.getByTestId('own-tmux-dismiss').textContent).toBe('Stay here');
  });

  it('counts one session as one', () => {
    mount(offer({ sessions: 1 }));
    expect(notice()?.textContent).toContain('Your tmux has 1 session on');
  });

  it('on the web, which cannot switch, says how to start there', () => {
    mount(offer({ canSwitch: false }));
    expect(notice()?.textContent).toContain('start tmuxy with TMUX_SOCKET=default');
    expect(screen.queryByTestId('own-tmux-use')).toBeNull();
    expect(screen.getByTestId('own-tmux-dismiss').textContent).toBe('Got it');
  });

  it('after the switch says how to start there every time, until dismissed', () => {
    const { actor } = mount(offer());

    fireEvent.click(screen.getByTestId('own-tmux-use'));

    expect(actor.getSnapshot().context.currentServerId).toBe('my-tmux');
    expect(notice()?.getAttribute('data-stage')).toBe('switched');
    expect(notice()?.textContent).toContain('launch tmuxy with TMUX_SOCKET=default');
    expect(screen.queryByTestId('own-tmux-use')).toBeNull();

    fireEvent.click(screen.getByTestId('own-tmux-dismiss'));
    expect(notice()).toBeNull();
  });
});
