import type { PushState } from '../../infra/pushNotifications';
import type { ServerState, KeyBindings, Appearance, ProcessIcons } from '../../domain/wire';
import type { PaneContent } from '../../domain/wireCells';
import type { ThemeInfo, ThemeMode, TraceLevel, TraceSettings } from '../../domain/wireSettings';
import type { TabStripGeometry } from '../drag/tabStripDrop';
import type { AskAnswer } from '../../domain/paneAsk';
import type { PaneId, WindowId } from '../../domain/ids';
import type { TmuxOp } from '../../domain/commands';
import type { PluginInfo } from '../../domain/plugins';
import type { TmuxClientModel } from '../../domain/store/types';
import type {
  BottomView,
  ChildMachineEvent,
  KeyboardOwner,
  KeyPressEvent,
  NotificationKind,
  ResizeHandle,
  SidebarSide,
} from './domain';
import type {
  GitRepository,
  PanePorts,
  RestorableSession,
  SessionTreeNode,
  TmuxServer,
} from '../../domain/servers';

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
  /**
   * Adapter detected the SSE/Tauri channel dropped but is retrying. Distinct
   * from TMUX_FATAL (no recovery possible).
   */
  | { type: 'TMUX_RECONNECTING' }
  /**
   * Adapter recovered the channel after one or more failed attempts. The
   * machine returns to `idle` and the store reconciles pending ops against the
   * next full server snapshot.
   */
  | { type: 'TMUX_RECONNECTED' }
  /** A clipboard write; `paneId` is null for the paste-buffer mirror. */
  | { type: 'TMUX_CLIPBOARD'; paneId: PaneId | null; text: string }
  | { type: 'CONNECTION_INFO'; defaultShell: string; hostname: string | null }
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

  // Resize events
  | {
      type: 'RESIZE_START';
      paneId: PaneId;
      handle: ResizeHandle;
      startX: number;
      startY: number;
    }

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
  /** A double tap on the phone's terminal: at the point tapped. */
  | { type: 'TOGGLE_PHONE_ZOOM'; x?: number; y?: number }
  /** The bar between the phone's terminal and its bottom view, released. */
  | { type: 'SET_PHONE_SPLIT'; zoom: number; collapsed: boolean }
  | { type: 'SET_PHONE_BOTTOM_VIEW'; view: BottomView }
  /** The phone's bottom view was measured, in the dock's cells. */
  | { type: 'SET_PHONE_DOCK_SIZE'; cols: number; rows: number }
  /** A change about to land must not animate: the next settled update turns animations back on. */
  | { type: 'SUPPRESS_ANIMATIONS' }
  /** The grid is the size this client asked for and settled: layout changes may animate again. */
  | { type: 'ANIMATIONS_SETTLED' }
  | {
      type: 'SET_TARGET_SIZE';
      cols: number;
      rows: number;
    }
  | { type: 'SET_CONTAINER_SIZE'; width: number; height: number }
  | { type: 'OBSERVE_CONTAINER'; element: HTMLElement }

  // Pane events
  /**
   * The user picked a pane: a click on it, its header tab or its tree row. The
   * machine decides how (a group switch, a tab switch first, a float or the
   * dock taking the keyboard).
   */
  | { type: 'SELECT_PANE'; paneId: PaneId }
  /**
   * A command that arrives as a string — a binding tmux reported, what the user
   * typed at the prompt, a tmuxy.conf alias. The machine parses it into the op
   * it means; everything the client originates is a `DispatchOpEvent` instead.
   */
  | { type: 'SEND_TMUX_COMMAND'; command: string }
  /** An intent the client issues itself, routed and dispatched through the store. */
  | { type: 'DISPATCH_OP'; op: TmuxOp }
  | { type: 'COPY_SELECTION' }
  /** `paneId` null: the pane the keyboard is in (a focused float, else the active pane). */
  | { type: 'CLOSE_PANE'; paneId: PaneId | null }
  | { type: 'CREATE_TAB' }
  | { type: 'ZOOM_PANE'; paneId: PaneId }

  // Pending confirmations (`tmuxy pane send -t`) — see domain/paneAsk.ts.
  | { type: 'MOVE_ASK_SELECTION'; paneId: PaneId; to: AskAnswer }
  | { type: 'ANSWER_ASK'; paneId: PaneId; answer: AskAnswer }
  | { type: 'ANSWER_VISIBLE_ASKS'; answer: AskAnswer }
  /** A plain key typed into a pane with a question on it; the ask slice decides what it does. */
  | { type: 'ASK_KEY'; paneId: PaneId; key: string }
  | { type: 'CLOSE_FLOAT'; paneId: PaneId }

  // Who holds the keyboard (the keyboard slice)
  | { type: 'TAKE_KEYBOARD'; owner: KeyboardOwner }
  | { type: 'RELEASE_KEYBOARD'; from: KeyboardOwner['kind'] }
  /** The floats on screen changed; with `claim` the topmost takes the keyboard. */
  | { type: 'SYNC_FLOAT_FOCUS'; claim: boolean }

  // The sidebar columns
  | { type: 'TOGGLE_SIDEBAR'; side: SidebarSide }
  | { type: 'FOCUS_SIDEBAR'; side: SidebarSide }
  | { type: 'BLUR_SIDEBAR'; side: SidebarSide }
  /** Break the column's pane out if it does not exist yet. */
  | { type: 'START_SIDEBAR'; side: SidebarSide }
  | { type: 'TOGGLE_TAB_COLLAPSE'; windowId: WindowId }
  | { type: 'SYNC_DOCK_SIZE' }
  | { type: 'SIDEBAR_START_TIMEOUT'; side: SidebarSide }
  | { type: 'SIDEBAR_RESIZE_PREVIEW'; side: SidebarSide; cols: number | null }
  | { type: 'SIDEBAR_RESIZE_COMMIT'; side: SidebarSide; cols: number | null }
  | { type: 'SIDEBAR_PREVIEW_EXPIRE'; side: SidebarSide }
  | { type: 'PEEK_SIDEBAR'; side: SidebarSide }
  | { type: 'END_SIDEBAR_PEEK' }
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
  /** Open a tab's rename field, in the strip or in the tree (`surface`, the strip by default). */
  | { type: 'RENAME_TAB'; windowId: WindowId; surface?: 'strip' | 'tree' }
  /** The tab's rename field closed: with the new name, or `null` when cancelled. */
  | { type: 'RENAME_TAB_COMMIT'; windowId: WindowId; name: string | null }
  | { type: 'RENAME_PANE'; paneId: PaneId }
  /** The pane's rename field closed: with the new title, or `null` when cancelled. */
  | { type: 'RENAME_PANE_COMMIT'; paneId: PaneId; title: string | null }
  /** A pane dropped on another tab: it moves there, and that tab comes to the front. */
  | { type: 'MOVE_PANE_TO_TAB'; paneId: PaneId; windowId: WindowId }
  /** Stacked panes on, or off, for a tab (the active one when none is named). */
  | { type: 'TOGGLE_STACKED_PANES'; windowId?: WindowId }
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
  | { type: 'COPY_MODE_CHUNK_FAILED'; paneId: PaneId }
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
  | { type: 'PANE_PORTS_UPDATED'; panePorts: readonly PanePorts[] }
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
  /** Turn this device's push notifications on or off (the View menu). */
  | { type: 'TOGGLE_PUSH' }
  /** Where this device's push notifications stand now. */
  | { type: 'PUSH_STATE'; state: PushState }
  /** tmux's `<theme>:<mode>` changed: some client picked a theme. */
  | { type: 'THEME_REV_CHANGED'; rev: string }
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
      icons?: ProcessIcons;
      pinned?: readonly string[];
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
  | { type: 'OPEN_TRACE_FILE' }
  /** A link a plugin's handler may take: the server decides, or the browser opens it. */
  | { type: 'PLUGIN_OPEN_LINK'; url: string; paneId: PaneId }
  /** Plain text clicked with the link modifier, for a plugin's text handler. */
  | { type: 'PLUGIN_OPEN_TEXT'; paneId: PaneId; line: string; column: number }
  /** The state stream carried a new `@tmuxy-plugins-rev` (`''`: none). */
  | { type: 'PLUGINS_REV_CHANGED'; rev: string }
  | { type: 'PLUGINS_RECEIVED'; plugins: PluginInfo[] }
  /**
   * Run a plugin's action from a menu: on `paneId` (`null`: the active pane),
   * with the selected text when it came from the selection menu.
   */
  | {
      type: 'PLUGIN_ACTION';
      plugin: string;
      action: string;
      paneId: PaneId | null;
      selection?: string;
    };

/** All events the app machine handles (external + child machine events) */
export type AllAppMachineEvents = AppMachineEvent | ChildMachineEvent;
