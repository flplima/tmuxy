/**
 * The keyboard actor under a stub parent that records every event it sends,
 * with the user's keys, typing and pastes dispatched on `window`.
 */

import { pid } from '../../../test/wire';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';

export function spawnKeyboardActor(activePaneId = pid('%3')) {
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

export function pressKey(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function wireCommand(event: { type: string; [k: string]: unknown }): string | undefined {
  if (event.type === 'SEND_TMUX_COMMAND') return event.command as string;
  if (event.type === 'DISPATCH_OP') return toTmuxCommand(event.op as TmuxOp);
  return undefined;
}

export function sendCommands(events: Array<{ type: string; [k: string]: unknown }>): string[] {
  return events.map(wireCommand).filter((command): command is string => command !== undefined);
}

export function lastSendCommand(
  events: Array<{ type: string; [k: string]: unknown }>,
): string | undefined {
  const commands = sendCommands(events);
  return commands[commands.length - 1];
}

export function pasteText(text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  window.dispatchEvent(event);
}
