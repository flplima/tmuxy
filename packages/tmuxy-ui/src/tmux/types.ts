// ============================================
// Tmux Domain Types
// ============================================

export interface TmuxPane {
  id: number;
  tmuxId: string;
  /** Window this pane belongs to (e.g., "@0") */
  windowId: string;
  content: PaneContent;
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
  x: number;
  y: number;
  active: boolean;
  command: string;
  /** Pane title (set by shell/application) */
  title: string;
  /** Evaluated pane-border-format from tmux config */
  borderTitle: string;
  inMode: boolean;
  copyCursorX: number;
  copyCursorY: number;
  /** True if application is in alternate screen mode (vim, less, htop) */
  alternateOn: boolean;
  /** True if application has mouse tracking enabled */
  mouseAnyFlag: boolean;
  /** True if output is paused due to flow control (backpressure) */
  paused: boolean;
  /** Number of history lines (scrollback above the visible area) */
  historySize: number;
  /** True if a selection is active in copy mode */
  selectionPresent: boolean;
  /** Selection start X (visible-area-relative column), only meaningful when selectionPresent */
  selectionStartX: number;
  /** Selection start Y (visible-area-relative row, can be negative), only meaningful when selectionPresent */
  selectionStartY: number;
  /** Image placements on this pane's terminal grid */
  images?: ImagePlacement[];
  /** Cursor shape from DECSCUSR: 0/1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar */
  cursorShape: number;
  /** Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l) */
  cursorHidden: boolean;
}

/** An image placement on the terminal grid */
export interface ImagePlacement {
  id: number;
  row: number;
  col: number;
  widthCells: number;
  heightCells: number;
  protocol: 'iterm2' | 'kitty' | 'sixel';
}

/**
 * Window type as set on the tmux window via @tmuxy-window-type.
 * `null` means foreign — tmuxy never created or adopted this window and
 * filters it out everywhere.
 */
export type WindowType = 'tab' | 'float' | 'float-backdrop' | 'group' | 'sidebar';

export interface TmuxWindow {
  /** Window ID (e.g., "@0") */
  id: string;
  index: number;
  name: string;
  active: boolean;
  /** Window type. `null` = foreign (ignored by the UI). */
  windowType: WindowType | null;
  /** Group pane membership (@tmuxy-group-panes), e.g. ["%4","%6","%7"]. */
  groupPanes: string[] | null;
  /** Parent window id for floats (launcher) and backdrops (the float). */
  floatParent: string | null;
  /** Float width in cells (@tmuxy-float-width). */
  floatWidth: number | null;
  /** Float height in cells (@tmuxy-float-height). */
  floatHeight: number | null;
  /** Drawer direction for drawer-style floats. */
  floatDrawer: string | null;
  /** Backdrop style for floats. */
  floatBg: string | null;
  /** True when the float hides its header chrome. */
  floatNoheader: boolean;
}

export interface TmuxState {
  /** Session name (e.g., "tmuxy") */
  sessionName: string;
  /** Active window ID (e.g., "@0") */
  activeWindowId: string | null;
  /** Active pane ID (e.g., "%0") */
  activePaneId: string | null;
  panes: TmuxPane[];
  windows: TmuxWindow[];
  totalWidth: number;
  totalHeight: number;
  connected: boolean;
  error: string | null;
}

// ============================================
// Structured Cell Types (from Rust backend)
// ============================================

/** Color can be indexed (0-255) or RGB */
export type CellColor = number | { r: number; g: number; b: number };

/** Cell style attributes */
export interface CellStyle {
  fg?: CellColor;
  bg?: CellColor;
  bold?: boolean;
  /** SGR 2: faint/dim text (rendered at reduced opacity) */
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  /** OSC 8 hyperlink URL */
  url?: string;
}

/** A single terminal cell with character and optional styling */
export interface TerminalCell {
  c: string; // character
  s?: CellStyle; // style (optional)
}

/** A line of terminal cells */
export type CellLine = TerminalCell[];

/** Pane content is always structured cells */
export type PaneContent = CellLine[];

// ============================================
// Client-Side Copy Mode Types
// ============================================

export interface CopyModeState {
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
}

// ============================================
// Server Types (snake_case from backend)
// ============================================

export interface ServerPane {
  id: number;
  tmux_id: string;
  window_id: string;
  content: PaneContent;
  cursor_x: number;
  cursor_y: number;
  width: number;
  height: number;
  x: number;
  y: number;
  active: boolean;
  command: string;
  title: string;
  border_title: string;
  in_mode: boolean;
  copy_cursor_x: number;
  copy_cursor_y: number;
  alternate_on?: boolean;
  mouse_any_flag?: boolean;
  paused?: boolean;
  history_size?: number;
  selection_present?: boolean;
  selection_start_x?: number;
  selection_start_y?: number;
  images?: ServerImagePlacement[];
  cursor_shape?: number;
  cursor_hidden?: boolean;
}

