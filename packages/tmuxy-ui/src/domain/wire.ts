/**
 * The wire: every shape the backend sends the client, as Effect Schemas.
 *
 * Single definition of the protocol on the TypeScript side (`Schema.Schema.Type<…>`),
 * mirroring `tmuxy-core` (`TmuxState`, `TmuxPane`, `TmuxWindow`, `TmuxDelta`,
 * `PaneDelta`, `WindowDelta`, `KeyBindings`, `theme::Appearance`) and `tmuxy-server/src/sse.rs`.
 * Committed `packages/protocol-fixtures` decode through these schemas.
 *
 * Payloads decode once at entry (`infra/transport/wireDecode.ts`) with branded IDs (`domain/ids.ts`).
 * Pane content is checked for outer shape only (array of rows) on the hot path.
 */

import { Schema } from 'effect';
import { GroupId, PaneId, WindowId } from './ids';
import { PaneContent, SparseContent } from './wireCells';

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
  /** Fill the cells instead of fitting inside them (`preserveAspectRatio=0`); absent = fit. */
  stretch: Schema.optional(Schema.Boolean),
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
   * own — see `findPaneWidget` (paneWidget.ts).
   */
  pane_widget: OptionalNull(Schema.String),
  /** `@tmuxy-pane-restore`: the line a session restore types to bring the pane back. */
  pane_restore: OptionalNull(Schema.String),
});
export type WirePane = Schema.Schema.Type<typeof WirePane>;
/** A pane before decoding: what a sandbox engine or a fixture builds. */
export type WirePaneEncoded = Schema.Schema.Encoded<typeof WirePane>;

/**
 * A window's split structure without sizes: a pane, or panes split side by
 * side (`vertical: false`) or stacked (`vertical: true`). What a divider drag
 * moves follows it (`machines/resize/limits.ts`).
 */
export type PaneTree =
  | PaneId
  | { readonly vertical: boolean; readonly children: readonly PaneTree[] };
type PaneTreeEncoded =
  | string
  | { readonly vertical: boolean; readonly children: readonly PaneTreeEncoded[] };
export const PaneTree: Schema.Schema<PaneTree, PaneTreeEncoded> = Schema.Union(
  PaneId,
  Schema.Struct({
    vertical: Schema.Boolean,
    children: Schema.Array(Schema.suspend(() => PaneTree)),
  }),
);

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
  pane_tree: OptionalNull(PaneTree),
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
   * column, `panes` to leave one. Set by `packages/tmuxy-cli/bin/tmuxy/nav` when a directional
   * `select-pane` is a no-op at the grid's edge. The client that acts on it
   * unsets the tmux option, which clears the field on the next poll.
   */
  focus_request: Schema.optional(Schema.String),
  /** `@tmuxy-plugins-rev`: a new value has the client re-read the plugins. */
  plugins_rev: Schema.optional(Schema.String),
  /**
   * `<@tmuxy-theme>:<@tmuxy-theme-mode>`: a new value — a theme picked on any
   * client — has the client re-read the theme settings.
   */
  theme_rev: Schema.optional(Schema.String),
  /**
   * The stream's counter when this state was taken: the delta that follows
   * it carries `seq + 1`, so a delta lost right after a full state or an
   * adopted answer is a gap like any other. Absent from a state no stream
   * numbers (a fixture, an engine); the next delta then starts the count.
   */
  seq: Schema.optional(Schema.Number),
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
  pane_tree: OptionalNull(PaneTree),
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
  /** See `ServerState.plugins_rev`; `''` when gone. */
  plugins_rev: Schema.optional(Schema.String),
  /** See `ServerState.theme_rev`; `''` when gone. */
  theme_rev: Schema.optional(Schema.String),
  total_width: Schema.optional(Schema.Number),
  total_height: Schema.optional(Schema.Number),
});
export type ServerDelta = Schema.Schema.Type<typeof ServerDelta>;

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
  /** The server machine's name, for the status line's host label. */
  hostname: Schema.optional(Schema.String),
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

/**
 * The prefix key and the key tables: prefix and root, and by name every other
 * table a binding can enter with `switch-client -T` (the sticky PANE and TAB
 * modes among them).
 */
export const KeyBindings = Schema.Struct({
  prefix_key: Schema.String,
  prefix_bindings: Schema.Array(KeyBinding),
  root_bindings: Schema.Array(KeyBinding),
  tables: Schema.Record({ key: Schema.String, value: Schema.Array(KeyBinding) }),
});
export type KeyBindings = Schema.Schema.Type<typeof KeyBindings>;

