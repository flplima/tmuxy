import './Cursor.css';

export type CursorMode = 'block' | 'underline' | 'bar';

interface CursorProps {
  x: number;
  y: number;
  char?: string;
  mode?: CursorMode;
  active?: boolean;
  copyMode?: boolean;
  charWidth?: number;
  charHeight?: number;
  /**
   * Position on the cell grid with CSS units instead of measured pixels.
   * `1ch` is the monospace advance the terminal rows are already pinned to
   * (`width: Nch` per style-group span), so the cursor lands on exactly the
   * same grid the content uses — independent of glyph advance, font fallback
   * and webfont load timing. Used by Terminal (live mode).
   */
  gridUnits?: boolean;
}

/**
 * Terminal cursor component.
 *
 * The cursor is always an absolutely positioned overlay addressed by CELL
 * coordinates — never spliced into the line's text. Splicing made its position
 * depend on the natural advance of the glyphs before it and on UTF-16 indexing
 * of the cell run, so a cell holding more than one code unit (variation
 * selectors, combining marks) or a glyph whose advance differs from the cell
 * pushed the cursor off the grid.
 *
 * Two ways to place the overlay:
 * - Grid units (`gridUnits`): `ch` / `--line-height-terminal` (Terminal)
 * - Measured pixels (charWidth/charHeight): (ScrollbackTerminal, copy mode)
 */
export function Cursor({
  x,
  y,
  char = ' ',
  mode = 'block',
  active = true,
  copyMode = false,
  charWidth,
  charHeight,
  gridUnits = false,
}: CursorProps) {
  const isPixelOverlay = charWidth !== undefined && charHeight !== undefined;
  const isOverlay = isPixelOverlay || gridUnits;

  const className = [
    'terminal-cursor',
    `terminal-cursor-${mode}`,
    isOverlay ? 'terminal-cursor-overlay' : '',
    copyMode ? 'terminal-cursor-copy' : '',
    !active ? 'terminal-cursor-inactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  let style: React.CSSProperties | undefined;
  if (gridUnits) {
    style = {
      left: `${x}ch`,
      top: `calc(${y} * var(--line-height-terminal))`,
      width: '1ch',
      height: 'var(--line-height-terminal)',
    };
  } else if (isPixelOverlay) {
    style = { left: x * charWidth, top: y * charHeight };
  }

  // Only a filled block repaints the character. Its background is opaque, so it
  // hides the glyph the line already drew and has to draw it back in the cursor
  // colour. The underline and bar shapes — and the hollow inactive-pane box —
  // are transparent decorations layered over that glyph, so painting the
  // character again would double-draw it, in the container's colour rather than
  // the cell's.
  const paintsChar = mode === 'block' && active;

  return (
    <span
      className={className}
      data-cursor-x={x}
      data-cursor-y={y}
      aria-hidden="true"
      style={style}
    >
      {paintsChar ? char : ' '}
    </span>
  );
}
