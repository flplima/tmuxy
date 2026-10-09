/**
 * The wire: every shape the backend sends the client, as Effect Schemas.
 *
 * This is the single definition of the protocol on the TypeScript side. The
 * types are derived from the schemas (`Schema.Schema.Type<…>`), so a field
 * cannot be added to one and forgotten in the other. They mirror the Rust
 * types in `tmuxy-core` (`TmuxState`, `TmuxPane`, `TmuxWindow`, `TmuxDelta`,
 * `PaneDelta`, `WindowDelta`, `KeyBindings`, `theme::Appearance`) and the
 * server's SSE frames (`tmuxy-server/src/sse.rs`); the committed
 * `packages/protocol-fixtures` are decoded through these schemas so a drift
 * fails a test.
 *
 * Every payload is decoded once, where it enters the client (see
 * `infra/transport/wireDecode.ts`). Ids are the branded schemas of `domain/ids.ts`, so
 * from the boundary on a pane id cannot be confused with a window id.
 *
 * Pane content is the hot path — a full state carries every cell of every
 * pane — so the cell grid is checked for its outer shape only (an array of
 * rows) and the cells are trusted. The cell schemas still define the cell
 * types.
 */

import { Schema } from 'effect';
import { GroupId, PaneId, WindowId } from './ids';

// ============================================
// Cells
// ============================================

/** A colour: an indexed one (0-255) or RGB. */
export const CellColor = Schema.Union(
  Schema.Number,
  Schema.Struct({ r: Schema.Number, g: Schema.Number, b: Schema.Number }),
);
export type CellColor = Schema.Schema.Type<typeof CellColor>;

/** A cell's style; every attribute optional. */
export const CellStyle = Schema.mutable(
  Schema.Struct({
    fg: Schema.optional(CellColor),
    bg: Schema.optional(CellColor),
    bold: Schema.optional(Schema.Boolean),
    /** SGR 2: faint text, drawn at reduced opacity. */
    dim: Schema.optional(Schema.Boolean),
    italic: Schema.optional(Schema.Boolean),
    underline: Schema.optional(Schema.Boolean),
    inverse: Schema.optional(Schema.Boolean),
    /** OSC 8 hyperlink. */
    url: Schema.optional(Schema.String),
  }),
);
export type CellStyle = Schema.Schema.Type<typeof CellStyle>;

/** One terminal cell: its character and, when styled, its style. */
export const TerminalCell = Schema.Struct({
  c: Schema.String,
  s: Schema.optional(CellStyle),
});
export type TerminalCell = Schema.Schema.Type<typeof TerminalCell>;

/** One row of cells. */
export const CellLine = Schema.mutable(Schema.Array(TerminalCell));
export type CellLine = Schema.Schema.Type<typeof CellLine>;
/** A pane's visible grid: its rows, top to bottom. */
export type PaneContent = CellLine[];

/** The cell grid, checked for its outer shape only (see the module note). */
export const PaneContent = Schema.declare((u: unknown): u is PaneContent => Array.isArray(u), {
  identifier: 'PaneContent',
});

/** Changed rows of a pane, keyed by row index (JSON object keys are strings). */
export type SparseContent = Record<number, CellLine>;

/** A delta's changed rows, checked for its outer shape only. */
export const SparseContent = Schema.declare(
  (u: unknown): u is SparseContent => typeof u === 'object' && u !== null && !Array.isArray(u),
  { identifier: 'SparseContent' },
);

// ============================================
// Panes and windows
// ============================================

/** An image placed on a pane's grid by an image protocol. */
export const WireImagePlacement = Schema.Struct({
  id: Schema.Number,
  row: Schema.Number,
  col: Schema.Number,
  width_cells: Schema.Number,
  height_cells: Schema.Number,
  protocol: Schema.Literal('iterm2', 'kitty', 'sixel'),
});
export type WireImagePlacement = Schema.Schema.Type<typeof WireImagePlacement>;

const Images = Schema.mutable(Schema.Array(WireImagePlacement));

/** Window type (`@tmuxy-window-type`). A window without one is foreign. */
export const WindowType = Schema.Literal('tab', 'float', 'sidebar-left', 'sidebar-right');
export type WindowType = Schema.Schema.Type<typeof WindowType>;

const OptionalNull = <S extends Schema.Schema.Any>(s: S) => Schema.optional(Schema.NullOr(s));

