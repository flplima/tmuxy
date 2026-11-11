/**
 * The transport as an Effect service: what the app asks of a backend, in
 * the typed vocabulary of `domain/backendCalls.ts`, with typed failures,
 * and everything the backend pushes as one ordered stream.
 *
 * Each backend is a driver (`TransportDriver`) — an SSE stream and POSTs, Tauri
 * IPC, an in-browser guest — that only moves calls and their answers.
 * `serviceOver` lifts one into this service exactly once, and owns what is
 * the same on every backend: the serial lane every op and call takes and the
 * keystroke batching in it (`commandLane.ts`), the decoding of every answer
 * against its command's schema (a mismatch is a `ProtocolError`), the
 * viewport a state refetch asks for again, and the trace switch the host's
 * greeting sets. Every failure is an `AdapterError` classified from the
 * backend's `{ error, kind }`. The driver's events are published on a
 * `PubSub` for whoever subscribes — as they come (`makeTransport`), or
 * through the stream stage that sequences a delta stream
 * (`makeSequencedTransport` in `stateFeed.ts`). The Layers that pick a driver
 * are in `layers.ts`.
 */

import { Context, Effect, PubSub, type Schema, type Scope, Stream } from 'effect';
import {
  BACKEND_COMMANDS,
  backendCall,
  type BackendCall,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type PlainCall,
  type PlainCommand,
} from '../../domain/backendCalls';
import { TmuxOp, toTmuxCommand } from '../../domain/commands';
import type { PaneId } from '../../domain/ids';
import type { ServerState } from '../../domain/wire';
import { tracer } from '../tracer';
import type { TransportDriver } from './driver';
import { type AdapterError, TransportError, classifyAdapterError } from './AdapterError';
import { commandLane } from './commandLane';
import type { DriverEvent, TransportEvent } from './events';
import type { StreamPosition } from './stateSequencer';
import { decodeServerStateOrThrow, decodeWire } from './wireDecode';

/** The terminal grid this client shows, in cells. */
export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

export interface TmuxTransportService {
  /** Open the connection; resolves once the backend has greeted this client. */
  readonly connect: Effect.Effect<void, AdapterError>;
  readonly disconnect: Effect.Effect<void>;
  /** A backend command, and its answer decoded against the command's schema. */
  readonly call: <K extends PlainCommand>(
    cmd: K,
    args: CommandArgs<K>,
  ) => Effect.Effect<CommandResult<K>, AdapterError>;
  /** A plain command whose answer nothing reads; still decoded, so a malformed one is reported. */
  readonly send: (call: PlainCall) => Effect.Effect<void, AdapterError>;
  /**
   * Run a tmux op, after every op run before it (keystrokes batched). A
   * keystroke completes once it is taken; any other op once the backend has
   * it, failing with tmux's refusal.
   */
  readonly run: (op: TmuxOp) => Effect.Effect<void, AdapterError>;
  /** The session's state at `viewport`, which is also the size this client reports. */
  readonly fetchState: (viewport: Viewport) => Effect.Effect<ServerState, AdapterError>;
  readonly setClientSize: (viewport: Viewport) => Effect.Effect<void, AdapterError>;
  /** Read from tmux: what the command printed. A TransportError where nothing answers (recorded fixtures). */
  readonly query: (command: string) => Effect.Effect<string, AdapterError>;
  /** Whether `query` reaches a tmux at all: false on recorded fixtures and mocks. */
  readonly answersQueries: () => boolean;
  /** Stage a preview pane's page (see `TransportDriver.stagePreview`); its frame's URL. */
  readonly stagePreview: (paneId: PaneId, html: string) => Effect.Effect<string, AdapterError>;
  readonly switchSession: (sessionName: string) => Effect.Effect<void, AdapterError>;
  /** Retry a dropped connection now rather than at the next backoff tick. */
  readonly reconnectNow: Effect.Effect<void>;

