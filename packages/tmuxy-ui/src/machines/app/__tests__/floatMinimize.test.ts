/**
 * A float minimized to the queue at the bottom of its tab
 * (`@tmuxy-float-minimized`): off screen on the click, its pane still
 * running, the keyboard handed back to the panes, and back on a click on its
 * pill, with the keyboard.
 */

import { describe, it, expect } from 'vitest';
import { createTmuxStoreActor } from '../../actors/tmuxStoreActor';
import { makeTmuxStore } from '../../../infra/store/TmuxStore';
import { fakeTransport } from '../../../test/transport';
import { startApp } from '../../../test/app';
import { pid, wid, wirePane, wireSession, wireWindow } from '../../../test/wire';
import { selectMinimizedFloats, selectVisibleFloats } from '../../selectors/panesAndSidebars';

const FLOAT_WINDOW = wid('@1');
const FLOAT = pid('%1');

/** A tab with one pane, and a float over it; `n` makes each state new. */
const withFloat = (minimized: boolean, n: number) =>
  wireSession({
    panes: [
      wirePane({ title: `t${n}` }),
      wirePane({ id: 1, tmux_id: FLOAT, window_id: FLOAT_WINDOW, active: false }),
    ],
    windows: [
      wireWindow(),
      wireWindow({
        id: FLOAT_WINDOW,
        index: 1,
        name: 'logs',
        active: false,
        window_type: 'float',
        float_parent: wid('@0'),
        float_minimized: minimized,
      }),
    ],
  });

function appWithFloat() {
  const transport = fakeTransport();
  const actor = startApp({
    actors: { tmuxStoreActor: createTmuxStoreActor(makeTmuxStore(), transport.runtime) },
  });
  actor.send({ type: 'TMUX_STATE_UPDATE', state: withFloat(false, 0) });
  const ctx = () => actor.getSnapshot().context;
  const shown = () => selectVisibleFloats(ctx()).map((f) => f.paneId);
  const queued = () => selectMinimizedFloats(ctx()).map((f) => f.paneId);
  const writes = () =>
    transport.invocations
      .map((c) => (c.args as { command?: string }).command ?? '')
      .filter((command) => command.includes('@tmuxy-float-minimized'));
  return { actor, ctx, shown, queued, writes };
}

describe('minimizing a float', () => {
  it('takes it off screen at once and into the queue, and gives the keyboard back to the panes', async () => {
    const { actor, ctx, shown, queued, writes } = appWithFloat();
    expect(shown()).toEqual([FLOAT]);
    expect(ctx().keyboardOwner).toEqual({ kind: 'float', paneId: FLOAT });

    actor.send({ type: 'MINIMIZE_FLOAT', paneId: FLOAT, minimized: true });
    expect(shown()).toEqual([]);
    expect(queued()).toEqual([FLOAT]);
    expect(ctx().keyboardOwner).toEqual({ kind: 'panes' });
    await expect
      .poll(writes)
      .toEqual([`set-option -w -t ${FLOAT_WINDOW} @tmuxy-float-minimized 1`]);
    // Its pane keeps running: nothing was killed.
    expect(ctx().panes.map((p) => p.tmuxId)).toContain(FLOAT);
  });

  it('a click on its pill brings it back, with the keyboard', async () => {
    const { actor, ctx, shown, queued, writes } = appWithFloat();
    actor.send({ type: 'MINIMIZE_FLOAT', paneId: FLOAT, minimized: true });
    actor.send({ type: 'TMUX_STATE_UPDATE', state: withFloat(true, 1) });
    expect(queued()).toEqual([FLOAT]);

    actor.send({ type: 'MINIMIZE_FLOAT', paneId: FLOAT, minimized: false });
    expect(shown()).toEqual([FLOAT]);
    expect(queued()).toEqual([]);
    expect(ctx().keyboardOwner).toEqual({ kind: 'float', paneId: FLOAT });
    await expect
      .poll(() => writes().slice(-1))
      .toEqual([`set-option -u -w -t ${FLOAT_WINDOW} @tmuxy-float-minimized`]);
  });

  it('another client minimizing it takes it off this screen too', () => {
    const { actor, shown, queued } = appWithFloat();
    actor.send({ type: 'TMUX_STATE_UPDATE', state: withFloat(true, 1) });
    expect(shown()).toEqual([]);
    expect(queued()).toEqual([FLOAT]);
  });
});
