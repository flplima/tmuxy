import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { pid } from '../../../test/wire';
import { usePaneMouse } from '../usePaneMouse';
import type { AppMachineEvent } from '../../../machines/types/events';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';

/**
 * The mouse reports a mouse-tracking program reads, as they leave for tmux:
 * cells or pixels (SGR-Pixels, `?1016h`), and the pointer's moves with no
 * button held (any-motion, `?1003h`).
 */

const CHAR_W = 8;
const CHAR_H = 18;
/** Where the cell grid sits on the page. */
const GRID = { left: 10, top: 20 };

/** The SGR bytes the reports carry, read back from the `send-keys -H` hex. */
function reportsOf(events: AppMachineEvent[]): string[] {
  return events
    .filter((e) => e.type === 'DISPATCH_OP')
    .map((e) => {
      const command = toTmuxCommand((e as { op: TmuxOp }).op);
      const hex = command.split(' -H ')[1] ?? '';
      return String.fromCharCode(...hex.split(' ').map((h) => parseInt(h, 16)))
        .split(String.fromCharCode(0x1b))
        .join('^[');
    });
}

interface Flags {
  mouseAnyFlag?: boolean;
  mouseAllFlag?: boolean;
  mousePixelsFlag?: boolean;
}

/** Animation frames, run by hand: `requestAnimationFrame` is stubbed. */
let frames = new Map<number, () => void>();
let nextFrame = 1;
const runFrame = () => {
  const due = [...frames.values()];
  frames = new Map();
  for (const cb of due) cb();
};

