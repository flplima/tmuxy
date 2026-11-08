import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { standaloneShortfall, useCursorInView, useVisualViewport } from '../usePhoneViewport';

/** A visual viewport a test can resize, as a keyboard does on a phone. */
class FakeViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  resize(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event('resize'));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useVisualViewport', () => {
  it('pins the app to what the keyboard leaves visible, and lets go after', () => {
    const viewport = new FakeViewport();
    vi.stubGlobal('visualViewport', viewport);
    const root = document.documentElement;
    const { unmount } = renderHook(() => useVisualViewport(true));
    expect(root.classList.contains('tmuxy-phone')).toBe(true);
    expect(root.style.getPropertyValue('--app-height')).toBe('844px');

    viewport.resize(470, 12);
    expect(root.style.getPropertyValue('--app-height')).toBe('470px');
    expect(root.style.getPropertyValue('--app-top')).toBe('12px');

    unmount();
    expect(root.classList.contains('tmuxy-phone')).toBe(false);
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });

  it('marks the root while a keyboard covers the page, and not once it is away', () => {
    const viewport = new FakeViewport();
    viewport.height = window.innerHeight;
    vi.stubGlobal('visualViewport', viewport);
    const root = document.documentElement;
    const { unmount } = renderHook(() => useVisualViewport(true));
    expect(root.classList.contains('tmuxy-keyboard-up')).toBe(false);
    viewport.resize(window.innerHeight - 300);
    expect(root.classList.contains('tmuxy-keyboard-up')).toBe(true);
    viewport.resize(window.innerHeight);
    expect(root.classList.contains('tmuxy-keyboard-up')).toBe(false);
    viewport.resize(window.innerHeight - 300);
    unmount();
    expect(root.classList.contains('tmuxy-keyboard-up')).toBe(false);
  });

  it('does nothing off a phone', () => {
    vi.stubGlobal('visualViewport', new FakeViewport());
    renderHook(() => useVisualViewport(false));
    expect(document.documentElement.classList.contains('tmuxy-phone')).toBe(false);
  });
});

describe('standaloneShortfall', () => {
  // An iPhone 15 installed app, status bar over the page: the screen is 852
  // tall for the page, iOS reports 793, the status bar is 59.
  const iphone = { standalone: true, large: 852, inner: 793, visual: 793, insetTop: 59 };

  it('puts back the status bar’s height iOS leaves out of an installed app', () => {
    expect(standaloneShortfall(iphone)).toBe(59);
  });

  it('adds nothing while the keyboard is up: what it leaves is laid out as reported', () => {
    expect(standaloneShortfall({ ...iphone, visual: 470 })).toBe(0);
  });

  it('adds nothing where the height is right, or the page is not under a status bar', () => {
    expect(standaloneShortfall({ ...iphone, inner: 852, visual: 852 })).toBe(0);
    expect(standaloneShortfall({ ...iphone, insetTop: 0 })).toBe(0);
    expect(standaloneShortfall({ ...iphone, standalone: false })).toBe(0);
  });

  it('adds nothing for a keyboard that really resizes the page (Android)', () => {
    expect(
      standaloneShortfall({ standalone: true, large: 915, inner: 600, visual: 600, insetTop: 24 }),
    ).toBe(0);
  });
});

describe('useCursorInView', () => {
  /** A terminal box `visible` px tall over `content` px, with the cursor at `cursorTop`. */
  function terminal(visible: number, cursorTop: number) {
    const box = document.createElement('div');
    const pane = document.createElement('div');
    pane.className = 'pane-active';
    const cursor = document.createElement('div');
    cursor.className = 'terminal-cursor';
    pane.appendChild(cursor);
    box.appendChild(pane);
    document.body.appendChild(box);
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: visible });
    box.getBoundingClientRect = () => ({ top: 0, bottom: visible }) as DOMRect;
    // The cursor's box is where it is drawn: its place in the content, less
    // what has been scrolled past.
    cursor.getBoundingClientRect = () =>
      ({
        top: cursorTop - box.scrollTop,
        bottom: cursorTop + 13 - box.scrollTop,
        height: 13,
      }) as DOMRect;
    return box;
  }

  it('scrolls a cut-short terminal so the cursor sits a row above the bottom', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const box = terminal(190, 300);
    renderHook(() => useCursorInView({ current: box }, true, '%1 0 23'));
    expect(box.scrollTop).toBe(300 + 13 + 13 - 190);
  });

  it('leaves a terminal whose cursor is in view from the top at its top', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const box = terminal(190, 40);
    box.scrollTop = 120;
    renderHook(() => useCursorInView({ current: box }, true, '%1 0 3'));
    expect(box.scrollTop).toBe(0);
  });

  it('leaves the zoom where the tap put it until the cursor moves, then brings its column back', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const box = terminal(800, 40);
    // The zoomed grid's sideways viewport, scrolled to the point tapped; the
    // cursor is at the line's start, out of that view to the left.
    const sideways = document.createElement('div');
    sideways.getBoundingClientRect = () => ({ left: 0, right: 390 }) as DOMRect;
    sideways.scrollLeft = 200;
    const cursor = box.querySelector('.terminal-cursor')!;
    const at = cursor.getBoundingClientRect();
    cursor.getBoundingClientRect = () =>
      ({
        ...at,
        left: 14 - sideways.scrollLeft,
        right: 24 - sideways.scrollLeft,
        width: 10,
      }) as DOMRect;
    let scrolledTo = 200;
    Object.defineProperty(sideways, 'scrollLeft', {
      configurable: true,
      get: () => scrolledTo,
      set: (v: number) => (scrolledTo = Math.max(0, v)),
    });
    const xRef = { current: sideways };
    const { rerender } = renderHook(
      ({ key, x }: { key: string; x: typeof xRef | null }) =>
        useCursorInView({ current: box }, true, key, x),
      { initialProps: { key: '%1 0 3', x: null as typeof xRef | null } },
    );
    // The zoom comes on: the view stays on the point tapped.
    rerender({ key: '%1 0 3', x: xRef });
    expect(scrolledTo).toBe(200);
    // The cursor moves: its column is brought back into view.
    rerender({ key: '%1 0 4', x: xRef });
    expect(scrolledTo).toBe(0);
  });
});
