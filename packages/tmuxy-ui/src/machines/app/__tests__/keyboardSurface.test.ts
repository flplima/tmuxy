/**
 * Exactly one surface holds the keyboard. A float that appears takes it from
 * a focused column, and a session switch takes it from whatever held it — in
 * the machine's context and in the key context the keyboard actor reads,
 * which is what aims the next keystroke.
 *
 * `appMachine` is exported with stub actors, so it starts standalone with a
 * recording stand-in for the keyboard actor.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromCallback, type EventObject } from 'xstate';
import { appMachine } from '../appMachine';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import type { KeyboardActorInput } from '../../actors/keyboardActor';
import type { KeyContext } from '../../selectors/keyboard';

const TAB = wid('@0');
const TREE = wid('@1');
const FLOAT = wid('@2');
const PANE = pid('%0');
const TREE_PANE = pid('%1');
const FLOAT_PANE = pid('%2');

const tabPane = modelPane(PANE, TAB, { active: true });
const tab = modelWindow(TAB, 0, { active: true });
const treePane = modelPane(TREE_PANE, TREE, { width: 30 });
const tree = modelWindow(TREE, 1, { windowType: 'sidebar-left' });
const floatPane = modelPane(FLOAT_PANE, FLOAT, { width: 60, height: 20 });
const float = modelWindow(FLOAT, 2, { windowType: 'float', floatParent: TAB });

const active = { paneId: PANE, windowId: TAB };

/** The app machine with a keyboard actor that records each key context it is told of. */
function startApp() {
  const seen: KeyContext[] = [];
  let view: KeyboardActorInput['keys'] | null = null;
  const keyboardActor = fromCallback<EventObject, KeyboardActorInput>(({ input }) => {
    view = input.keys;
    return input.keys.subscribe((keys) => seen.push(keys));
  });
  const actor = createActor(appMachine.provide({ actors: { keyboardActor } })).start();
  actor.send({ type: 'TMUX_CONNECTED' });
  return { actor, seen, keys: () => view!.get() };
}

describe('the keyboard surface', () => {
  it('a float that appears takes the keyboard from the focused tree', () => {
    const { actor, seen, keys } = startApp();
    actor.send(modelUpdate([tabPane, treePane], [tab, tree], active));
    actor.send({ type: 'FOCUS_SIDEBAR', side: 'left' });
    expect(actor.getSnapshot().context.keyboardOwner).toEqual({ kind: 'left', paneId: TREE_PANE });
    seen.length = 0;

    actor.send(modelUpdate([tabPane, treePane, floatPane], [tab, tree, float], active));

    expect(actor.getSnapshot().context.keyboardOwner).toEqual({
      kind: 'float',
      paneId: FLOAT_PANE,
    });
    expect(seen[seen.length - 1]?.target).toBe(FLOAT_PANE);
    expect(keys().target).toBe(FLOAT_PANE);
    actor.stop();
  });

  it('a session switch takes the keyboard from the old session’s float', () => {
    const { actor, seen, keys } = startApp();
    actor.send(modelUpdate([tabPane, floatPane], [tab, float], active));
    expect(keys().owner).toEqual({ kind: 'float', paneId: FLOAT_PANE });
    seen.length = 0;

    actor.send({ type: 'SWITCH_SESSION', sessionName: 'other' });

    expect(actor.getSnapshot().context.keyboardOwner).toEqual({ kind: 'panes' });
    expect(seen[seen.length - 1]?.owner).toEqual({ kind: 'panes' });
    actor.stop();
  });
});
