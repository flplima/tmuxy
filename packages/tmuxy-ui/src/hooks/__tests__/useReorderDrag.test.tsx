import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createRef, type PointerEvent as ReactPointerEvent } from 'react';
import { wid } from '../../test/wire';
import { useReorderDrag } from '../useReorderDrag';
import { DRAG_THRESHOLD_PX, LONG_PRESS_MS } from '../../utils/tabOverview';
import type { WindowId } from '../../domain/ids';

/** Three cards on one row, 100px apart, each 80px wide. */
function setup(options: { axis?: 'x' | 'xy'; readOnly?: boolean } = {}) {
  const container = document.createElement('div');
  const ids = [wid('@1'), wid('@2'), wid('@3')];
  const cards = ids.map((id, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.windowId = id;
    card.getBoundingClientRect = () =>
      ({ left: i * 100, width: 80, top: 0, height: 40 }) as DOMRect;
    container.appendChild(card);
    return card;
  });
  const containerRef = createRef<HTMLDivElement>();
  (containerRef as { current: HTMLDivElement }).current = container;
  const onReorder = vi.fn<(windowId: WindowId, toIndex: number) => void>();
  const hook = renderHook(() =>
    useReorderDrag({
      containerRef,
      cardSelector: '.card[data-window-id]',
      axis: options.axis ?? 'x',
      readOnly: options.readOnly ?? false,
      onReorder,
    }),
  );
  let captured: number | null = null;
  const pointer = (
    card: HTMLElement,
    init: { pointerId?: number; pointerType?: string; x?: number; y?: number },
  ) =>
    ({
      pointerId: init.pointerId ?? 1,
      pointerType: init.pointerType ?? 'mouse',
      clientX: init.x ?? 0,
      clientY: init.y ?? 0,
      currentTarget: Object.assign(card, {
        setPointerCapture: (id: number) => {
          captured = id;
        },
        hasPointerCapture: (id: number) => captured === id,
        releasePointerCapture: () => {
          captured = null;
        },
      }),
    }) as unknown as ReactPointerEvent<HTMLElement>;
  return { hook, ids, cards, onReorder, pointer, isCaptured: () => captured !== null };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useReorderDrag', () => {
  it('a mouse press becomes a drag after the threshold and drops where it is released', () => {
    const { hook, ids, cards, onReorder, pointer, isCaptured } = setup();
    act(() => hook.result.current.handlePointerDown(pointer(cards[0], { x: 40 }), ids[0], 0));
    expect(isCaptured()).toBe(true);
    expect(hook.result.current.dragging).toBeNull();

    // Short of the threshold: still a press.
    act(() =>
      hook.result.current.handlePointerMove(pointer(cards[0], { x: 40 + DRAG_THRESHOLD_PX - 1 })),
    );
    expect(hook.result.current.dragging).toBeNull();

    // Past it, and past the second card's centre: lands after it.
    act(() => hook.result.current.handlePointerMove(pointer(cards[0], { x: 150 })));
    expect(hook.result.current.dragging).toMatchObject({ windowId: ids[0], dx: 110, active: true });
    expect(hook.result.current.dragging?.overIndex).toBe(1);
    expect(hook.result.current.dropMarkerAt).toBe(2);

    let released: ReturnType<typeof hook.result.current.handlePointerUp> = null;
    act(() => {
      released = hook.result.current.handlePointerUp(pointer(cards[0], { x: 150 }));
    });
    expect(released).toMatchObject({ active: true });
    expect(onReorder).toHaveBeenCalledWith(ids[0], 1);
    expect(isCaptured()).toBe(false);
    expect(hook.result.current.dragging).toBeNull();
  });

  it('a press released in place is handed back as a click, and reorders nothing', () => {
    const { hook, ids, cards, onReorder, pointer } = setup();
    act(() => hook.result.current.handlePointerDown(pointer(cards[1], { x: 140 }), ids[1], 1));
    let released: ReturnType<typeof hook.result.current.handlePointerUp> = null;
    act(() => {
      released = hook.result.current.handlePointerUp(pointer(cards[1], { x: 141 }));
    });
    expect(released).toMatchObject({ windowId: ids[1], active: false });
    expect(onReorder).not.toHaveBeenCalled();
    // Another pointer's release is not this press.
    expect(hook.result.current.handlePointerUp(pointer(cards[1], { pointerId: 9 }))).toBeNull();
  });

  it('a finger drags after the long press, but a finger that moves first is scrolling', () => {
    vi.useFakeTimers();
    const { hook, ids, cards, pointer } = setup();
    const touch = (x: number) => pointer(cards[0], { pointerType: 'touch', x });

    act(() => hook.result.current.handlePointerDown(touch(40), ids[0], 0));
    act(() => hook.result.current.handlePointerMove(touch(40 + DRAG_THRESHOLD_PX * 2 + 1)));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(hook.result.current.dragging).toBeNull();

    act(() => hook.result.current.handlePointerDown(touch(40), ids[0], 0));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(hook.result.current.dragging).toMatchObject({ windowId: ids[0], active: true });
    act(() => hook.result.current.handlePointerMove(touch(250)));
    expect(hook.result.current.dragging?.overIndex).toBe(2);
  });

  it('a viewer presses but never drags', () => {
    vi.useFakeTimers();
    const { hook, ids, cards, pointer } = setup({ readOnly: true });
    act(() =>
      hook.result.current.handlePointerDown(
        pointer(cards[0], { pointerType: 'touch', x: 40 }),
        ids[0],
        0,
      ),
    );
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    act(() => hook.result.current.handlePointerMove(pointer(cards[0], { x: 250 })));
    expect(hook.result.current.dragging).toBeNull();
  });

  it('a wrapped grid drops by the nearest row, a strip by x alone', () => {
    // Two rows: the third card sits under the first.
    const grid = setup({ axis: 'xy' });
    grid.cards[2].getBoundingClientRect = () =>
      ({ left: 0, width: 80, top: 100, height: 40 }) as DOMRect;
    act(() =>
      grid.hook.result.current.handlePointerDown(
        grid.pointer(grid.cards[1], { x: 140 }),
        grid.ids[1],
        1,
      ),
    );
    act(() =>
      grid.hook.result.current.handlePointerMove(grid.pointer(grid.cards[1], { x: 200, y: 120 })),
    );
    expect(grid.hook.result.current.dragging).toMatchObject({ dx: 60, dy: 120, overIndex: 2 });

    const strip = setup({ axis: 'x' });
    strip.cards[2].getBoundingClientRect = () =>
      ({ left: 0, width: 80, top: 100, height: 40 }) as DOMRect;
    act(() =>
      strip.hook.result.current.handlePointerDown(
        strip.pointer(strip.cards[1], { x: 140 }),
        strip.ids[1],
        1,
      ),
    );
    act(() =>
      strip.hook.result.current.handlePointerMove(strip.pointer(strip.cards[1], { x: 20, y: 120 })),
    );
    expect(strip.hook.result.current.dragging?.overIndex).toBe(0);
  });
});
