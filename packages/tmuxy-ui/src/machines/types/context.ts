import type { CopyModeState } from '../../domain/copyMode';
import type { TmuxPane, TmuxWindow } from '../../domain/client';
import type { KeyBindings, SizePolicy } from '../../domain/wire';
import type { GridCell } from '../../utils/gridFit';
import type { ThemeInfo, ThemeMode } from '../../utils/themeManager';
import type { AskAnswer } from '../../utils/paneAsk';
import type { GroupId, PaneId, WindowId } from '../../domain/ids';
import type {
  AppNotification,
  DragState,
  FloatPaneState,
  GestureFlags,
  GestureState,
  GitRepository,
  LogEntry,
  PaneGroup,
  ResizeState,
  RestorableSession,
  SessionTreeNode,
  TmuxServer,
  TraceSettings,
} from './domain';

export interface AppMachineContext {
  connected: boolean;
  error: string | null;
  /**
   * Set when the backend gave up reconnecting (e.g. tmux server unavailable
   * after MAX_CONSECUTIVE_FAILURES attempts). Terminal: no further events
   * will arrive on this monitor.
   */
  fatalError: string | null;
  /** Recent commands sent and errors received (debug log shown on status screen) */
  log: LogEntry[];
  sessionName: string;
  activeWindowId: WindowId | null;
  activePaneId: PaneId | null;
  panes: TmuxPane[];
  windows: TmuxWindow[];
  totalWidth: number;
  totalHeight: number;
  paneGroups: Record<GroupId, PaneGroup>;
  /**
   * Which of Yes/No is highlighted on each pane showing a `tmuxy pane send -t`
   * question, keyed by pane id. A pane with no entry starts on `yes` — the
   * answer the keyboard shortcut gives, so the highlight and the shortcut
   * agree before the user has touched anything. Entries are dropped when the
   * question goes away.
   */
  askSelections: Record<PaneId, AskAnswer>;
  targetCols: number;
  targetRows: number;
  drag: DragState | null;
  resize: ResizeState | null;
  resizeActive: boolean;
  charWidth: number;
  charHeight: number;
  /** letter-spacing (px) that pads the font's natural advance up to charWidth. */
  cellGap: number;
  /**
   * The pane grid's own font size in px when it differs from the chrome's —
   * the phone layout's shrunken cell (utils/phoneLayout.ts), or a cell fitted
   * to a grid `@tmuxy-size` sized for someone else (utils/gridFit.ts). Null
   * otherwise.
   */
  gridFontSize: number | null;
  /**
   * The cell the size actor measured (or cut for the phone), before any fit
   * to the window's size. `charWidth`/`charHeight`/`cellGap`/`gridFontSize`
   * are the grid's cell, fitted from this one; the sidebar columns and the
   * viewport size this client asks tmux for are measured in this one.
   */
  measuredCell: GridCell;
  /** `@tmuxy-size`, from the config: how tmux sizes the session across clients. */
  sizePolicy: SizePolicy;
  /** The phone layout: the whole 80 × 25 terminal, a key row and the tree below it. */
  phoneLayout: boolean;
  /** The phone layout held sideways: the terminal right, the strip, keys and tree left of it. */
  phoneLandscape: boolean;
  /** Default shell name (e.g., "bash", "zsh") from server */
  defaultShell: string;
  /** The server machine's name, from its greeting; null until it says. */
  serverHostname: string | null;

