import type {
  CellLine,
  KeyBindings,
  LogEntryKind,
  ServerState,
  ThemeSettings,
} from '../domain/wire';
import type { PaneId } from '../domain/ids';

// ============================================
// Client-Side Copy Mode Types
// ============================================

/**
 * Which of the two scrollback views a pane is showing.
 *
 * `scroll` is the native-like one a wheel gesture opens: scrollback rendered
 * and selectable with the browser's own selection, no cursor, no vi keys, and
 * tmux never told anything — the pane is not in `in_mode`, so the application
 * keeps running as if nothing happened.
 *
 * `copy` is tmux's copy mode as reached by `prefix [`: the pane really is in
 * `in_mode`, and the client draws a block cursor and resolves vi motions and
 * cell selection against it.
 *
 * Both share this record, and a pane has at most one, so the two can never be
 * live at once. See docs/COPY-MODE.md.
 */
export type ScrollbackMode = 'scroll' | 'copy';

export interface CopyModeState {
  /** Which view this is — see ScrollbackMode. */
  mode: ScrollbackMode;
  /** Loaded lines of scrollback content, keyed by absolute line index */
  lines: Map<number, CellLine>;
  /** Total lines available (historySize + height) */
  totalLines: number;
  /** Number of history lines above the visible area */
  historySize: number;
  /** Loaded ranges: [startLine, endLine] pairs (inclusive) */
  loadedRanges: Array<[number, number]>;
  /** Whether a chunk is currently being fetched */
  loading: boolean;
  width: number;
  height: number;
  /** Absolute row (0 = first history line) */
  cursorRow: number;
  cursorCol: number;
  selectionMode: 'char' | 'line' | null;
  selectionAnchor: { row: number; col: number } | null;
  /** Absolute row at top of viewport */
  scrollTop: number;
  /** Pending selection to apply on first chunk load (visible-relative row) */
  pendingSelection?: { mode: 'char' | 'line'; row: number; col: number };
  /**
   * Select every row once the history lands. A select-all issued as the view
   * opens cannot know where history ends — `totalLines` is the pane's own
   * guess until the first chunk answers with the real `history_size` — so the
   * selection is re-laid over the true extent when it does.
   */
  pendingSelectAll?: boolean;
  /**
   * When the selection was copied, while the view is on its way out. tmux has
   * already left its mode; the view stays for the copy flash (COPY_FLASH_MS)
   * so the copied text blinks where it was, then closes.
   */
  copiedAt?: number;
  /**
   * tmux has reported `in_mode` for THIS record. Set by the reconciliation
   * when a pane snapshot shows the mode on; never set by `ENTER_COPY_MODE`
   * itself, which only asks tmux to enter.
   *
   * What it guards: "tmux left copy mode" is only evidence about this record
   * once tmux has been seen in it. A record opened right after the previous
   * one closed is otherwise killed by the snapshot that merely reports the
   * PREVIOUS exit — the `-X cancel` landing a round trip late — and the view
   * vanishes under the user's hands.
   */
  tmuxSeen?: boolean;
}

// ============================================
// Adapter Types
// ============================================

export type StateListener = (state: ServerState) => void;
export type ErrorListener = (error: string) => void;
export type ConnectionInfoListener = (
  defaultShell: string,
  /** The server runs `--read-only`: this client is a viewer. Absent on transports with no such mode. */
  readOnly?: boolean,
) => void;
export type ReconnectionListener = (reconnecting: boolean) => void;
/**
 * OSC 52 clipboard request from a terminal application. The frontend mirrors
 * the payload into the system clipboard via `navigator.clipboard.writeText`.
 */
export type ClipboardListener = (paneId: PaneId | null, text: string) => void;

export type LogListener = (kind: LogEntryKind, message: string) => void;

/** Terminal failure: backend has exhausted retries and stopped. */
export type FatalListener = (message: string) => void;
/**
 * The connection ended, carrying tmux's own `%exit` reason (`detached` when
 * the user detached deliberately). Separate from {@link FatalListener}: a
 * detach is not a failure and must not be retried.
 */
export type DetachedListener = (reason: string | null) => void;

export interface TmuxAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  onStateChange(listener: StateListener): () => void;
  onError(listener: ErrorListener): () => void;
  onConnectionInfo(listener: ConnectionInfoListener): () => void;
  onReconnection(listener: ReconnectionListener): () => void;
  onKeyBindings(listener: KeyBindingsListener): () => void;
  /** Theme + appearance pushed by the backend after the config is (re)sourced. */
  onThemeSettings(listener: ThemeSettingsListener): () => void;
  /** Streaming connection-time log (each tmux command + its output). */
  onLog(listener: LogListener): () => void;
  /** Terminal failure — backend gave up reconnecting. No further events expected. */
  onFatal(listener: FatalListener): () => void;
  /** Subscribe to connection-ended notices; see {@link DetachedListener}. */
  onDetached?(listener: DetachedListener): () => void;
  /**
   * OSC 52 clipboard write request from a terminal application. Returns an
   * unsubscribe function.
   */
  onClipboard(listener: ClipboardListener): () => void;
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
  enumeratesSessions?: boolean;
  /**
   * The backend serves this client as a viewer (`tmuxy server --read-only`):
   * it answers reads and refuses everything else. Known once connected.
   */
  readOnly?: boolean;
  /**
   * Run a tmux command and resolve with what it printed (`query_tmux`).
   *
   * The one way to READ from tmux: `run_tmux_command` is fire-and-forget and
   * resolves null on every transport. A query rides the same control-mode
   * connection as mutations and is answered in-band, so it needs no place in
   * the client-side serial queue — ordering against queued window/pane
   * commands is tmux's, not ours. Absent on the in-browser sandboxes (demo,
   * v86), which never enumerate sessions.
   */
  query?(command: string): Promise<string>;
}

export type KeyBindingsListener = (keybindings: KeyBindings) => void;

export type ThemeSettingsListener = (settings: ThemeSettings) => void;