/** A pane as the server sends it. */
export const WirePane = Schema.Struct({
  id: Schema.Number,
  tmux_id: PaneId,
  window_id: WindowId,
  content: PaneContent,
  cursor_x: Schema.Number,
  cursor_y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
  active: Schema.Boolean,
  command: Schema.String,
  title: Schema.String,
  border_title: Schema.String,
  group_id: OptionalNull(GroupId),
  group_pos: OptionalNull(Schema.Number),
  in_mode: Schema.Boolean,
  copy_cursor_x: Schema.Number,
  copy_cursor_y: Schema.Number,
  alternate_on: Schema.optional(Schema.Boolean),
  mouse_any_flag: Schema.optional(Schema.Boolean),
  marked: Schema.optional(Schema.Boolean),
  paused: Schema.optional(Schema.Boolean),
  history_size: Schema.optional(Schema.Number),
  selection_present: Schema.optional(Schema.Boolean),
  selection_start_x: Schema.optional(Schema.Number),
  selection_start_y: Schema.optional(Schema.Number),
  images: Schema.optional(Images),
  cursor_shape: Schema.optional(Schema.Number),
  cursor_hidden: Schema.optional(Schema.Boolean),
  pane_state: OptionalNull(Schema.String),
  pane_ask: OptionalNull(Schema.String),
  /**
   * `@tmuxy-pane-widget`: which widget this pane may render. The
   * `__TMUXY_WIDGET__:` marker is pane OUTPUT, so it authorises nothing on its
   * own — see `detectWidget`.
   */
  pane_widget: OptionalNull(Schema.String),
  /** `@tmuxy-pane-restore`: the line a session restore types to bring the pane back. */
  pane_restore: OptionalNull(Schema.String),
});
export type WirePane = Schema.Schema.Type<typeof WirePane>;
/** A pane before decoding: what a sandbox engine or a fixture builds. */
export type WirePaneEncoded = Schema.Schema.Encoded<typeof WirePane>;

/** A window as the server sends it. */
export const WireWindow = Schema.Struct({
  id: WindowId,
  index: Schema.Number,
  name: Schema.String,
  active: Schema.Boolean,
  window_type: OptionalNull(WindowType),
  float_parent: OptionalNull(WindowId),
  float_width: OptionalNull(Schema.Number),
  float_height: OptionalNull(Schema.Number),
  float_drawer: OptionalNull(Schema.String),
  float_bg: OptionalNull(Schema.String),
  float_noheader: Schema.optional(Schema.Boolean),
  sidebar_cols: OptionalNull(Schema.Number),
  sidebar_hidden: Schema.optional(Schema.Boolean),
  collapsible: Schema.optional(Schema.Boolean),
  zoomed: Schema.optional(Schema.Boolean),
  active_pane_id: OptionalNull(PaneId),
});
export type WireWindow = Schema.Schema.Type<typeof WireWindow>;
/** A window before decoding; see `WirePaneEncoded`. */
export type WireWindowEncoded = Schema.Schema.Encoded<typeof WireWindow>;

/** The whole session, as a full update or the `get_initial_state` answer carries it. */
export const ServerState = Schema.Struct({
  session_name: Schema.String,
  active_window_id: Schema.NullOr(WindowId),
  active_pane_id: Schema.NullOr(PaneId),
  panes: Schema.mutable(Schema.Array(WirePane)),
  windows: Schema.mutable(Schema.Array(WireWindow)),
  total_width: Schema.Number,
  total_height: Schema.Number,
  /**
   * A one-shot request from a shell helper for this client to move keyboard
   * focus somewhere no tmux command could reach: `left`/`right` for a sidebar
   * column, `panes` to leave one. Set by `bin/tmuxy/nav` when a directional
   * `select-pane` is a no-op at the grid's edge. The client that acts on it
   * unsets the tmux option, which clears the field on the next poll.
   */
  focus_request: Schema.optional(Schema.String),
});
export type ServerState = Schema.Schema.Type<typeof ServerState>;
/** A full state before decoding: what an engine or a fixture builds, ids as plain strings. */
export type ServerStateEncoded = Schema.Schema.Encoded<typeof ServerState>;

// ============================================
// Deltas
// ============================================

