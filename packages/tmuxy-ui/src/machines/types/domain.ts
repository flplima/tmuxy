import type { TmuxPane, TmuxWindow } from '../../domain/client';
import type { GroupId, PaneId, WindowId } from '../../domain/ids';
import type { Side, TmuxOp } from '../../domain/commands';
import type { TabDrop, TabStripGeometry } from '../../utils/tabStripDrop';
import type { GroupDrop } from '../../utils/groupDrop';

// ============================================
// Shared State Types
// ============================================

/** Pane group - groups panes that share the same visual position (like tabs) */
export interface PaneGroup {
  id: GroupId;
  paneIds: PaneId[]; // Tab order - active pane is derived from which pane is in activeWindowId
}

/** Drawer direction for float panes docked to an edge */
export type DrawerDirection = 'left' | 'right' | 'top' | 'bottom';

/** Backdrop style for float panes */
export type FloatBackdrop = 'dim' | 'blur' | 'none';

/** Float pane state */
export interface FloatPaneState {
  /** Pane ID (e.g., "%5") */
  paneId: PaneId;
  /**
   * The tab the float belongs to (`@tmuxy-float-parent`), or null when its
   * window carries no parent. A float is only shown while that tab is the
   * active one: it was opened over a tab, so it is that tab's overlay and must
   * not reappear over the next one. A float whose parent window is gone is
   * orphaned and shown anywhere, so closing a tab can never hide it for good.
   */
  parentWindowId: WindowId | null;
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
  draggedPaneId: PaneId;
  targetPaneId: PaneId | null;
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
  /**
   * Where on the tab strip the pointer is, if it is there at all. While this
   * is set the drag has left the grid: no pane swaps, and releasing moves the
   * pane to that tab (or into a tab of its own). The tab strip reads it to
   * light up the tab under the pointer.
   */
  tabDrop: TabDrop | null;
  /**
   * Over a pane header: the place in a group the pane would take on release
   * (reorder within its group, or join another pane's). The header reads it
   * to show where.
   */
  groupDrop: GroupDrop | null;
  /**
   * A parked group member, dragged by its tab: it is not on screen, so nothing
   * swaps; released over a pane it leaves the group beside it (`leaveSide`).
   */
  memberDrag: boolean;
  leaveSide: Side | null;
}

/** A pane's box in cells, as the resize snapshot and the limits see it. */
export interface PaneCellBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which edge of a pane a drag is moving. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w';

/**
 * How far the current drag may travel, in cells, signed the way the pointer
 * moves: negative is left/up, positive is right/down. Both ends are what the
 * panes being shrunk can still give before one of them would go below a
 * single cell, which is where tmux stops.
 */
export interface ResizeLimits {
  min: number;
  max: number;
}

