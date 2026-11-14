import { Effect } from 'effect';
import { TmuxTransport, type TmuxTransportService } from '../../infra/transport/TmuxTransport';

/** An effect against the transport the runtime provides. */
export const withTransport = <A, E>(
  f: (transport: TmuxTransportService) => Effect.Effect<A, E>,
): Effect.Effect<A, E, TmuxTransport> => Effect.flatMap(TmuxTransport, f);
