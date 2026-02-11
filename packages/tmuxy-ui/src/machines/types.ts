/**
 * Machine Types
 *
 * All type definitions for state machines and their events.
 */

import type { TmuxPane, TmuxWindow, TmuxPopup, ServerState } from '../tmux/types';

// Re-export domain types
export type { TmuxPane, TmuxWindow, TmuxPopup, ServerState };

// ============================================
// Shared State Types
// ============================================

/** Pane group - groups panes that share the same visual position (like tabs) */
export interface PaneGroup {
  id: string;
  paneIds: string[];
  activeIndex: number;
}

/** Float pane position and state */
export interface FloatPaneState {
  /** Pane ID (e.g., "%5") */
  paneId: string;
  /** Position in pixels relative to container */
  x: number;
  y: number;
  /** Size in pixels */
  width: number;
  height: number;
  /** Whether this float is pinned (visible even when float view is hidden) */
  pinned: boolean;
}

/** Drag operation state */
export interface DragState {
  draggedPaneId: string;
  targetPaneId: string | null;
  targetNewWindow: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /** Original position of dragged pane (for stable visual tracking during swaps) */
  originalX: number;
  originalY: number;
  originalWidth: number;
  originalHeight: number;
  /** Original position of target pane when first hovered (for stable drop indicator) */
  targetOriginalX: number | null;
  targetOriginalY: number | null;
  targetOriginalWidth: number | null;
  targetOriginalHeight: number | null;
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
}

// ============================================
// App Machine Types
// ============================================

/** Pending state update stored during pane exit animation */
export interface PendingUpdate {
  panes: TmuxPane[];
  windows: TmuxWindow[];
  groups: Record<string, PaneGroup>;
  activeWindowId: string | null;
  activePaneId: string | null;
  totalWidth: number;
  totalHeight: number;
  sessionName: string;
  statusLine: string;
  popup: TmuxPopup | null;
}

export interface AppMachineContext {
  connected: boolean;
  error: string | null;
  sessionName: string;
  activeWindowId: string | null;
  activePaneId: string | null;
  panes: TmuxPane[];
  windows: TmuxWindow[];
  totalWidth: number;
  totalHeight: number;
  groups: Record<string, PaneGroup>;
  targetCols: number;
  targetRows: number;
  drag: DragState | null;
  resize: ResizeState | null;
  charWidth: number;
  charHeight: number;
  /** Connection ID assigned by the server */
  connectionId: number | null;
  /** Tmux status line with ANSI escape codes */
  statusLine: string;
  /** Pending state update during pane exit animation */
  pendingUpdate: PendingUpdate | null;
  /** Container dimensions for centering calculations */
  containerWidth: number;
  containerHeight: number;
  /** Timestamp of last tmux state update (for activity tracking) */
  lastUpdateTime: number;
  /**
   * Active popup (if any)
   * Note: Requires tmux with control mode popup support (PR #4361)
   */
  popup: TmuxPopup | null;
  /** Whether the float view is currently visible */
  floatViewVisible: boolean;
  /** Float pane positions and states (keyed by pane ID) */
  floatPanes: Record<string, FloatPaneState>;
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
  drag: DragState | null;
}

export type DragMachineEvent =
  | { type: 'DRAG_START'; paneId: string; startX: number; startY: number; panes: TmuxPane[]; activePaneId: string | null; charWidth: number; charHeight: number; containerWidth: number; containerHeight: number }
  | { type: 'DRAG_MOVE'; clientX: number; clientY: number }
  | { type: 'DRAG_END' }
  | { type: 'DRAG_CANCEL' }
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
  | { type: 'RESIZE_START'; paneId: string; handle: 'n' | 's' | 'e' | 'w'; startX: number; startY: number; panes: TmuxPane[]; charWidth: number; charHeight: number }
  | { type: 'RESIZE_MOVE'; clientX: number; clientY: number }
  | { type: 'RESIZE_END' }
  | { type: 'RESIZE_CANCEL' }
  | KeyPressEvent
  | { type: 'SEND_RESIZE_COMMAND'; command: string; deltaCols: number; deltaRows: number };

// ============================================
// Child Machine → Parent Events
// ============================================

/** Events sent from drag machine to parent */
export type DragParentEvent =
  | { type: 'SEND_TMUX_COMMAND'; command: string }
  | { type: 'DRAG_STATE_UPDATE'; drag: DragState | null }
  | { type: 'DRAG_COMPLETED' }
  | { type: 'DRAG_ERROR'; error: string };

/** Events sent from resize machine to parent */
export type ResizeParentEvent =
  | { type: 'SEND_TMUX_COMMAND'; command: string }
  | { type: 'RESIZE_STATE_UPDATE'; resize: ResizeState | null }
  | { type: 'RESIZE_COMPLETED' }
  | { type: 'RESIZE_ERROR'; error: string };

/** All events from child machines to parent */
export type ChildMachineEvent = DragParentEvent | ResizeParentEvent;

// ============================================
// App Machine Events (External API)
// ============================================

