import type { PaneGroup, TmuxPane, TmuxWindow } from '../../domain/client';
import type { GroupId, PaneId, WindowId } from '../../domain/ids';
import type { Side, TmuxOp } from '../../domain/commands';
import type { TabDrop, TabStripGeometry } from '../drag/tabStripDrop';
import type { GroupDrop } from '../drag/groupDrop';
import type { GridOffset } from '../../domain/paneGeometry';

/** A sidebar column: the tree on the left, the pinned terminal (the dock) on the right. */
export type SidebarSide = 'left' | 'right';

/**
 * What the phone shows under the keys: the app menu, the tabs/panes tree, or
 * the pinned terminal (the dock). The order the views are laid out in, left
 * to right, is the bottom view's (components/phone/bottomSlide.ts).
 */
export type BottomView = 'menu' | 'tree' | 'dock';

/**
 * Who holds the keyboard: the tiled panes (the active pane), or one surface
 * over or beside them — a float, or a sidebar column's pane. Exactly one does,
 * so taking it is all a surface does to release the others.
 */
export type KeyboardOwner =
  | { readonly kind: 'panes' }
  | { readonly kind: 'float' | SidebarSide; readonly paneId: PaneId };

/** One sidebar column's state on this client. */
export interface SidebarState {
  /**
   * Whether the column is shown. Its pane lives in a `sidebar-<side>`-typed
   * window; closing hides the column (`@tmuxy-sidebar-hidden` on its window)
   * and keeps that pane, so the choice survives a reload and reaches every
   * other client.
   */
  readonly open: boolean;
  /**
   * This client asked tmux to create the column's pane and is waiting for it.
   * Cleared when the pane appears, or by SIDEBAR_START_TIMEOUT when it never
   * does: then the start failed rather than a user closing it.
   */
  readonly starting: boolean;
  /**
   * The column was asked to open but its pane never appeared (the start
   * command failed on this server). The column shows why instead of
   * "starting…" forever.
   */
  readonly startFailed: boolean;
}

/** Drawer direction for float panes docked to an edge */
export type DrawerDirection = 'left' | 'right' | 'top' | 'bottom';

export type FloatBackdrop = 'dim' | 'blur' | 'none';

export interface FloatPaneState {
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
  hideHeader?: boolean;
  /** Minimized to the queue at the bottom of its tab (`@tmuxy-float-minimized`): not drawn. */
  minimized?: boolean;
}

export interface DragState {
  draggedPaneId: PaneId;
  targetPaneId: PaneId | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /**
   * Where the grid sat in the pane container when the drag started. The hit
   * test and PaneLayout both place the panes from it for the whole drag: the
   * dragged pane is drawn at its original box while tmux swaps it, so the
   * drawn panes' extent (and its centring) changes under the pointer.
   */
  origin: GridOffset;
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

/** An entry of the log the connection overlay shows under Details. */
export interface LogEntry {
  timestamp: number;
  kind: 'command' | 'output' | 'error' | 'info';
  message: string;
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

/** A key the keyboard actor consumed; the drag and resize machines cancel on Escape. */
export type KeyPressEvent = { type: 'KEY_PRESS'; key: string };

export interface DragMachineContext {
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  containerWidth: number;
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
