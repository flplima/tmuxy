/**
 * Exactly one surface holds the keyboard. A float that appears takes it from
 * a focused column, and a session switch takes it from whatever held it — in
 * the machine's context and in the keyboard actor, which is what aims the
 * next keystroke.
 *
 * `appMachine` is exported with stub actors, so it starts standalone with a
 * recording stand-in for the keyboard actor.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromCallback, type AnyActorRef } from 'xstate';
import { appMachine } from '../appMachine';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import type { KeyboardActorEvent } from '../../actors/keyboardActor';

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

/** The app machine with a keyboard actor that records what it is sent. */
function startApp() {
  const sent: KeyboardActorEvent[] = [];
  const keyboardActor = fromCallback<KeyboardActorEvent, { parent: AnyActorRef }>(({ receive }) => {
    receive((event) => sent.push(event));
    return () => {};
  });
  const actor = createActor(appMachine.provide({ actors: { keyboardActor } })).start();
  actor.send({ type: 'TMUX_CONNECTED' });
  return { actor, sent };
}

const lastOfType = <T extends KeyboardActorEvent['type']>(sent: KeyboardActorEvent[], type: T) => {
  const ofType = sent.filter((e): e is Extract<KeyboardActorEvent, { type: T }> => e.type === type);
  return ofType[ofType.length - 1];
};

describe('the keyboard surface', () => {
  it('a float that appears takes the keyboard from the focused tree', () => {
    const { actor, sent } = startApp();
    actor.send(modelUpdate([tabPane, treePane], [tab, tree], active));
    actor.send({ type: 'FOCUS_LEFT_SIDEBAR' });
    expect(actor.getSnapshot().context.leftSidebarFocused).toBe(true);
    sent.length = 0;

    actor.send(modelUpdate([tabPane, treePane, floatPane], [tab, tree, float], active));

    const { context } = actor.getSnapshot();
    expect(context.focusedFloatPaneId).toBe(FLOAT_PANE);
    expect(context.leftSidebarFocused).toBe(false);
    expect(lastOfType(sent, 'UPDATE_FOCUSED_FLOAT')?.paneId).toBe(FLOAT_PANE);
    expect(lastOfType(sent, 'UPDATE_LEFT_SIDEBAR_FOCUSED')?.focused).toBe(false);
    actor.stop();
  });

  it('a session switch takes the keyboard from the old session’s float', () => {
    const { actor, sent } = startApp();
    actor.send(modelUpdate([tabPane, floatPane], [tab, float], active));
    expect(actor.getSnapshot().context.focusedFloatPaneId).toBe(FLOAT_PANE);
    sent.length = 0;

    actor.send({ type: 'SWITCH_SESSION', sessionName: 'other' });

    expect(actor.getSnapshot().context.focusedFloatPaneId).toBeNull();
    expect(lastOfType(sent, 'UPDATE_FOCUSED_FLOAT')?.paneId).toBeNull();
    actor.stop();
  });
});
