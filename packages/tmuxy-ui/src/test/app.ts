import {
  createActor,
  createMachine,
  fromCallback,
  type SimulatedClock,
  type AnyActorLogic,
  type AnyEventObject,
} from 'xstate';
import { appMachine } from '../machines/app/appMachine';
import { createInitialContext } from '../machines/app/context';
import type { AppMachineContext } from '../machines/types/context';
import type { TmuxOp } from '../domain/commands';

type AppActorName = keyof (typeof appMachine)['implementations']['actors'];

/**
 * The app machine as the app runs it — every slice's handlers where
 * appMachine mounts them — over `context`, with any of its actors replaced
 * by a test's own, connected unless `connected: false`.
 */
export function startApp(
  opts: {
    context?: Partial<AppMachineContext>;
    actors?: Partial<Record<AppActorName, AnyActorLogic>>;
    clock?: SimulatedClock;
    connected?: boolean;
  } = {},
) {
  const machine = opts.context
    ? (createMachine(
        { ...appMachine.config, context: { ...createInitialContext(), ...opts.context } } as never,
        appMachine.implementations as never,
      ) as unknown as typeof appMachine)
    : appMachine;
  const actor = createActor(
    machine.provide({ actors: opts.actors ?? {} } as never),
    opts.clock ? { clock: opts.clock } : {},
  ).start();
  if (opts.connected !== false) actor.send({ type: 'TMUX_CONNECTED' });
  return actor;
}

/** An actor that keeps every event it is sent, and the tmux ops among them. */
export function recorder() {
  const received: AnyEventObject[] = [];
  const logic = fromCallback<AnyEventObject>(({ receive }) => {
    receive((event) => {
      received.push(event);
    });
  });
  const ops = (): TmuxOp[] => received.flatMap((event) => (event.op ? [event.op as TmuxOp] : []));
  return { logic, received, ops };
}
