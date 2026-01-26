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
}

export interface TmuxWindow {
  /** Window ID (e.g., "@0") */
  id: string;
  index: number;
  name: string;
  active: boolean;
  /** True if this is a hidden group window */
  isGroupWindow: boolean;
  /** Parent pane ID if this is a group window (e.g., "%5") */
  groupParentPane: string | null;
  /** Group index if this is a group window (0, 1, 2...) */
  groupIndex: number | null;
  /** True if this is a hidden float window */
  isFloatWindow: boolean;
  /** Pane ID if this is a float window (e.g., "%5") */
  floatPaneId: string | null;
}

/**
 * Tmux popup state
 * Note: Requires tmux with control mode popup support (PR #4361)
 */
export interface TmuxPopup {
  /** Popup ID */
  id: string;
  /** Popup content (terminal cells) */
  content: PaneContent;
  /** Cursor position */
  cursorX: number;
  cursorY: number;
  /** Popup dimensions */
  width: number;
  height: number;
  /** Position relative to window */
  x: number;
  y: number;
  /** Whether the popup is active */
  active: boolean;
  /** Command running in popup */
  command: string;
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
  /** Active popup (if any) - requires tmux with control mode popup support */
  popup?: TmuxPopup | null;
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
}

export interface ServerWindow {
  id: string;
  index: number;
  name: string;
  active: boolean;
  is_group_window: boolean;
  group_parent_pane: string | null;
  group_index: number | null;
  is_float_window?: boolean;
  float_pane_id?: string | null;
}

export interface ServerPopup {
  id: string;
  content: PaneContent;
  cursor_x: number;
  cursor_y: number;
  width: number;
  height: number;
  x: number;
  y: number;
  active: boolean;
  command: string;
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
  popup?: ServerPopup | null;
}

// ============================================
// Delta Types (for incremental updates)
// ============================================

export interface PaneDelta {
  content?: PaneContent;
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
}

export interface WindowDelta {
  name?: string;
  active?: boolean;
  is_group_window?: boolean;
  group_parent_pane?: string | null;
  group_index?: number | null;
  is_float_window?: boolean;
  float_pane_id?: string | null;
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
  /** Popup change: ServerPopup = new/updated, null = closed, undefined = no change */
  popup?: ServerPopup | null;
}

export type StateUpdate =
  | { type: 'full'; state: ServerState }
  | { type: 'delta'; delta: ServerDelta };

// ============================================
// Adapter Types
// ============================================

export type StateListener = (state: ServerState) => void;
export type ErrorListener = (error: string) => void;
export type ConnectionInfoListener = (connectionId: number, isPrimary: boolean) => void;
export type PrimaryChangedListener = (isPrimary: boolean) => void;
export type ReconnectionListener = (reconnecting: boolean, attempt: number) => void;

export interface TmuxAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  isReconnecting(): boolean;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  onStateChange(listener: StateListener): () => void;
  onError(listener: ErrorListener): () => void;
  onConnectionInfo(listener: ConnectionInfoListener): () => void;
  onPrimaryChanged(listener: PrimaryChangedListener): () => void;
  onReconnection(listener: ReconnectionListener): () => void;
}
