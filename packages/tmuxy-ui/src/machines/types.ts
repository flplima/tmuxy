/**
 * Machine Types
 *
 * All type definitions for state machines and their events.
 */

import type { TmuxPane, TmuxWindow, ServerState, KeyBindings, KeyBinding, CopyModeState } from '../tmux/types';

// Re-export domain types
export type { TmuxPane, TmuxWindow, ServerState, KeyBindings, KeyBinding, CopyModeState };

// ============================================
// Shared State Types
// ============================================

/** Pane group - groups panes that share the same visual position (like tabs) */
export interface PaneGroup {
  id: string;
  paneIds: string[];  // Tab order - active pane is derived from which pane is in activeWindowId
}

/** Float pane state */
export interface FloatPaneState {
  /** Pane ID (e.g., "%5") */
  paneId: string;
  /** Size in pixels */
  width: number;
  height: number;
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
  paneGroups: Record<string, PaneGroup>;
  floatPanes: Record<string, FloatPaneState>;
  activeWindowId: string | null;
  activePaneId: string | null;
  totalWidth: number;
  totalHeight: number;
  sessionName: string;
  statusLine: string;
}

/** Stored pane group state (persisted in tmux environment) */
export interface TmuxyGroupsEnv {
  version: number;
  groups: Record<string, { id: string; paneIds: string[] }>;
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
  paneGroups: Record<string, PaneGroup>;
  /** Stored group state from tmux environment (source of truth for persistence) */
  paneGroupsEnv: TmuxyGroupsEnv;
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
  /** Float pane positions and states (keyed by pane ID) */
  floatPanes: Record<string, FloatPaneState>;
  /** Whether browser-side animations are enabled */
  enableAnimations: boolean;
  /** Keybindings received from the server */
  keybindings: KeyBindings | null;
  /** Client-side copy mode state per pane */
  copyModeStates: Record<string, CopyModeState>;
  /** Current optimistic operation being applied (awaiting server confirmation) */
  optimisticOperation: OptimisticOperation | null;
  /** Override during group switch (prevents intermediate state flicker) */
  groupSwitchDimOverride: {
    paneId: string;
    fromPaneId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    timestamp: number;
  } | null;
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
export type KeybindingsReceivedEvent = { type: 'KEYBINDINGS_RECEIVED'; keybindings: KeyBindings };
export type PaneGroupsLoadedEvent = { type: 'PANE_GROUPS_LOADED'; groupsJson: string | null };

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
export type SendTmuxCommandEvent = { type: 'SEND_TMUX_COMMAND'; command: string };
export type CopySelectionEvent = { type: 'COPY_SELECTION' };

// Copy mode events
export type EnterCopyModeEvent = { type: 'ENTER_COPY_MODE'; paneId: string; scrollLines?: number };
export type ExitCopyModeEvent = { type: 'EXIT_COPY_MODE'; paneId: string };
export type CopyModeChunkLoadedEvent = { type: 'COPY_MODE_CHUNK_LOADED'; paneId: string; cells: import('../tmux/types').PaneContent; start: number; end: number; historySize: number; width: number };
export type CopyModeCursorMoveEvent = { type: 'COPY_MODE_CURSOR_MOVE'; paneId: string; row: number; col: number; relative?: boolean };
export type CopyModeSelectionStartEvent = { type: 'COPY_MODE_SELECTION_START'; paneId: string; mode: 'char' | 'line'; row: number; col: number };
export type CopyModeSelectionClearEvent = { type: 'COPY_MODE_SELECTION_CLEAR'; paneId: string };
export type CopyModeScrollEvent = { type: 'COPY_MODE_SCROLL'; paneId: string; scrollTop: number };
export type CopyModeYankEvent = { type: 'COPY_MODE_YANK'; paneId: string };
export type CopyModeKeyEvent = { type: 'COPY_MODE_KEY'; key: string; ctrlKey: boolean; shiftKey: boolean };
export type CopyModeWordSelectEvent = { type: 'COPY_MODE_WORD_SELECT'; paneId: string; row: number; col: number };

// Group switch detection event (fired internally when switch detected in state update)
export type ClearGroupSwitchOverrideEvent = { type: 'CLEAR_GROUP_SWITCH_OVERRIDE' };
export type EnableAnimationsEvent = { type: 'ENABLE_ANIMATIONS' };


/** All events the app machine can receive from external sources */
export type AppMachineEvent =
  | TmuxConnectedEvent
  | TmuxStateUpdateEvent
  | TmuxErrorEvent
  | TmuxDisconnectedEvent
  | ConnectionInfoEvent
  | KeybindingsReceivedEvent
  | PaneGroupsLoadedEvent
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
  | ClearGroupSwitchOverrideEvent
  | EnableAnimationsEvent;

/** All events the app machine handles (external + child machine events) */
export type AllAppMachineEvents = AppMachineEvent | ChildMachineEvent;

// ============================================
// Optimistic Update Types
// ============================================

/** Optimistic operation tracking for instant UI feedback */
export interface OptimisticOperation {
  id: string;
  type: 'split' | 'navigate' | 'swap';
  command: string;
  timestamp: number;
  prediction: OptimisticPrediction;
}

export type OptimisticPrediction =
  | SplitPrediction
  | NavigatePrediction
  | SwapPrediction;

export interface SplitPrediction {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  targetPaneId: string;
  newPane: {
    placeholderId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    windowId: string;
  };
  resizedPanes: Array<{
    paneId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface NavigatePrediction {
  type: 'navigate';
  direction: 'L' | 'R' | 'U' | 'D';
  fromPaneId: string;
  toPaneId: string;
}

export interface SwapPrediction {
  type: 'swap';
  sourcePaneId: string;
  targetPaneId: string;
  sourceNewPosition: { x: number; y: number; width: number; height: number };
  targetNewPosition: { x: number; y: number; width: number; height: number };
}

