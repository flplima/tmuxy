import type { CursorMode } from './Cursor';

/** DECSCUSR (0-6). */
export function cursorShapeToMode(shape: number): { mode: CursorMode; blink: boolean } {
  switch (shape) {
    case 3:
      return { mode: 'underline', blink: true };
    case 4:
      return { mode: 'underline', blink: false };
    case 5:
      return { mode: 'bar', blink: true };
    case 6:
      return { mode: 'bar', blink: false };
    case 1:
      return { mode: 'block', blink: true };
    case 2:
      return { mode: 'block', blink: false };
    default: // 0: the terminal's default, a blinking block
      return { mode: 'block', blink: true };
  }
}