  /** Attached to a real tmux server whose sessions can be listed (web, desktop). */
  readonly enumeratesSessions: () => boolean;
  /**
   * How much this client has sent that is not yet done: ops queued or in
   * flight, and keystrokes batched but unsent. Zero is one half of
   * "settled" — the question the E2E suite asks through
   * `window.app.settled()` instead of sleeping (`AppProvider`).
   */
  readonly pendingCommands: () => number;
  /** Where the state stream stands (`StateSequencer.position`): the other half of settled; null where none is sequenced. */
  readonly streamPosition: () => StreamPosition | null;
  /**
   * Subscribe now, consume later: the subscription is taken when this runs,
   * so a caller that connects afterwards misses nothing the connection says.
   * The stream carries every pushed event in arrival order, the decoded and
   * sequenced state (`State`) among them.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<TransportEvent>, never, Scope.Scope>;
}

export class TmuxTransport extends Context.Tag('tmuxy/TmuxTransport')<
  TmuxTransport,
  TmuxTransportService
>() {}

export const openEventPubSub = Effect.acquireRelease(
  PubSub.unbounded<TransportEvent>(),
  PubSub.shutdown,
);

/**
 * The host says on its greeting whether it records a trace (docs/TRACING.md):
 * only then does the client tracer ship its events, through the driver's own
 * sink or as `record_trace`. The host rejects them when off regardless, so
 * this is a hint, not the gate.
 */
function followHostTrace(driver: TransportDriver<DriverEvent>, enabled: boolean): void {
  tracer.setServerEnabled(enabled);
  tracer.setSink(
    driver.shipTrace
      ? (events) => driver.shipTrace!(events)
      : (events) => {
          driver.send(backendCall('record_trace', { events })).catch((cause: unknown) => {
            console.warn('[tracer] a batch was not recorded:', cause);
          });
        },
  );
}

export const forwardDriverEvents = <E extends DriverEvent>(
  driver: TransportDriver<E>,
  offer: (event: E) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      driver.events.subscribe((event) => {
        if (event._tag === 'ConnectionInfo' && event.traceEnabled !== undefined) {
          followHostTrace(driver as TransportDriver<DriverEvent>, event.traceEnabled);
        }
        offer(event);
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

export interface ServiceOptions {
  /**
   * Make a fetched full state the client's: a sequenced transport adopts it
   * into its sequencer, so later deltas apply to it. Decoded by default.
   */
  readonly adoptState?: (raw: unknown) => ServerState;
  readonly streamPosition?: () => StreamPosition;
}

/** The service over `driver`, its events read from `pubsub`; and the viewport it last reported. */
export function serviceOver(
  driver: Omit<TransportDriver<DriverEvent>, 'events'>,
  pubsub: PubSub.PubSub<TransportEvent>,
  options: ServiceOptions = {},
): { readonly service: TmuxTransportService; readonly viewport: () => Viewport | null } {
  const adoptState = options.adoptState ?? decodeServerStateOrThrow;
  const send = (call: BackendCall, actionId?: string, ordered?: boolean) =>
    driver.send(call, actionId, ordered);
  const lane = commandLane(send, driver.ordersSends === true);
  let viewport: Viewport | null = null;

  const attempt = <A>(context: string, run: () => Promise<A>): Effect.Effect<A, AdapterError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => classifyAdapterError(cause, { command: context }),
    });
  const unsupported = (what: string, context: string) =>
    Effect.fail(new TransportError({ cause: `${what} not supported by this adapter`, context }));
  const sendDecoded = <K extends CommandName>(
    cmd: K,
    args: CommandArgs<K>,
  ): Effect.Effect<CommandResult<K>, AdapterError> => {
    const schema = BACKEND_COMMANDS[cmd].result as unknown as Schema.Schema<
      CommandResult<K>,
      unknown
    >;
    const decode = decodeWire(schema, cmd);
    return attempt(cmd, () => lane.call(backendCall(cmd, args))).pipe(
      Effect.flatMap((raw) => decode(raw)),
    );
  };
  const run = (op: TmuxOp) => attempt(toTmuxCommand(op), () => lane.run(op));

  const service: TmuxTransportService = {
    connect: attempt('connect', () => driver.connect()),
    disconnect: Effect.sync(() => {
      lane.close();
      driver.disconnect();
    }),
    call: sendDecoded,
    send: (call) => Effect.asVoid(sendDecoded(call.cmd, call.args as CommandArgs<typeof call.cmd>)),
    run,
    // Not behind the batched keys: the state is read, never ordered against input.
    fetchState: (size) =>
      attempt('get_initial_state', () => {
        viewport = size;
        return send(backendCall('get_initial_state', size)).then(adoptState);
      }),
    setClientSize: (size) =>
      Effect.suspend(() => {
        viewport = size;
        return Effect.asVoid(sendDecoded('set_client_size', size));
      }),
    // Not on the lane: the host answers a read in-band on the connection the
    // ops use, so tmux keeps its order against them.
    query: (command) =>
      driver.answersQueries
        ? attempt(command, () => send(backendCall('query_tmux', { command }))).pipe(
            Effect.flatMap(decodeWire(BACKEND_COMMANDS.query_tmux.result, 'query_tmux')),
          )
        : unsupported('query', command),
    stagePreview: (paneId, html) =>
      driver.stagePreview
        ? attempt('stage_preview', () => driver.stagePreview!(paneId, html))
        : unsupported('stagePreview', 'stage_preview'),
    switchSession: (sessionName) =>
      driver.switchSession
        ? attempt('switchSession', () => driver.switchSession!(sessionName))
        : run(TmuxOp.SwitchClient({ session: sessionName })),
    reconnectNow: Effect.sync(() => driver.reconnectNow?.()),

    enumeratesSessions: () => driver.enumeratesSessions === true,
    answersQueries: () => driver.answersQueries === true,
    pendingCommands: () => lane.pending(),
    streamPosition: () => options.streamPosition?.() ?? null,
    subscribe: Stream.fromPubSub(pubsub, { scoped: true }),
  };
  return { service, viewport: () => viewport };
}

/**
 * The service over a driver whose events need no stage (the in-browser
 * guests, which emit whole decoded states): published as they come.
 */
export const makeTransport = (
  driver: TransportDriver,
): Effect.Effect<TmuxTransportService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* openEventPubSub;
    yield* forwardDriverEvents(driver, (event) => {
      pubsub.unsafeOffer(event);
    });
    return serviceOver(driver, pubsub).service;
  });
