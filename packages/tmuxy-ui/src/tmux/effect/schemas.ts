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
 * existing hand-written interfaces in ../types.ts are still authoritative,
 * and the assertion at the end of this file cross-checks that every
 * hand-written ServerState satisfies the schema's decoded type.
 */

import { Schema } from 'effect';
import type { ServerState as HandWrittenServerState } from '../types';

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
  protocol: Schema.Union(
    Schema.Literal('iterm2'),
    Schema.Literal('kitty'),
    Schema.Literal('sixel'),
  ),
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
export const WindowType = Schema.Literal('tab', 'float', 'float-backdrop', 'group', 'sidebar');

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

// Schema-derived TS types. The existing hand-written interfaces in
// ../types.ts remain the public contract — these are used only by
// decoders to keep the protocol boundary type-safe.
export type ServerStateSchema = Schema.Schema.Type<typeof ServerState>;

// Compile-time cross-check: every hand-written ServerState must be accepted
// by the schema's decoded type. If the schema is NARROWER than ../types.ts —
// the kitty-placement bug was exactly this (the schema's protocol union was
// missing 'kitty') — this line fails to compile. (The reverse direction is
// blocked by Schema.Array's readonly arrays; a schema that is WIDER than the
// hand-written type only makes decoding more permissive.)
const _assertHandWrittenSatisfiesSchema: (s: HandWrittenServerState) => ServerStateSchema = (s) =>
  s;
void _assertHandWrittenSatisfiesSchema;
