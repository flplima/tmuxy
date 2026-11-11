/**
 * What a key typed in the palette's box means to its list. The text keys
 * are not here: they are the box's own.
 */

import { isPaletteChord } from '../../machines/actors/keyboard/keyFormatting';

export type PaletteKey =
  | { kind: 'close' }
  | { kind: 'run' }
  /** The keyboard stays in the box: nothing happens, and nothing else gets the key. */
  | { kind: 'stay' }
  | { kind: 'step'; by: 1 | -1 }
  | { kind: 'page'; by: 1 | -1 }
  | { kind: 'end'; which: 'first' | 'last' };

type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** Down or up, for a key that moves the highlight; 0 for one that does not. */
function direction(event: Key): 1 | -1 | 0 {
  const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  // The arrows, and the two pairs a terminal user's hands already know.
  if (event.key === 'ArrowDown' || (ctrl && (event.key === 'j' || event.key === 'n'))) return 1;
  if (event.key === 'ArrowUp' || (ctrl && (event.key === 'k' || event.key === 'p'))) return -1;
  return 0;
}

function moveOf(event: Key): PaletteKey | null {
  if (event.key === 'PageDown') return { kind: 'page', by: 1 };
  if (event.key === 'PageUp') return { kind: 'page', by: -1 };
  const by = direction(event);
  if (by === 0) return null;
  const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
  // Cmd with an arrow jumps to an end of the list, Alt moves by a page.
  if (arrow && event.metaKey) return { kind: 'end', which: by === 1 ? 'last' : 'first' };
  if (arrow && event.altKey) return { kind: 'page', by };
  return { kind: 'step', by };
}

/** Null for a key that is the text box's own. */
export function paletteKeyOf(event: Key): PaletteKey | null {
  // The chord that opened the palette closes it, as Escape does.
  if (isPaletteChord(event) || event.key === 'Escape') return { kind: 'close' };
  if (event.key === 'Enter') return { kind: 'run' };
  if (event.key === 'Tab') return { kind: 'stay' };
  return moveOf(event);
}
