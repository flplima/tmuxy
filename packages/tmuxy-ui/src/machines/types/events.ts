import type { ServerState, KeyBindings, Appearance, PaneContent } from '../../domain/wire';
import type { ThemeInfo, ThemeMode } from '../../utils/themeManager';
import type { TabStripGeometry } from '../../utils/tabStripDrop';
import type { AskAnswer } from '../../utils/paneAsk';
import type { PaneId, WindowId } from '../../domain/ids';
import type { TmuxOp } from '../../domain/commands';
import type { TmuxClientModel } from '../../domain/store/types';
import type {
  ChildMachineEvent,
  GitRepository,
  KeyPressEvent,
  NotificationKind,
  ResizeHandle,
  RestorableSession,
  SessionTreeNode,
  TmuxServer,
  TraceLevel,
  TraceSettings,
} from './domain';

/** All events the app machine can receive from external sources */
export type AppMachineEvent =
  // Tmux connection events
  | { type: 'TMUX_CONNECTED' }
  | { type: 'TMUX_STATE_UPDATE'; state: ServerState }
  /**
   * Fired by tmuxStoreActor whenever the TmuxClientModel changes — either from
   * a server reconciliation, a local optimistic dispatch, or a rollback. The
   * handler reads `model.derived` and treats it as the authoritative snapshot
   * for downstream effects (group/float builds, copy-mode detection, animations).
   */
  | { type: 'TMUX_MODEL_UPDATE'; model: TmuxClientModel }
  /** A failed command or call, as the display string the snackbar shows. */
  | { type: 'TMUX_ERROR'; error: string }
  | { type: 'TMUX_FATAL'; message: string }
  | { type: 'TMUX_DISCONNECTED' }
  /**
   * Adapter detected the SSE/Tauri channel dropped but is retrying. Distinct
   * from TMUX_DISCONNECTED (gave up) and TMUX_FATAL (no recovery possible).
   */
  | { type: 'TMUX_RECONNECTING' }
  /**
   * Adapter recovered the channel after one or more failed attempts. The
   * appMachine returns to the live idle/syncing branch and the store
   * reconciles pending ops against the next full server snapshot.
   */
  | { type: 'TMUX_RECONNECTED' }
  /** A clipboard write; `paneId` is null for the paste-buffer mirror. */
  | { type: 'TMUX_CLIPBOARD'; paneId: PaneId | null; text: string }
  | { type: 'CONNECTION_INFO'; defaultShell: string }
  | { type: 'KEYBINDINGS_RECEIVED'; keybindings: KeyBindings }

  // Drag events
  | {
      type: 'DRAG_START';
      paneId: PaneId;
      startX: number;
      startY: number;
      containerLeft: number;
      containerTop: number;
      tabStrip: TabStripGeometry | null;
    }
  | { type: 'DRAG_MOVE'; clientX: number; clientY: number }
  | { type: 'DRAG_END' }

  // Resize events
  | {
      type: 'RESIZE_START';
      paneId: PaneId;
      handle: ResizeHandle;
      startX: number;
      startY: number;
    }
  | { type: 'RESIZE_MOVE'; clientX: number; clientY: number }
  | { type: 'RESIZE_END' }

  // Keyboard events
  | KeyPressEvent
  /**
   * The prefix was armed or released. `repeatOnly` names the keys a repeat
   * window (after `prefix s`) still takes; any other key goes on as typed.
   */
  | {
      type: 'PREFIX_MODE_CHANGE';
      active: boolean;
      repeatOnly?: readonly string[] | null;
    }
  /** The keyboard entered a sticky key table, or left it (null). */
  | { type: 'KEY_TABLE_CHANGE'; table: string | null }
  /** Open or close the keys view (`prefix ?`). */
  | { type: 'TOGGLE_KEYS_VIEW' }

  // UI config events
  | {
      type: 'SET_CHAR_SIZE';
      charWidth: number;
      charHeight: number;
      cellGap: number;
      /** The grid's font size when it is not the chrome's (the phone layout). */
      gridFontSize?: number;
    }
  | { type: 'SET_PHONE_LAYOUT'; phone: boolean; landscape: boolean }
  | { type: 'REFIT_GRID' }
  /** A double tap on the phone's terminal, or its zoom key: at the point tapped. */
  | { type: 'TOGGLE_PHONE_ZOOM'; x?: number; y?: number }
  | { type: 'SET_PHONE_BOTTOM_VIEW'; view: 'tree' | 'dock' }
  | { type: 'SET_PHONE_DOCK_SIZE'; cols: number; rows: number }
  /** Break the dock's pane out if it does not exist yet (the sidebars slice). */
  | { type: 'START_RIGHT_SIDEBAR' }
  | {
      type: 'SET_TARGET_SIZE';
      cols: number;
      rows: number;
    }
  | { type: 'SET_CONTAINER_SIZE'; width: number; height: number }
  | { type: 'OBSERVE_CONTAINER'; element: HTMLElement }

  // Pane events
  | { type: 'FOCUS_PANE'; paneId: PaneId }
  | { type: 'SEND_KEYS'; paneId: PaneId; keys: string }
  /**
   * A command that arrives as a string — a binding tmux reported, what the user
   * typed at the prompt, a tmuxy.conf alias. The machine parses it into the op
   * it means; everything the client originates is a `DispatchOpEvent` instead.
   */
  | { type: 'SEND_TMUX_COMMAND'; command: string }
  /** An intent the client issues itself, routed and dispatched through the store. */
  | { type: 'DISPATCH_OP'; op: TmuxOp }
  | { type: 'COPY_SELECTION' }
  | { type: 'CLOSE_PANE'; paneId: PaneId }
  /**
   * Click on a pane-group tab (the tabs inside a `PaneHeader`, not the top
   * window tabs — those use `SELECT_TAB`).
   */
  | { type: 'SELECT_PANE_GROUP_TAB'; paneId: PaneId }
  | { type: 'CREATE_TAB' }
  | { type: 'ZOOM_PANE'; paneId: PaneId }

  // Pending confirmations (`tmuxy pane send -t`) — see utils/paneAsk.ts.
  | { type: 'MOVE_ASK_SELECTION'; paneId: PaneId; to: AskAnswer }
  | { type: 'ANSWER_ASK'; paneId: PaneId; answer: AskAnswer }
  | { type: 'ANSWER_VISIBLE_ASKS'; answer: AskAnswer }
  | { type: 'CLOSE_FLOAT'; paneId: PaneId }
  | { type: 'CLOSE_TOP_FLOAT' }

  // Left & Right sidebars
  | { type: 'TOGGLE_LEFT_SIDEBAR' }
  | { type: 'FOCUS_LEFT_SIDEBAR' }
  | { type: 'BLUR_LEFT_SIDEBAR' }
  | { type: 'TOGGLE_TAB_COLLAPSE'; windowId: WindowId }
  | { type: 'TOGGLE_RIGHT_SIDEBAR' }
  | { type: 'SYNC_DOCK_ROWS' }
  | { type: 'SYNC_FLOAT_FOCUS' }
  | { type: 'FOCUS_RIGHT_SIDEBAR' }
  | { type: 'BLUR_RIGHT_SIDEBAR' }
  | { type: 'SIDEBAR_START_TIMEOUT'; side: 'left' | 'right' }
  | { type: 'SIDEBAR_RESIZE_PREVIEW'; side: 'left' | 'right'; cols: number | null }
  | { type: 'SIDEBAR_RESIZE_COMMIT'; side: 'left' | 'right'; cols: number | null }
  | { type: 'SIDEBAR_PREVIEW_EXPIRE'; side: 'left' | 'right' }
  | { type: 'SET_BODY_SIZE'; width: number }

  // Tab Overview and position-based tab keys
  | { type: 'TOGGLE_TAB_OVERVIEW' }
  | { type: 'CLOSE_TAB_OVERVIEW' }
  | { type: 'TAB_OVERVIEW_MOVE'; delta: number }
  | { type: 'TAB_OVERVIEW_ACTIVATE'; index?: number }
  | { type: 'SELECT_TAB_BY_POSITION'; position: number }
  | { type: 'REORDER_TAB'; windowId: WindowId; toIndex: number }
  | { type: 'MOVE_ACTIVE_TAB'; by: -1 | 1 }
  | { type: 'CLOSE_TAB'; windowId: WindowId }
  | { type: 'RENAME_ACTIVE_TAB' }
  | { type: 'RENAME_TAB'; windowId: WindowId }
  | { type: 'TAB_RENAME_END' }
  | { type: 'RENAME_PANE'; paneId: PaneId }
  | { type: 'PANE_RENAME_END' }
  | { type: 'TOGGLE_STACKED_PANES' }
  | { type: 'WRITE_TO_PANE'; paneId: PaneId; data: string }
  | { type: 'SELECT_TAB'; windowId: WindowId }

  // Copy mode & scrollback events
  | {
      type: 'ENTER_COPY_MODE';
      paneId: PaneId;
      scrollLines?: number;
      nativeScrollTop?: number;
    }
  | { type: 'EXIT_COPY_MODE'; paneId: PaneId }
  | {
      type: 'ENTER_SCROLL_MODE';
      paneId: PaneId;
      scrollLines?: number;
      nativeScrollTop?: number;
    }
  | { type: 'EXIT_SCROLL_MODE'; paneId: PaneId }
  | { type: 'SELECT_ALL_SCROLLBACK'; paneId: PaneId }
  | {
      type: 'COPY_MODE_CHUNK_LOADED';
      paneId: PaneId;
      cells: PaneContent;
      start: number;
      end: number;
      historySize: number;
      width: number;
    }
  | {
      type: 'COPY_MODE_CURSOR_MOVE';
      paneId: PaneId;
      row: number;
      col: number;
      relative?: boolean;
    }
  | {
      type: 'COPY_MODE_SELECTION_START';
      paneId: PaneId;
      mode: 'char' | 'line';
      row: number;
      col: number;
    }
  | { type: 'COPY_MODE_SELECTION_CLEAR'; paneId: PaneId }
  | {
      type: 'COPY_MODE_SCROLL';
      paneId: PaneId;
      scrollTop: number;
      nativeSelection?: boolean;
    }
  | { type: 'COPY_MODE_YANK'; paneId: PaneId }
  | { type: 'COPY_MODE_MOUSE_COPY'; paneId: PaneId }
  | { type: 'COPY_MODE_COPIED_EXIT'; paneId: PaneId; copiedAt: number }
  | { type: 'COPY_MODE_KEY'; key: string; ctrlKey: boolean; shiftKey: boolean }
  | {
      type: 'COPY_MODE_WORD_SELECT';
      paneId: PaneId;
      row: number;
      col: number;
      broad?: boolean;
    }
  | { type: 'COPY_MODE_LINE_SELECT'; paneId: PaneId; row: number }

  // Command mode & snackbar events
  | {
      type: 'OPEN_COMMAND_PROMPT';
      prompt: string | null;
      initial: string;
      template: string | null;
    }
  | { type: 'COMMAND_MODE_SUBMIT'; value: string }
  | { type: 'COMMAND_MODE_CANCEL' }
  | { type: 'SHOW_STATUS_MESSAGE'; text: string }
  | { type: 'CLEAR_STATUS_MESSAGE' }
  | { type: 'NOTIFY'; text: string; kind?: NotificationKind }
  | { type: 'DISMISS_NOTIFICATION'; id: number }

  // Focus events
  | { type: 'APP_FOCUS' }
  | { type: 'APP_BLUR' }

  // Session & server events
  | { type: 'SWITCH_SESSION'; sessionName: string }
  | { type: 'NEW_SESSION' }
  | { type: 'OPEN_CONNECT_FLOAT' }
  | { type: 'SESSIONS_UPDATED'; sessions: SessionTreeNode[] }
  | { type: 'SNAPSHOTS_UPDATED'; restorableSessions: RestorableSession[] }
  | { type: 'RESTORE_SESSION'; sessionName: string }
  | { type: 'SESSION_MENU_OPENED' }
  | { type: 'GIT_REPOSITORIES_UPDATED'; repositories: GitRepository[] }
  | {
      type: 'SERVERS_UPDATED';
      servers: TmuxServer[];
      currentServerId: string | null;
    }
  | { type: 'CONNECT_SERVER'; serverId: string; session?: string }
  | { type: 'DETACH_CLIENT' }
  | { type: 'RECONNECT_NOW' }
  | { type: 'TMUX_DETACHED'; reason: string | null }

  // Display, theme, gesture & trace events
  | { type: 'INCREASE_FONT_SIZE' }
  | { type: 'DECREASE_FONT_SIZE' }
  | { type: 'RESET_FONT_SIZE' }
  | {
      type: 'LOG_APPEND';
      kind: 'command' | 'output' | 'error' | 'info';
      message: string;
    }
  | { type: 'SET_THEME'; name: string }
  | { type: 'SET_THEME_MODE'; mode: ThemeMode }
  | { type: 'TOGGLE_CURSOR_BLINK' }
  | { type: 'TOGGLE_SEND_ASK' }
  | { type: 'TOGGLE_TRANSPARENCY' }
  | {
      type: 'THEME_SETTINGS_RECEIVED';
      theme: string;
      mode: ThemeMode;
      appearance?: Appearance;
      cssVars?: Readonly<Record<string, string>>;
    }
  | { type: 'THEMES_LIST_RECEIVED'; themes: ThemeInfo[] }
  | { type: 'CSS_CHANGED' }
  | { type: 'GESTURE_PINCH'; scale: number; paneId: PaneId | null }
  | { type: 'GESTURE_PINCH_END' }
  | { type: 'GESTURE_SWIPE'; dx: number }
  | { type: 'GESTURE_SWIPE_END'; speed: number }
  | { type: 'GESTURE_SETTLE' }
  | { type: 'FETCH_TRACE_SETTINGS' }
  | { type: 'TRACE_SETTINGS_RECEIVED'; settings: TraceSettings }
  | { type: 'SET_TRACE_ENABLED'; enabled: boolean }
  | { type: 'SET_TRACE_LEVEL'; level: TraceLevel }
  | { type: 'OPEN_TRACE_FILE' };

/** All events the app machine handles (external + child machine events) */
export type AllAppMachineEvents = AppMachineEvent | ChildMachineEvent;
