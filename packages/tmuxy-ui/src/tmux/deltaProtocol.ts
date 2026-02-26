import type {
  ServerState,
  ServerPane,
  ServerWindow,
  ServerDelta,
  PaneDelta,
  WindowDelta,
  StateUpdate,
} from './types';

/**
 * Handle a StateUpdate (full or delta), returning the new state.
 * Returns null if a delta arrives before any full state.
 */
export function handleStateUpdate(
  update: StateUpdate,
  currentState: ServerState | null,
): ServerState | null {
  if (update.type === 'full') {
    return update.state;
  }

  if (currentState === null) {
    console.warn('Received delta before full state, ignoring');
    return null;
  }

  return applyDelta(currentState, update.delta);
}

/**
 * Apply a delta to the current state and return a new state
 */
export function applyDelta(state: ServerState, delta: ServerDelta): ServerState {
  const newState: ServerState = { ...state };

  if (delta.active_window_id !== undefined) {
    newState.active_window_id = delta.active_window_id;
  }
  if (delta.active_pane_id !== undefined) {
    newState.active_pane_id = delta.active_pane_id;
  }
  if (delta.status_line !== undefined) {
    newState.status_line = delta.status_line;
  }
  if (delta.total_width !== undefined) {
    newState.total_width = delta.total_width;
  }
  if (delta.total_height !== undefined) {
    newState.total_height = delta.total_height;
  }

  if (delta.panes || delta.new_panes) {
    const paneMap = new Map<string, ServerPane>();
    for (const pane of state.panes) {
      paneMap.set(pane.tmux_id, pane);
    }

    if (delta.panes) {
      for (const [paneId, paneDelta] of Object.entries(delta.panes)) {
        if (paneDelta === null) {
          paneMap.delete(paneId);
        } else {
          const existing = paneMap.get(paneId);
          if (existing) {
            paneMap.set(paneId, applyPaneDelta(existing, paneDelta));
          }
        }
      }
    }

    if (delta.new_panes) {
      for (const newPane of delta.new_panes) {
        paneMap.set(newPane.tmux_id, newPane);
      }
    }

    newState.panes = Array.from(paneMap.values());
  }

  if (delta.windows || delta.new_windows) {
    const windowMap = new Map<string, ServerWindow>();
    for (const window of state.windows) {
      windowMap.set(window.id, window);
    }

    if (delta.windows) {
      for (const [windowId, windowDelta] of Object.entries(delta.windows)) {
        if (windowDelta === null) {
          windowMap.delete(windowId);
        } else {
          const existing = windowMap.get(windowId);
          if (existing) {
            windowMap.set(windowId, applyWindowDelta(existing, windowDelta));
          }
        }
      }
    }

    if (delta.new_windows) {
      for (const newWindow of delta.new_windows) {
        windowMap.set(newWindow.id, newWindow);
      }
    }

    newState.windows = Array.from(windowMap.values());
  }

  return newState;
}

function applyPaneDelta(pane: ServerPane, delta: PaneDelta): ServerPane {
  return {
    ...pane,
    ...(delta.window_id !== undefined && { window_id: delta.window_id }),
    ...(delta.content !== undefined && { content: delta.content }),
    ...(delta.cursor_x !== undefined && { cursor_x: delta.cursor_x }),
    ...(delta.cursor_y !== undefined && { cursor_y: delta.cursor_y }),
    ...(delta.width !== undefined && { width: delta.width }),
    ...(delta.height !== undefined && { height: delta.height }),
    ...(delta.x !== undefined && { x: delta.x }),
    ...(delta.y !== undefined && { y: delta.y }),
    ...(delta.active !== undefined && { active: delta.active }),
    ...(delta.command !== undefined && { command: delta.command }),
    ...(delta.title !== undefined && { title: delta.title }),
    ...(delta.border_title !== undefined && { border_title: delta.border_title }),
    ...(delta.in_mode !== undefined && { in_mode: delta.in_mode }),
    ...(delta.copy_cursor_x !== undefined && { copy_cursor_x: delta.copy_cursor_x }),
    ...(delta.copy_cursor_y !== undefined && { copy_cursor_y: delta.copy_cursor_y }),
    ...(delta.alternate_on !== undefined && { alternate_on: delta.alternate_on }),
    ...(delta.mouse_any_flag !== undefined && { mouse_any_flag: delta.mouse_any_flag }),
    ...(delta.paused !== undefined && { paused: delta.paused }),
    ...(delta.history_size !== undefined && { history_size: delta.history_size }),
    ...(delta.selection_present !== undefined && { selection_present: delta.selection_present }),
    ...(delta.selection_start_x !== undefined && { selection_start_x: delta.selection_start_x }),
    ...(delta.selection_start_y !== undefined && { selection_start_y: delta.selection_start_y }),
  };
}

function applyWindowDelta(window: ServerWindow, delta: WindowDelta): ServerWindow {
  return {
    ...window,
    ...(delta.name !== undefined && { name: delta.name }),
    ...(delta.active !== undefined && { active: delta.active }),
    ...(delta.is_pane_group_window !== undefined && {
      is_pane_group_window: delta.is_pane_group_window,
    }),
    ...(delta.pane_group_pane_ids !== undefined && {
      pane_group_pane_ids: delta.pane_group_pane_ids,
    }),
  };
}
