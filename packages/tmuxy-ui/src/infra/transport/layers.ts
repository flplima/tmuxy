/**
 * One Layer per backend, each providing `TmuxTransport` over its driver.
 * `transportForEnvironment` picks the one this page runs against.
 */

import { Effect, Layer } from 'effect';
import { noAnswer } from '../../domain/backendCalls';
import { HttpAdapter } from './drivers/HttpAdapter';
import { TauriAdapter } from './drivers/TauriAdapter';
import type { GuestTmuxAdapter } from './drivers/guest/GuestTmuxAdapter';
import type { TransportDriver } from './driver';
import { isTauri } from '../platform';
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

/**
 * The guest as a driver: a read is its `query`, every other call its
 * `invoke` by name, and what it answers nothing to is `noAnswer`'s.
 */
function guestDriver(guest: GuestTmuxAdapter): TransportDriver {
  return {
    events: guest.events,
    answersQueries: true,
    connect: () => guest.connect(),
    disconnect: () => guest.disconnect(),
    switchSession: (sessionName) => guest.switchSession(sessionName),
    send: async (call) => {
      if (call.cmd === 'query_tmux') return guest.query(call.args.command);
      const answer = await guest.invoke<unknown>(call.cmd, call.args);
      return answer ?? noAnswer(call.cmd);
    },
  };
}

/** Real tmux in an in-browser guest (v86 or CheerpX): the demo site and the v86 stories. */
export const GuestTransportLive = (guest: GuestTmuxAdapter) =>
  Layer.scoped(TmuxTransport, makeTransport(guestDriver(guest)));

/** The desktop app's IPC, the web server otherwise. */
export function transportForEnvironment(): Layer.Layer<TmuxTransport> {
  return isTauri() ? TauriTransportLive : HttpTransportLive;
}
