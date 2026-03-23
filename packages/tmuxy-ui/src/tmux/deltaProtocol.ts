import type {
  ServerState,
  ServerPane,
  ServerWindow,
  ServerDelta,
  PaneDelta,
  WindowDelta,
  StateUpdate,
  CellLine,
  PaneContent,
} from './types';

/**
 * Detect if a full state update represents a different session (kill+recreate).
 * Returns true when either session name changed, or all window IDs are different
 * (tmux assigns new window IDs on session creation, even if name is reused).
 */
function isSessionChanged(oldState: ServerState, newState: ServerState): boolean {
  if (oldState.session_name !== newState.session_name) return true;
  // If window IDs have zero overlap, it's a recreated session
  const oldWindowIds = new Set(oldState.windows.map((w) => w.id));
  return newState.windows.length > 0 && newState.windows.every((w) => !oldWindowIds.has(w.id));
}

/**
 * Check if pane content is effectively empty (all lines are empty or whitespace-only).
 * Used to detect panes awaiting capture-pane refresh after resize.
 */
function isPaneContentEmpty(content: PaneContent): boolean {
  if (content.length === 0) return true;
  return content.every(
    (line) => line.length === 0 || line.every((cell) => !cell.c || cell.c === ' '),
  );
}

/**
 * Handle a StateUpdate (full or delta), returning the new state.
 * Returns null if a delta arrives before any full state.
 */
export function handleStateUpdate(
  update: StateUpdate,
  currentState: ServerState | null,
): ServerState | null {
  if (update.type === 'full') {
    // When replacing existing state with a full update, preserve non-empty pane
    // content that would be overwritten by empty content. This handles two cases:
    // 1. Initial sync: get_initial_state captured real content, but the control mode
    //    aggregator's first full emission has empty panes (captures not yet complete).
    // 2. Layout changes: after pane resize, the vt100 parser is reset (empty), but
    //    the capture-pane refill hasn't arrived yet.
    //
    // Skip content preservation when the session has changed (kill+recreate):
    // pane IDs are reused across sessions, so old content would leak as ghost lines.
    // Detect session change by: different session name, OR completely different set
    // of window IDs (same name but recreated — tmux assigns new window IDs).
    const sessionChanged = currentState !== null && isSessionChanged(currentState, update.state);
    if (currentState && currentState.panes.length > 0 && !sessionChanged) {
      const existingPaneMap = new Map(currentState.panes.map((p) => [p.tmux_id, p]));
      const mergedPanes = update.state.panes.map((pane) => {
        const existing = existingPaneMap.get(pane.tmux_id);
        if (existing && isPaneContentEmpty(pane.content) && !isPaneContentEmpty(existing.content)) {
          return {
            ...pane,
            content: existing.content,
            cursor_x: existing.cursor_x,
            cursor_y: existing.cursor_y,
          };
        }
        return pane;
      });
      return { ...update.state, panes: mergedPanes };
    }
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

/**
 * Compare two cell lines for deep equality.
 * Returns true if both lines have the same characters and styles.
 */
function cellLinesEqual(a: CellLine, b: CellLine): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i],
      cb = b[i];
    if (ca.c !== cb.c) return false;
    if (ca.s === cb.s) continue;
    // Treat null and undefined as equivalent (both mean "no style")
    if (!ca.s && !cb.s) continue;
    if (!ca.s || !cb.s) return false;
    // Deep-compare fg/bg with RGB object support
    if (typeof ca.s.fg === 'object' && typeof cb.s.fg === 'object') {
      if (ca.s.fg.r !== cb.s.fg.r || ca.s.fg.g !== cb.s.fg.g || ca.s.fg.b !== cb.s.fg.b)
        return false;
    } else if (ca.s.fg !== cb.s.fg) return false;
    if (typeof ca.s.bg === 'object' && typeof cb.s.bg === 'object') {
      if (ca.s.bg.r !== cb.s.bg.r || ca.s.bg.g !== cb.s.bg.g || ca.s.bg.b !== cb.s.bg.b)
        return false;
    } else if (ca.s.bg !== cb.s.bg) return false;
    // Normalize boolean fields: undefined and false are equivalent
    if (
      (ca.s.bold ?? false) !== (cb.s.bold ?? false) ||
      (ca.s.italic ?? false) !== (cb.s.italic ?? false) ||
      (ca.s.underline ?? false) !== (cb.s.underline ?? false) ||
      (ca.s.inverse ?? false) !== (cb.s.inverse ?? false) ||
      ca.s.url !== cb.s.url
    )
      return false;
  }
  return true;
}

/**
 * Merge sparse line updates into existing content.
 * delta.content is Record<number, CellLine> — only changed line indices.
 */
function mergeSparseContent(
  oldContent: PaneContent,
  changes: Record<number, CellLine>,
): PaneContent {
  // Find the max line index to determine new content length
  let maxIdx = oldContent.length - 1;
  for (const key of Object.keys(changes)) {
    const idx = Number(key);
    if (idx > maxIdx) maxIdx = idx;
  }
  const newLength = maxIdx + 1;
  const merged: CellLine[] = new Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const changedLine = changes[i];
    if (changedLine !== undefined) {
      // Check if line is actually unchanged (preserve identity for React.memo)
      if (i < oldContent.length && cellLinesEqual(oldContent[i], changedLine)) {
        merged[i] = oldContent[i];
      } else {
        merged[i] = changedLine;
      }
    } else if (i < oldContent.length) {
      merged[i] = oldContent[i];
    } else {
      merged[i] = [];
    }
  }
  return merged;
}

function applyPaneDelta(pane: ServerPane, delta: PaneDelta): ServerPane {
  // When content delta would result in all-empty content but existing content
  // is non-empty, preserve existing content. This happens when a pane is resized
  // (vt100 parser reset) but capture-pane refill hasn't arrived yet.
  let mergedContent: PaneContent | undefined;
  if (delta.content !== undefined) {
    const candidate = mergeSparseContent(pane.content, delta.content);
    if (isPaneContentEmpty(candidate) && !isPaneContentEmpty(pane.content)) {
      mergedContent = pane.content;
    } else {
      mergedContent = candidate;
    }
  }

  return {
    ...pane,
    ...(delta.window_id !== undefined && { window_id: delta.window_id }),
    ...(mergedContent !== undefined && { content: mergedContent }),
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
    ...(delta.images !== undefined && { images: delta.images }),
    ...(delta.cursor_shape !== undefined && { cursor_shape: delta.cursor_shape }),
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
