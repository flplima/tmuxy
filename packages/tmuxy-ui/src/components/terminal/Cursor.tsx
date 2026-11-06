import './Cursor.css';
import { cellsToCss } from './terminalShared';
import { attachCursorAnchor } from './cursorAnchor';
import { TERMINAL_CURSOR } from '../../infra/dom/terminalDom';

export type CursorMode = 'block' | 'underline' | 'bar';

interface CursorProps {
  x: number;
  y: number;
  char?: string;
  mode?: CursorMode;
  copyMode?: boolean;
  /** A class, not an animation: SmoothCursor paints the cursor and reads the flag off this element. */
  blink?: boolean;
}

/**
 * An overlay addressed by cell, never spliced into the line's text: there its
 * position depended on the glyphs' advance and on UTF-16 offsets, and a cell
 * holding several code units pushed it off the grid.
 */
export function Cursor({
  x,
  y,
  char = ' ',
  mode = 'block',
  copyMode = false,
  blink = false,
}: CursorProps) {
  const className = [
    TERMINAL_CURSOR,
    `${TERMINAL_CURSOR}-${mode}`,
    copyMode ? 'terminal-cursor-copy' : '',
    blink ? 'terminal-cursor-blink' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style: React.CSSProperties = {
    left: cellsToCss(x),
    top: `calc(${y} * var(--line-height-terminal))`,
    width: cellsToCss(1),
    height: 'var(--line-height-terminal)',
  };

  // A block's opaque background hides the glyph, so it draws it back; an
  // underline or bar over the glyph would double-draw it.
  const paintsChar = mode === 'block';

  return (
    <span
      // The anchor SmoothCursor glides to. A fresh callback every render makes
      // React re-attach it on every commit, which is how a move is noticed.
      ref={(el) => (el ? attachCursorAnchor(el) : undefined)}
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
