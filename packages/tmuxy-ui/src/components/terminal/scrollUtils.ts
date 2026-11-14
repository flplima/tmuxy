import type { AppMachineEvent } from '../../machines/types/events';
import type { PaneId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';

/**
 * The escape protocol has no scroll unit smaller than a row and a trackpad
 * reports pixels, so the sub-row part is carried into the next event: a slow
 * drag still moves.
 */
export function takeWholeRows(
  deltaPixels: number,
  charHeight: number,
  remainder: number,
): { rows: number; remainder: number } {
  if (charHeight <= 0) return { rows: 0, remainder: 0 };
  const total = remainder + deltaPixels;
  const rows = Math.trunc(total / charHeight);
  return { rows, remainder: total - rows * charHeight };
}

/**
 * Lands on a row boundary: a container left mid-row (a `scrollIntoView`, a
 * font-size change) is pulled back onto the grid. The browser clamps the far end.
 */
export function scrollByRows(el: HTMLElement, rows: number, charHeight: number): void {
  if (rows === 0 || charHeight <= 0) return;
  const currentRow = Math.round(el.scrollTop / charHeight);
  el.scrollTop = Math.max(0, currentRow + rows) * charHeight;
}

interface ScrollCommandOptions {
  send: (event: AppMachineEvent) => void;
  paneId: PaneId;
  /** Positive = down. */
  lines: number;
  alternateOn: boolean;
  mouseAnyFlag: boolean;
  /** 0-based cell, for the SGR report. */
  cellX?: number;
  cellY?: number;
}

/**
 * A mouse-tracking application gets SGR wheel reports, even on the alternate
 * screen: arrow keys would move nvim's cursor, not its viewport. The alternate
 * screen without mouse tracking gets Up/Down. False for a pane that is neither.
 */
export function sendScrollLines(opts: ScrollCommandOptions): boolean {
  const { send, paneId, lines, alternateOn, mouseAnyFlag, cellX = 0, cellY = 0 } = opts;

  if (lines === 0) return true;

  if (!alternateOn && !mouseAnyFlag) return false;

  const isScrollUp = lines < 0;
  const absLines = Math.abs(lines);

  if (mouseAnyFlag) {
    // SGR wheel buttons: 64 up, 65 down.
    const button = isScrollUp ? 64 : 65;
    // One op for the whole flick: a report a row, in a single command.
    const report = { button, x: cellX + 1, y: cellY + 1, release: false };
    send({
      type: 'DISPATCH_OP',
      op: TmuxOp.SendMouse({ paneId, reports: Array.from({ length: absLines }, () => report) }),
    });
  } else {
    const key = isScrollUp ? 'Up' : 'Down';
    for (let i = 0; i < absLines; i++) {
      send({ type: 'DISPATCH_OP', op: TmuxOp.SendKeys({ target: paneId, keys: key }) });
    }
  }

  return true;
}
