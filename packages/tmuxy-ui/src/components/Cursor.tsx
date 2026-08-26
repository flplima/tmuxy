import './Cursor.css';
import { cellsToCss } from './terminalShared';

export type CursorMode = 'block' | 'underline' | 'bar';

interface CursorProps {
  x: number;
  y: number;
  char?: string;
  mode?: CursorMode;
  active?: boolean;
  copyMode?: boolean;
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
 * It is placed in grid units — `--cell-w` horizontally (the snapped cell width
 * the style-group spans are pinned to; see utils/cellMetrics.ts) and
 * `--line-height-terminal` vertically — so it lands on exactly the same grid
 * the content uses in both renderers (Terminal and ScrollbackTerminal),
 * independent of glyph advance, font fallback and webfont load timing.
 */
export function Cursor({
  x,
  y,
  char = ' ',
  mode = 'block',
  active = true,
  copyMode = false,
}: CursorProps) {
  const className = [
    'terminal-cursor',
    `terminal-cursor-${mode}`,
    copyMode ? 'terminal-cursor-copy' : '',
    !active ? 'terminal-cursor-inactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style: React.CSSProperties = {
    left: cellsToCss(x),
    top: `calc(${y} * var(--line-height-terminal))`,
    width: cellsToCss(1),
    height: 'var(--line-height-terminal)',
  };

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
