import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openSurface,
  dismissOpenSurface,
  openSurfaceId,
  subscribeSurface,
  resetSurfaceRegistry,
} from '../surfaceRegistry';

beforeEach(() => resetSurfaceRegistry());

describe('the floating layer holds one surface', () => {
  it('dismisses the surface that held it when another opens', () => {
    // The bug this exists for: right-clicking a tab drew its context menu on
    // top of the tab's own preview — two cards about one tab, overlapping.
    const dismissPreview = vi.fn();
    openSurface('tab-preview', dismissPreview);
    expect(openSurfaceId()).toBe('tab-preview');

    openSurface('tab-context-menu', vi.fn());
    expect(dismissPreview).toHaveBeenCalledTimes(1);
    expect(openSurfaceId()).toBe('tab-context-menu');
  });

  it('does not dismiss a surface re-claiming the layer it already holds', () => {
    // A surface re-registers on any render that changes its content. Treating
    // that as a peer taking over would have it dismiss itself mid-open.
    const dismiss = vi.fn();
    openSurface('tab-preview', dismiss);
    openSurface('tab-preview', dismiss);
    expect(dismiss).not.toHaveBeenCalled();
    expect(openSurfaceId()).toBe('tab-preview');
  });

  it('lets a surface release only the layer it still holds', () => {
    // The release runs from an effect cleanup, which fires AFTER the peer that
    // replaced it has already claimed the layer. A release that cleared
    // whatever it found would close the new surface a frame after it opened.
    const release = openSurface('tab-preview', vi.fn());
    openSurface('app-menu', vi.fn());

    release();

    expect(openSurfaceId()).toBe('app-menu');
  });

  it('survives a dismiss that releases its own claim synchronously', () => {
    // A surface's dismiss typically sets state that unmounts it, and its
    // cleanup calls release. That must not clear the entry the incoming
    // surface is in the middle of writing.
    let release = () => {};
    release = openSurface('tab-preview', () => release());

    openSurface('tab-context-menu', vi.fn());

    expect(openSurfaceId()).toBe('tab-context-menu');
  });

  it('closes whatever is open on demand, and is safe when nothing is', () => {
    const dismiss = vi.fn();
    openSurface('pane-context-menu', dismiss);

    dismissOpenSurface();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(openSurfaceId()).toBeNull();

    expect(() => dismissOpenSurface()).not.toThrow();
  });

  it('tells subscribers which surface is open', () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeSurface((id) => seen.push(id));

    const release = openSurface('tab-preview', vi.fn());
    release();

    expect(seen).toEqual(['tab-preview', null]);

    unsubscribe();
    openSurface('app-menu', vi.fn());
    expect(seen).toEqual(['tab-preview', null]);
  });
});