/** What changed about a pane; an absent field did not change, `null` cleared it. */
export const PaneDelta = Schema.Struct({
  window_id: Schema.optional(WindowId),
  content: Schema.optional(SparseContent),
  cursor_x: Schema.optional(Schema.Number),
  cursor_y: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  active: Schema.optional(Schema.Boolean),
  command: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  border_title: Schema.optional(Schema.String),
  group_id: OptionalNull(GroupId),
  group_pos: OptionalNull(Schema.Number),
  in_mode: Schema.optional(Schema.Boolean),
  copy_cursor_x: Schema.optional(Schema.Number),
  copy_cursor_y: Schema.optional(Schema.Number),
  alternate_on: Schema.optional(Schema.Boolean),
  mouse_any_flag: Schema.optional(Schema.Boolean),
  marked: Schema.optional(Schema.Boolean),
  paused: Schema.optional(Schema.Boolean),
  history_size: Schema.optional(Schema.Number),
  selection_present: Schema.optional(Schema.Boolean),
  selection_start_x: Schema.optional(Schema.Number),
  selection_start_y: Schema.optional(Schema.Number),
  images: Schema.optional(Images),
  cursor_shape: Schema.optional(Schema.Number),
  cursor_hidden: Schema.optional(Schema.Boolean),
  pane_state: OptionalNull(Schema.String),
  pane_ask: OptionalNull(Schema.String),
  pane_widget: OptionalNull(Schema.String),
  pane_restore: OptionalNull(Schema.String),
});
export type PaneDelta = Schema.Schema.Type<typeof PaneDelta>;

/** What changed about a window; see `PaneDelta`. */
export const WindowDelta = Schema.Struct({
  /** The window's index moved (a reorder renumbers its neighbours too). */
  index: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  window_type: OptionalNull(WindowType),
  float_parent: OptionalNull(WindowId),
  float_width: OptionalNull(Schema.Number),
  float_height: OptionalNull(Schema.Number),
  float_drawer: OptionalNull(Schema.String),
  float_bg: OptionalNull(Schema.String),
  float_noheader: Schema.optional(Schema.Boolean),
  sidebar_cols: OptionalNull(Schema.Number),
  sidebar_hidden: Schema.optional(Schema.Boolean),
  collapsible: Schema.optional(Schema.Boolean),
  zoomed: Schema.optional(Schema.Boolean),
  active_pane_id: OptionalNull(PaneId),
});
export type WindowDelta = Schema.Schema.Type<typeof WindowDelta>;

/**
 * Changes since the previous emission. `panes` / `windows` map an id to its
 * changes, or to `null` when it is gone; `new_panes` / `new_windows` carry
 * whole records for ones that appeared.
 */
export const ServerDelta = Schema.Struct({
  seq: Schema.Number,
  panes: Schema.optional(
    Schema.ReadonlyMapFromRecord({ key: PaneId, value: Schema.NullOr(PaneDelta) }),
  ),
  windows: Schema.optional(
    Schema.ReadonlyMapFromRecord({ key: WindowId, value: Schema.NullOr(WindowDelta) }),
  ),
  new_panes: Schema.optional(Schema.Array(WirePane)),
  new_windows: Schema.optional(Schema.Array(WireWindow)),
  active_window_id: Schema.optional(WindowId),
  active_pane_id: Schema.optional(PaneId),
  /** See `ServerState.focus_request`. An empty string means "cleared". */
  focus_request: Schema.optional(Schema.String),
  total_width: Schema.optional(Schema.Number),
  total_height: Schema.optional(Schema.Number),
});
export type ServerDelta = Schema.Schema.Type<typeof ServerDelta>;
export type ServerDeltaEncoded = Schema.Schema.Encoded<typeof ServerDelta>;

/** One `state-update`: the whole state, or the changes since the last one. */
export const StateUpdate = Schema.Union(
  Schema.Struct({ type: Schema.Literal('full'), state: ServerState }),
  Schema.Struct({ type: Schema.Literal('delta'), delta: ServerDelta }),
);
export type StateUpdate = Schema.Schema.Type<typeof StateUpdate>;
export type StateUpdateEncoded = Schema.Schema.Encoded<typeof StateUpdate>;

// ============================================
// Other server events
// ============================================

/** The greeting on a new event stream (SSE `connection-info`). */
export const ConnectionInfo = Schema.Struct({
  connection_id: Schema.Number,
  default_shell: Schema.optional(Schema.String),
  trace_enabled: Schema.optional(Schema.Boolean),
  /** The server runs `--read-only`: this client is a viewer. */
  read_only: Schema.optional(Schema.Boolean),
});
export type ConnectionInfo = Schema.Schema.Type<typeof ConnectionInfo>;

/** One binding of a key table, as `list-keys` prints it. */
export const KeyBinding = Schema.Struct({
  key: Schema.String,
  command: Schema.String,
  description: Schema.String,
  /** `-r`: the binding re-enters prefix mode after it runs. */
  repeat: Schema.optional(Schema.Boolean),
});
export type KeyBinding = Schema.Schema.Type<typeof KeyBinding>;

