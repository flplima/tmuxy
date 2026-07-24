/**
 * Machine Types
 *
 * All type definitions for state machines and their events.
 */

import type {
  TmuxPane,
  TmuxWindow,
  ServerState,
  KeyBindings,
  KeyBinding,
  CopyModeState,
} from '../tmux/types';
import type { GitRepository, SessionTreeNode } from '../workspaces/model';

// Re-export domain types
export type { TmuxPane, TmuxWindow, ServerState, KeyBindings, KeyBinding, CopyModeState };
export type {
  GitRepository,
  GitWorktree,
  SessionTreeNode,
  SessionTreePane,
  SessionTreeWindow,
} from '../workspaces/model';

// ============================================
// Shared State Types
// ============================================

/** Pane group - groups panes that share the same visual position (like tabs) */
export interface PaneGroup {
  id: string;
  paneIds: string[]; // Tab order - active pane is derived from which pane is in activeWindowId
}

/** Drawer direction for float panes docked to an edge */
export type DrawerDirection = 'left' | 'right' | 'top' | 'bottom';

/** Backdrop style for float panes */
export type FloatBackdrop = 'dim' | 'blur' | 'none';

/** Float pane state */
export interface FloatPaneState {
  /** Pane ID (e.g., "%5") */
  paneId: string;
  /** Size in pixels */
  width: number;
  height: number;
  /** If set, float is a drawer docked to this edge */
  drawer?: DrawerDirection;
  /** Backdrop style (default: dim) */
  backdrop?: FloatBackdrop;
  /** Whether to hide the header bar */
  hideHeader?: boolean;
}

/** Drag operation state */
export interface DragState {
  draggedPaneId: string;
  targetPaneId: string | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /** Original position of dragged pane (for stable visual tracking during swaps) */
  originalX: number;
  originalY: number;
  originalWidth: number;
  originalHeight: number;
  /** Current grid position of dragged pane - updated after each swap (for ghost indicator) */
  ghostX: number;
  ghostY: number;
  ghostWidth: number;
  ghostHeight: number;
}

/** Resize operation state */
export interface ResizeState {
  paneId: string;
  handle: 'n' | 's' | 'e' | 'w';
  startX: number;
  startY: number;
  originalPane: TmuxPane;
  /** Original neighbor panes affected by this resize (for stable preview) */
  originalNeighbors: TmuxPane[];
  pixelDelta: { x: number; y: number };
  delta: { cols: number; rows: number };
  /** Last delta that was sent to tmux (to avoid duplicate commands) */
  lastSentDelta: { cols: number; rows: number };
  /**
   * When the last resize command batch was sent. Drag moves are throttled to
   * one batch per RESIZE_SEND_INTERVAL_MS — a fast drag otherwise sprays a
   * one-column command per cell crossed, and their confirms trickle back for
   * seconds on a slow transport, re-wiggling settled geometry. The preview
   * stays per-frame smooth; only the wire traffic is coalesced. RESIZE_END
   * flushes whatever delta is still unsent.
   */
  lastSentAt: number;
}

// ============================================
// App Machine Types
// ============================================

/** Log entry shown on the connecting/error status screen for debugging */
export interface LogEntry {
  timestamp: number;
  kind: 'command' | 'output' | 'error' | 'info';
  message: string;
}

/**
 * A saved tmux *server* for the sidebar server picker (footer), read from
 * `~/.config/tmuxy/servers.json` by the desktop `list_servers` command.
 * Desktop-only; the web build always uses its launch socket.
 */
export interface ServerInfo {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
}

