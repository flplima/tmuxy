import type { TmuxPane, TmuxWindow, ServerState } from '../tmux/types';

// Re-export domain types
export type { TmuxPane, TmuxWindow, ServerState };

// ============================================
// App Machine Context
// ============================================

// Pane stack - groups panes that share the same visual position (like tabs)
export interface PaneStack {
  id: string; // Stack ID (usually the first pane's tmuxId)
  paneIds: string[]; // tmuxIds of panes in this stack
  activeIndex: number; // Index of the active pane in the stack
}

export interface DragState {
  draggedPaneId: string;
  targetPaneId: string | null;
  targetNewWindow: boolean; // True when dragging over status bar to create new window
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export interface ResizeState {
  paneId: string;
  handle: 'n' | 's' | 'e' | 'w';
  startX: number;
  startY: number;
  originalPane: TmuxPane;
  /** Raw pixel offset from start position - follows cursor freely */
  pixelDelta: { x: number; y: number };
  /** Grid-snapped delta in cols/rows - calculated on mouse release */
  delta: { cols: number; rows: number };
}

export interface AppMachineContext {
  // Connection
  connected: boolean;
  error: string | null;

  // Tmux state (from server)
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

  // Preview panes (computed from panes + drag/resize state)
  // Updated in real-time during drag/resize operations
  previewPanes: TmuxPane[];

  // Pane stacks - groups of panes that share the same visual position
  // Key is stack ID (parent pane ID), value is the stack info
  // Stacks are computed from window names on each state update
  stacks: Record<string, PaneStack>;

  // UI target dimensions (source of truth - what we want tmux to be)
  targetCols: number;
  targetRows: number;

  // Drag state (only present in dragging/committingDrag states)
  drag: DragState | null;

  // Resize state (only present in resizing/committingResize states)
  resize: ResizeState | null;

  // Command input for command mode
  commandInput: string;

  // UI config
  charWidth: number;
  charHeight: number;
}

// ============================================
// App Machine Events
// ============================================

// Tmux connection events
export type TmuxConnectedEvent = {
  type: 'TMUX_CONNECTED';
};

export type TmuxStateUpdateEvent = {
  type: 'TMUX_STATE_UPDATE';
  state: ServerState;
};

export type TmuxErrorEvent = {
  type: 'TMUX_ERROR';
  error: string;
};

export type TmuxDisconnectedEvent = {
  type: 'TMUX_DISCONNECTED';
};

// Drag events
export type DragStartEvent = {
  type: 'DRAG_START';
  paneId: string;
  startX: number;
  startY: number;
};

export type DragMoveEvent = {
  type: 'DRAG_MOVE';
  clientX: number;
  clientY: number;
};

export type DragEndEvent = {
  type: 'DRAG_END';
};

export type DragCancelEvent = {
  type: 'DRAG_CANCEL';
};

// Resize events
export type ResizeStartEvent = {
  type: 'RESIZE_START';
  paneId: string;
  handle: 'n' | 's' | 'e' | 'w';
  startX: number;
  startY: number;
};

export type ResizeMoveEvent = {
  type: 'RESIZE_MOVE';
  clientX: number;
  clientY: number;
};

export type ResizeEndEvent = {
  type: 'RESIZE_END';
};

export type ResizeCancelEvent = {
  type: 'RESIZE_CANCEL';
};

// Keyboard events
export type KeyPressEvent = {
  type: 'KEY_PRESS';
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

// Command mode events
export type CommandModeEnterEvent = {
  type: 'COMMAND_MODE_ENTER';
};

export type CommandModeExitEvent = {
  type: 'COMMAND_MODE_EXIT';
};

export type CommandInputEvent = {
  type: 'COMMAND_INPUT';
  value: string;
};

export type CommandSubmitEvent = {
  type: 'COMMAND_SUBMIT';
};

// UI config events
export type SetCharSizeEvent = {
  type: 'SET_CHAR_SIZE';
  charWidth: number;
  charHeight: number;
};

// Set target window size (UI is source of truth)
export type SetTargetSizeEvent = {
  type: 'SET_TARGET_SIZE';
  cols: number;
  rows: number;
};

// Pane focus event
export type FocusPaneEvent = {
  type: 'FOCUS_PANE';
  paneId: string;
};

// Send tmux command
export type SendCommandEvent = {
  type: 'SEND_COMMAND';
  command: string;
};

// Send keys to tmux
export type SendKeysEvent = {
  type: 'SEND_KEYS';
  paneId: string;
  keys: string;
};

// Stack events
export type StackAddPaneEvent = {
  type: 'STACK_ADD_PANE';
  paneId: string; // The pane to add a new stacked pane to
};

export type StackSwitchEvent = {
  type: 'STACK_SWITCH';
  stackId: string;
  paneId: string; // The pane to switch to
};

export type StackClosePaneEvent = {
  type: 'STACK_CLOSE_PANE';
  stackId: string;
  paneId: string;
};

// Union of all events
export type AppMachineEvent =
  | TmuxConnectedEvent
  | TmuxStateUpdateEvent
  | TmuxErrorEvent
  | TmuxDisconnectedEvent
  | DragStartEvent
  | DragMoveEvent
  | DragEndEvent
  | DragCancelEvent
  | ResizeStartEvent
  | ResizeMoveEvent
  | ResizeEndEvent
  | ResizeCancelEvent
  | KeyPressEvent
  | CommandModeEnterEvent
  | CommandModeExitEvent
  | CommandInputEvent
  | CommandSubmitEvent
  | SetCharSizeEvent
  | SetTargetSizeEvent
  | FocusPaneEvent
  | SendCommandEvent
  | SendKeysEvent
  | StackAddPaneEvent
  | StackSwitchEvent
  | StackClosePaneEvent;

// ============================================
// Actor Types
// ============================================

export interface TmuxActorInput {
  onConnected: () => void;
  onStateUpdate: (state: ServerState) => void;
  onError: (error: string) => void;
  onDisconnected: () => void;
}

export interface TmuxActorRef {
  sendCommand: (command: string) => Promise<void>;
  sendKeys: (paneId: string, keys: string) => Promise<void>;
}

export interface KeyboardActorInput {
  onKeyPress: (event: KeyPressEvent) => void;
}