/**
 * Surface opacities, native blur and the other `@tmuxy-*` appearance options,
 * the same on every transport — mirrors `tmuxy_core::theme::Appearance`.
 */
/**
 * `@tmuxy-size`: how the session is sized across clients of different
 * viewports (`tmuxy-core/src/client_size.rs`). Every mode but `smallest`
 * scales the client's grid to fit the window tmux was given.
 */
export const SizePolicy = Schema.Union(
  Schema.Struct({ mode: Schema.Literal('smallest', 'largest', 'latest') }),
  Schema.Struct({ mode: Schema.Literal('fixed'), cols: Schema.Number, rows: Schema.Number }),
);
export type SizePolicy = Schema.Schema.Type<typeof SizePolicy>;

export const Appearance = Schema.Struct({
  /** Window chrome: title bar, sidebar, the gaps between panes. */
  opacity: Schema.Number,
  activePaneOpacity: Schema.Number,
  inactivePaneOpacity: Schema.Number,
  activeTextOpacity: Schema.Number,
  inactiveTextOpacity: Schema.Number,
  /** macOS blur behind the window; ignored elsewhere. */
  blur: Schema.Boolean,
  /**
   * Whether the window is see-through at all (`@tmuxy-transparency`): off
   * paints the surfaces opaque and clears the blur. Absent from older servers.
   */
  transparency: Schema.optional(Schema.Boolean),
  /** Layout animations (`@tmuxy-animations`): pane morphs, swaps, resizes, float keyframes. */
  animations: Schema.Boolean,
  /** Whether the cursor blinks (`@tmuxy-cursor-blink`), unless the app asks for a steady one. */
  cursorBlink: Schema.Boolean,
  /** Whether a send into another pane asks there first (`@tmuxy-send-ask`). */
  sendAsk: Schema.Boolean,
  /** Whether a pane needing the user is pushed as a notification (`@tmuxy-notify`); absent from older servers. */
  notify: Schema.optional(Schema.Boolean),
  /** Cards per row in the "all tabs" view (`@tmuxy-tab-overview-cols`), 1–12. */
  tabOverviewCols: Schema.Number,
  /** Two-finger slide switches tabs (`@tmuxy-gesture-swipe-tabs`). */
  gestureSwipeTabs: Schema.Boolean,
  /** Pinch out zooms a pane, pinch in unzooms (`@tmuxy-gesture-pinch-zoom`). */
  gesturePinchZoom: Schema.Boolean,
  /** Pinch in opens the "all tabs" view (`@tmuxy-gesture-pinch-overview`). */
  gesturePinchOverview: Schema.Boolean,
  /** The desktop app draws its menus natively (`@tmuxy-native-menus`); absent from older servers. */
  nativeMenus: Schema.optional(Schema.Boolean),
  /** `@tmuxy-size`; absent from older servers, which size to the smallest client. */
  size: Schema.optional(SizePolicy),
});
export type Appearance = Schema.Schema.Type<typeof Appearance>;

/** The config's process icons: what each process wears, text or an SVG `data:` URL. */
export const ProcessIcons = Schema.Record({ key: Schema.String, value: Schema.String });
export type ProcessIcons = Schema.Schema.Type<typeof ProcessIcons>;

/** `get_theme_settings` answer and `theme-settings` push. */
export const ThemeSettings = Schema.Struct({
  theme: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  appearance: Schema.optional(Appearance),
  /** The `@tmuxy-css-<name>` options: `--<name>` declared over the theme, under `custom.css`. */
  cssVars: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** `@tmuxy-icon-<process>`: ASCII text, or an SVG as a `data:` URL. */
  icons: Schema.optional(ProcessIcons),
  pinned: Schema.optional(Schema.Array(Schema.String)),
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

/** A message tmux showed this client (`display-message`): SSE and desktop `tmux-message`. */
export const TmuxMessageEvent = Schema.Struct({ text: Schema.String });

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
 * `forbidden` — the server's policy refuses it (a command a client may not
 * send, such as a direct `resize-window`).
 */
export const CommandFailureKind = Schema.Literal('tmux', 'unavailable', 'invalid', 'forbidden');
export type CommandFailureKind = Schema.Schema.Type<typeof CommandFailureKind>;

/** The body of a failed `POST /commands`, and the rejection of a desktop command. */
export const CommandFailure = Schema.Struct({
  error: Schema.String,
  kind: CommandFailureKind,
});
export type CommandFailure = Schema.Schema.Type<typeof CommandFailure>;
