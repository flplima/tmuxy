/**
 * Mounts one state slice — its `on` handlers and their actions — in a minimal
 * machine typed with the full AppMachineContext and events, with no-op actors
 * under the ids the slices send to.
 */

import {
  createActor,
  fromCallback,
  setup,
  type AnyEventObject,
  type AnyStateMachine,
  type Actor,
} from 'xstate';
import { createInitialContext } from '../../context';
import type { AppMachineContext } from '../../../types/context';
import type { AllAppMachineEvents } from '../../../types/events';

// Helper-file `vi.mock` is NOT auto-hoisted by Vitest; mocks only work
// when declared inside test files. Tests requiring stubbed side-effect
// modules should declare their own vi.mock at the top of the .test.ts file.

const stubActor = fromCallback<{ type: string }>(() => () => {});

export interface MountOptions {
  /** Extra/override actors to invoke alongside the default stubs. */
  extraActors?: Record<string, ReturnType<typeof fromCallback>>;
}

export function mountState<TActions extends Record<string, unknown>>(
  stateConfig: { on: Record<string, { actions: string }> },
  actions: TActions,
  guards: Record<string, unknown> = {},
  overrideContext: Partial<AppMachineContext> = {},
  options: MountOptions = {},
): Actor<AnyStateMachine> {
  const machine = setup({
    types: {
      context: {} as AppMachineContext,
      events: {} as AllAppMachineEvents,
    },
    actors: {
      tmux: stubActor,
      tmuxStore: stubActor,
      keyboard: stubActor,
      size: stubActor,
      ...(options.extraActors ?? {}),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions: actions as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guards: guards as any,
  }).createMachine({
    context: { ...createInitialContext(), ...overrideContext },
    initial: 'active',
    // Every default stub and every extra actor is invoked under its own id,
    // so a slice that sends to an actor the defaults do not name (the
    // servers actor, say) can be given one instead of crashing the machine.
    invoke: [
      ...new Set([
        'tmux',
        'tmuxStore',
        'keyboard',
        'size',
        ...Object.keys(options.extraActors ?? {}),
      ]),
    ].map((id) => ({ id, src: id as never })),
    states: {
      active: {
        on: stateConfig.on as Record<string, { actions: string }>,
      },
    },
  });

  return createActor(machine).start() as Actor<AnyStateMachine>;
}

export function sendAndGetContext(
  actor: Actor<AnyStateMachine>,
  event: AnyEventObject,
): AppMachineContext {
  actor.send(event);
  return actor.getSnapshot().context as AppMachineContext;
}