export interface ResizeState {
  paneId: PaneId;
  handle: ResizeHandle;
  startX: number;
  startY: number;
  /**
   * Every pane's geometry at resize start, keyed by id. A resize moves a whole
   * BAND of panes together (all sharing the dragged edge), and tmux's
   * intermediate %layout-change events during the drag are internally
   * inconsistent (a pane's y flips 0/1 as the border row flickers). The preview
   * and the settled check both rebuild the band from this frozen snapshot
   * instead of the live server panes (machines/resize/limits.ts), so nothing
   * wobbles.
   */
  originalGeometry: Record<PaneId, PaneCellBox>;
  /**
   * The part of `originalGeometry` this drag can move: the two cells of the
   * window's layout tree that the divider separates (`bandScope` in
   * machines/resize/limits.ts). The band, the limits and the settled check
   * are all computed from it.
   */
  bandGeometry: Record<PaneId, PaneCellBox>;
  /**
   * How far this drag may travel before tmux would refuse it. Computed once
   * from the frozen geometry (machines/resize/limits.ts) and applied to the
   * delta, so the preview and the commands agree and neither can draw or ask
   * for a layout that cannot exist.
   */
  limits: ResizeLimits;
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
// App Machine Domain Types
// ============================================

/** An error the user has to see, or a message tmux showed them (`display-message`). */
export type NotificationKind = 'error' | 'info';

/**
 * A snackbar entry in the top-right of the app chrome, shown until dismissed
 * or aged out: an error, or a tmux message. The status line keeps only the
 * client's own status ("Copied …").
 */
export interface AppNotification {
  id: number;
  text: string;
  kind: NotificationKind;
  timestamp: number;
}

/** Log entry shown on the connecting/error status screen for debugging */
export interface LogEntry {
  timestamp: number;
  kind: 'command' | 'output' | 'error' | 'info';
  message: string;
}

/**
 * A lightweight window in another session's subtree (sidebar sessions tree).
 * Only the fields needed to render and switch — not a full {@link TmuxWindow}.
 */
export interface SessionTreeWindow {
  id: WindowId;
  index: number;
  name: string;
}

/** A lightweight pane in another session's subtree. */
export interface SessionTreePane {
  id: PaneId;
  windowId: WindowId;
  command: string;
  /** App-set pane title (OSC 0/2); empty when the app never set one. */
  title: string;
  /** Working directory tmux reports for the pane (`#{pane_current_path}`). */
  cwd: string;
  active: boolean;
}

/**
 * One checkout of a repository as `git worktree list` reports it — the wire
 * shape of `tmuxy-core/src/worktrees.rs`, discovered by the host from the cwd
 * of every pane and shown as a branch badge in the sidebar tree.
 */
export interface GitWorktree {
  path: string;
  /** Absent for a detached HEAD and for a bare repository. */
  branch?: string;
  head: string;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitRepository {
  id: string;
  name: string;
  root: string | null;
  worktrees: GitWorktree[];
}

/**
 * SSH details for a remote tmux server — the wire shape of
 * `tmuxy-core/src/servers.rs`.
 *
 * Deliberately thin. tmuxy runs the system `ssh` binary rather than speaking
 * the protocol itself, so `~/.ssh/config` supplies User, Port, IdentityFile,
 * ProxyJump, agent and 2FA behaviour for free; `host` can be any alias that
 * file defines. `options` is the escape hatch for a raw flag.
 */
export interface TmuxSshConfig {
  host: string;
  user?: string | null;
  port?: number | null;
  options?: string | null;
}

export type ServerReachability = 'online' | 'known' | 'offline';

export type ProbeStageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ProbeStage {
  name: string;
  label: string;
  status: ProbeStageStatus;
  elapsed_ms?: number | null;
  error?: string | null;
}

export interface RemoteSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
}

export interface ServerProbeState {
  server: TmuxServer;
  status: 'running' | 'done' | 'failed';
  stages: ProbeStage[];
  sessions: RemoteSessionInfo[];
}

/** A saved tmux server: a socket on this machine, or one reached over SSH. */
export interface TmuxServer {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  ssh?: TmuxSshConfig | null;
  /** tmux socket name (`-L`), or a path when it contains a `/` (`-S`). */
  socket: string;
  /** Preferred session to attach to on this server, if any. */
  session?: string | null;
  /** Last time this server was connected or probed (unix seconds). */
  last_used?: number | null;
  /** Reachability status reported by the server list or probe. */
  reachable?: ServerReachability | null;
  /** Number of sessions discovered on this server, if known. */
  session_count?: number | null;
}

/**
 * One tmux session as shown in the sidebar's sessions→tabs→panes tree.
 *
 * Populated by the `serversActor` poll (`list-windows -a` / `list-panes -a`) on
 * both the web and desktop builds, so a client attached to a multi-session
 * socket lists all of them. Empty on the single-session in-browser sandboxes
 * (demo, v86), which render the classic flat tab/pane tree. The active
 * session's subtree is drawn from live state, not this summary.
 */
export interface SessionTreeNode {
  sessionName: string;
  windows: SessionTreeWindow[];
  panes: SessionTreePane[];
}

/**
 * A session that has a snapshot to be rebuilt from (`session_snapshot`), and
 * when it was last saved (unix seconds). Listed by the same poll as the
 * sessions, so the switcher can offer what is not running beside what is.
 */
export interface RestorableSession {
  name: string;
  savedAt: number;
}

/** The trackpad gestures tmuxy.conf allows. */
export interface GestureFlags {
  swipeTabs: boolean;
  pinchZoom: boolean;
  pinchOverview: boolean;
}

/**
 * A gesture in progress.
 *
 * A slide carries how far the pane grid is drawn from rest and the tab drawn
 * beside it (null past either end of the strip, where the grid only gives a
 * little).
 *
 * `tracking`: under the fingers; `dx` is where they have the grid and
 * `neighborId` the tab being pulled in. `cancelling`: released short, sliding
 * back to rest. `finishing`: released past the mark - the tab has ALREADY
 * switched, so `dx` is where the grid has to be put back to keep the picture
 * still (the new tab's panes now sit at rest, where they were being drawn) and
 * `neighborId` is the tab just left, sliding out.
 *
 * A pinch carries its cumulative scale, what it will do when the fingers lift
 * (`enter` is a pinch out of the Tab Overview, back into the current tab) and
 * the pane it acts on. `handoff`: committed to a zoom, with the drawing held
 * where the fingers left it until the new geometry lands in the DOM.
 */
export type GestureState =
  | {
      kind: 'swipe';
      dx: number;
      neighborId: WindowId | null;
      phase: 'tracking' | 'finishing' | 'cancelling';
      /** How long the released slide has to run, from its distance and the speed the fingers had. */
      settleMs: number;
    }
  | {
      kind: 'pinch';
      mode: 'zoom' | 'unzoom' | 'overview' | 'enter';
      scale: number;
      paneId: PaneId;
      phase: 'tracking' | 'handoff';
    };

/** Usefulness↔sensitivity dial for the local action trace (docs/TELEMETRY.md). */
export type TraceLevel = 'shape' | 'labeled' | 'full';

/** The Debug menu's view of local action tracing, as the backend reports it. */
export interface TraceSettings {
  enabled: boolean;
  level: TraceLevel;
  /** File the backend writes to; null when no state dir could be resolved. */
  path: string | null;
  /** A DO_NOT_TRACK / TMUXY_NO_TRACE kill switch forbids turning it on. */
  locked: boolean;
}

// ============================================
// Child Machine Types (Drag & Resize)
// ============================================

/** A key the keyboard actor consumed; the drag and resize machines cancel on Escape. */
export type KeyPressEvent = { type: 'KEY_PRESS'; key: string };

export interface DragMachineContext {
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  containerWidth: number;
  containerHeight: number;
  containerLeft: number;
  containerTop: number;
  /** The tab strip's boxes, measured once when the drag started. */
  tabStrip: TabStripGeometry | null;
  /** The window the dragged pane came from, and how many panes it had. */
  paneWindowId: WindowId | null;
  panesInWindow: number;
  groups: Record<GroupId, PaneGroup>;
  /** The pane the pointer is resting on, waiting out the swap dwell. */
  pendingSwap: string | null;
  drag: DragState | null;
}

export type DragMachineEvent =
  | {
      type: 'DRAG_START';
      paneId: PaneId;
      startX: number;
      startY: number;
      panes: TmuxPane[];
      charWidth: number;
      charHeight: number;
      containerWidth: number;
      containerHeight: number;
      containerLeft: number;
      containerTop: number;
      tabStrip: TabStripGeometry | null;
      paneWindowId: WindowId | null;
      panesInWindow: number;
      groups: Record<GroupId, PaneGroup>;
      memberDrag: boolean;
    }
  | { type: 'DRAG_MOVE'; clientX: number; clientY: number }
  | { type: 'SWAP_DWELL'; paneId: PaneId }
  | { type: 'DRAG_END' }
  | KeyPressEvent;

export interface ResizeMachineContext {
  charWidth: number;
  charHeight: number;
  resize: ResizeState | null;
}

export type ResizeMachineEvent =
  | {
      type: 'RESIZE_START';
      paneId: PaneId;
      handle: ResizeHandle;
      startX: number;
      startY: number;
      panes: TmuxPane[];
      windows: TmuxWindow[];
      charWidth: number;
      charHeight: number;
    }
  | { type: 'RESIZE_MOVE'; clientX: number; clientY: number }
  | { type: 'RESIZE_END' }
  | KeyPressEvent;

/** Events sent from drag machine to parent */
export type DragParentEvent =
  | { type: 'DISPATCH_OP'; op: TmuxOp }
  | { type: 'DRAG_STATE_UPDATE'; drag: DragState | null };

/** Events sent from resize machine to parent */
export type ResizeParentEvent =
  | { type: 'DISPATCH_OP'; op: TmuxOp }
  | { type: 'RESIZE_STATE_UPDATE'; resize: ResizeState | null }
  | { type: 'RESIZE_COMPLETED' };

/** All events from child machines to parent */
export type ChildMachineEvent = DragParentEvent | ResizeParentEvent;