// Tmux connection events
export type TmuxConnectedEvent = { type: 'TMUX_CONNECTED' };
export type TmuxStateUpdateEvent = { type: 'TMUX_STATE_UPDATE'; state: ServerState };
export type TmuxErrorEvent = { type: 'TMUX_ERROR'; error: string };
export type TmuxDisconnectedEvent = { type: 'TMUX_DISCONNECTED' };
export type ConnectionInfoEvent = { type: 'CONNECTION_INFO'; connectionId: number };

// Drag events
export type DragStartEvent = { type: 'DRAG_START'; paneId: string; startX: number; startY: number };
export type DragMoveEvent = { type: 'DRAG_MOVE'; clientX: number; clientY: number };
export type DragEndEvent = { type: 'DRAG_END' };
export type DragCancelEvent = { type: 'DRAG_CANCEL' };

// Resize events
export type ResizeStartEvent = { type: 'RESIZE_START'; paneId: string; handle: 'n' | 's' | 'e' | 'w'; startX: number; startY: number };
export type ResizeMoveEvent = { type: 'RESIZE_MOVE'; clientX: number; clientY: number };
export type ResizeEndEvent = { type: 'RESIZE_END' };
export type ResizeCancelEvent = { type: 'RESIZE_CANCEL' };

// Keyboard events
export type KeyPressEvent = {
  type: 'KEY_PRESS';
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

// UI config events
export type SetCharSizeEvent = { type: 'SET_CHAR_SIZE'; charWidth: number; charHeight: number };
export type SetTargetSizeEvent = { type: 'SET_TARGET_SIZE'; cols: number; rows: number };
export type SetContainerSizeEvent = { type: 'SET_CONTAINER_SIZE'; width: number; height: number };
export type SetAnimationRootEvent = { type: 'SET_ANIMATION_ROOT'; element: HTMLElement };
export type ObserveContainerEvent = { type: 'OBSERVE_CONTAINER'; element: HTMLElement };
export type StopObserveContainerEvent = { type: 'STOP_OBSERVE_CONTAINER' };

// Animation events from animation actor
export type AnimationLeaveCompleteEvent = { type: 'ANIMATION_LEAVE_COMPLETE' };
export type AnimationDragCompleteEvent = { type: 'ANIMATION_DRAG_COMPLETE' };

// Pane events
export type FocusPaneEvent = { type: 'FOCUS_PANE'; paneId: string };
export type SendCommandEvent = { type: 'SEND_COMMAND'; command: string };
export type SendKeysEvent = { type: 'SEND_KEYS'; paneId: string; keys: string };

// Pane group events
export type PaneGroupAddEvent = { type: 'PANE_GROUP_ADD'; paneId: string };
export type PaneGroupSwitchEvent = { type: 'PANE_GROUP_SWITCH'; groupId: string; paneId: string };
export type PaneGroupCloseEvent = { type: 'PANE_GROUP_CLOSE'; groupId: string; paneId: string };

// Float events
export type ToggleFloatViewEvent = { type: 'TOGGLE_FLOAT_VIEW' };
export type CreateFloatEvent = { type: 'CREATE_FLOAT' };
export type ConvertToFloatEvent = { type: 'CONVERT_TO_FLOAT'; paneId: string };
export type EmbedFloatEvent = { type: 'EMBED_FLOAT'; paneId: string };
export type PinFloatEvent = { type: 'PIN_FLOAT'; paneId: string };
export type UnpinFloatEvent = { type: 'UNPIN_FLOAT'; paneId: string };
export type MoveFloatEvent = { type: 'MOVE_FLOAT'; paneId: string; x: number; y: number };
export type ResizeFloatEvent = { type: 'RESIZE_FLOAT'; paneId: string; width: number; height: number };
export type CloseFloatEvent = { type: 'CLOSE_FLOAT'; paneId: string };

/** All events the app machine can receive from external sources */
export type AppMachineEvent =
  | TmuxConnectedEvent
  | TmuxStateUpdateEvent
  | TmuxErrorEvent
  | TmuxDisconnectedEvent
  | ConnectionInfoEvent
  | DragStartEvent
  | DragMoveEvent
  | DragEndEvent
  | DragCancelEvent
  | ResizeStartEvent
  | ResizeMoveEvent
  | ResizeEndEvent
  | ResizeCancelEvent
  | KeyPressEvent
  | SetCharSizeEvent
  | SetTargetSizeEvent
  | SetContainerSizeEvent
  | SetAnimationRootEvent
  | ObserveContainerEvent
  | StopObserveContainerEvent
  | AnimationLeaveCompleteEvent
  | AnimationDragCompleteEvent
  | FocusPaneEvent
  | SendCommandEvent
  | SendKeysEvent
  | PaneGroupAddEvent
  | PaneGroupSwitchEvent
  | PaneGroupCloseEvent
  | ToggleFloatViewEvent
  | CreateFloatEvent
  | ConvertToFloatEvent
  | EmbedFloatEvent
  | PinFloatEvent
  | UnpinFloatEvent
  | MoveFloatEvent
  | ResizeFloatEvent
  | CloseFloatEvent;

/** All events the app machine handles (external + child machine events) */
export type AllAppMachineEvents = AppMachineEvent | ChildMachineEvent;