  /** Container dimensions for centering calculations */
  containerWidth: number;
  containerHeight: number;
  /** Float pane positions and states (keyed by pane ID) */
  floatPanes: Record<PaneId, FloatPaneState>;
  /** Pane ID of the currently focused float (keyboard routes here instead of session) */
  focusedFloatPaneId: PaneId | null;
  /**
   * Whether the left sidebar column (the tab/pane tree) is shown. Its pane lives
   * in a `sidebar-left`-typed window running `tmuxy widget tree`; closing hides
   * the column (`@tmuxy-sidebar-hidden` on its window) and keeps that pane, so
   * the choice survives a reload and reaches every other client.
   */
  leftSidebarOpen: boolean;
  /**
   * Whether the tree column holds keyboard focus. While true, keys drive the
   * tree widget (j/k/Enter/l/q) instead of reaching a tab's pane.
   */
  leftSidebarFocused: boolean;
  /**
   * The tree column was asked to open but its pane never appeared (the
   * `tmuxy widget tree` command failed on this server). The column shows why
   * instead of "starting…" forever.
   */
  leftSidebarStartFailed: boolean;
  /**
   * This client asked tmux to create the tree column's pane and is waiting
   * for it. Cleared by SIDEBAR_START_TIMEOUT. While set, a pane that appears
   * and vanishes within the window is a failed start, not a user closing it.
   */
  leftSidebarStarting: boolean;
  /**
   * Whether the right sidebar column (the pinned terminal) is open. The pane
   * behind it lives in a `sidebar-right`-typed window and survives closing —
   * closing hides the column, it never kills the shell.
   */
  rightSidebarOpen: boolean;
  /**
   * Whether the pinned terminal dock holds keyboard focus. While true, keys are
   * routed to its pane instead of the active tab's pane (same mechanism a
   * focused float uses).
   */
  rightSidebarFocused: boolean;
  /** The dock was asked to open but its pane never appeared. */
  rightSidebarStartFailed: boolean;
  /** Same as `leftSidebarStarting`, for the dock. */
  rightSidebarStarting: boolean;
  /**
   * A sidebar column width being previewed while its divider is dragged, in
   * columns (null = the default). Drawn immediately; the tmux option is written
   * on release and the preview is dropped once the server reports that width.
   */
  sidebarColsPreview: { side: 'left' | 'right'; cols: number | null } | null;
  /** Rows last written to the dock's @tmuxy-sidebar-rows, and for which window. */
  dockRowsSent: { windowId: WindowId; rows: number } | null;

