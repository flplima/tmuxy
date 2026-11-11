import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { activityState } from '../activity';
import { activityActions } from '../../actions/activity';
import { mountState, sendAndGetContext } from './testHarness';
import type { ActivityRow } from '../../../../domain/activity';
import { recorder } from '../../../../test/app';

const row = (pane: string, session: string, state: ActivityRow['state']): ActivityRow => ({
  paneId: pid(pane),
  windowId: wid('@4'),
  session,
  tab: 'main',
  tabIndex: 0,
  state,
  name: 'claude',
  said: '',
});

function mount(context: { activityOpen?: boolean; activityRows?: ActivityRow[] } = {}) {
  const tmux = recorder();
  const actor = mountState(
    activityState,
    activityActions,
    { sessionName: 'work', activePaneId: pid('%1'), ...context },
    { extraActors: { tmux: tmux.logic } },
  );
  const asked = (type: string) => tmux.received.filter((event) => event.type === type);
  return { actor, asked };
}

describe('activity state', () => {
  it('opening reads the panes, closing does not', () => {
    const { actor, asked } = mount();
    expect(sendAndGetContext(actor, { type: 'TOGGLE_ACTIVITY' }).activityOpen).toBe(true);
    expect(asked('FETCH_ACTIVITY')).toEqual([{ type: 'FETCH_ACTIVITY' }]);
    expect(sendAndGetContext(actor, { type: 'TOGGLE_ACTIVITY' }).activityOpen).toBe(false);
    expect(asked('FETCH_ACTIVITY')).toHaveLength(1);
  });

  it('reads again only while it is open, and keeps what tmux answered', () => {
    const { actor, asked } = mount();
    sendAndGetContext(actor, { type: 'REFRESH_ACTIVITY' });
    expect(asked('FETCH_ACTIVITY')).toHaveLength(0);

    sendAndGetContext(actor, { type: 'TOGGLE_ACTIVITY' });
    sendAndGetContext(actor, { type: 'REFRESH_ACTIVITY' });
    expect(asked('FETCH_ACTIVITY')).toHaveLength(2);

    const rows = [row('%7', 'play', 'needs-input')];
    expect(sendAndGetContext(actor, { type: 'ACTIVITY_LOADED', rows }).activityRows).toEqual(rows);
  });

  it('going to a pane of another session closes the inbox and hands the move to tmux', () => {
    const { actor, asked } = mount({ activityOpen: true });
    const target = row('%7', 'play', 'needs-input');
    const ctx = sendAndGetContext(actor, { type: 'ACTIVITY_GO', row: target });
    expect(ctx.activityOpen).toBe(false);
    expect(asked('GO_TO_PANE')).toEqual([
      expect.objectContaining({ paneId: '%7', session: 'play' }),
    ]);
  });

  it('going to a pane of the session in view asks tmux for no session move', () => {
    const { actor, asked } = mount({ activityOpen: true });
    const ctx = sendAndGetContext(actor, { type: 'ACTIVITY_GO', row: row('%3', 'work', 'unread') });
    expect(ctx.activityOpen).toBe(false);
    expect(asked('GO_TO_PANE')).toEqual([]);
  });

  it('the jump to whoever needs you reads the panes first, then goes', () => {
    const { actor, asked } = mount();
    sendAndGetContext(actor, { type: 'ACTIVITY_GO_MOST_URGENT' });
    expect(asked('FETCH_ACTIVITY')).toEqual([{ type: 'FETCH_ACTIVITY', go: 'most-urgent' }]);

    const rows = [row('%1', 'work', 'needs-input'), row('%7', 'play', 'error')];
    const ctx = sendAndGetContext(actor, { type: 'ACTIVITY_LOADED', rows, go: 'most-urgent' });
    expect(ctx.activityOpen).toBe(false);
    // %1 is the pane in front: the next one is who to go to.
    expect(asked('GO_TO_PANE')).toEqual([expect.objectContaining({ paneId: '%7' })]);
  });

  it('with nobody waiting, the jump goes nowhere', () => {
    const { actor, asked } = mount();
    sendAndGetContext(actor, {
      type: 'ACTIVITY_LOADED',
      rows: [row('%7', 'play', 'working')],
      go: 'most-urgent',
    });
    expect(asked('GO_TO_PANE')).toEqual([]);
  });
});
