/**
 * The cell size in CSS pixels that programs in panes are told
 * (`@tmuxy-cell-px`, docs/MOUSE.md): how this client writes it, when, and
 * how its pixel mouse reports are scaled to it.
 *
 * Every client measures its own cell; the one that measured last wins. A
 * program counts pixels in the announced cell, so a client whose cell differs
 * scales its reports to it, and the program's arithmetic holds whoever
 * clicks.
 */

export interface CellPx {
  readonly width: number;
  readonly height: number;
}

/** One side, up to two decimals and no trailing zeros: `9`, `8.5`, `8.53`. */
const side = (px: number): string => String(Math.round(px * 100) / 100);

/** The option's value for a cell: `9x24`, `8.5x17`. */
export function formatCellPx(width: number, height: number): string {
  return `${side(width)}x${side(height)}`;
}

/** `<width>x<height>`, both positive; null for anything else (`''` too). */
export function parseCellPx(value: string): CellPx | null {
  const match = /^(\d+(?:\.\d{1,2})?)x(\d+(?:\.\d{1,2})?)$/.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Whether this client announces its cell now, and what it has claimed after.
 *
 * `own` is this client's cell, formatted; `announced` the option as tmux
 * holds it (`''` unset); `claimed` what this client last announced or found
 * already announced on this connection (null before it has). The first time,
 * the client writes when the option is unset or differs; after that, only
 * when its own cell changes. A change of `announced` alone never writes: two
 * clients with different cells would otherwise rewrite it at each other
 * forever. The last to measure wins.
 */
export function cellSizeClaim(
  own: string,
  announced: string,
  claimed: string | null,
): { write: boolean; claimed: string } {
  if (own === claimed) return { write: false, claimed };
  return { write: claimed !== null || own !== announced, claimed: own };
}

/**
 * A pointer offset in this client's CSS pixels, counted in the announced
 * cell: `offset × announced / own`, per axis. Unscaled with no size announced,
 * or when the announced one is this client's own (as formatted, so a cell of
 * 8.5333 px announced as 8.53 is the same cell).
 */
export function scaleToAnnounced(
  offset: { x: number; y: number },
  own: { width: number; height: number },
  announced: string,
): { x: number; y: number } {
  const cell = parseCellPx(announced);
  if (!cell || formatCellPx(own.width, own.height) === announced) return offset;
  return {
    x: (offset.x * cell.width) / own.width,
    y: (offset.y * cell.height) / own.height,
  };
}