/** Pending state update stored during pane exit animation */
export interface AppMachineContext {
  connected: boolean;
  error: string | null;
  /**
   * Set when the backend gave up reconnecting (e.g. tmux server unavailable
   * after MAX_CONSECUTIVE_FAILURES attempts). Terminal: no further events
   * will arrive on this monitor.
   */
  fatalError: string | null;
  /**
   * Adapter's current reconnect attempt count. 0 = channel is live or has
   * never dropped. >0 = SSE/Tauri channel dropped and the adapter is
   * retrying. Surfaced in the UI as a banner while in the `reconnecting`
   * state and cleared on TMUX_RECONNECTED.
   */
  reconnectAttempt: number;
  /** Recent commands sent and errors received (debug log shown on status screen) */
  log: LogEntry[];
  sessionName: string;
  activeWindowId: string | null;
  activePaneId: string | null;
  panes: TmuxPane[];
  windows: TmuxWindow[];
  totalWidth: number;
  totalHeight: number;
  paneGroups: Record<string, PaneGroup>;
  targetCols: number;
  targetRows: number;
  drag: DragState | null;
  resize: ResizeState | null;
  resizeActive: boolean;
  charWidth: number;
  charHeight: number;
  /** Default shell name (e.g., "bash", "zsh") from server */
  defaultShell: string;
  /** Tmux status line with ANSI escape codes */
  statusLine: string;
  /** Container dimensions for centering calculations */
  containerWidth: number;
  containerHeight: number;
  /** Float pane positions and states (keyed by pane ID) */
  floatPanes: Record<string, FloatPaneState>;
  /** Pane ID of the currently focused float (keyboard routes here instead of session) */
  focusedFloatPaneId: string | null;
  /** Whether the left sidebar drawer (the React tab/pane tree) is open */
  sidebarOpen: boolean;
  /**
   * Whether the sidebar tree holds keyboard focus. While true, keys drive the
   * SidebarTree (j/k/Enter/Escape) instead of reaching a pane.
   */
  sidebarFocused: boolean;
  /** Whether browser-side animations are enabled */
  enableAnimations: boolean;
  /** Keybindings received from the server */
  keybindings: KeyBindings | null;
  /** Client-side copy mode state per pane */
  copyModeStates: Record<string, CopyModeState>;
  /** Pane IDs ordered by most-recently-active first (for navigation tie-breaking) */
  paneActivationOrder: string[];
  /**
   * Whether the previous TMUX_MODEL_UPDATE carried no geometry delta on
   * existing panes. React can batch an optimistic (dirty) update and its
   * instant confirm (quiet) into ONE commit; any "stop suppressing
   * transitions" decision made on the quiet update alone would then apply
   * to the whole batch's cumulative geometry delta and animate it. Keeping
   * one update of history lets suppression relax only after two
   * consecutive quiet updates — a batch ending in a fresh quiet update
   * still commits suppressed.
   */
  lastUpdateQuiet: boolean;
  /**
   * Pane IDs involved in in-flight GroupSwitch store ops — mirrored from
   * `model.ops` on every TMUX_MODEL_UPDATE so selectors can suppress CSS
   * transitions on the swapped panes while the swap is unconfirmed. The
   * geometry/window pinning itself lives in the op's optimistic patch
   * (see store/ops.ts predictGroupSwitch); no timers, no overrides.
   */
  groupSwitchPaneIds: string[];
  /** Command mode state (tmux command prompt) */
  commandMode: {
    prompt: string;
    input: string;
    template: string | null;
  } | null;
  /** Temporary status message (from display-message) */
  statusMessage: { text: string; timestamp: number } | null;
  /** Current theme name */
  themeName: string;
  /** Current theme mode */
  themeMode: 'dark' | 'light';
  /** Available themes from server */
  availableThemes: Array<{ name: string; displayName: string }>;
  /** Whether the app container is focused (for keyboard capture gating) */
  appFocused: boolean;
  /** Whether the tmux prefix key has been pressed and we're awaiting a binding key */
  prefixActive: boolean;
  /** Base font size for terminal text in pixels */
  baseFontSize: number;
  /** Timestamp of last layout command (for debouncing rapid layout changes) */
  lastLayoutCommandTime: number;
  /** Temporarily suppress layout transitions (e.g., command-based resize) */
  suppressLayoutTransition: boolean;
  /** Maps real pane tmuxId → stable React key (placeholder ID it morphed from).
   *  Prevents unmount/remount flicker when optimistic placeholders are replaced
   *  by server-confirmed panes. */
  paneKeyOverrides: Record<string, string>;
  /** Per-window most-recently-active pane ID, populated from server state and
   *  used by SELECT_TAB to pick the optimistic focus when switching tabs. */
  lastActivePaneByWindow: Record<string, string>;
  /**
   * All tmux sessions on the current server, for the sidebar sessions→tabs→panes
   * tree. Populated by the `serversActor` poll on web + desktop; stays `[]` on
   * the single-session in-browser sandboxes (demo, v86), which then render the
   * classic single-session flat tree.
   */
  sessions: SessionTreeNode[];
  /**
   * Repositories discovered from the current pane paths. Real tmux adapters
   * populate this while the sidebar is open; in-browser demo adapters leave it
   * empty and keep the classic session/tab/pane tree.
   */
  repositories: GitRepository[];
  /**
   * Saved tmux servers for the sidebar server picker. Desktop-only: populated
   * by the `serversActor` poll (`list_servers`); stays `[]` on the web build,
   * where the picker is not rendered.
   */
  serverList: ServerInfo[];
  /** Id of the server the desktop app is currently attached to (picker highlight). */
  currentServerId: string;
}

