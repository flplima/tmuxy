/**
 * A sidebar column docked and shut again is this client's own say, whatever
 * tmux's late states still report (P13). The dock writes
 * `@tmuxy-sidebar-hidden` away and the shut writes it back; a state tmux
 * computed before the dock, then the dock's own echo, can arrive after the
 * shut. Read as another client showing the column, that echo docked it again
 * under the user's pointer.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createTmuxStoreActor } from '../../actors/tmuxStoreActor';
import { makeTmuxStore } from '../../../infra/store/TmuxStore';
import { fakeTransport } from '../../../test/transport';
import { startApp } from '../../../test/app';
import { pid, wid, wirePane, wireSession, wireWindow } from '../../../test/wire';
import { CONFIRM_LINGER_MS } from '../../../domain/store/types';

const TREE = wid('@1');

/** tmux's state with the tree's window hidden or shown; `n` makes each one new. */
const treeState = (hidden: boolean, n: number) =>
  wireSession({
    panes: [
      wirePane({ title: `t${n}` }),
      wirePane({ id: 1, tmux_id: pid('%1'), window_id: TREE, active: false }),
    ],
    windows: [
      wireWindow(),
      wireWindow({
        id: TREE,
        index: 1,
        name: 'tree',
        active: false,
        window_type: 'sidebar-left',
        sidebar_hidden: hidden,
      }),
    ],
  });

function appWithShutTree() {
  const transport = fakeTransport();
  const actor = startApp({
    actors: { tmuxStoreActor: createTmuxStoreActor(makeTmuxStore(), transport.runtime) },
  });
  actor.send({ type: 'TMUX_STATE_UPDATE', state: treeState(true, 0) });
  const open = () => actor.getSnapshot().context.sidebars.left.open;
  const writes = () =>
    transport.invocations
      .map((c) => (c.args as { command?: string }).command ?? '')
      .filter((command) => command.includes('@tmuxy-sidebar-hidden'));
  return { actor, open, writes };
}

describe('a sidebar column docked and shut again', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('stays shut through a stale state and the late echo of its own dock, and follows another client once tmux has kept the shut', async () => {
    const { actor, open, writes } = appWithShutTree();
    expect(open()).toBe(false);

    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(open()).toBe(true);
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(open()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A state from before the dock, then the dock's own echo, then the shut's.
    actor.send({ type: 'TMUX_STATE_UPDATE', state: treeState(true, 1) });
    expect(open()).toBe(false);
    actor.send({ type: 'TMUX_STATE_UPDATE', state: treeState(false, 2) });
    expect(open()).toBe(false);
    actor.send({ type: 'TMUX_STATE_UPDATE', state: treeState(true, 3) });
    expect(open()).toBe(false);
    expect(writes()).toEqual([
      'set-option -u -w -t @1 @tmuxy-sidebar-hidden',
      'set-option -w -t @1 @tmuxy-sidebar-hidden 1',
    ]);

    // Once tmux has kept the shut for the linger, a show is another client's.
    vi.advanceTimersByTime(CONFIRM_LINGER_MS + 1);
    actor.send({ type: 'TMUX_STATE_UPDATE', state: treeState(true, 4) });
    actor.send({ type: 'TMUX_STATE_UPDATE', state: treeState(false, 5) });
    expect(open()).toBe(true);
    expect(actor.getSnapshot().context.windows.find((w) => w.id === TREE)?.sidebarHidden).toBe(
      false,
    );
  });
});
