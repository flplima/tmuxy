import type {
  CellLine,
  PaneContent,
  PaneDelta,
  ServerDelta,
  ServerState,
  SparseContent,
  StateUpdate,
  WindowDelta,
  WirePane,
  WireWindow,
} from '../domain/wire';

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
 * Take a `get_initial_state` answer as the client's state.
 *
 * The answer is a snapshot taken when the request reached the server, and the
 * live stream keeps running while it travels back. The stream is a sequence —
 * a full state, then deltas against the server's previous emission — so once
 * it has delivered a full state (`streamSynced`), it alone is the server's
 * state, and an answer from outside the sequence is at best as new and often
 * older. Put back, it undid whatever the stream had delivered since: a shell
 * prompt already printed (it is never printed again, so the pane stayed blank
 * for good), or the windows a session restore had just made — the stream
 * never sends those again, since to the server nothing changed. So a synced
 * stream keeps its state, and the answer only fills a pane the stream has
 * delivered no content for yet (it carries a capture the stream may not).
 *
 * Before the stream's first full state, or after a sequence gap, the answer
 * IS the state to start from, merged the way a full update from the stream
 * would be.
 */
export function adoptInitialState(
  answer: ServerState,
  current: ServerState | null,
  streamSynced: boolean,
): ServerState {
  if (!current || !streamSynced) {
    return handleStateUpdate({ type: 'full', state: answer }, current) ?? answer;
  }
  const answered = new Map(answer.panes.map((p) => [p.tmux_id, p]));
  let filled = false;
  const panes = current.panes.map((pane) => {
    const from = answered.get(pane.tmux_id);
    if (!from || !isPaneContentEmpty(pane.content) || isPaneContentEmpty(from.content)) {
      return pane;
    }
    filled = true;
    return { ...pane, content: from.content, cursor_x: from.cursor_x, cursor_y: from.cursor_y };
  });
  return filled ? { ...current, panes } : current;
}

/**
 * Detect a gap in the delta sequence. Deltas carry a monotonic `seq`; a
 * correctly-ordered stream advances it by exactly one each time. If a delta is
 * dropped or reordered the seq jumps, and applying it to stale state silently
 * diverges the client — so the adapter should refetch a full snapshot instead.
 *
 * `prevSeq` is the last applied delta seq, or `null` right after a full state
 * (a fresh sync point, which never reports a gap). A seq that goes backwards or
 * repeats is also treated as a gap.
 */
export function isDeltaSeqGap(prevSeq: number | null, delta: ServerDelta): boolean {
  return prevSeq !== null && delta.seq !== prevSeq + 1;
}

/**
 * Handle a decoded StateUpdate (full or delta), returning the new state.
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
 * Merge a delta's changes into `current`: a key mapped to `null` is removed,
 * a key mapped to a change is updated (a change for an unknown key is
 * ignored), and `added` records are inserted or replaced whole.
 */
function mergeRecords<K, R, C>(
  current: ReadonlyArray<R>,
  keyOf: (record: R) => K,
  changes: ReadonlyMap<K, C | null> | undefined,
  apply: (record: R, change: C) => R,
  added: ReadonlyArray<R> | undefined,
): R[] {
  const byKey = new Map<K, R>();
  for (const record of current) byKey.set(keyOf(record), record);
  for (const [key, change] of changes ?? []) {
    const existing = byKey.get(key);
    if (change === null) byKey.delete(key);
    else if (existing !== undefined) byKey.set(key, apply(existing, change));
  }
  for (const record of added ?? []) byKey.set(keyOf(record), record);
  return Array.from(byKey.values());
}

/**
 * Apply a delta to the current state and return a new state
 */
export function applyDelta(state: ServerState, delta: ServerDelta): ServerState {
  return {
    ...state,
    active_window_id: delta.active_window_id ?? state.active_window_id,
    active_pane_id: delta.active_pane_id ?? state.active_pane_id,
    focus_request: delta.focus_request ?? state.focus_request,
    total_width: delta.total_width ?? state.total_width,
    total_height: delta.total_height ?? state.total_height,
    panes:
      delta.panes || delta.new_panes
        ? mergeRecords(state.panes, (p) => p.tmux_id, delta.panes, applyPaneDelta, delta.new_panes)
        : state.panes,
    windows:
      delta.windows || delta.new_windows
        ? mergeRecords(
            state.windows,
            (w) => w.id,
            delta.windows,
            applyWindowDelta,
            delta.new_windows,
          )
        : state.windows,
  };
}

