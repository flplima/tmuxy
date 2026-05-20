/**
 * Effect Schema definitions for the SSE / IPC protocol shapes.
 *
 * These mirror the Rust types in packages/tmuxy-server (and tmuxy-core)
 * by hand. The point of decoding through Schema rather than trusting the
 * raw JSON is that any drift between the Rust wire format and the TS
 * consumer is caught at the protocol boundary and surfaced as a typed
 * ProtocolError rather than blowing up deep inside deltaProtocol.ts.
 *
 * The decoded types are inferred (`Schema.Schema.Type<typeof Foo>`) — the
 * existing hand-written interfaces in ../types.ts are still authoritative
 * for now, and we cross-check that the schemas match them via a type
 * assertion at the end of this file.
 */

import { Schema } from 'effect';

/** Color: indexed (0-255) or RGB. */
export const CellColor = Schema.Union(
  Schema.Number,
  Schema.Struct({ r: Schema.Number, g: Schema.Number, b: Schema.Number }),
);

/** Cell style — every field optional. */
export const CellStyle = Schema.Struct({
  fg: Schema.optional(CellColor),
  bg: Schema.optional(CellColor),
  bold: Schema.optional(Schema.Boolean),
  dim: Schema.optional(Schema.Boolean),
  italic: Schema.optional(Schema.Boolean),
  underline: Schema.optional(Schema.Boolean),
  inverse: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
});

/** A single terminal cell. */
export const TerminalCell = Schema.Struct({
  c: Schema.String,
  s: Schema.optional(CellStyle),
});

/** A line of cells. */
export const CellLine = Schema.Array(TerminalCell);

/** Full pane content: array of lines. */
export const PaneContent = Schema.Array(CellLine);

/** Image placement on the terminal grid. */
export const ServerImagePlacement = Schema.Struct({
  id: Schema.Number,
  row: Schema.Number,
  col: Schema.Number,
  width_cells: Schema.Number,
  height_cells: Schema.Number,
  protocol: Schema.Union(Schema.Literal('iterm2'), Schema.Literal('sixel')),
});

/** Full pane snapshot from the server. */
export const ServerPane = Schema.Struct({
  id: Schema.Number,
  tmux_id: Schema.String,
  window_id: Schema.String,
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
  in_mode: Schema.Boolean,
  copy_cursor_x: Schema.Number,
  copy_cursor_y: Schema.Number,
  alternate_on: Schema.optional(Schema.Boolean),
  mouse_any_flag: Schema.optional(Schema.Boolean),
  paused: Schema.optional(Schema.Boolean),
  history_size: Schema.optional(Schema.Number),
  selection_present: Schema.optional(Schema.Boolean),
  selection_start_x: Schema.optional(Schema.Number),
  selection_start_y: Schema.optional(Schema.Number),
  images: Schema.optional(Schema.Array(ServerImagePlacement)),
  cursor_shape: Schema.optional(Schema.Number),
  cursor_hidden: Schema.optional(Schema.Boolean),
});

/** Window type set on @tmuxy-window-type. Null = foreign window. */
export const WindowType = Schema.Literal('tab', 'float', 'float-backdrop', 'group');

/** Window metadata. */
export const ServerWindow = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  name: Schema.String,
  active: Schema.Boolean,
  window_type: Schema.optional(Schema.NullOr(WindowType)),
  group_panes: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  float_parent: Schema.optional(Schema.NullOr(Schema.String)),
  float_width: Schema.optional(Schema.NullOr(Schema.Number)),
  float_height: Schema.optional(Schema.NullOr(Schema.Number)),
  float_drawer: Schema.optional(Schema.NullOr(Schema.String)),
  float_bg: Schema.optional(Schema.NullOr(Schema.String)),
  float_noheader: Schema.optional(Schema.Boolean),
});

