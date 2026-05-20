/**
 * Test harness for isolating a single parallel state.
 *
 * Mounts a minimal machine that contains just the state's on: handlers and
 * its action/guard implementations, with the full AppMachineContext + Event
 * types so type-narrowing inside handlers still works.
 *
 * Usage:
 *   const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
 *   actor.send({ type: 'SET_THEME', name: 'dracula' });
 *   expect(actor.getSnapshot().context.themeName).toBe('dracula');
 */

import { createActor, fromCallback, setup } from 'xstate';
import type { AnyEventObject, AnyStateMachine, Actor } from 'xstate';
import { createInitialContext } from '../../context';
import type { AppMachineContext, AllAppMachineEvents } from '../../../types';

// Helper-file `vi.mock` is NOT auto-hoisted by Vitest; mocks only work
// when declared inside test files. Tests requiring stubbed side-effect
// modules should declare their own vi.mock at the top of the .test.ts file.

/**
 * No-op stub actor — swallows any event sent to 'tmux', 'keyboard', 'size'
 * so handlers that use sendTo('tmux', ...) don't crash the test machine.
 *
 * Tests that need to assert on actor sends can replace these via the
 * `extraActors` option below.
 */
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
    invoke: [
      { id: 'tmux', src: 'tmux' },
      { id: 'keyboard', src: 'keyboard' },
      { id: 'size', src: 'size' },
    ],
    states: {
      active: {
        on: stateConfig.on as Record<string, { actions: string }>,
      },
    },
  });

  return createActor(machine).start() as Actor<AnyStateMachine>;
}

/**
 * Send an event and return the resulting context for a fluent assert style.
 */
export function sendAndGetContext(
  actor: Actor<AnyStateMachine>,
  event: AnyEventObject,
): AppMachineContext {
  actor.send(event);
  return actor.getSnapshot().context as AppMachineContext;
}
