/**
 * The client's own model of panes and windows, derived from the wire.
 *
 * Each client schema decodes FROM the wire shape (`domain/wire.ts`): its
 * fields rename the snake_case wire keys (`Schema.fromKey`) and fill the
 * defaults the wire leaves out, so the client types are derived — never
 * hand-written next to the wire — and carry the branded ids. A wire field the
 * client does not model (`pane_restore`, which only the shell side reads) is
 * dropped here.
 */

import { Schema } from 'effect';
import { GroupId, PaneId, WindowId, paneNumber } from './ids';
import { PaneContent, PaneTree, WindowType, type ServerState } from './wire';

/** A required field, read from the wire key `key`. */
const from = <K extends string, S extends Schema.Schema.All>(key: K, schema: S) =>
  Schema.propertySignature(schema).pipe(Schema.fromKey(key));

/** A field the wire may omit, read from `key`, `fallback` when it does. */
const withDefault = <K extends string, S extends Schema.Schema.Any>(
  key: K,
  schema: S,
  fallback: () => Schema.Schema.Type<S>,
) => Schema.optionalWith(schema, { default: fallback }).pipe(Schema.fromKey(key));

/** A field the wire may omit, read from `key`, absent when it does. */
const optionalFrom = <K extends string, S extends Schema.Schema.Any>(key: K, schema: S) =>
  Schema.optional(schema).pipe(Schema.fromKey(key));

/** An image placement on the terminal grid. */
export const ImagePlacement = Schema.mutable(
  Schema.Struct({
    id: Schema.Number,
    row: Schema.Number,
    col: Schema.Number,
    widthCells: from('width_cells', Schema.Number),
    heightCells: from('height_cells', Schema.Number),
    protocol: Schema.Literal('iterm2', 'kitty', 'sixel'),
  }),
);
export type ImagePlacement = Schema.Schema.Type<typeof ImagePlacement>;

