/**
 * A divider drag's commands, through the app machine as the app runs it: the
 * pointer listener, the resize machine, and the store the commands go to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recorder, startApp } from '../../../test/app';
import { modelPane, modelWindow } from '../../../test/model';
import { pid, wid } from '../../../test/wire';
import { RESIZE_SEND_INTERVAL_MS } from '../resizeMachine';

const LEFT = pid('%0');
const RIGHT = pid('%1');
const TAB = wid('@0');
/** px per column in these tests. */
const CELL = 10;

/** Two panes side by side, the divider between them held at x=400. */
function dragging() {
  const store = recorder();
  const actor = startApp({
    context: {
      panes: [
        modelPane(LEFT, TAB, { x: 0, width: 40, active: true }),
        modelPane(RIGHT, TAB, { x: 41, width: 39 }),
      ],
      windows: [modelWindow(TAB, 0, { active: true })],
      activeWindowId: TAB,
      activePaneId: LEFT,
      totalWidth: 80,
      totalHeight: 24,
      charWidth: CELL,
      charHeight: 20,
    },
    actors: { tmuxStoreActor: store.logic },
  });
  actor.send({ type: 'RESIZE_START', paneId: LEFT, handle: 'e', startX: 400, startY: 100 });
  /** The columns each resize command moved the edge by, right positive. */
  const sent = () =>
    store
      .ops()
      .flatMap((op) =>
        op._tag === 'ResizePanes'
          ? [op.steps.reduce((sum, s) => sum + (s.direction === 'R' ? s.cells : -s.cells), 0)]
          : [],
      );
  return {
    sent,
    /** The pointer `cols` columns right of where the drag began. */
    moveTo: (cols: number) =>
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 + cols * CELL })),
    release: () => window.dispatchEvent(new MouseEvent('mouseup')),
    answer: () => actor.send({ type: 'RESIZE_ANSWERED' }),
    stop: () => actor.stop(),
  };
}

describe('a divider drag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('over a slow link sends a command a round trip, each carrying what the pointer moved meanwhile', () => {
    const drag = dragging();
    drag.moveTo(1);
    expect(drag.sent()).toEqual([1]);

    // A second of dragging while that command's answer is on its way back.
    for (let cols = 2; cols <= 11; cols++) {
      vi.advanceTimersByTime(100);
      drag.moveTo(cols);
    }
    expect(drag.sent()).toEqual([1]);

    // The answer lands with the pointer standing still: the ten columns go
    // at once, as one command.
    drag.answer();
    expect(drag.sent()).toEqual([1, 10]);
    drag.stop();
  });

  it('over a fast link is paced by its interval, as before', () => {
    const drag = dragging();
    // A column every 20ms, each command answered before the next move.
    for (let cols = 1; cols <= 12; cols++) {
      drag.moveTo(cols);
      drag.answer();
      vi.advanceTimersByTime(20);
    }
    // 240ms of dragging: a command at 0, 80 and 160ms.
    expect(drag.sent()).toHaveLength(Math.ceil(240 / RESIZE_SEND_INTERVAL_MS));
    expect(drag.sent().reduce((a, b) => a + b, 0)).toBe(9);
    drag.stop();
  });

  it('sends what is left when the mouse is released, answered or not', () => {
    const drag = dragging();
    drag.moveTo(1);
    vi.advanceTimersByTime(100);
    drag.moveTo(6);
    drag.release();
    expect(drag.sent()).toEqual([1, 5]);
    drag.stop();
  });
});
