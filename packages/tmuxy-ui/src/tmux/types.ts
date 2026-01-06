// ============================================
// Tmux Domain Types
// ============================================

export interface TmuxPane {
  id: number;
  tmuxId: string;
  /** Window this pane belongs to (e.g., "@0") */
  windowId: string;
  content: string[];
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
  x: number;
  y: number;
  active: boolean;
  command: string;
  inMode: boolean;
  copyCursorX: number;
  copyCursorY: number;
}

export interface TmuxWindow {
  /** Window ID (e.g., "@0") */
  id: string;
  index: number;
  name: string;
  active: boolean;
  /** True if this is a hidden stack window */
  isStackWindow: boolean;
  /** Parent pane ID if this is a stack window (e.g., "%5") */
  stackParentPane: string | null;
  /** Stack index if this is a stack window (0, 1, 2...) */
  stackIndex: number | null;
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
// Server Types (snake_case from backend)
// ============================================

export interface ServerState {
  session_name: string;
  active_window_id: string | null;
  active_pane_id: string | null;
  panes: Record<string, unknown>[];
  windows: Record<string, unknown>[];
  total_width: number;
  total_height: number;
}

// ============================================
// Adapter Types
// ============================================

export type StateListener = (state: ServerState) => void;
export type ErrorListener = (error: string) => void;

export interface TmuxAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  onStateChange(listener: StateListener): () => void;
  onError(listener: ErrorListener): () => void;
}
