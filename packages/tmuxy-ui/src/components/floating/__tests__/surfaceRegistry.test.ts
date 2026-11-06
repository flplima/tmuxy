import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openSurface, resetSurfaceRegistry } from '../surfaceRegistry';

beforeEach(() => resetSurfaceRegistry());

describe('the floating layer holds one surface', () => {
  it('dismisses the surface that held it when another opens', () => {
    // Right-clicking a tab drew its context menu on top of the tab's own preview.
    const dismissPreview = vi.fn();
    openSurface('tab-preview', dismissPreview);

    openSurface('tab-context-menu', vi.fn());
    expect(dismissPreview).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss a surface re-claiming the layer it already holds', () => {
    const dismiss = vi.fn();
    openSurface('tab-preview', dismiss);
    openSurface('tab-preview', dismiss);
    expect(dismiss).not.toHaveBeenCalled();

    openSurface('app-menu', vi.fn());
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('lets a surface release only the layer it still holds', () => {
    // The release runs from an effect cleanup, after the peer that replaced it
    // has claimed the layer.
    const release = openSurface('tab-preview', vi.fn());
    const dismissMenu = vi.fn();
    openSurface('app-menu', dismissMenu);

    release();

    openSurface('tab-context-menu', vi.fn());
    expect(dismissMenu).toHaveBeenCalledTimes(1);
  });

  it('survives a dismiss that releases its own claim synchronously', () => {
    // The dismiss unmounts the surface, whose cleanup releases while the
    // incoming surface is still writing its entry.
    let release = () => {};
    release = openSurface('tab-preview', () => release());
    const dismissMenu = vi.fn();
    openSurface('tab-context-menu', dismissMenu);

    openSurface('app-menu', vi.fn());
    expect(dismissMenu).toHaveBeenCalledTimes(1);
  });
});
