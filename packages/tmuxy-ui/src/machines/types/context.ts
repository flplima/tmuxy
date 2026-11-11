import type { ActivityRow } from '../../domain/activity';
import type { PushState } from '../../infra/pushNotifications';
import type { CopyModeState } from '../../domain/copyMode';
import type { PluginInfo } from '../../domain/plugins';
import type { TmuxPane, TmuxWindow, PaneGroup } from '../../domain/client';
import type { KeyBindings, ProcessIcons, SizePolicy } from '../../domain/wire';
import type { GridCell } from '../../domain/gridFit';
import type { ThemeInfo, ThemeMode, TraceSettings } from '../../domain/wireSettings';
import type { AskAnswer } from '../../domain/paneAsk';
import type { GroupId, PaneId, WindowId } from '../../domain/ids';
import type {
  AppNotification,
  BottomView,
  DragState,
  FloatPaneState,
  GestureFlags,
  GestureState,
  KeyboardOwner,
  LogEntry,
  ResizeState,
  SidebarSide,
  SidebarState,
} from './domain';
import type {
  GitRepository,
  RestorableSession,
  SessionTreeNode,
  TmuxServer,
} from '../../domain/servers';

export interface AppMachineContext {
  connected: boolean;
  error: string | null;
  /**
   * Set when the backend gave up reconnecting (e.g. tmux server unavailable
   * after MAX_CONSECUTIVE_FAILURES attempts). Terminal: no further events
   * will arrive on this monitor.
   */
  fatalError: string | null;
  /** Recent commands sent and errors received: the connection overlay's Details. */
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
  /**
   * The size actor has measured the viewport: `targetCols`/`targetRows` are
   * this client's, not the defaults. The state is fetched at that size.
   */
  viewportMeasured: boolean;
  drag: DragState | null;
  resize: ResizeState | null;
  resizeActive: boolean;
  charWidth: number;
  charHeight: number;
  /** letter-spacing (px) that pads the font's natural advance up to charWidth. */
  cellGap: number;
  /**
   * The pane grid's own font size in px when it differs from the chrome's —
   * the phone layout's shrunken cell (infra/dom/phoneLayout.ts), or a cell fitted
   * to a grid `@tmuxy-size` sized for someone else (domain/gridFit.ts). Null
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
  /** The phone layout (infra/dom/phoneLayout.ts): the terminal, a key row and the tree below it. */
  phoneLayout: boolean;
  /** The phone layout held sideways: the terminal right, the strip, keys and tree left of it. */
  phoneLandscape: boolean;
  /** The server machine's name, from its greeting; null until it says. */
  serverHostname: string | null;

  containerWidth: number;
  containerHeight: number;
  floatPanes: Record<PaneId, FloatPaneState>;
  /**
   * Who holds the keyboard. A float or the dock takes the keystrokes typed;
   * the tree (left) drives its widget (j/k/Enter/l/q) instead of a pane.
   */
  keyboardOwner: KeyboardOwner;
  /** The two sidebar columns: the tree (left) and the pinned terminal (right). */
  sidebars: Record<SidebarSide, SidebarState>;
  /**
   * A sidebar column width being previewed while its divider is dragged, in
   * columns (null = the default). Drawn immediately; the tmux option is written
   * on release and the preview is dropped once the server reports that width.
   */
  sidebarColsPreview: { side: SidebarSide; cols: number | null } | null;
  /**
   * The dock size last written to its window (`@tmuxy-sidebar-rows`, and
   * `@tmuxy-sidebar-cols` when the phone's bottom view sized it), and for
   * which window: the one record behind the one writer, `sidebars_syncDockSize`.
   */
  dockSizeSent: { windowId: WindowId; cols: number | null; rows: number } | null;

