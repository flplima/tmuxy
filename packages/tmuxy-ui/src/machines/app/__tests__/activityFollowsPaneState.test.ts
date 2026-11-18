/**
 * The status line's counts follow a state change in the session in view at
 * once. They were polled every five seconds alone, so `tmuxy pane state
 * needs-input` showed on the pane's header at once and in the counts up to
 * five seconds later.
 */

import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';

const TAB = wid('@1');

/** The session with %1 in front and %2 beside it, %2 in `paneState`. */
const session = (paneState: string | null, content = 'build') =>
  modelUpdate(
    [
      modelPane(pid('%1'), TAB, { width: 40, height: 23, y: 1, active: true }),
      modelPane(pid('%2'), TAB, { width: 39, height: 23, x: 41, y: 1, paneState, title: content }),
    ],
    [modelWindow(TAB, 0, { active: true })],
    { paneId: pid('%1'), windowId: TAB },
  );

function mounted() {
  const tmux = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic } });
  actor.send(session(null));
  const reads = () => tmux.received.filter((event) => event.type === 'FETCH_ACTIVITY').length;
  return { actor, reads };
}

describe('the counts and a pane state in view', () => {
  it('are read again when a pane takes, changes or drops its state', () => {
    const { actor, reads } = mounted();
    const before = reads();

    actor.send(session('needs-input'));
    expect(reads()).toBe(before + 1);
    actor.send(session('error'));
    expect(reads()).toBe(before + 2);
    actor.send(session(null));
    expect(reads()).toBe(before + 3);
  });

  it('are not read again for an update that leaves every state as it was', () => {
    const { actor, reads } = mounted();
    actor.send(session('working'));
    const settled = reads();

    actor.send(session('working', 'build: 40%'));
    actor.send(session('working', 'build: 80%'));
    expect(reads()).toBe(settled);
  });
});