// ============================================
// Drag Machine Types
// ============================================

export interface DragMachineContext {
  panes: TmuxPane[];
  activePaneId: string | null;
  charWidth: number;
  charHeight: number;
  containerWidth: number;
  containerHeight: number;
  containerLeft: number;
  containerTop: number;
  drag: DragState | null;
}

export type DragMachineEvent =
  | {
      type: 'DRAG_START';
      paneId: string;
      startX: number;
      startY: number;
      panes: TmuxPane[];
      activePaneId: string | null;
      charWidth: number;
      charHeight: number;
      containerWidth: number;
      containerHeight: number;
      containerLeft: number;
      containerTop: number;
    }
  | { type: 'DRAG_MOVE'; clientX: number; clientY: number }
  | { type: 'DRAG_END' }
  | KeyPressEvent;

// ============================================
// Resize Machine Types
// ============================================

export interface ResizeMachineContext {
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  resize: ResizeState | null;
}

export type ResizeMachineEvent =
  | {
      type: 'RESIZE_START';
      paneId: string;
      handle: 'n' | 's' | 'e' | 'w';
      startX: number;
      startY: number;
      panes: TmuxPane[];
      charWidth: number;
      charHeight: number;
    }
  | { type: 'RESIZE_MOVE'; clientX: number; clientY: number }
  | { type: 'RESIZE_END' }
  | KeyPressEvent;

// ============================================
// Child Machine → Parent Events
// ============================================

/** Events sent from drag machine to parent */
export type DragParentEvent =
  | { type: 'SEND_TMUX_COMMAND'; command: string }
  | { type: 'DRAG_STATE_UPDATE'; drag: DragState | null };

/** Events sent from resize machine to parent */
export type ResizeParentEvent =
  | { type: 'SEND_TMUX_COMMAND'; command: string }
  | { type: 'RESIZE_STATE_UPDATE'; resize: ResizeState | null }
  | { type: 'RESIZE_COMPLETED' };

/** All events from child machines to parent */
export type ChildMachineEvent = DragParentEvent | ResizeParentEvent;

// ============================================
// App Machine Events (External API)
// ============================================

// Tmux connection events
export type TmuxConnectedEvent = { type: 'TMUX_CONNECTED' };
export type TmuxStateUpdateEvent = { type: 'TMUX_STATE_UPDATE'; state: ServerState };
/**
 * Fired by tmuxStoreActor whenever the TmuxClientModel changes — either from
 * a server reconciliation, a local optimistic dispatch, or a rollback. The
 * handler reads `model.derived` and treats it as the authoritative snapshot
 * for downstream effects (group/float builds, copy-mode detection, animations).
 */
export type TmuxModelUpdateEvent = {
  type: 'TMUX_MODEL_UPDATE';
  model: import('../tmux/store').TmuxClientModel;
};
/**
 * `tagged` is the structured AdapterError from the Effect-based adapter
 * layer (see src/tmux/effect/AdapterError.ts). `error` remains a free-form
 * display string for the existing log and status surfaces. New consumers
 * that want pattern-matching should branch on `tagged?._tag` and fall back
 * to `error` only for display.
 */
export type TmuxErrorEvent = {
  type: 'TMUX_ERROR';
  error: string;
  tagged?: import('../tmux/effect/AdapterError').AdapterError;
};
export type TmuxFatalEvent = { type: 'TMUX_FATAL'; message: string };
export type TmuxDisconnectedEvent = { type: 'TMUX_DISCONNECTED' };
/**
 * Adapter detected the SSE/Tauri channel dropped but is retrying. Distinct
 * from TMUX_DISCONNECTED (gave up) and TMUX_FATAL (no recovery possible).
 * `attempt` increments per retry — the UI shows it in the reconnect banner.
 */