  /**
   * The phone's browser-side zoom (the `phone` slice, domain/phoneSplit.ts):
   * the terminal's scale, 1 at its own size. Set by the bar between the
   * terminal and the bottom view, or a double tap; panned with a
   * finger when it is past 1. Kept per device.
   */
  phoneZoom: number;
  /** Where the last double tap zoomed in (client px; null for the middle, or none). */
  phoneZoomAt: { x: number | null; y: number | null } | null;
  /** Upright, the terminal and the keys folded away under a dragged-up bar. Kept per device. */
  phoneCollapsed: boolean;
  /** What the phone shows under the keys: the menu, the tree, or the pinned terminal (the dock). */
  phoneBottomView: BottomView;
  /**
   * The phone's bottom view, measured in the dock's cells: the size the dock's
   * pane is given while a phone draws it there. Null before it is measured.
   */
  phoneDockView: { cols: number; rows: number } | null;
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
   * The closed column shown for a moment over the panes while the pointer
   * rests on its header toggle or on the column itself (a peek, the way
   * a collapsed sidebar comes out on hover in the Claude desktop app). It
   * covers the panes rather than docking beside them, so the grid keeps its
   * size and tmux re-tiles nothing. Null when no column is peeking.
   */
  sidebarPeek: 'left' | 'right' | null;
  /**
   * The Tab Overview (ctrl+0): every tab as a slot over the pane area, the
   * current one zoomed out into its slot. `tabOverviewSelected` is the keyboard
   * cursor over the slots in strip order, the last index being the "+" slot.
   */
  tabOverviewOpen: boolean;
  tabOverviewSelected: number;
  /** The tab whose rename field is open, and where: the strip or the tree. */
  renamingTab: { windowId: WindowId; surface: 'strip' | 'tree' } | null;
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
  /** Whether tmuxy.conf lets the server push notifications (`@tmuxy-notify`). */
  notifyAllowed: boolean;
  /** Whether this device gets them (infra/pushNotifications.ts). */
  pushState: PushState;
  /**
   * The config's `@tmuxy-icon-<process>` icons: ASCII text, or an SVG as a
   * `data:` URL (components/PaneIcon.tsx).
   */
  processIcons: ProcessIcons;
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
  keybindings: KeyBindings | null;
  copyModeStates: Record<PaneId, CopyModeState>;
  /**
   * When this client last left copy mode on each pane: tmux can still report
   * the mode on for a beat after, and inside COPY_MODE_REENTRY_COOLDOWN that
   * report is not a new entry.
   */
  copyModeExitedAt: Record<PaneId, number>;
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
   * Pane IDs involved in in-flight GroupSwitch store ops, mirrored from
   * `model.ops` on every TMUX_MODEL_UPDATE so selectors can suppress CSS
   * transitions on the swapped panes while the swap is unconfirmed. The
   * geometry itself is the op's optimistic patch (`predictGroupSwitch` in
   * domain/store/windowOps.ts).
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
  themeName: string;
  /** Current theme mode: a palette, or `auto` for the operating system's */
  themeMode: ThemeMode;
  availableThemes: ThemeInfo[];
  /**
   * Local action tracing as the backend last reported it, or null before the
   * Debug menu has asked. Never assumed from the client side: an enable can be
   * refused by a kill switch, so the UI renders the backend's answer.
   */
  traceSettings: TraceSettings | null;
  /** The installed plugins' menu actions (`domain/plugins.ts`). */
  plugins: ReadonlyArray<PluginInfo>;
  /** The `@tmuxy-plugins-rev` `plugins` was read at; `''` before any. */
  pluginsRev: string;
  /** The `<theme>:<mode>` tmux last said, `''` before the first state. */
  themeRev: string;
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
  /** The activity inbox is up. */
  activityOpen: boolean;
  /** Every pane that declared a state, most urgent first, as last read. */
  activityRows: readonly ActivityRow[];
  /** The pane whose rename field is open in its header, if any. */
  renamingPaneId: PaneId | null;
  /** Base font size for terminal text in pixels */
  baseFontSize: number;
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