/** A pane as the client holds it, decoded from a wire pane. */
export const TmuxPane = Schema.mutable(
  Schema.Struct({
    id: Schema.Number,
    tmuxId: from('tmux_id', PaneId),
    /** Window this pane belongs to. */
    windowId: from('window_id', WindowId),
    content: PaneContent,
    cursorX: from('cursor_x', Schema.Number),
    cursorY: from('cursor_y', Schema.Number),
    width: Schema.Number,
    height: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
    active: Schema.Boolean,
    command: Schema.String,
    /** Pane title (set by shell/application) */
    title: Schema.String,
    /** Evaluated pane-border-format from tmux config */
    borderTitle: from('border_title', Schema.String),
    /**
     * Pane-group identity (`@tmuxy-group-id`, e.g. `g5`); absent/null when the
     * pane is not in a group (the backend omits it from the wire). Panes sharing
     * a value form a group; the member whose `windowId` is the active window is
     * the visible one, the rest are hidden stubs parked in the stash session.
     */
    groupId: optionalFrom('group_id', Schema.NullOr(GroupId)),
    /** `@tmuxy-group-pos`: this member's place in its group, once reordered. */
    groupPos: optionalFrom('group_pos', Schema.NullOr(Schema.Number)),
    inMode: from('in_mode', Schema.Boolean),
    copyCursorX: from('copy_cursor_x', Schema.Number),
    copyCursorY: from('copy_cursor_y', Schema.Number),
    /** True if application is in alternate screen mode (vim, less, htop) */
    alternateOn: withDefault('alternate_on', Schema.Boolean, () => false),
    /** True if application has mouse tracking enabled */
    mouseAnyFlag: withDefault('mouse_any_flag', Schema.Boolean, () => false),
    /**
     * True if this is tmux's marked pane (`select-pane -m`, `#{pane_marked}`).
     * Absent means false. `swap-pane` / `join-pane` without a source act on it.
     */
    marked: Schema.optional(Schema.Boolean),
    /** True if output is paused due to flow control (backpressure) */
    paused: withDefault('paused', Schema.Boolean, () => false),
    /** Number of history lines (scrollback above the visible area) */
    historySize: withDefault('history_size', Schema.Number, () => 0),
    /** True if a selection is active in copy mode */
    selectionPresent: withDefault('selection_present', Schema.Boolean, () => false),
    /** Selection start X (visible-area-relative column), only meaningful when selectionPresent */
    selectionStartX: withDefault('selection_start_x', Schema.Number, () => 0),
    /** Selection start Y (visible-area-relative row, can be negative), only meaningful when selectionPresent */
    selectionStartY: withDefault('selection_start_y', Schema.Number, () => 0),
    /** Image placements on this pane's terminal grid */
    images: Schema.optional(Schema.mutable(Schema.Array(ImagePlacement))),
    /** Cursor shape from DECSCUSR: 0/1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar */
    cursorShape: withDefault('cursor_shape', Schema.Number, () => 0),
    /** Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l) */
    cursorHidden: withDefault('cursor_hidden', Schema.Boolean, () => false),
    /**
     * What the pane says it is doing (`@tmuxy-pane-state`), verbatim. Any
     * process can set it via `tmuxy pane state <value>`; the vocabulary the tree
     * draws lives in `utils/paneState.ts`, which collapses anything unknown.
     * Absent when the option is unset.
     */
    paneState: optionalFrom('pane_state', Schema.NullOr(Schema.String)),
    /**
     * The confirmation this pane is waiting on (`@tmuxy-ask`), as the base64
     * payload `tmuxy ask` wrote. Decoded by `utils/paneAsk.ts`; absent when no
     * question is pending.
     */
    paneAsk: optionalFrom('pane_ask', Schema.NullOr(Schema.String)),
    /**
     * Which widget this pane may render (`@tmuxy-pane-widget`), written by
     * `tmuxy-widget`. The `__TMUXY_WIDGET__:` marker travels in pane OUTPUT and
     * so authorises nothing on its own — see `components/widgets/detectWidget`.
     */
    paneWidget: optionalFrom('pane_widget', Schema.NullOr(Schema.String)),
  }),
);
export type TmuxPane = Schema.Schema.Type<typeof TmuxPane>;

/**
 * The members of group `groupId`, in the group's order: by `@tmuxy-group-pos`
 * (set when the user reorders the group), then — for those without one — by
 * pane-id number. The same rule as `group_members` in bin/tmuxy/_lib, so the
 * client's tab order and the shell's next/prev agree.
 */
export function groupMembers(
  panes: ReadonlyArray<Pick<TmuxPane, 'tmuxId' | 'groupId' | 'groupPos'>>,
  groupId: GroupId,
): PaneId[] {
  const position = (p: Pick<TmuxPane, 'groupPos'>) =>
    typeof p.groupPos === 'number' ? p.groupPos : Infinity;
  return panes
    .filter((p) => p.groupId === groupId)
    .sort((a, b) => position(a) - position(b) || paneNumber(a.tmuxId) - paneNumber(b.tmuxId))
    .map((p) => p.tmuxId);
}

