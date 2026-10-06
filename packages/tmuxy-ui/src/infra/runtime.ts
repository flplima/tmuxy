/**
 * The app's one Effect runtime, built from the chosen transport Layer. The
 * XState actors receive it and run every effect through it, so each program
 * finds `TmuxTransport` in its environment instead of being handed an adapter.
 */

import { type Layer, ManagedRuntime } from 'effect';
import type { TmuxTransport } from './transport/TmuxTransport';

export type AppRuntime = ManagedRuntime.ManagedRuntime<TmuxTransport, never>;

export const makeAppRuntime = (transport: Layer.Layer<TmuxTransport>): AppRuntime =>
  ManagedRuntime.make(transport);
