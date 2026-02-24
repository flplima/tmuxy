export type CursorMode = 'block' | 'underline' | 'bar';

interface CursorProps {
  x: number;
  y: number;
  char?: string;
  mode?: CursorMode;
  blink?: boolean;
  active?: boolean;
  copyMode?: boolean;
}

/**
 * Terminal cursor component
 * Renders as an overlay positioned by character coordinates
 */
export function Cursor({
  x,
  y,
  char = ' ',
  mode = 'block',
  blink = false,
  active = true,
  copyMode = false,
}: CursorProps) {
  const className = [
    'tmuxy-cursor',
    `tmuxy-cursor-${mode}`,
    blink && active ? 'tmuxy-cursor-blink' : '',
    copyMode ? 'tmuxy-cursor-copy' : '',
    !active ? 'tmuxy-cursor-inactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={className} data-cursor-x={x} data-cursor-y={y} aria-hidden="true">
      {char}
    </span>
  );
}