/** A window as the client holds it, decoded from a wire window. */
export const TmuxWindow = Schema.mutable(
  Schema.Struct({
    id: WindowId,
    index: Schema.Number,
    name: Schema.String,
    active: Schema.Boolean,
    /** Window type. `null` = foreign (ignored by the UI). */
    windowType: withDefault('window_type', Schema.NullOr(WindowType), () => null),
    /** Parent window id for floats (launcher) and backdrops (the float). */
    floatParent: withDefault('float_parent', Schema.NullOr(WindowId), () => null),
    /** Float width in cells (@tmuxy-float-width). */
    floatWidth: withDefault('float_width', Schema.NullOr(Schema.Number), () => null),
    /** Float height in cells (@tmuxy-float-height). */
    floatHeight: withDefault('float_height', Schema.NullOr(Schema.Number), () => null),
    /** Drawer direction for drawer-style floats. */
    floatDrawer: withDefault('float_drawer', Schema.NullOr(Schema.String), () => null),
    /** Backdrop style for floats. */
    floatBg: withDefault('float_bg', Schema.NullOr(Schema.String), () => null),
    /** True when the float hides its header chrome. */
    floatNoheader: withDefault('float_noheader', Schema.Boolean, () => false),
    /**
     * The window's own active pane, from the server. `pane.active` is a
     * session-wide flag (only the current window's active pane carries it), so
     * this is how a tab switch knows which pane of a background tab to land on.
     */
    activePaneId: optionalFrom('active_pane_id', Schema.NullOr(PaneId)),
    /**
     * A sidebar column's width in cells when the user has dragged it off its
     * default (@tmuxy-sidebar-cols). The column is drawn at this many cells, and
     * the backend sized its pane to the same number — so a drag moves both, and
     * every client attached to the session agrees on the width. Absent is
     * equivalent to null — the side's default.
     */
    sidebarCols: optionalFrom('sidebar_cols', Schema.NullOr(Schema.Number)),
    /**
     * True while the user has closed this sidebar column (@tmuxy-sidebar-hidden).
     * The pane behind it stays alive, so the window existing no longer means the
     * column is shown; every client reads the flag, so a close made in one client
     * or before a reload holds everywhere. Absent is equivalent to false.
     */
    sidebarHidden: optionalFrom('sidebar_hidden', Schema.Boolean),
    /**
     * True while the window keeps only the active pane's first-level row
     * expanded (@tmuxy-collapsible; the backend reshapes the layout). Absent is
     * equivalent to false.
     */
    collapsible: Schema.optional(Schema.Boolean),
    /** True while a pane in this window is zoomed (tmux hides the others).
     *  Absent is equivalent to false. */
    zoomed: Schema.optional(Schema.Boolean),
    /** The window's split structure, which a divider drag follows; absent until tmux reports a layout. */
    paneTree: optionalFrom('pane_tree', Schema.NullOr(PaneTree)),
  }),
);
export type TmuxWindow = Schema.Schema.Type<typeof TmuxWindow>;

/** The session's own fields as the client holds them; its panes and windows are decoded per record. */
const ClientSession = Schema.Struct({
  sessionName: from('session_name', Schema.String),
  activeWindowId: from('active_window_id', Schema.NullOr(WindowId)),
  activePaneId: from('active_pane_id', Schema.NullOr(PaneId)),
  totalWidth: from('total_width', Schema.Number),
  totalHeight: from('total_height', Schema.Number),
  /** See `ServerState.focus_request`; `''` when nothing is pending. */
  focusRequest: withDefault('focus_request', Schema.String, () => ''),
});

/** The session as the client holds it, decoded from a wire full state. */
export type ClientState = Schema.Schema.Type<typeof ClientSession> & {
  panes: TmuxPane[];
  windows: TmuxWindow[];
};

const decodeSession = Schema.decodeSync(ClientSession);

/**
 * Decode each wire record once. A delta rebuilds only the records it changes
 * and keeps the rest as they were (`mergeRecords`), so on every later state an
 * unchanged pane or window is the same object, and its decode is reused —
 * this runs on every state the client paints.
 */
function cachedDecode<W extends object, C>(decode: (wire: W) => C): (wire: W) => C {
  const decoded = new WeakMap<W, C>();
  return (wire) => {
    let client = decoded.get(wire);
    if (client === undefined) {
      client = decode(wire);
      decoded.set(wire, client);
    }
    return client;
  };
}

const decodePane = cachedDecode(Schema.decodeSync(TmuxPane));
const decodeWindow = cachedDecode(Schema.decodeSync(TmuxWindow));

/**
 * The client's view of a decoded server state: camelCase records with their
 * defaults filled in, windows in index order. The input has already passed
 * the wire decode, so this cannot fail.
 */
export function toClientState(state: ServerState): ClientState {
  return {
    ...decodeSession(state),
    panes: state.panes.map(decodePane),
    windows: state.windows.map(decodeWindow).sort((a, b) => a.index - b.index),
  };
}
