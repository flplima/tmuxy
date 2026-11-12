/**
 * The client's model of panes and windows, decoded from the wire shape
 * (`domain/wire.ts`). A wire field the client does not model (`pane_restore`,
 * which only the shell side reads) is dropped here.
 */

import { Schema } from 'effect';
import { GroupId, PaneId, WindowId, paneNumber } from './ids';
import { PaneTree, WindowType, type ServerState } from './wire';
import { PaneContent } from './wireCells';

const from = <K extends string, S extends Schema.Schema.All>(key: K, schema: S) =>
  Schema.propertySignature(schema).pipe(Schema.fromKey(key));

const withDefault = <K extends string, S extends Schema.Schema.Any>(
  key: K,
  schema: S,
  fallback: () => Schema.Schema.Type<S>,
) => Schema.optionalWith(schema, { default: fallback }).pipe(Schema.fromKey(key));

const optionalFrom = <K extends string, S extends Schema.Schema.Any>(key: K, schema: S) =>
  Schema.optional(schema).pipe(Schema.fromKey(key));

export const ImagePlacement = Schema.mutable(
  Schema.Struct({
    id: Schema.Number,
    row: Schema.Number,
    col: Schema.Number,
    widthCells: from('width_cells', Schema.Number),
    heightCells: from('height_cells', Schema.Number),
    protocol: Schema.Literal('iterm2', 'kitty', 'sixel'),
    stretch: optionalFrom('stretch', Schema.Boolean),
  }),
);
export type ImagePlacement = Schema.Schema.Type<typeof ImagePlacement>;

export const TmuxPane = Schema.mutable(
  Schema.Struct({
    id: Schema.Number,
    tmuxId: from('tmux_id', PaneId),
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
    /** `#{pane_title}`, which the application sets. */
    title: Schema.String,
    /** tmux's evaluated `pane-border-format`. */
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
    alternateOn: withDefault('alternate_on', Schema.Boolean, () => false),
    /** The application has turned mouse tracking on. */
    mouseAnyFlag: withDefault('mouse_any_flag', Schema.Boolean, () => false),
    /**
     * True if this is tmux's marked pane (`select-pane -m`, `#{pane_marked}`).
     * Absent means false. `swap-pane` / `join-pane` without a source act on it.
     */
    marked: Schema.optional(Schema.Boolean),
    /** Scrollback lines above the visible area. */
    historySize: withDefault('history_size', Schema.Number, () => 0),
    selectionPresent: withDefault('selection_present', Schema.Boolean, () => false),
    /** Visible-area-relative column; meaningful only when selectionPresent. */
    selectionStartX: withDefault('selection_start_x', Schema.Number, () => 0),
    /** Visible-area-relative row, can be negative; meaningful only when selectionPresent. */
    selectionStartY: withDefault('selection_start_y', Schema.Number, () => 0),
    images: Schema.optional(Schema.mutable(Schema.Array(ImagePlacement))),
    /** DECSCUSR: 0/1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar */
    cursorShape: withDefault('cursor_shape', Schema.Number, () => 0),
    /** DECTCEM (mode 25) off, `ESC[?25l`. */
    cursorHidden: withDefault('cursor_hidden', Schema.Boolean, () => false),
    /**
     * What the pane says it is doing (`@tmuxy-pane-state`), verbatim. Any
     * process can set it via `tmuxy pane state <value>`; the vocabulary the tree
     * draws lives in `domain/paneState.ts`, which collapses anything unknown.
     * Absent when the option is unset.
     */
    paneState: optionalFrom('pane_state', Schema.NullOr(Schema.String)),
    /**
     * The confirmation this pane is waiting on (`@tmuxy-ask`), as the base64
     * payload `tmuxy pane send -t` wrote. Decoded by `domain/paneAsk.ts`; absent when no
     * question is pending.
     */
    paneAsk: optionalFrom('pane_ask', Schema.NullOr(Schema.String)),
    /**
     * Which widget this pane may render (`@tmuxy-pane-widget`), written by
     * `tmuxy-widget`. The `__TMUXY_WIDGET__:` marker travels in pane OUTPUT and
     * so authorises nothing on its own — see `findPaneWidget` (domain/paneWidget.ts).
     */
    paneWidget: optionalFrom('pane_widget', Schema.NullOr(Schema.String)),
  }),
);
export type TmuxPane = Schema.Schema.Type<typeof TmuxPane>;

/**
 * The members of group `groupId`, in the group's order: by `@tmuxy-group-pos`
 * (set when the user reorders the group), then — for those without one — by
 * pane-id number. The same rule as `group_members` in packages/tmuxy-cli/bin/tmuxy/_lib, so the
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

export function markedPaneId(
  panes: ReadonlyArray<Pick<TmuxPane, 'tmuxId' | 'marked'>>,
): PaneId | null {
  return panes.find((p) => p.marked)?.tmuxId ?? null;
}

/**
 * Whether copy mode means anything on the pane. A pane running a widget (a
 * preview, the tree) draws its own view, and under it the pane's text is only
 * the widget's marker: there is nothing there to scroll back through or copy.
 */
