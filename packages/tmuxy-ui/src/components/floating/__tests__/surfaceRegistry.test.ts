import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openSurface, resetSurfaceRegistry } from '../surfaceRegistry';

beforeEach(() => resetSurfaceRegistry());

describe('the floating layer holds one surface', () => {
  it('dismisses the surface that held it when another opens', () => {
    // The bug this exists for: right-clicking a tab drew its context menu on
    // top of the tab's own preview — two cards about one tab, overlapping.
    const dismissPreview = vi.fn();
    openSurface('tab-preview', dismissPreview);

    openSurface('tab-context-menu', vi.fn());
    expect(dismissPreview).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss a surface re-claiming the layer it already holds', () => {
    // A surface re-registers on any render that changes its content. Treating
    // that as a peer taking over would have it dismiss itself mid-open.
    const dismiss = vi.fn();
    openSurface('tab-preview', dismiss);
    openSurface('tab-preview', dismiss);
    expect(dismiss).not.toHaveBeenCalled();

    openSurface('app-menu', vi.fn());
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('lets a surface release only the layer it still holds', () => {
    // The release runs from an effect cleanup, which fires AFTER the peer that
    // replaced it has already claimed the layer. A release that cleared
    // whatever it found would close the new surface a frame after it opened.
    const release = openSurface('tab-preview', vi.fn());
    const dismissMenu = vi.fn();
    openSurface('app-menu', dismissMenu);

    release();

    openSurface('tab-context-menu', vi.fn());
    expect(dismissMenu).toHaveBeenCalledTimes(1);
  });

  it('survives a dismiss that releases its own claim synchronously', () => {
    // A surface's dismiss typically sets state that unmounts it, and its
    // cleanup calls release. That must not clear the entry the incoming
    // surface is in the middle of writing.
    let release = () => {};
    release = openSurface('tab-preview', () => release());
    const dismissMenu = vi.fn();
    openSurface('tab-context-menu', dismissMenu);

    openSurface('app-menu', vi.fn());
    expect(dismissMenu).toHaveBeenCalledTimes(1);
  });
});
