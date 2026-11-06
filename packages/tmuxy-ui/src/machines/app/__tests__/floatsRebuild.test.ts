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
});
