/**
 * One Layer per backend, each providing `TmuxTransport` over its driver.
 * `transportForEnvironment` picks the one this page runs against.
 */

import { Effect, Layer } from 'effect';
import { HttpAdapter } from './drivers/HttpAdapter';
import { TauriAdapter } from './drivers/TauriAdapter';
import type { GuestTmuxAdapter } from './drivers/guest/GuestTmuxAdapter';
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

/** Real tmux in an in-browser guest (v86 or CheerpX): the demo site and the v86 stories. */
export const GuestTransportLive = (guest: GuestTmuxAdapter) =>
  Layer.scoped(TmuxTransport, makeTransport(guest));

/** The desktop app's IPC, the web server otherwise. */
export function transportForEnvironment(): Layer.Layer<TmuxTransport> {
  return isTauri() ? TauriTransportLive : HttpTransportLive;
}