/**
 * Cell-line equality with wire-shape normalization: `null`/`undefined` styles
 * are both "no style", and absent boolean flags equal `false`. Exported as
 * THE line comparator — `store/adapters.ts` used to carry its own
 * `linesEqual` with stricter semantics (`undefined !== false`), so the two
 * halves of the pipeline disagreed about what "changed" means.
 */
export function cellLinesEqual(a: CellLine, b: CellLine): boolean {
  if (a === b) return true;
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
      (ca.s.dim ?? false) !== (cb.s.dim ?? false) ||
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
function mergeSparseContent(oldContent: PaneContent, changes: SparseContent): PaneContent {
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

function applyPaneDelta(pane: WirePane, delta: PaneDelta): WirePane {
  // A delta is applied verbatim, even when it empties every row: that is what
  // a `clear` looks like (the erase arrives as its own %output, the prompt as
  // the next one). The resize transient this used to guard against — a reset
  // vt100 grid emitted before its capture-pane refill — is held back on the
  // server (the aggregator keeps the previous content while a capture is in
  // flight), so nothing legitimate reaches here as a spurious blank.
  const mergedContent =
    delta.content !== undefined ? mergeSparseContent(pane.content, delta.content) : undefined;

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
    ...(delta.group_id !== undefined && { group_id: delta.group_id }),
    ...(delta.group_pos !== undefined && { group_pos: delta.group_pos }),
    ...(delta.in_mode !== undefined && { in_mode: delta.in_mode }),
    ...(delta.copy_cursor_x !== undefined && { copy_cursor_x: delta.copy_cursor_x }),
    ...(delta.copy_cursor_y !== undefined && { copy_cursor_y: delta.copy_cursor_y }),
    ...(delta.alternate_on !== undefined && { alternate_on: delta.alternate_on }),
    ...(delta.marked !== undefined && { marked: delta.marked }),
    ...(delta.mouse_any_flag !== undefined && { mouse_any_flag: delta.mouse_any_flag }),
    ...(delta.paused !== undefined && { paused: delta.paused }),
    ...(delta.history_size !== undefined && { history_size: delta.history_size }),
    ...(delta.selection_present !== undefined && { selection_present: delta.selection_present }),
    ...(delta.selection_start_x !== undefined && { selection_start_x: delta.selection_start_x }),
    ...(delta.selection_start_y !== undefined && { selection_start_y: delta.selection_start_y }),
    ...(delta.images !== undefined && { images: delta.images }),
    ...(delta.cursor_shape !== undefined && { cursor_shape: delta.cursor_shape }),
    ...(delta.cursor_hidden !== undefined && { cursor_hidden: delta.cursor_hidden }),
    ...(delta.pane_state !== undefined && { pane_state: delta.pane_state }),
    ...(delta.pane_ask !== undefined && { pane_ask: delta.pane_ask }),
    ...(delta.pane_widget !== undefined && { pane_widget: delta.pane_widget }),
    ...(delta.pane_restore !== undefined && { pane_restore: delta.pane_restore }),
  };
}

function applyWindowDelta(window: WireWindow, delta: WindowDelta): WireWindow {
  return {
    ...window,
    ...(delta.index !== undefined && { index: delta.index }),
    ...(delta.name !== undefined && { name: delta.name }),
    ...(delta.active !== undefined && { active: delta.active }),
    ...(delta.window_type !== undefined && { window_type: delta.window_type }),
    ...(delta.float_parent !== undefined && { float_parent: delta.float_parent }),
    ...(delta.float_width !== undefined && { float_width: delta.float_width }),
    ...(delta.float_height !== undefined && { float_height: delta.float_height }),
    ...(delta.float_drawer !== undefined && { float_drawer: delta.float_drawer }),
    ...(delta.float_bg !== undefined && { float_bg: delta.float_bg }),
    ...(delta.float_noheader !== undefined && { float_noheader: delta.float_noheader }),
    ...(delta.sidebar_cols !== undefined && { sidebar_cols: delta.sidebar_cols }),
    ...(delta.sidebar_hidden !== undefined && { sidebar_hidden: delta.sidebar_hidden }),
    ...(delta.collapsible !== undefined && { collapsible: delta.collapsible }),
    ...(delta.zoomed !== undefined && { zoomed: delta.zoomed }),
    ...(delta.active_pane_id !== undefined && { active_pane_id: delta.active_pane_id }),
  };
}
