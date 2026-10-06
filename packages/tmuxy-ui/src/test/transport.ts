/**
 * A test transport: a scripted driver behind the real `TmuxTransport` Layer,
 * so a test exercises the same lift (typed errors, the event stream) the app
 * runs on, and swaps only the backend.
 */

import { Layer, type Effect } from 'effect';
import { EventHub } from '../infra/eventHub';
import { makeAppRuntime, type AppRuntime } from '../infra/runtime';
import { TmuxTransport, makeTransport } from '../infra/transport/TmuxTransport';
import type { TransportEvent } from '../infra/transport/events';
import type { TmuxAdapter } from '../infra/transport/driver';

type NextResult = { kind: 'ok'; value: unknown } | { kind: 'reject'; error: unknown };

export interface FakeTransport {
  readonly driver: TmuxAdapter;
  readonly layer: Layer.Layer<TmuxTransport>;
  readonly runtime: AppRuntime;
  /** Every invoke, in order. */
  readonly invocations: Array<{ cmd: string; args?: Record<string, unknown> }>;
  /** What every later invoke the overrides leave alone answers. */
  setNextResult(result: NextResult): void;
  /** Push an event as if the backend had. */
  emit(event: TransportEvent): void;
  /** Run an effect against this transport. */
  run<A, E>(effect: Effect.Effect<A, E, TmuxTransport>): Promise<A>;
}

export function fakeTransport(overrides: Partial<TmuxAdapter> = {}): FakeTransport {
  const invocations: FakeTransport['invocations'] = [];
  let next: NextResult = { kind: 'ok', value: undefined };
  const events = new EventHub<TransportEvent>();
  const driver: TmuxAdapter = {
    events,
    connect: async () => {},
    disconnect: () => {},
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      invocations.push({ cmd, args });
      if (next.kind === 'reject') throw next.error;
      return next.value as T;
    },
    ...overrides,
  };
  const layer = Layer.scoped(TmuxTransport, makeTransport(driver));
  const runtime = makeAppRuntime(layer);
  return {
    driver,
    layer,
    runtime,
    invocations,
    setNextResult: (result) => {
      next = result;
    },
    emit: (event) => events.emit(event),
    run: (effect) => runtime.runPromise(effect),
  };
}
