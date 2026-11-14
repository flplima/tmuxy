/**
 * Numbered jumps: ctrl+1…9 select the Nth tab of the strip, ctrl+alt+1…9 the
 * Nth pane of the tab in front. Holding the chord alone for a moment shows
 * the numbers (`machines/actors/jumpHintsActor.ts`), on the tabs or on the
 * panes, so the user can see where each digit goes before pressing it.
 */

import type { PaneId } from './ids';

/** One number per digit key. */
export const JUMP_HINT_LIMIT = 9;

/** Which numbers a held chord shows: the tabs' (ctrl) or the panes' (ctrl+alt). */
export type JumpHintMode = 'tabs' | 'panes';

interface Modifiers {
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly getModifierState?: (key: string) => boolean;
}

/**
 * The numbers the modifiers held now would jump by, or null for any other
 * chord. AltGr is not a jump: Windows reports it as ctrl+alt, and on many
 * layouts AltGr with a digit types a character (`{ [ ] }` on a German one).
 */
export function jumpHintMode(keys: Modifiers): JumpHintMode | null {
  if (!keys.ctrlKey || keys.metaKey || keys.shiftKey) return null;
  if (keys.getModifierState?.('AltGraph')) return null;
  return keys.altKey ? 'panes' : 'tabs';
}

/**
 * The digit of a jump key, 1…9, read off the physical key: with alt held,
 * macOS reports the character Option makes, not the digit.
 */
export function jumpDigit(code: string): number | null {
  const digit = /^Digit([1-9])$/.exec(code);
  return digit ? Number(digit[1]) : null;
}

/**
 * The panes of the tab in front in the order they are numbered: reading
 * order, top row first, left to right. Only the first nine get a number.
 */
export function paneJumpOrder(
  panes: readonly { readonly tmuxId: PaneId; readonly x: number; readonly y: number }[],
): PaneId[] {
  return [...panes]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, JUMP_HINT_LIMIT)
    .map((pane) => pane.tmuxId);
}
