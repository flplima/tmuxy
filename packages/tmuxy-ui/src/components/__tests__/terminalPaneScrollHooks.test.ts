/**
 * A scrollback view that comes back on screen is where it was.
 *
 * Another tab's panes stay mounted with `display: none`, and a scroll
 * container with no box loses its offset. Shown again, it sat at row 0 while
 * the view rendered only the rows around its own `scrollTop` — a blank pane —
 * and the first wheel step, read from row 0, threw the view to the top of
 * history. Coming back is a resize from nothing; that is when the offset is
 * restored.
 *
 * jsdom lays nothing out, so the container's box and the ResizeObserver are
 * stand-ins: the hook is driven exactly as the browser drives it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTerminalPaneScroll } from '../terminalPaneScrollHooks';
import { pid } from '../../test/wire';
import type { CopyModeState } from '../../domain/copyMode';

const ROW = 10;

let observers: Array<() => void> = [];
const RealResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe() {
      observers.push(this.callback);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = RealResizeObserver;
});

/** A scroll container whose box and offset the test controls. */
function container() {
  const box = { height: 400, scrollTop: 0 };
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { get: () => box.height });
  Object.defineProperty(el, 'scrollHeight', { get: () => 6000 });
  Object.defineProperty(el, 'scrollTop', {
    get: () => box.scrollTop,
    set: (value: number) => {
      box.scrollTop = value;
    },
  });
  return { el, box };
}

const scrollView = (scrollTop: number) => ({ mode: 'scroll', scrollTop }) as CopyModeState;

function mount(el: HTMLDivElement, copyState: CopyModeState | undefined) {
  return renderHook(() =>
    useTerminalPaneScroll({
      paneId: pid('%1'),
      charHeight: ROW,
      copyState,
      scrollRef: { current: el },
      send: () => {},
    }),
  );
}

const resized = () => observers.forEach((notify) => notify());

describe('useTerminalPaneScroll on a pane whose tab is hidden and shown again', () => {
  it('puts a scrollback view back at its row when the pane comes back on screen', () => {
    const { el, box } = container();
    mount(el, scrollView(500));

    // The tab goes away: the box collapses and the browser drops the offset.
    box.height = 0;
    resized();
    box.scrollTop = 0;
    // ...and comes back.
    box.height = 400;
    resized();

    expect(el.scrollTop).toBe(500 * ROW);
  });

  it('keeps the live screen pinned to the bottom when there is no view open', () => {
    const { el, box } = container();
    mount(el, undefined);

    box.height = 0;
    resized();
    box.scrollTop = 0;
    box.height = 400;
    resized();

    expect(el.scrollTop).toBe(6000);
  });

  it('leaves the offset alone on a resize that is not a return from hidden', () => {
    const { el, box } = container();
    mount(el, scrollView(500));
    box.scrollTop = 123;

    box.height = 300;
    resized();

    expect(el.scrollTop).toBe(123);
  });
});
