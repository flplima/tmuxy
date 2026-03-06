import './Cursor.css';

export type CursorMode = 'block' | 'underline' | 'bar';

interface CursorProps {
  x: number;
  y: number;
  char?: string;
  mode?: CursorMode;
  blink?: boolean;
  active?: boolean;
  copyMode?: boolean;
  charWidth?: number;
  charHeight?: number;
}

/**
 * Terminal cursor component.
 *
 * Two rendering modes:
 * - Overlay (charWidth/charHeight provided): absolutely positioned over terminal content
 * - Inline (no charWidth/charHeight): rendered inline within text (used by ScrollbackTerminal)
 */
export function Cursor({
  x,
  y,
  char = ' ',
  mode = 'block',
  blink = false,
  active = true,
  copyMode = false,
  charWidth,
  charHeight,
}: CursorProps) {
  const isOverlay = charWidth !== undefined && charHeight !== undefined;

  const className = [
    'terminal-cursor',
    `terminal-cursor-${mode}`,
    isOverlay ? 'terminal-cursor-overlay' : '',
    blink && active ? 'terminal-cursor-blink' : '',
    copyMode ? 'terminal-cursor-copy' : '',
    !active ? 'terminal-cursor-inactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style: React.CSSProperties | undefined = isOverlay
    ? { left: x * charWidth, top: y * charHeight }
    : undefined;

  return (
    <span
      className={className}
      data-cursor-x={x}
      data-cursor-y={y}
      aria-hidden="true"
      style={style}
    >
      {char}
    </span>
  );
}