  /**
   * The phone's browser-side zoom (the `phone` slice): the terminal drawn at
   * twice its size and panned with a finger, around the point tapped (client
   * px; null for the middle). Null when not zoomed.
   */
  phoneZoom: { x: number | null; y: number | null } | null;
  /** What the phone shows under the keys: the tree, or the pinned terminal (the dock). */
  phoneBottomView: 'tree' | 'dock';
  /** The dock size last written to its window from the phone's bottom view. */
  phoneDockSizeSent: { windowId: WindowId; cols: number; rows: number } | null;
  /**
   * Width of the app body (both columns plus the pane grid), in pixels. The
   * docked/overlay decision is made from this, never from the pane container,
   * whose width already depends on that decision.
   */
  bodyWidth: number;
  /**
   * Tabs the user has collapsed in the sidebar tree, by window id. Tabs are
   * expanded by default, so this holds only the exceptions — a tab that goes
   * away takes its entry with it.
   */
  collapsedTabIds: WindowId[];
  /**
   * The Tab Overview (ctrl+0): every tab as a slot over the pane area, the
   * current one zoomed out into its slot. `tabOverviewSelected` is the keyboard
   * cursor over the slots in strip order, the last index being the "+" slot.
   */
  tabOverviewOpen: boolean;
  tabOverviewSelected: number;
  /** The tab whose rename field is open in the strip, if any. */
  renamingTabId: WindowId | null;
  /** Whether browser-side animations are enabled */
  enableAnimations: boolean;
  /**
   * The config's say (`@tmuxy-animations`): false strips every layout
   * transition and keyframe for the session, whatever `enableAnimations`
   * settles to. Defaults to true, also on adapters without a config.
   */
  animationsAllowed: boolean;
  /**
   * The config's `@tmuxy-cursor-blink` switch, flipped from the View menu and
   * written back to `tmuxy.state.json`. False keeps the cursor solid; true
   * lets it blink, except where the running application asked for a steady
   * cursor through DECSCUSR.
   */
  cursorBlink: boolean;
  /**
   * The config's `@tmuxy-send-ask` switch, flipped from the View menu and
   * written back to `tmuxy.state.json`: whether `tmuxy pane send` into a
   * pane the caller does not own asks the user there first.
   */
  sendAsk: boolean;
  /**
   * The config's `@tmuxy-transparency` switch, flipped from the View menu on
   * the macOS desktop app and written back to `tmuxy.state.json`: off, the
   * window is opaque and has no blur.
   */
  transparency: boolean;
  /**
   * The menu-managed options (`@tmuxy-theme`, `@tmuxy-theme-mode`,
   * `@tmuxy-transparency`, `@tmuxy-cursor-blink`, `@tmuxy-send-ask`) the
   * user's `tmuxy.conf` sets. Config beats menu state: the menus show each as
   * "set in tmuxy.conf" and leave it alone, and a pinned theme wins over the
   * one this client last picked.
   */
  pinnedOptions: readonly string[];
  /**
   * The config's `@tmuxy-tab-overview-cols`: cards per row in the "all tabs"
   * view. Defaults to 3, also on adapters without a config.
   */
  tabOverviewCols: number;
  /** Which trackpad gestures the config allows (`@tmuxy-gesture-*`); all on by default. */
  gestureFlags: GestureFlags;
  /** The desktop app draws its menus natively (`@tmuxy-native-menus`). */
  nativeMenus: boolean;
  /** The trackpad gesture being drawn right now, or null with the fingers off the pad. */
  gesture: GestureState | null;
  /** Keybindings received from the server */
  keybindings: KeyBindings | null;
  /** Client-side copy mode state per pane */
  copyModeStates: Record<PaneId, CopyModeState>;
  /** Pane IDs ordered by most-recently-active first (for navigation tie-breaking) */
  paneActivationOrder: PaneId[];
  /**
   * Panes that went from working (or waiting) to idle while the user was in
   * another pane: drawn `unread` until they look (`utils/paneState.ts`).
   */
  unreadPaneIds: PaneId[];
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
  groupSwitchPaneIds: PaneId[];
  /** Command mode state (tmux command prompt) */
  commandMode: {
    prompt: string;
    input: string;
    template: string | null;
  } | null;
  /** The client's own temporary status on the status line ("Copied …") */
  statusMessage: { text: string; timestamp: number } | null;
  /** Snackbar entries on screen, oldest first (see AppNotification) */
  notifications: AppNotification[];
  /** Current theme name */
  themeName: string;
  /** Current theme mode: a palette, or `auto` for the operating system's */
  themeMode: ThemeMode;
  /** Available themes from server */
  availableThemes: ThemeInfo[];
  /**
   * Local action tracing as the backend last reported it, or null before the
   * Debug menu has asked. Never assumed from the client side: an enable can be
   * refused by a kill switch, so the UI renders the backend's answer.
   */
  traceSettings: TraceSettings | null;
  /** Whether the app container is focused (for keyboard capture gating) */
  appFocused: boolean;
  /** Whether the tmux prefix key has been pressed and we're awaiting a binding key */
  prefixActive: boolean;
  /** While the prefix is a repeat window, the only keys it still takes. */
  prefixRepeatOnly: readonly string[] | null;
  /** The sticky key table in force — `pane`, `tab` — or null (keyboardActor). */
  keyTable: string | null;
  /** Whether the keys view (`prefix ?`) is open. */
  keysViewOpen: boolean;
  /** The pane whose rename field is open in its header, if any. */
  renamingPaneId: PaneId | null;
  /** Base font size for terminal text in pixels */
  baseFontSize: number;
  /** Timestamp of last layout command (for debouncing rapid layout changes) */
  lastLayoutCommandTime: number;
  /** Temporarily suppress layout transitions (e.g., command-based resize) */
  suppressLayoutTransition: boolean;
  /**
   * Whether the last model update was a geometry change we chose to animate.
   * The quiet update that follows one must not re-latch the suppression, or
   * the transition would be cut off a frame in.
   */
  lastUpdateAnimated: boolean;
  /** Maps real pane tmuxId → stable React key (placeholder ID it morphed from).
   *  Prevents unmount/remount flicker when optimistic placeholders are replaced
   *  by server-confirmed panes. */
  paneKeyOverrides: Record<PaneId, PaneId>;
  /** Per-window most-recently-active pane ID, populated from server state and
   *  used by SELECT_TAB to pick the optimistic focus when switching tabs. */
  lastActivePaneByWindow: Record<WindowId, PaneId>;
  /**
   * All tmux sessions on the current server, for the sidebar sessions→tabs→panes
   * tree. Populated by the `serversActor` poll on web + desktop; stays `[]` on
   * the single-session in-browser sandboxes (demo, v86), which then render the
   * classic single-session flat tree.
   */
  sessions: SessionTreeNode[];
  /**
   * Git repositories discovered from the panes' working directories, refreshed
   * by the `serversActor` poll alongside `sessions`; `[]` on the sandboxes and
   * for SSH-backed servers (their pane paths are remote).
   */
  repositories: GitRepository[];
  /**
   * Saved tmux servers (localhost plus anything added through the session
   * switcher) and which one is attached. Empty on web, which has no server
   * list of its own.
   */
  servers: TmuxServer[];
  currentServerId: string | null;
  /** Sessions a snapshot could bring back; see {@link RestorableSession}. */
  restorableSessions: RestorableSession[];
}
