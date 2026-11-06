import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor, sendTo, setup } from 'xstate';
import { dragMachine, SWAP_DWELL_MS } from '../dragMachine';
import type { DragMachineEvent, DragState } from '../../types/domain';
import type { TmuxPane } from '../../../domain/client';
import { centeringOffset, gridExtent, gridPixelSize, paneBox } from '../../../domain/paneGeometry';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';
import { pid, wid } from '../../../test/wire';

const CW = 10;
const CH = 20;
const CONTAINER_WIDTH = 1000;

const last = <T>(xs: T[]): T => xs[xs.length - 1];

const pane = (id: string, x: number, width: number): TmuxPane =>
  ({ tmuxId: pid(id), windowId: wid('@1'), x, y: 1, width, height: 20 }) as TmuxPane;

type ParentEvent =
  | { type: 'DRAG_STATE_UPDATE'; drag: DragState | null }
  | { type: 'DISPATCH_OP'; op: TmuxOp }
  | { type: 'FORWARD'; inner: DragMachineEvent };

/** A parent that forwards drag events to the machine and records what it reports back. */
function startDrag(panes: TmuxPane[]) {
  const updates: (DragState | null)[] = [];
  const ops: TmuxOp[] = [];
  const parent = setup({
    types: { events: {} as ParentEvent },
    actors: { drag: dragMachine },
  }).createMachine({
    invoke: { id: 'drag', src: 'drag' },
    on: {
      DRAG_STATE_UPDATE: { actions: ({ event }) => updates.push(event.drag) },
      DISPATCH_OP: { actions: ({ event }) => ops.push(event.op) },
      FORWARD: { actions: sendTo('drag', ({ event }) => event.inner) },
    },
  });
  const actor = createActor(parent).start();
  const send = (inner: DragMachineEvent) => actor.send({ type: 'FORWARD', inner });
  send({
    type: 'DRAG_START',
    paneId: panes[0].tmuxId,
    startX: 0,
    startY: 0,
    panes,
    charWidth: CW,
    charHeight: CH,
    containerWidth: CONTAINER_WIDTH,
    containerLeft: 0,
    containerTop: 0,
    tabStrip: null,
    paneWindowId: wid('@1'),
    panesInWindow: panes.length,
    groups: {},
    memberDrag: false,
  });
  return { send, updates, ops, stop: () => actor.stop() };
}

describe('a pane drag hit-tests the grid PaneLayout draws', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('swaps with the pane under the pointer in its drawn box, and keeps its origin through the swap', () => {
    const panes = [pane('%1', 0, 40), pane('%2', 41, 38)];
    // PaneLayout's origin: the active window's extent, centred in the container.
    const grid = gridPixelSize(gridExtent(panes, null, { cols: 0, rows: 0 }).cols, 21, CW, CH);
    const drawn = centeringOffset(CONTAINER_WIDTH, grid.width);
    const target = paneBox(panes[1], CW, CH, drawn.x, drawn.y);
    const { send, updates, ops, stop } = startDrag(panes);
    expect(last(updates)?.origin).toEqual(drawn);

    // Just left of the drawn box is the dragged pane's own: nothing to swap.
    send({ type: 'DRAG_MOVE', clientX: target.left - 1, clientY: target.top + 30 });
    vi.advanceTimersByTime(SWAP_DWELL_MS);
    expect(ops).toEqual([]);

    // Just inside the drawn box, below its header (a header is a group drop).
    send({ type: 'DRAG_MOVE', clientX: target.left + 1, clientY: target.top + CH + 1 });
    vi.advanceTimersByTime(SWAP_DWELL_MS);
    expect(ops.map(toTmuxCommand)).toEqual([expect.stringContaining('swap-pane')]);
    expect(last(updates)?.targetPaneId).toBe(pid('%2'));
    expect(last(updates)?.origin).toEqual(drawn);
    stop();
  });
});