export function paneTakesCopyMode(
  panes: ReadonlyArray<Pick<TmuxPane, 'tmuxId' | 'paneWidget'>>,
  paneId: PaneId,
): boolean {
  const pane = panes.find((p) => p.tmuxId === paneId);
  return !!pane && !pane.paneWidget;
}

export const TmuxWindow = Schema.mutable(
  Schema.Struct({
    id: WindowId,
    index: Schema.Number,
    name: Schema.String,
    active: Schema.Boolean,
    /** `null` = a foreign window, which the UI ignores. */
    windowType: withDefault('window_type', Schema.NullOr(WindowType), () => null),
    /** Parent window id for floats (launcher) and backdrops (the float). */
    floatParent: withDefault('float_parent', Schema.NullOr(WindowId), () => null),
    /** Cells (`@tmuxy-float-width`). */
    floatWidth: withDefault('float_width', Schema.NullOr(Schema.Number), () => null),
    /** Cells (`@tmuxy-float-height`). */
    floatHeight: withDefault('float_height', Schema.NullOr(Schema.Number), () => null),
    floatDrawer: withDefault('float_drawer', Schema.NullOr(Schema.String), () => null),
    floatBg: withDefault('float_bg', Schema.NullOr(Schema.String), () => null),
    floatNoheader: withDefault('float_noheader', Schema.Boolean, () => false),
    /**
     * The user minimized this float to the queue at the bottom of its tab
     * (`@tmuxy-float-minimized`); its pane keeps running. Absent is false.
     */
    floatMinimized: optionalFrom('float_minimized', Schema.Boolean),
    /**
     * The window's own active pane, from the server. `pane.active` is a
     * session-wide flag (only the current window's active pane carries it), so
     * this is how a tab switch knows which pane of a background tab to land on.
     */
    activePaneId: optionalFrom('active_pane_id', Schema.NullOr(PaneId)),
    /**
     * A sidebar column's width in cells once the user has dragged it off its
     * default (`@tmuxy-sidebar-cols`); the backend sizes its pane to the same
     * number, so every attached client agrees. Absent or null: the default.
     */
    sidebarCols: optionalFrom('sidebar_cols', Schema.NullOr(Schema.Number)),
    /**
     * The user has closed this sidebar column (`@tmuxy-sidebar-hidden`); its pane
     * stays alive, so the window existing does not mean the column is shown.
     * Absent is false.
     */
    sidebarHidden: optionalFrom('sidebar_hidden', Schema.Boolean),
    /**
     * Only the active pane's first-level row is expanded (`@tmuxy-collapsible`;
     * the backend reshapes the layout). Absent is false.
     */
    collapsible: Schema.optional(Schema.Boolean),
    /** Absent is false. */
    zoomed: Schema.optional(Schema.Boolean),
    /** Absent until tmux reports a layout. */
    paneTree: optionalFrom('pane_tree', Schema.NullOr(PaneTree)),
  }),
);
export type TmuxWindow = Schema.Schema.Type<typeof TmuxWindow>;

const ClientSession = Schema.Struct({
  sessionName: from('session_name', Schema.String),
  activeWindowId: from('active_window_id', Schema.NullOr(WindowId)),
  activePaneId: from('active_pane_id', Schema.NullOr(PaneId)),
  totalWidth: from('total_width', Schema.Number),
  totalHeight: from('total_height', Schema.Number),
  /** See `ServerState.focus_request`; `''` when nothing is pending. */
  focusRequest: withDefault('focus_request', Schema.String, () => ''),
  /** See `ServerState.plugins_rev`; `''` when no inventory was published. */
  pluginsRev: withDefault('plugins_rev', Schema.String, () => ''),
  /** See `ServerState.theme_rev`; `''` before the theme is known. */
  themeRev: withDefault('theme_rev', Schema.String, () => ''),
});

export type ClientState = Schema.Schema.Type<typeof ClientSession> & {
  panes: TmuxPane[];
  windows: TmuxWindow[];
};

const decodeSession = Schema.decodeSync(ClientSession);

/**
 * A delta keeps the records it does not change as the same objects
 * (`mergeRecords`), so the decode of an unchanged pane or window is reused.
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

/** Cannot fail: the input has already passed the wire decode. */
export function toClientState(state: ServerState): ClientState {
  return {
    ...decodeSession(state),
    panes: state.panes.map(decodePane),
    windows: state.windows.map(decodeWindow).sort((a, b) => a.index - b.index),
  };
}

export interface PaneGroup {
  id: GroupId;
  /** Tab order; the active member is the one in `activeWindowId`. */
  paneIds: PaneId[];
}
