/**
 * The app's one Effect runtime, built from the chosen transport Layer. The
 * XState actors receive it and run every effect through it, so each program
 * finds `TmuxTransport` in its environment instead of being handed an adapter.
 */

import { Effect, type Layer, ManagedRuntime } from 'effect';
import type { TmuxTransport } from './transport/TmuxTransport';

export type AppRuntime = ManagedRuntime.ManagedRuntime<TmuxTransport, never>;

/**
 * Built at once — every transport Layer builds synchronously — so the first
 * effect starts on the caller's stack: a dispatch's optimistic patch lands in
 * the same tick as the keystroke that asked for it, as it does on every later
 * one.
 */
export function makeAppRuntime(transport: Layer.Layer<TmuxTransport>): AppRuntime {
  const runtime = ManagedRuntime.make(transport);
  runtime.runSync(Effect.void);
  return runtime;
}
