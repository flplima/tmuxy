import { describe, expect, it } from 'vitest';
import { pid, wid } from '../../test/wire';
import { dropIndex, overviewSlots, reorderCommand, slotBoxes } from '../tabOverview';
import type { TmuxPane, TmuxWindow } from '../../machines/types';
import { placeholderWindowId, type WindowId } from '../../domain/ids';

const win = (id: WindowId, index: number): TmuxWindow => ({
  id,
  index,
  name: 'sh',
  active: index === 1,
  windowType: 'tab',
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
  sidebarCols: null,
  sidebarHidden: false,
  zoomed: false,
});

const pane = (
  id: string,
  windowId: WindowId,
  x: number,
  y: number,
  w: number,
  h: number,
): TmuxPane =>
  ({
    tmuxId: id,
    windowId,
    x,
    y,
    width: w,
    height: h,
    active: id.endsWith('0'),
    command: 'zsh',
    title: '',
    content: [],
  }) as unknown as TmuxPane;

describe('slotBoxes', () => {
  it('scales a 2×2 grid to percentages of the tab extent, ignoring the border row', () => {
    const panes = [
      pane(pid('%0'), wid('@1'), 0, 1, 69, 14),
      pane(pid('%1'), wid('@1'), 70, 1, 69, 14),
      pane(pid('%2'), wid('@1'), 0, 16, 69, 14),
      pane(pid('%3'), wid('@1'), 70, 16, 69, 14),
      pane(pid('%9'), wid('@2'), 0, 1, 139, 29),
    ];
    const boxes = slotBoxes(panes, wid('@1'));
    expect(boxes).toHaveLength(4);
    const byId = Object.fromEntries(boxes.map((b) => [b.paneId, b]));
    expect(byId[pid('%0')].left).toBe(0);
    expect(byId[pid('%0')].top).toBe(0);
    expect(byId[pid('%1')].left).toBeCloseTo((70 / 139) * 100, 5);
    expect(byId[pid('%2')].top).toBeCloseTo((15 / 29) * 100, 5);
    expect(byId[pid('%3')].width).toBeCloseTo((69 / 139) * 100, 5);
    expect(byId[pid('%0')].active).toBe(true);
  });

  it('drops optimistic placeholder panes and tolerates a tab with no panes yet', () => {
    expect(slotBoxes([pane('__placeholder_1', wid('@1'), 0, 1, 10, 10)], wid('@1'))).toEqual([]);
    expect(slotBoxes([], wid('@1'))).toEqual([]);
  });
});

describe('overviewSlots', () => {
  it('numbers slots by strip position, not tmux index', () => {
    const slots = overviewSlots([win(wid('@0'), 1), win(wid('@9'), 3), win(wid('@16'), 6)], []);
    expect(slots.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(slots.map((s) => s.window.id)).toEqual([wid('@0'), wid('@9'), wid('@16')]);
  });
});

describe('dropIndex', () => {
  const row = (y: number) => [100, 300, 500].map((x) => ({ x, y }));

  it('inserts before the first slot whose centre is right of the pointer', () => {
    expect(dropIndex(row(50), { x: 90, y: 50 })).toBe(0);
    expect(dropIndex(row(50), { x: 250, y: 50 })).toBe(1);
    expect(dropIndex(row(50), { x: 450, y: 50 })).toBe(2);
    expect(dropIndex(row(50), { x: 600, y: 50 })).toBe(3);
  });

  it('honours rows in a wrapped grid', () => {
    const centers = [...row(50), ...row(250)];
    // Pointer on the second row, left of its first slot → first slot of row 2.
    expect(dropIndex(centers, { x: 50, y: 250 })).toBe(3);
    // Pointer between rows lands in the nearer row.
    expect(dropIndex(centers, { x: 50, y: 140 })).toBe(0);
    expect(dropIndex(centers, { x: 50, y: 160 })).toBe(3);
    // Past the last slot of the first row: after it, not at the grid's end.
    expect(dropIndex(centers, { x: 600, y: 50 })).toBe(3);
  });
});

describe('reorderCommand', () => {
  const tabs = [win(wid('@0'), 1), win(wid('@1'), 2), win(wid('@2'), 3)];

  it('inserts before the window that will follow', () => {
    expect(reorderCommand(tabs, wid('@2'), 0)).toBe('move-window -b -s @2 -t @0');
    expect(reorderCommand(tabs, wid('@0'), 1)).toBe('move-window -b -s @0 -t @2');
  });

  it('appends after the last window when dropped at the end', () => {
    expect(reorderCommand(tabs, wid('@0'), 2)).toBe('move-window -a -s @0 -t @2');
    expect(reorderCommand(tabs, wid('@0'), 99)).toBe('move-window -a -s @0 -t @2');
  });

  it('is a no-op when the slot does not move or the window is unknown', () => {
    expect(reorderCommand(tabs, wid('@1'), 1)).toBeNull();
    expect(reorderCommand(tabs, wid('@7'), 0)).toBeNull();
  });

  it('never targets an optimistic placeholder tab, as source or as neighbour', () => {
    const withPlaceholder = [...tabs, win(placeholderWindowId('op_1_2'), 4)];
    expect(reorderCommand(withPlaceholder, placeholderWindowId('op_1_2'), 0)).toBeNull();
    // Dropping at the end lands after the last REAL tab, not after the placeholder.
    expect(reorderCommand(withPlaceholder, wid('@0'), 3)).toBe('move-window -a -s @0 -t @2');
  });
});
