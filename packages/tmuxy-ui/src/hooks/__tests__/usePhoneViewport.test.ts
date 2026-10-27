import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCursorInView, useVisualViewport } from '../usePhoneViewport';

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

  it('does nothing off a phone', () => {
    vi.stubGlobal('visualViewport', new FakeViewport());
    renderHook(() => useVisualViewport(false));
    expect(document.documentElement.classList.contains('tmuxy-phone')).toBe(false);
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
});
