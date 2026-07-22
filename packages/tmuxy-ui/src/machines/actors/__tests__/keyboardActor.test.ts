import { describe, it, expect, beforeEach } from 'vitest';
import { createActor, createMachine, assign, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';

/**
 * Spawn the keyboard actor under a tiny parent that records every event it
 * sends and exposes a context snapshot (the actor reads activePaneId /
 * copyModeStates off the parent snapshot for copy-mode detection).
 */
function spawnKeyboardActor(activePaneId = '%3') {
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

/**
 * Spawn the actor under a parent whose `activePaneId` can be reassigned WITHOUT
 * notifying the child. This mirrors a pane-group tab click: the machine's
 * `assign({ activePaneId })` runs synchronously in the transition, but the
 * `UPDATE_ACTIVE_PANE` event that refreshes the actor's cached closure is
 * delivered a task later. The actor must read the live value off the parent
 * snapshot, not its stale closure, or the first keystroke after the click
 * targets the previously-active pane.
 */
function spawnWithLiveContext(initial = '%1') {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: { activePaneId: string; copyModeStates: Record<string, unknown> };
      events: { type: string; paneId?: string; [k: string]: unknown };
    },
    context: { activePaneId: initial, copyModeStates: {} },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      // Test-only: flip the machine's activePaneId the way a tab click does,
      // deliberately WITHOUT sending UPDATE_ACTIVE_PANE to the child.
      SET_PARENT_ACTIVE: {
        actions: assign({ activePaneId: ({ event }) => event.paneId as string }),
      },
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
  // Sync the child's cached closure to the initial pane, as the real app does.
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: initial });
  return { actor, child, events };
}

describe('keyboardActor — active-pane target uses the live snapshot', () => {
  it('targets the newly-active pane even before UPDATE_ACTIVE_PANE arrives', () => {
    const { actor, events } = spawnWithLiveContext('%1');

    // Tab click: machine context flips synchronously; the child closure is NOT
    // refreshed (no UPDATE_ACTIVE_PANE), exactly as in the same-tick race.
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: '%2' });

    // A printable key fired in this same tick must reach %2, not the stale
    // %1 (sent literally as `-l 'a'`).
    pressKey({ key: 'a' });
    expect(lastSendCommand(events)).toBe("send-keys -t %2 -l 'a'");
  });

  it('falls back to the cached pane when the snapshot has no activePaneId', () => {
    // Defends the try/catch fallback: a parent that never carries activePaneId
    // must not break key routing — the cached closure value still applies.
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const keyboardActor = createKeyboardActor();
    const parent = createMachine({
      types: {} as {
        context: Record<string, never>;
        events: { type: string; [k: string]: unknown };
      },
      context: {},
      invoke: {
        id: 'keyboard',
        src: 'keyboardActor',
        input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
      },
      on: {
        '*': { actions: ({ event }) => events.push(event as { type: string }) },
      },
    }).provide({ actors: { keyboardActor }, actions: {} } as never);
    const actor = createActor(parent);
    actor.start();
    const child = actor.getSnapshot().children.keyboard as AnyActorRef;
    child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%7' });

    pressKey({ key: 'b' });
    expect(lastSendCommand(events)).toBe("send-keys -t %7 -l 'b'");
  });
});