export type TmuxReconnectingEvent = { type: 'TMUX_RECONNECTING'; attempt: number };
/**
 * Adapter recovered the channel after one or more failed attempts. The
 * appMachine returns to the live idle/syncing branch and the store
 * reconciles pending ops against the next full server snapshot.
 */
export type TmuxReconnectedEvent = { type: 'TMUX_RECONNECTED' };
/**
 * OSC 52 clipboard write request emitted by a terminal application.
 * The appMachine forwards the payload to navigator.clipboard.writeText.
 */
export type TmuxClipboardEvent = { type: 'TMUX_CLIPBOARD'; paneId: string; text: string };
export type ConnectionInfoEvent = {
  type: 'CONNECTION_INFO';
  connectionId: number;
  defaultShell: string;
};
export type KeybindingsReceivedEvent = { type: 'KEYBINDINGS_RECEIVED'; keybindings: KeyBindings };

// Drag events
export type DragStartEvent = {
  type: 'DRAG_START';
  paneId: string;
  startX: number;
  startY: number;
  containerLeft: number;
  containerTop: number;
};
export type DragMoveEvent = { type: 'DRAG_MOVE'; clientX: number; clientY: number };
export type DragEndEvent = { type: 'DRAG_END' };

// Resize events
export type ResizeStartEvent = {
  type: 'RESIZE_START';
  paneId: string;
  handle: 'n' | 's' | 'e' | 'w';
  startX: number;
  startY: number;
};
export type ResizeMoveEvent = { type: 'RESIZE_MOVE'; clientX: number; clientY: number };
export type ResizeEndEvent = { type: 'RESIZE_END' };

// Keyboard events
export type KeyPressEvent = {
  type: 'KEY_PRESS';
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};
export type PrefixModeChangeEvent = { type: 'PREFIX_MODE_CHANGE'; active: boolean };

// UI config events
export type SetCharSizeEvent = { type: 'SET_CHAR_SIZE'; charWidth: number; charHeight: number };
export type SetTargetSizeEvent = { type: 'SET_TARGET_SIZE'; cols: number; rows: number };
export type SetContainerSizeEvent = { type: 'SET_CONTAINER_SIZE'; width: number; height: number };
export type ObserveContainerEvent = { type: 'OBSERVE_CONTAINER'; element: HTMLElement };
export type StopObserveContainerEvent = { type: 'STOP_OBSERVE_CONTAINER' };

// Pane events
export type FocusPaneEvent = { type: 'FOCUS_PANE'; paneId: string };
export type SendCommandEvent = { type: 'SEND_COMMAND'; command: string };
export type SendKeysEvent = { type: 'SEND_KEYS'; paneId: string; keys: string };
export type SendTmuxCommandEvent = { type: 'SEND_TMUX_COMMAND'; command: string };
export type CopySelectionEvent = { type: 'COPY_SELECTION' };

// Semantic pane events (components send intent, machine constructs commands)
export type ClosePaneEvent = { type: 'CLOSE_PANE'; paneId: string };
/**
 * Click on a pane-group tab (the tabs inside a `PaneHeader`, not the top
 * window tabs — those use `SELECT_TAB`). Handler is optimistic in the same
 * shape as `SELECT_TAB`: it flips `activePaneId`, swaps the clicked pane
 * into the visible window slot locally, primes the group-switch dim override
 * to suppress mid-swap nvim redraw flicker, and pushes `UPDATE_ACTIVE_PANE`
 * to the keyboard actor so subsequent keystrokes target the clicked pane
 * before tmux's `swap-pane` round-trips.
 */
export type SelectPaneGroupTabEvent = { type: 'SELECT_PANE_GROUP_TAB'; paneId: string };
/**
 * Create a new tab/window. Single entry point for the "+" button, the
 * tab context-menu "New Tab" item, and the AppMenu "New Tab" item.
 * Applies the same optimistic-prediction path that prefix+c gets so the
 * placeholder tab appears instantly and reconciliation surfaces failures.
 */
export type CreateTabEvent = { type: 'CREATE_TAB' };
export type ZoomPaneEvent = { type: 'ZOOM_PANE'; paneId: string };
export type CloseFloatEvent = { type: 'CLOSE_FLOAT'; paneId: string };
export type CloseTopFloatEvent = { type: 'CLOSE_TOP_FLOAT' };

