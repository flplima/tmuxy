/**
 * One Layer per backend, each providing `TmuxTransport` over its driver.
 * `transportForEnvironment` picks the one this page runs against.
 */

import { Effect, Layer } from 'effect';
import { HttpAdapter } from './drivers/HttpAdapter';
import { TauriAdapter } from './drivers/TauriAdapter';
import { DemoAdapter } from './drivers/demo/DemoAdapter';
import type { V86TmuxAdapter } from './drivers/v86/V86TmuxAdapter';
import { isTauri } from '../../utils/platform';
import { TmuxTransport, makeTransport } from './TmuxTransport';
import { makeSequencedTransport } from './stateFeed';

/** The web build: SSE for what the server pushes, POST for commands; states painted once per frame. */
export const HttpTransportLive = Layer.scoped(
  TmuxTransport,
  Effect.suspend(() => makeSequencedTransport(new HttpAdapter(), { latestPerFrame: true })),
);

/** The desktop build: Tauri events and commands. */
export const TauriTransportLive = Layer.scoped(
  TmuxTransport,
  Effect.suspend(() => makeSequencedTransport(new TauriAdapter(), { latestPerFrame: false })),
);

/** The in-browser demo engine; a story passes its own to drive the demo's test hooks. */
export const DemoTransportLive = (demo: DemoAdapter = new DemoAdapter()) =>
  Layer.scoped(TmuxTransport, makeTransport(demo));

/** Real tmux in a v86 guest (browser-only stories). */
export const V86TransportLive = (v86: V86TmuxAdapter) =>
  Layer.scoped(TmuxTransport, makeTransport(v86));

function isDemoUrl(): boolean {
  return typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('demo');
}

/** The desktop app's IPC, the demo on `?demo`, the web server otherwise. */
export function transportForEnvironment(): Layer.Layer<TmuxTransport> {
  if (isTauri()) return TauriTransportLive;
  if (isDemoUrl()) return DemoTransportLive();
  return HttpTransportLive;
}
