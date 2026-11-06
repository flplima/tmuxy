import type { BackendCall } from '../../domain/backendCalls';
import type { PaneId } from '../../domain/ids';
import type { EventHub } from '../eventHub';
import type { DriverEvent, TransportEvent } from './events';
import type { StateSequencer } from './stateSequencer';

/**
 * A transport driver: the Promise-shaped machinery that moves bytes to one
 * backend and back (an SSE stream and POSTs, Tauri IPC, an in-browser
 * engine). It knows how to reach its host, not what the calls mean: the
 * `TmuxTransport` service holds the vocabulary, the serial lane, the key
 * batching and the decoding, and nothing outside `infra/transport` talks to
 * a driver.
 */
export interface TransportDriver<E extends DriverEvent = TransportEvent> {
  /** Every event the backend pushes, in arrival order. */
  readonly events: EventHub<E>;
  connect(): Promise<void>;
  disconnect(): void;
  /**
   * Hand `call` to the backend and resolve with its raw answer; reject with
   * the backend's `{ error, kind }` when it refuses. `actionId` correlates
   * the request in the trace (docs/TRACING.md), where the link can carry it.
   */
  send(call: BackendCall, actionId?: string): Promise<unknown>;
  /** Point the connection at another session, where that is the driver's to do (the web's URL). */
  switchSession?(sessionName: string): Promise<void>;
  /**
   * Retry a dropped connection now instead of at the next backoff tick. For
   * transports that reconnect on a schedule; a no-op while connected.
   */
  reconnectNow?(): void;
  /**
   * True when the adapter is attached to a real tmux server whose sessions can
   * be enumerated (`list-windows -a` across every session) — the web
   * `HttpAdapter` and the desktop Tauri adapter. Absent on the single-session
   * in-browser sandboxes (demo, v86), where the sidebar's sessions poll would
   * be pointless churn. Gates the `serversActor` poll.
   */
  readonly enumeratesSessions?: boolean;
  /**
   * Whether `query_tmux` reaches a tmux: the one way to READ from it, since
   * `run_tmux_command` is fire-and-forget and resolves null on every
   * transport. False on the stories' recorded fixtures.
   */
  readonly answersQueries?: boolean;
  /**
   * Stage a `preview` pane's composed page and resolve with the URL its frame
   * loads it from — a route on the web, the `tmuxypreview:` scheme on the
   * desktop — where it is served under the page's own sandboxing policy
   * (`tmuxy_core::preview`). Each call's URL is new, so the frame reloads.
   * Absent on v86, which has no server to stage it on.
   */
  stagePreview?(paneId: PaneId, html: string): Promise<string>;
  /**
   * Where the client tracer's batches go when the host records a trace, if
   * not `record_trace` (the web's `/trace`, which outlives a closing page).
   */
  shipTrace?(events: Record<string, unknown>[]): void;
}

/**
 * A driver whose backend streams a full state then deltas (HTTP, Tauri): it
 * emits each payload raw and keeps the sequencer the stream stage applies
 * them with, telling it when a connection opens or the session changes.
 */
export interface SequencedDriver extends TransportDriver<DriverEvent> {
  readonly sequencer: StateSequencer;
}

/**
 * The in-browser guest's shape (`GuestTmuxAdapter`), which answers commands
 * by name: `guestDriver` in `layers.ts` makes it a `TransportDriver`.
 */
export interface TmuxAdapter {
  readonly events: EventHub<TransportEvent>;
  connect(): Promise<void>;
  disconnect(): void;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  query(command: string): Promise<string>;
  switchSession(sessionName: string): Promise<void>;
}