/** Image placement in snake_case from backend */
export interface ServerImagePlacement {
  id: number;
  row: number;
  col: number;
  width_cells: number;
  height_cells: number;
  protocol: 'iterm2' | 'kitty' | 'sixel';
}

export interface ServerWindow {
  id: string;
  index: number;
  name: string;
  active: boolean;
  window_type?: WindowType | null;
  group_panes?: string[] | null;
  float_parent?: string | null;
  float_width?: number | null;
  float_height?: number | null;
  float_drawer?: string | null;
  float_bg?: string | null;
  float_noheader?: boolean;
}

export interface ServerState {
  session_name: string;
  active_window_id: string | null;
  active_pane_id: string | null;
  panes: ServerPane[];
  windows: ServerWindow[];
  total_width: number;
  total_height: number;
  status_line: string;
}

// ============================================
// Delta Types (for incremental updates)
// ============================================

export interface PaneDelta {
  window_id?: string;
  /** Sparse line updates: line index → cells (only changed lines) */
  content?: Record<number, CellLine>;
  cursor_x?: number;
  cursor_y?: number;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  active?: boolean;
  command?: string;
  title?: string;
  border_title?: string;
  in_mode?: boolean;
  copy_cursor_x?: number;
  copy_cursor_y?: number;
  alternate_on?: boolean;
  mouse_any_flag?: boolean;
  paused?: boolean;
  history_size?: number;
  selection_present?: boolean;
  selection_start_x?: number;
  selection_start_y?: number;
  images?: ServerImagePlacement[];
  cursor_shape?: number;
  cursor_hidden?: boolean;
}

export interface WindowDelta {
  name?: string;
  active?: boolean;
  window_type?: WindowType | null;
  group_panes?: string[] | null;
  float_parent?: string | null;
  float_width?: number | null;
  float_height?: number | null;
  float_drawer?: string | null;
  float_bg?: string | null;
  float_noheader?: boolean;
}

export interface ServerDelta {
  seq: number;
  panes?: Record<string, PaneDelta | null>; // null = removed
  windows?: Record<string, WindowDelta | null>; // null = removed
  new_panes?: ServerPane[];
  new_windows?: ServerWindow[];
  active_window_id?: string;
  active_pane_id?: string;
  status_line?: string;
  total_width?: number;
  total_height?: number;
}

export type StateUpdate =
  | { type: 'full'; state: ServerState }
  | { type: 'delta'; delta: ServerDelta };

// ============================================
// Adapter Types
// ============================================

export type StateListener = (state: ServerState) => void;
export type ErrorListener = (error: string) => void;
export type ConnectionInfoListener = (connectionId: number, defaultShell: string) => void;
export type ReconnectionListener = (reconnecting: boolean, attempt: number) => void;
/**
 * OSC 52 clipboard request from a terminal application. The frontend mirrors
 * the payload into the system clipboard via `navigator.clipboard.writeText`.
 */
export type ClipboardListener = (paneId: string, text: string) => void;

/** Streamed progress entry kind from the backend (matches `LogKind` in Rust) */
export type LogEntryKind = 'command' | 'output' | 'info' | 'error';

export type LogListener = (kind: LogEntryKind, message: string) => void;

/** Terminal failure: backend has exhausted retries and stopped. */
export type FatalListener = (message: string) => void;

export interface TmuxAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  isReconnecting(): boolean;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  onStateChange(listener: StateListener): () => void;
  onError(listener: ErrorListener): () => void;
  onConnectionInfo(listener: ConnectionInfoListener): () => void;
  onReconnection(listener: ReconnectionListener): () => void;
  onKeyBindings(listener: KeyBindingsListener): () => void;
  /** Streaming connection-time log (each tmux command + its output). */
  onLog(listener: LogListener): () => void;
  /** Terminal failure — backend gave up reconnecting. No further events expected. */
  onFatal(listener: FatalListener): () => void;
  /**
   * OSC 52 clipboard write request from a terminal application. Optional —
   * adapters that don't implement it are treated as "no clipboard plumbing"
   * by the rest of the app. Returns an unsubscribe function when supported.
   */
  onClipboard?(listener: ClipboardListener): () => void;
  switchSession?(sessionName: string): Promise<void>;
  /**
   * True when the adapter is attached to a real tmux server whose sessions can
   * be enumerated (`list-windows -a` across every session) — the web
   * `HttpAdapter` and the desktop Tauri adapter. Absent on the single-session
   * in-browser sandboxes (demo, v86), where the sidebar's sessions poll would
   * be pointless churn. Gates the `serversActor` poll.
   */
  enumeratesSessions?: boolean;
}

// ============================================
// Key Bindings Types
// ============================================

export interface KeyBinding {
  key: string;
  command: string;
  description: string;
  repeat?: boolean;
}

export interface KeyBindings {
  prefix_key: string;
  prefix_bindings: KeyBinding[];
  root_bindings: KeyBinding[];
}

export type KeyBindingsListener = (keybindings: KeyBindings) => void;
