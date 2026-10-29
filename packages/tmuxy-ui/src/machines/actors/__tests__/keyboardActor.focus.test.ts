/**
 * The page gets the focus with no pane asked for it — a reload, a switch back
 * to the tab, a return to the window — and the browser restores whatever
 * element it last had. Typing must reach the active pane from there without
 * a click on it; a real form control keeps what is typed into it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pid } from '../../../test/wire';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';
import * as mobileKeyboard from '../../../utils/mobileKeyboard';

const { getMobileInput } = mobileKeyboard;

function spawnKeyboardActor(activePaneId = pid('%3')) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: { activePaneId: string; copyModeStates: Record<string, unknown> };
      events: { type: string; [k: string]: unknown };
    },
    context: { activePaneId, copyModeStates: {} },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
      },
    },
  }).provide({ actors: { keyboardActor }, actions: {} } as never);

  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.keyboard as AnyActorRef;
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: activePaneId });
  return { actor, child, events };
}

const sendCommands = (events: Array<{ type: string; [k: string]: unknown }>) =>
  events
    .map((event) => (event.type === 'DISPATCH_OP' ? toTmuxCommand(event.op as TmuxOp) : undefined))
    .filter((command): command is string => command !== undefined);

/** The browser giving the page its focus back, with `element` restored. */
function pageGetsFocusWith(element: HTMLElement) {
  element.focus();
  window.dispatchEvent(new Event('focus'));
}

describe('keyboardActor — the page gets the focus with no pane clicked', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  let chrome: HTMLButtonElement;
  let field: HTMLInputElement;

  beforeEach(() => {
    // jsdom answers to `ontouchstart`; this is a desktop, where the hidden
    // input holds the keyboard. A phone keeps it down until the ⌨ key.
    vi.spyOn(mobileKeyboard, 'isTouchDevice').mockReturnValue(false);
    chrome = document.createElement('button');
    field = document.createElement('input');
    document.body.append(chrome, field);
    handle = spawnKeyboardActor(pid('%3'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    handle.actor.stop();
    chrome.remove();
    field.remove();
  });

  it('takes the keyboard from a chrome control the browser restored, and a key reaches the pane', () => {
    pageGetsFocusWith(chrome);
    expect(document.activeElement).toBe(getMobileInput());
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(sendCommands(handle.events)).toEqual(['send-keys -t %3 Enter']);
  });

  it('takes the keyboard from the body, where a restore lands after a re-render', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(getMobileInput());
  });

  it('leaves a real form control alone, and what is typed there stays there', () => {
    pageGetsFocusWith(field);
    expect(document.activeElement).toBe(field);
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
    );
    expect(sendCommands(handle.events)).toEqual([]);
  });

  it('reclaims on the tab becoming visible too', () => {
    pageGetsFocusWith(chrome);
    chrome.focus();
    expect(document.activeElement).toBe(chrome);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.activeElement).toBe(getMobileInput());
  });
});
