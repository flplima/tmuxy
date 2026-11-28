/**
 * When a sheet pulled across its height lets go on release: the compose
 * sheet dragged down by its bar (components/phone/ComposeSheet.tsx), and the
 * phone's bottom sheet raised or lowered by its handle (domain/phoneSplit.ts).
 * Past a quarter of its height, or flicked, as a phone's own sheets go.
 * Anything less springs back.
 */

/** Dragged this share of the sheet's height, it closes however slowly. */
export const SHEET_CLOSE_SHARE = 0.25;
/** A flick: still moving down this fast (px/ms) when the finger lifts... */
export const SHEET_FLICK_SPEED = 0.5;
/** ...after at least this far, so a jittery tap on the bar closes nothing. */
export const SHEET_FLICK_DISTANCE = 40;

/**
 * Whether a sheet `height` px tall, pulled down `pulled` px and moving down
 * at `speed` px/ms as the finger lifts, closes.
 */
export function sheetCloses(pulled: number, speed: number, height: number): boolean {
  if (pulled <= 0) return false;
  if (pulled >= height * SHEET_CLOSE_SHARE) return true;
  return pulled >= SHEET_FLICK_DISTANCE && speed >= SHEET_FLICK_SPEED;
}
