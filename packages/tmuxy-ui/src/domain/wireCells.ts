/**
 * The cell grid on the wire: a terminal cell, its style and colours, a pane's
 * rows and a delta's changed rows. Part of the wire schemas (`wire.ts`, which
 * re-exports all of it); the grid is checked for its outer shape only, on the
 * hot path.
 */

import { Schema } from 'effect';

/** A colour: an indexed one (0-255) or RGB. */
export const CellColor = Schema.Union(
  Schema.Number,
  Schema.Struct({ r: Schema.Number, g: Schema.Number, b: Schema.Number }),
);
export type CellColor = Schema.Schema.Type<typeof CellColor>;

/** Line/character size multiplier (`ESC # 3..6` DEC line sizes or `OSC 66` text sizing). */
export const CellSize = Schema.Literal('dwl', 'dhl-top', 'dhl-bottom');
export type CellSize = Schema.Schema.Type<typeof CellSize>;

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
    size: Schema.optional(CellSize),
  }),
);
export type CellStyle = Schema.Schema.Type<typeof CellStyle>;

export const TerminalCell = Schema.Struct({
  c: Schema.String,
  s: Schema.optional(CellStyle),
});
export type TerminalCell = Schema.Schema.Type<typeof TerminalCell>;

export const CellLine = Schema.mutable(Schema.Array(TerminalCell));
export type CellLine = Schema.Schema.Type<typeof CellLine>;
export type PaneContent = CellLine[];

/** The cell grid, checked for its outer shape only (see the module note). */
export const PaneContent = Schema.declare((u: unknown): u is PaneContent => Array.isArray(u), {
  identifier: 'PaneContent',
});

/** Keyed by row index (JSON object keys are strings). */
export type SparseContent = Record<number, CellLine>;

export const SparseContent = Schema.declare(
  (u: unknown): u is SparseContent => typeof u === 'object' && u !== null && !Array.isArray(u),
  { identifier: 'SparseContent' },
);