/** Full server state snapshot. */
export const ServerState = Schema.Struct({
  session_name: Schema.String,
  active_window_id: Schema.NullOr(Schema.String),
  active_pane_id: Schema.NullOr(Schema.String),
  panes: Schema.Array(ServerPane),
  windows: Schema.Array(ServerWindow),
  total_width: Schema.Number,
  total_height: Schema.Number,
  status_line: Schema.String,
});

/**
 * Per-pane delta — every field optional. `content` is a sparse map of
 * line index → CellLine (only changed lines).
 */
export const PaneDelta = Schema.Struct({
  window_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Record({ key: Schema.String, value: CellLine })),
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
  in_mode: Schema.optional(Schema.Boolean),
  copy_cursor_x: Schema.optional(Schema.Number),
  copy_cursor_y: Schema.optional(Schema.Number),
  alternate_on: Schema.optional(Schema.Boolean),
  mouse_any_flag: Schema.optional(Schema.Boolean),
  paused: Schema.optional(Schema.Boolean),
  history_size: Schema.optional(Schema.Number),
  selection_present: Schema.optional(Schema.Boolean),
  selection_start_x: Schema.optional(Schema.Number),
  selection_start_y: Schema.optional(Schema.Number),
  images: Schema.optional(Schema.Array(ServerImagePlacement)),
  cursor_shape: Schema.optional(Schema.Number),
  cursor_hidden: Schema.optional(Schema.Boolean),
});

/** Per-window delta — every field optional. */
export const WindowDelta = Schema.Struct({
  name: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  window_type: Schema.optional(Schema.NullOr(WindowType)),
  group_panes: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  float_parent: Schema.optional(Schema.NullOr(Schema.String)),
  float_width: Schema.optional(Schema.NullOr(Schema.Number)),
  float_height: Schema.optional(Schema.NullOr(Schema.Number)),
  float_drawer: Schema.optional(Schema.NullOr(Schema.String)),
  float_bg: Schema.optional(Schema.NullOr(Schema.String)),
  float_noheader: Schema.optional(Schema.Boolean),
});

/** Server delta envelope. `null` value in panes/windows means removed. */
export const ServerDelta = Schema.Struct({
  seq: Schema.Number,
  panes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.NullOr(PaneDelta) })),
  windows: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.NullOr(WindowDelta) }),
  ),
  new_panes: Schema.optional(Schema.Array(ServerPane)),
  new_windows: Schema.optional(Schema.Array(ServerWindow)),
  active_window_id: Schema.optional(Schema.String),
  active_pane_id: Schema.optional(Schema.String),
  status_line: Schema.optional(Schema.String),
  total_width: Schema.optional(Schema.Number),
  total_height: Schema.optional(Schema.Number),
});

/** Tagged-union top-level SSE payload. */
export const StateUpdate = Schema.Union(
  Schema.Struct({ type: Schema.Literal('full'), state: ServerState }),
  Schema.Struct({ type: Schema.Literal('delta'), delta: ServerDelta }),
);

/** Individual keybinding entry. */
export const KeyBinding = Schema.Struct({
  key: Schema.String,
  command: Schema.String,
  description: Schema.String,
  repeat: Schema.optional(Schema.Boolean),
});

/** Full keybindings payload from the server. */
export const KeyBindings = Schema.Struct({
  prefix_key: Schema.String,
  prefix_bindings: Schema.Array(KeyBinding),
  root_bindings: Schema.Array(KeyBinding),
});

// Schema-derived TS types. The existing hand-written interfaces in
// ../types.ts remain the public contract — these are used only by
// decoders below to keep the protocol boundary type-safe.
export type ServerStateSchema = Schema.Schema.Type<typeof ServerState>;
export type ServerDeltaSchema = Schema.Schema.Type<typeof ServerDelta>;
export type StateUpdateSchema = Schema.Schema.Type<typeof StateUpdate>;
export type KeyBindingsSchema = Schema.Schema.Type<typeof KeyBindings>;
