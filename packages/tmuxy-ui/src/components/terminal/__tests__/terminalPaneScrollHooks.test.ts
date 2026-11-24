/**
 * A scrollback view that comes back on screen is where it was.
 *
 * Another tab's panes stay mounted with `display: none`, and a scroll
 * container with no box loses its offset: shown again, the pane was blank and
 * the first wheel step threw the view to the top of history.
 *
 * jsdom lays nothing out, so the container's box and the ResizeObserver are
 * stand-ins.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTerminalPaneScroll } from '../terminalPaneScrollHooks';
import { pid } from '../../../test/wire';
import type { CopyModeState } from '../../../domain/copyMode';

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

/** Like `mount`, with a row height the test changes afterwards. */
function mountWithRowHeight(el: HTMLDivElement, copyState: CopyModeState, charHeight: number) {
  return renderHook(
    ({ charHeight }: { charHeight: number }) =>
      useTerminalPaneScroll({
        paneId: pid('%1'),
        charHeight,
        copyState,
        scrollRef: { current: el },
        send: () => {},
      }),
    { initialProps: { charHeight } },
  );
}

describe('useTerminalPaneScroll when the rows change height under a view', () => {
  it('keeps the view on the same row', () => {
    // A phone turned sideways: the row did not move, its pixel offset did.
    const { el } = container();
    const { rerender } = mountWithRowHeight(el, scrollView(500), ROW);
    expect(el.scrollTop).toBe(500 * ROW);

    rerender({ charHeight: ROW + 4 });

    expect(el.scrollTop).toBe(500 * (ROW + 4));
  });
});

describe('useTerminalPaneScroll on a pane whose tab is hidden and shown again', () => {
  it('puts a scrollback view back at its row when the pane comes back on screen', () => {
    const { el, box } = container();
    mount(el, scrollView(500));

    // The tab goes away: the box collapses and the browser drops the offset.
    box.height = 0;
    resized();
    box.scrollTop = 0;
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

describe('useTerminalPaneScroll at a row height that is not a whole number of pixels', () => {
  it('puts the view on its last row scrolled to the far end, a fraction of a row short of it', () => {
    // 100 lines of 17.6px in a 24-row view: the last row starts at 1337.6px,
    // but the container's far end is 1760 - 423 = 1337px, as far as it goes.
    const charHeight = 17.6;
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientHeight', { get: () => 423 });
    Object.defineProperty(el, 'scrollHeight', { get: () => 1760 });
    let scrollTop = 0;
    Object.defineProperty(el, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const sent: unknown[] = [];
    const { result } = renderHook(() =>
      useTerminalPaneScroll({
        paneId: pid('%1'),
        charHeight,
        copyState: { mode: 'scroll', scrollTop: 70, totalLines: 100, height: 24 } as CopyModeState,
        scrollRef: { current: el },
        send: (event) => sent.push(event),
      }),
    );
    const scrolledTo = (px: number) => {
      scrollTop = px;
      result.current.handleContainerScroll({
        currentTarget: el,
      } as unknown as React.UIEvent<HTMLDivElement>);
      return (sent[sent.length - 1] as { scrollTop: number }).scrollTop;
    };

    expect(scrolledTo(1337)).toBe(76);
    expect(scrolledTo(176)).toBe(10);
  });
});