/** The prefix key and the prefix/root tables. */
export const KeyBindings = Schema.Struct({
  prefix_key: Schema.String,
  prefix_bindings: Schema.Array(KeyBinding),
  root_bindings: Schema.Array(KeyBinding),
});
export type KeyBindings = Schema.Schema.Type<typeof KeyBindings>;

/**
 * Surface opacities, native blur and the other `@tmuxy-*` appearance options,
 * the same on every transport — mirrors `tmuxy_core::theme::Appearance`.
 */
export const Appearance = Schema.Struct({
  /** Window chrome: title bar, sidebar, the gaps between panes. */
  opacity: Schema.Number,
  activePaneOpacity: Schema.Number,
  inactivePaneOpacity: Schema.Number,
  activeTextOpacity: Schema.Number,
  inactiveTextOpacity: Schema.Number,
  /** macOS blur behind the window; ignored elsewhere. */
  blur: Schema.Boolean,
  /** Layout animations (`@tmuxy-animations`): pane morphs, swaps, resizes, float keyframes. */
  animations: Schema.Boolean,
  /** Whether the cursor blinks (`@tmuxy-cursor-blink`), unless the app asks for a steady one. */
  cursorBlink: Schema.Boolean,
  /** Cards per row in the "all tabs" view (`@tmuxy-tab-overview-cols`), 1–12. */
  tabOverviewCols: Schema.Number,
  /** Two-finger slide switches tabs (`@tmuxy-gesture-swipe-tabs`). */
  gestureSwipeTabs: Schema.Boolean,
  /** Pinch out zooms a pane, pinch in unzooms (`@tmuxy-gesture-pinch-zoom`). */
  gesturePinchZoom: Schema.Boolean,
  /** Pinch in opens the "all tabs" view (`@tmuxy-gesture-pinch-overview`). */
  gesturePinchOverview: Schema.Boolean,
});
export type Appearance = Schema.Schema.Type<typeof Appearance>;

/** `get_theme_settings` answer and `theme-settings` push. */
export const ThemeSettings = Schema.Struct({
  theme: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  appearance: Schema.optional(Appearance),
});
export type ThemeSettings = Schema.Schema.Type<typeof ThemeSettings>;

/** Kind of a streamed connection-log line (matches `LogKind` in Rust). */
export const LogEntryKind = Schema.Literal('command', 'output', 'info', 'error');
export type LogEntryKind = Schema.Schema.Type<typeof LogEntryKind>;

/** A streamed connection-log line (SSE `log`, desktop `tmux-log`). */
export const LogEvent = Schema.Struct({ kind: LogEntryKind, message: Schema.String });

/** A message-only event: SSE `tmux-error` / `fatal`, desktop `tmux-fatal`. */
export const MessageFrame = Schema.Struct({ message: Schema.String });

/** The connection ended, with tmux's `%exit` reason when it gave one. */
export const DetachedEvent = Schema.Struct({ reason: Schema.NullishOr(Schema.String) });

/** The pane a clipboard write came from; the paste-buffer mirror has none and sends `''`. */
const ClipboardSource = Schema.transform(
  Schema.Union(Schema.Literal(''), PaneId),
  Schema.NullOr(Schema.typeSchema(PaneId)),
  {
    strict: true,
    decode: (id) => (id === '' ? null : id),
    encode: (id) => id ?? '',
  },
);

/** A clipboard write: an OSC 52 sequence from a pane, or the tmux paste buffer (no pane). */
export const ClipboardEvent = Schema.Struct({ pane_id: ClipboardSource, text: Schema.String });

/** A `get_scrollback_cells` answer: a slice of a pane's history. */
export const ScrollbackCells = Schema.Struct({
  cells: PaneContent,
  historySize: Schema.Number,
  start: Schema.Number,
  end: Schema.Number,
  width: Schema.Number,
});
export type ScrollbackCells = Schema.Schema.Type<typeof ScrollbackCells>;

// ============================================
// Command failures
// ============================================

/**
 * Why the backend refused a command: `tmux` — tmux itself rejected it (a
 * query answered with `%error`); `unavailable` — no tmux connection to run
 * it on; `invalid` — the request was malformed or named an unknown command;
 * `forbidden` — the server's policy refuses it (a read-only server).
 */
export const CommandFailureKind = Schema.Literal('tmux', 'unavailable', 'invalid', 'forbidden');
export type CommandFailureKind = Schema.Schema.Type<typeof CommandFailureKind>;

/** The body of a failed `POST /commands`, and the rejection of a desktop command. */
export const CommandFailure = Schema.Struct({
  error: Schema.String,
  kind: CommandFailureKind,
});
export type CommandFailure = Schema.Schema.Type<typeof CommandFailure>;
