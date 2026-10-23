import type { EventHub } from '../eventHub';
import type { DriverEvent, TransportEvent } from './events';
import type { StateSequencer, StreamPosition } from './stateSequencer';

/**
 * A transport driver: the Promise-shaped machinery one backend needs (an SSE
 * stream and POSTs, Tauri IPC, an in-browser engine). Nothing outside
 * `infra/transport` talks to one — the `TmuxTransport` service lifts it into
 * Effects with typed errors and publishes its events as a stream.
 */
export interface TmuxAdapter<E extends DriverEvent = TransportEvent> {
  /** Every event the backend pushes, in arrival order. */
  readonly events: EventHub<E>;
  connect(): Promise<void>;
  disconnect(): void;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
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
   * How much this client has sent that is not yet done: commands queued or
   * in flight to the backend, and keystrokes batched but not yet sent. Zero
   * is one half of "settled" — the question the E2E suite asks through
   * `window.app.settled()` instead of sleeping (`AppProvider`). Absent on a
   * sandbox, where nothing is ever outstanding.
   */
  pendingCommands?(): number;
  /**
   * Where the state stream stands (`StateSequencer.position`): the other
   * half of settled, once the store holds the state at that number. Absent
   * where no stream is sequenced (the sandboxes).
   */
  streamPosition?(): StreamPosition;
  /**
   * The backend serves this client as a viewer (`tmuxy server --read-only`):
   * it answers reads and refuses everything else. Known once connected.
   */
  readonly readOnly?: boolean;
  /**
   * Run a tmux command and resolve with what it printed (`query_tmux`).
   *
   * The one way to READ from tmux: `run_tmux_command` is fire-and-forget and
   * resolves null on every transport. A query rides the same control-mode
   * connection as mutations and is answered in-band, so it needs no place in
   * the client-side serial queue — ordering against queued window/pane
   * commands is tmux's, not ours. Absent on the stories' recorded fixtures.
   */
  query?(command: string): Promise<string>;
  /**
   * Stage a `preview` pane's composed page and resolve with the URL its frame
   * loads it from — a route on the web, the `tmuxypreview:` scheme on the
   * desktop — where it is served under the page's own sandboxing policy
   * (`tmuxy_core::preview`). Each call's URL is new, so the frame reloads.
   * Absent on v86, which has no server to stage it on.
   */
  stagePreview?(paneId: string, html: string): Promise<string>;
}

/**
 * A driver whose backend streams a full state then deltas (HTTP, Tauri): it
 * emits each payload raw and keeps the sequencer the stream stage applies
 * them with, telling it when a connection opens or the session changes.
 */
export interface SequencedAdapter extends TmuxAdapter<DriverEvent> {
  readonly sequencer: StateSequencer;
}
