import { describe, it, expect, beforeEach } from 'vitest';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';

/**
 * Spawn the keyboard actor under a tiny parent that records every event it
 * sends and exposes a context snapshot (the actor reads activePaneId off the
 * parent snapshot).
 */
function spawnKeyboardActor(activePaneId = '%3') {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: { activePaneId: string };
      events: { type: string; [k: string]: unknown };
    },
    context: { activePaneId },
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

function pressKey(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function lastSendCommand(
  events: Array<{ type: string; [k: string]: unknown }>,
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'SEND_TMUX_COMMAND') return events[i].command as string;
  }
  return undefined;
}

describe('keyboardActor — Tab / Shift-Tab', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor('%3');
  });

  it('sends plain Tab as the tmux key "Tab"', () => {
    pressKey({ key: 'Tab' });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 Tab');
  });

  it('sends Shift+Tab as the tmux back-tab key "BTab" (not S-Tab)', () => {
    // tmux emits a literal Tab (0x09) for the key name "S-Tab"; only "BTab"
    // produces the CSI Z back-tab sequence applications expect for Shift+Tab.
    pressKey({ key: 'Tab', shiftKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 BTab');
  });
});