// Sidebar (left drawer running the `tmuxy tree` TUI)
export type ToggleSidebarEvent = { type: 'TOGGLE_SIDEBAR' };
export type FocusSidebarEvent = { type: 'FOCUS_SIDEBAR' };
export type BlurSidebarEvent = { type: 'BLUR_SIDEBAR' };
export type WriteToPaneEvent = { type: 'WRITE_TO_PANE'; paneId: string; data: string };

/**
 * Switch to a tab/window. Covers every tab-nav method — click, keybinding,
 * native menu, command palette — not just clicks. The handler flips
 * `activeWindowId` optimistically before `select-window` round-trips, so the
 * new window's cached pane contents render immediately.
 */
export type SelectTabEvent = {
  type: 'SELECT_TAB';
  windowId: string;
  windowIndex: number;
};

// Copy mode events
export type EnterCopyModeEvent = {
  type: 'ENTER_COPY_MODE';
  paneId: string;
  scrollLines?: number;
  nativeScrollTop?: number;
};
export type ExitCopyModeEvent = { type: 'EXIT_COPY_MODE'; paneId: string };
export type CopyModeChunkLoadedEvent = {
  type: 'COPY_MODE_CHUNK_LOADED';
  paneId: string;
  cells: import('../tmux/types').PaneContent;
  start: number;
  end: number;
  historySize: number;
  width: number;
};
export type CopyModeCursorMoveEvent = {
  type: 'COPY_MODE_CURSOR_MOVE';
  paneId: string;
  row: number;
  col: number;
  relative?: boolean;
};
export type CopyModeSelectionStartEvent = {
  type: 'COPY_MODE_SELECTION_START';
  paneId: string;
  mode: 'char' | 'line';
  row: number;
  col: number;
};
export type CopyModeSelectionClearEvent = { type: 'COPY_MODE_SELECTION_CLEAR'; paneId: string };
export type CopyModeScrollEvent = { type: 'COPY_MODE_SCROLL'; paneId: string; scrollTop: number };
export type CopyModeYankEvent = { type: 'COPY_MODE_YANK'; paneId: string };
export type CopyModeKeyEvent = {
  type: 'COPY_MODE_KEY';
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
};
export type CopyModeWordSelectEvent = {
  type: 'COPY_MODE_WORD_SELECT';
  paneId: string;
  row: number;
  col: number;
  broad?: boolean;
};
export type CopyModeLineSelectEvent = {
  type: 'COPY_MODE_LINE_SELECT';
  paneId: string;
  row: number;
};

// Group switch detection event (fired internally when switch detected in state update)

// Command mode events
export type CommandModeSubmitEvent = { type: 'COMMAND_MODE_SUBMIT'; value: string };
export type CommandModeCancelEvent = { type: 'COMMAND_MODE_CANCEL' };
export type ShowStatusMessageEvent = { type: 'SHOW_STATUS_MESSAGE'; text: string };
export type ClearStatusMessageEvent = { type: 'CLEAR_STATUS_MESSAGE' };

// Focus events (for keyboard capture gating)
export type AppFocusEvent = { type: 'APP_FOCUS' };
export type AppBlurEvent = { type: 'APP_BLUR' };

// Session events
export type SwitchSessionEvent = {
  type: 'SWITCH_SESSION';
  sessionName: string;
  /** Stable targets selected after the adapter has attached to the new session. */
  windowId?: string;
  paneId?: string;
};
export type OpenSessionFloatEvent = { type: 'OPEN_SESSION_FLOAT' };
export type OpenConnectFloatEvent = { type: 'OPEN_CONNECT_FLOAT' };
/** Open the `tmuxy connect` "add a server" form in a float (desktop only). */
export type OpenAddServerFloatEvent = { type: 'OPEN_ADD_SERVER_FLOAT' };
export type SessionSwitchRequestedEvent = {
  type: 'SESSION_SWITCH_REQUESTED';
  sessionName: string;
};
/** Sidebar sessions tree refreshed by the `serversActor` poll (web+desktop). */
export type SessionsUpdatedEvent = {
  type: 'SESSIONS_UPDATED';
  sessions: SessionTreeNode[];
};
/** Git repositories/worktrees refreshed from the paths in the session tree. */
export type GitRepositoriesUpdatedEvent = {
  type: 'GIT_REPOSITORIES_UPDATED';
  repositories: GitRepository[];
};
/** Sidebar server picker refreshed by the desktop poll (`serversActor`). */
export type ServersUpdatedEvent = {
  type: 'SERVERS_UPDATED';
  serverList: ServerInfo[];
  currentServerId: string;
};

