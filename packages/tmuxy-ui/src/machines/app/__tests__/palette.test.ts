/**
 * The command palette's slice: it opens in a mode and closes, asks for the
 * session listing when it opens, and goes to a tab or pane — at once in this
 * session, after the switch in another.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';
import { toTmuxCommand } from '../../../domain/commands';

const TAB_A = wid('@0');
const TAB_B = wid('@1');
const PANE_A = pid('%0');
const PANE_B = pid('%1');
const FAR_TAB = wid('@7');
const FAR_PANE = pid('%9');

/** This session: two tabs, a pane in each, the first in front. */
const here = () =>
  modelUpdate(
    [modelPane(PANE_A, TAB_A, { active: true }), modelPane(PANE_B, TAB_B, { active: true })],
    [modelWindow(TAB_A, 0, { active: true }), modelWindow(TAB_B, 1)],
    { paneId: PANE_A, windowId: TAB_A },
    { sessionName: 'tmuxy' },
  );

/** The other session: two tabs, tmux showing the first. */
const there = (sessionName = 'other') =>
  modelUpdate(
    [
      modelPane(pid('%8'), wid('@6'), { active: true }),
      modelPane(FAR_PANE, FAR_TAB, { active: true }),
    ],
    [modelWindow(wid('@6'), 0, { active: true }), modelWindow(FAR_TAB, 1)],
    { paneId: pid('%8'), windowId: wid('@6') },
    { sessionName },
  );

function app() {
  const tmux = recorder();
  const store = recorder();
  const servers = recorder();
  const actor = startApp({
    actors: { tmuxActor: tmux.logic, tmuxStoreActor: store.logic, serversActor: servers.logic },
  });
  actor.send(here());
  const commands = () => store.ops().map((op) => toTmuxCommand(op));
  return { actor, tmux, store, servers, commands, ctx: () => actor.getSnapshot().context };
}

describe('the command palette', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens in a mode, switches mode, and closes on the same key', () => {
    const { actor, ctx } = app();
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'all' });
    expect(ctx().palette).toBe('all');
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'go' });
    expect(ctx().palette).toBe('go');
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'go' });
    expect(ctx().palette).toBeNull();
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'all' });
    actor.send({ type: 'CLOSE_PALETTE' });
    expect(ctx().palette).toBeNull();
    actor.stop();
  });

  it('asks for the session listing each time it opens, not when it closes', () => {
    const { actor, servers } = app();
    const asked = () => servers.received.filter((e) => e.type === 'REFRESH_SESSIONS').length;
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'all' });
    expect(asked()).toBe(1);
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'all' });
    expect(asked()).toBe(1);
    actor.send({ type: 'TOGGLE_PALETTE', mode: 'go' });
    expect(asked()).toBe(2);
    actor.stop();
  });

  it('goes to a pane of this session the way a click does: its tab, then the pane', () => {
    const { actor, commands, tmux } = app();
    actor.send({ type: 'GO_TO', sessionName: 'tmuxy', windowId: TAB_B, paneId: PANE_B });
    expect(commands().some((c) => c.includes(`select-window -t ${TAB_B}`))).toBe(true);
    expect(commands().some((c) => c.includes(`select-pane -t ${PANE_B}`))).toBe(true);
    expect(tmux.received.some((e) => e.type === 'SWITCH_SESSION')).toBe(false);
    actor.stop();
  });

  it('switches session first for a pane elsewhere, and picks it once it is there', () => {
    const { actor, commands, tmux, ctx } = app();
    actor.send({ type: 'GO_TO', sessionName: 'other', windowId: FAR_TAB, paneId: FAR_PANE });

    expect(ctx().sessionName).toBe('other');
    expect(tmux.received.filter((e) => e.type === 'SWITCH_SESSION')).toEqual([
      { type: 'SWITCH_SESSION', sessionName: 'other' },
    ]);
    // Nothing is selected in a session whose panes this client does not hold yet.
    expect(commands().some((c) => c.includes(FAR_PANE))).toBe(false);
    expect(ctx().pendingGoTo).toMatchObject({ sessionName: 'other', paneId: FAR_PANE });

    // A last frame of the session it left changes nothing.
    actor.send(here());
    expect(ctx().pendingGoTo).not.toBeNull();

    actor.send(there());

    expect(commands().some((c) => c.includes(`select-window -t ${FAR_TAB}`))).toBe(true);
    expect(commands().some((c) => c.includes(`select-pane -t ${FAR_PANE}`))).toBe(true);
    expect(ctx().pendingGoTo).toBeNull();
    actor.stop();
  });

  it('goes to a tab elsewhere without naming a pane', () => {
    const { actor, commands, ctx } = app();
    actor.send({ type: 'GO_TO', sessionName: 'other', windowId: FAR_TAB });
    actor.send(there());
    expect(commands().some((c) => c.includes(`select-window -t ${FAR_TAB}`))).toBe(true);
    expect(ctx().pendingGoTo).toBeNull();
    actor.stop();
  });

  it('gives up on a place that never shows, and on one in a session it left', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { actor, commands, ctx } = app();
    actor.send({ type: 'GO_TO', sessionName: 'other', windowId: FAR_TAB, paneId: pid('%99') });
    actor.send(there());
    // Not there yet: still waited for.
    expect(ctx().pendingGoTo).not.toBeNull();
    now.mockReturnValue(60_000);
    actor.send(there());
    expect(ctx().pendingGoTo).toBeNull();
    expect(commands().some((c) => c.includes('%99'))).toBe(false);

    actor.send({ type: 'GO_TO', sessionName: 'other2', windowId: FAR_TAB, paneId: FAR_PANE });
    actor.send({ type: 'SWITCH_SESSION', sessionName: 'third' });
    expect(ctx().pendingGoTo).toBeNull();
    actor.send(there('third'));
    expect(commands().some((c) => c.includes(`select-pane -t ${FAR_PANE}`))).toBe(false);
    actor.stop();
  });
});

describe('NEW_SESSION with a name', () => {
  it('creates the session the user named and switches to it', () => {
    const { actor, commands, ctx } = app();
    actor.send({ type: 'NEW_SESSION', name: 'notes' });
    expect(commands()).toContain('new-session -d -s notes');
    expect(ctx().sessionName).toBe('notes');
    actor.stop();
  });
});
