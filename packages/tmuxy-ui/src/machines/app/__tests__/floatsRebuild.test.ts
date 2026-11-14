/**
 * The floats follow every window option they are built from. The model
 * update once rebuilt them only when one of a hand-kept list of window fields
 * changed, and the list missed `floatParent`: a float whose parent tag landed
 * in an update of its own stayed parentless, drawn over every tab.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';

const TAB = wid('@0');
const FLOAT = wid('@1');

function update(floatParent: typeof TAB | null) {
  return modelUpdate(
    [modelPane(pid('%0'), TAB, { active: true }), modelPane(pid('%1'), FLOAT)],
    [
      modelWindow(TAB, 0, { active: true }),
      modelWindow(FLOAT, 1, { windowType: 'float', floatParent }),
    ],
    { paneId: pid('%0'), windowId: TAB },
  );
}

describe('the floats in a model update', () => {
  it('take a parent tag that lands on its own, and keep their identity when nothing they read changed', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send(update(null));
    expect(actor.getSnapshot().context.floatPanes[pid('%1')].parentWindowId).toBeNull();

    actor.send(update(TAB));
    const floats = actor.getSnapshot().context.floatPanes;
    expect(floats[pid('%1')].parentWindowId).toBe(TAB);

    actor.send(update(TAB));
    expect(actor.getSnapshot().context.floatPanes).toBe(floats);
  });

  // A float's window has no border row, so its pane sits at the window's
  // first row for good. Only a tab's pane seen there is one whose border has
  // not landed yet, to be drawn a row down and a row shorter meanwhile.
  it('keep the rows tmux gave their pane, where a tab pane at the top row is held a row down', () => {
    const frame = () =>
      modelUpdate(
        [
          modelPane(pid('%0'), TAB, { active: true, y: 0, height: 24 }),
          modelPane(pid('%1'), FLOAT, { y: 0, height: 15, width: 60 }),
        ],
        [
          modelWindow(TAB, 0, { active: true }),
          modelWindow(FLOAT, 1, {
            windowType: 'float',
            floatParent: TAB,
            floatWidth: 60,
            floatHeight: 15,
          }),
        ],
        { paneId: pid('%0'), windowId: TAB },
      );
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send(frame());
    // The second frame is the one that finds both panes already on screen.
    actor.send(frame());

    const pane = (id: string) =>
      actor.getSnapshot().context.panes.find((p) => p.tmuxId === pid(id));
    expect([pane('%1')?.y, pane('%1')?.height]).toEqual([0, 15]);
    expect([pane('%0')?.y, pane('%0')?.height]).toEqual([1, 23]);
  });
});