// Display settings events
export type IncreaseFontSizeEvent = { type: 'INCREASE_FONT_SIZE' };
export type DecreaseFontSizeEvent = { type: 'DECREASE_FONT_SIZE' };
export type ResetFontSizeEvent = { type: 'RESET_FONT_SIZE' };

// Debug log events
export type LogAppendEvent = {
  type: 'LOG_APPEND';
  kind: 'command' | 'output' | 'error' | 'info';
  message: string;
};

// Theme events
export type SetThemeEvent = { type: 'SET_THEME'; name: string };
export type SetThemeModeEvent = { type: 'SET_THEME_MODE'; mode: 'dark' | 'light' };
export type ThemeSettingsReceivedEvent = {
  type: 'THEME_SETTINGS_RECEIVED';
  theme: string;
  mode: 'dark' | 'light';
};
export type ThemesListReceivedEvent = {
  type: 'THEMES_LIST_RECEIVED';
  themes: Array<{ name: string; displayName: string }>;
};

/** All events the app machine can receive from external sources */
export type AppMachineEvent =
  | TmuxConnectedEvent
  | TmuxStateUpdateEvent
  | TmuxModelUpdateEvent
  | TmuxErrorEvent
  | TmuxFatalEvent
  | TmuxDisconnectedEvent
  | TmuxReconnectingEvent
  | TmuxReconnectedEvent
  | TmuxClipboardEvent
  | ConnectionInfoEvent
  | KeybindingsReceivedEvent
  | DragStartEvent
  | DragMoveEvent
  | DragEndEvent
  | ResizeStartEvent
  | ResizeMoveEvent
  | ResizeEndEvent
  | KeyPressEvent
  | SetCharSizeEvent
  | SetTargetSizeEvent
  | SetContainerSizeEvent
  | ObserveContainerEvent
  | StopObserveContainerEvent
  | FocusPaneEvent
  | SendCommandEvent
  | SendKeysEvent
  | SendTmuxCommandEvent
  | CopySelectionEvent
  | EnterCopyModeEvent
  | ExitCopyModeEvent
  | CopyModeChunkLoadedEvent
  | CopyModeCursorMoveEvent
  | CopyModeSelectionStartEvent
  | CopyModeSelectionClearEvent
  | CopyModeScrollEvent
  | CopyModeYankEvent
  | CopyModeKeyEvent
  | CopyModeWordSelectEvent
  | CopyModeLineSelectEvent
  | ClosePaneEvent
  | SelectPaneGroupTabEvent
  | CreateTabEvent
  | SelectTabEvent
  | ZoomPaneEvent
  | CloseFloatEvent
  | CloseTopFloatEvent
  | ToggleSidebarEvent
  | FocusSidebarEvent
  | BlurSidebarEvent
  | WriteToPaneEvent
  | CommandModeSubmitEvent
  | CommandModeCancelEvent
  | ShowStatusMessageEvent
  | ClearStatusMessageEvent
  | SetThemeEvent
  | SetThemeModeEvent
  | ThemeSettingsReceivedEvent
  | ThemesListReceivedEvent
  | AppFocusEvent
  | AppBlurEvent
  | PrefixModeChangeEvent
  | SwitchSessionEvent
  | OpenSessionFloatEvent
  | OpenConnectFloatEvent
  | OpenAddServerFloatEvent
  | SessionSwitchRequestedEvent
  | SessionsUpdatedEvent
  | GitRepositoriesUpdatedEvent
  | ServersUpdatedEvent
  | IncreaseFontSizeEvent
  | DecreaseFontSizeEvent
  | ResetFontSizeEvent
  | LogAppendEvent;

/** All events the app machine handles (external + child machine events) */
export type AllAppMachineEvents = AppMachineEvent | ChildMachineEvent;

// Optimistic operation tracking lives in `src/tmux/store/` now (Tier 3).
// The PendingOp / TmuxOp / TmuxClientModel types replace the per-op
// prediction structs that used to live here.
