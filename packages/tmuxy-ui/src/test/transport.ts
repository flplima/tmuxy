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
import type { TransportDriver } from '../infra/transport/driver';
import type { BackendCall } from '../domain/backendCalls';

type NextResult = { kind: 'ok'; value: unknown } | { kind: 'reject'; error: unknown };

export interface FakeTransport {
  readonly driver: TransportDriver;
  readonly layer: Layer.Layer<TmuxTransport>;
  readonly runtime: AppRuntime;
  /** Every call sent, in order, whoever answered it. */
  readonly invocations: BackendCall[];
  /** What every later call the overrides leave alone answers. */
  setNextResult(result: NextResult): void;
  /** Push an event as if the backend had. */
  emit(event: TransportEvent): void;
  /** Run an effect against this transport. */
  run<A, E>(effect: Effect.Effect<A, E, TmuxTransport>): Promise<A>;
}

export function fakeTransport(overrides: Partial<TransportDriver> = {}): FakeTransport {
  const invocations: FakeTransport['invocations'] = [];
  let next: NextResult = { kind: 'ok', value: null };
  const events = new EventHub<TransportEvent>();
  const driver: TransportDriver = {
    events,
    connect: async () => {},
    disconnect: () => {},
    ...overrides,
    send: async (call, actionId) => {
      invocations.push(call);
      if (overrides.send) return overrides.send(call, actionId);
      if (next.kind === 'reject') throw next.error;
      return next.value;
    },
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