beforeEach(() => {
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

function setup(flags: Flags) {
  const events: AppMachineEvent[] = [];
  const contentRef = createRef<HTMLDivElement>();
  const scrollRef = createRef<HTMLDivElement>();
  const grid = document.createElement('div');
  grid.getBoundingClientRect = () =>
    ({ ...GRID, width: 640, height: 432, right: 650, bottom: 452 }) as DOMRect;
  (contentRef as { current: HTMLDivElement }).current = document.createElement('div');
  (scrollRef as { current: HTMLDivElement }).current = grid;
  const { result } = renderHook(() =>
    usePaneMouse((e) => events.push(e), {
      paneId: pid('%1'),
      charWidth: CHAR_W,
      charHeight: CHAR_H,
      mouseAnyFlag: flags.mouseAnyFlag ?? true,
      mouseAllFlag: flags.mouseAllFlag ?? false,
      mousePixelsFlag: flags.mousePixelsFlag ?? false,
      alternateOn: true,
      inMode: false,
      scrollbackMode: null,
      paneHeight: 24,
      contentRef,
      scrollRef,
      historySize: 0,
    }),
  );
  const at = (clientX: number, clientY: number, button = 0) =>
    ({
      clientX,
      clientY,
      button,
      detail: 1,
      shiftKey: false,
      ctrlKey: false,
      target: grid,
      deltaY: 0,
      preventDefault: () => {},
    }) as unknown as React.MouseEvent;
  const wheel = (clientX: number, clientY: number, deltaY: number) =>
    ({ ...at(clientX, clientY), deltaY }) as unknown as React.WheelEvent;
  return { result, events, at, wheel };
}

describe('usePaneMouse reports', () => {
  it('a program that asked for neither mode gets the cell reports it always got', () => {
    const { result, events, at, wheel } = setup({});
    const h = result.current;
    // Hover first: nothing, as before.
    h.handleMouseMove(at(GRID.left + 40, GRID.top + 40));
    h.handleMouseDown(at(GRID.left + 17, GRID.top + 37));
    h.handleMouseMove(at(GRID.left + 17, GRID.top + 37));
    h.handleMouseMove(at(GRID.left + 33, GRID.top + 37));
    h.handleMouseUp(at(GRID.left + 33, GRID.top + 37));
    h.handleWheel(wheel(GRID.left + 1, GRID.top + 1, CHAR_H));
    runFrame();
    expect(reportsOf(events)).toEqual([
      '^[[<0;3;3M',
      '^[[<32;3;3M',
      '^[[<32;5;3M',
      '^[[<0;5;3m',
      '^[[<65;1;1M',
    ]);
  });

  it('SGR-Pixels reports the CSS pixel from the grid corner, 1-based, for press, drag, release and wheel', () => {
    const { result, events, at, wheel } = setup({ mousePixelsFlag: true });
    const h = result.current;
    h.handleMouseDown(at(GRID.left + 17.6, GRID.top + 37.2));
    h.handleMouseMove(at(GRID.left + 30, GRID.top + 40));
    h.handleMouseMove(at(GRID.left + 31, GRID.top + 41));
    runFrame();
    h.handleMouseUp(at(GRID.left + 31, GRID.top + 41));
    h.handleWheel(wheel(GRID.left, GRID.top, -CHAR_H));
    // A pointer above or left of the grid still reports pixel 1, never 0.
    h.handleMouseDown(at(GRID.left - 5, GRID.top - 5, 2));
    expect(reportsOf(events)).toEqual([
      '^[[<0;18;38M',
      // Two moves in one frame: only the latest goes.
      '^[[<32;32;42M',
      '^[[<0;32;42m',
      '^[[<64;1;1M',
      '^[[<2;1;1M',
    ]);
  });

  it('any-motion in cells sends a hover report (35) only when the cell changes', () => {
    const { result, events, at } = setup({ mouseAllFlag: true });
    const h = result.current;
    h.handleMouseMove(at(GRID.left + 1, GRID.top + 1));
    h.handleMouseMove(at(GRID.left + 7, GRID.top + 17));
    h.handleMouseMove(at(GRID.left + 9, GRID.top + 1));
    // A drag keeps its own code: button plus 32.
    h.handleMouseDown(at(GRID.left + 9, GRID.top + 1));
    h.handleMouseMove(at(GRID.left + 9, GRID.top + 19));
    h.handleMouseUp(at(GRID.left + 9, GRID.top + 19));
    // Hovering where the release was says nothing new.
    h.handleMouseMove(at(GRID.left + 10, GRID.top + 20));
    h.handleMouseMove(at(GRID.left + 1, GRID.top + 20));
    expect(reportsOf(events)).toEqual([
      '^[[<35;1;1M',
      '^[[<35;2;1M',
      '^[[<0;2;1M',
      '^[[<32;2;2M',
      '^[[<0;2;2m',
      '^[[<35;1;2M',
    ]);
  });

  it('any-motion in pixels sends at most one hover report a frame, only when the pointer moved', () => {
    const { result, events, at } = setup({ mouseAllFlag: true, mousePixelsFlag: true });
    const h = result.current;
    h.handleMouseMove(at(GRID.left + 1, GRID.top + 1));
    h.handleMouseMove(at(GRID.left + 2, GRID.top + 1));
    h.handleMouseMove(at(GRID.left + 3, GRID.top + 5));
    expect(reportsOf(events)).toEqual([]);
    runFrame();
    expect(reportsOf(events)).toEqual(['^[[<35;4;6M']);
    // Still in the same place a frame later: nothing.
    h.handleMouseMove(at(GRID.left + 3, GRID.top + 5));
    runFrame();
    expect(reportsOf(events)).toHaveLength(1);
    // A press drops a hover still waiting for its frame: it would land after it.
    h.handleMouseMove(at(GRID.left + 50, GRID.top + 50));
    h.handleMouseDown(at(GRID.left + 60, GRID.top + 60));
    runFrame();
    expect(reportsOf(events)).toEqual(['^[[<35;4;6M', '^[[<0;61;61M']);
  });

  it('no hover report reaches a program that did not ask for any motion', () => {
    const { result, events, at } = setup({ mousePixelsFlag: true });
    result.current.handleMouseMove(at(GRID.left + 5, GRID.top + 5));
    runFrame();
    expect(events).toEqual([]);
  });
});
