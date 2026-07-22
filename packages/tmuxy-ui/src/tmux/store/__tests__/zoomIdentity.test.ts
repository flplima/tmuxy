import { describe, it, expect } from 'vitest';
import { preserveSnapshotIdentity } from '../adapters';
import type { TmuxSnapshot } from '../types';
import type { TmuxWindow } from '../../types';

/**
 * The store hands derived arrays to subscribers by reference and keeps the
 * previous object whenever a window is "unchanged", so anything omitted from
 * that comparison can never reach the UI. Zoom was omitted: toggling it changed
 * no other window field, so the old object identity was preserved and the pane
 * stayed stuck in (or out of) zoom until some unrelated field happened to
 * change — or the page was reloaded.
 */
const win = (over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  id: '@1',
  index: 1,
  name: 'shell',
  active: true,
  windowType: 'tab',
  groupPanes: null,
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
  ...over,
});

const snap = (windows: TmuxWindow[]): TmuxSnapshot =>
  ({
    panes: [],
    windows,
    activePaneId: '%1',
    activeWindowId: '@1',
    totalWidth: 80,
    totalHeight: 24,
    statusLine: '',
    sessionName: 'tmuxy',
  }) as unknown as TmuxSnapshot;

describe('preserveSnapshotIdentity — zoom', () => {
  it('publishes a new window object when zoom turns on', () => {
    const prev = snap([win({ zoomed: false })]);
    const next = snap([win({ zoomed: true })]);
    const result = preserveSnapshotIdentity(prev, next);

    expect(result).not.toBe(prev);
    expect(result.windows[0].zoomed).toBe(true);
  });

  it('publishes a new window object when zoom turns off', () => {
    const prev = snap([win({ zoomed: true })]);
    const next = snap([win({ zoomed: false })]);
    const result = preserveSnapshotIdentity(prev, next);

    expect(result).not.toBe(prev);
    expect(result.windows[0].zoomed).toBe(false);
  });

  it('treats absent and false as the same, so identity is still preserved', () => {
    // The wire omits `zoomed` for hosts that do not send it; that must not look
    // like a change on every tick.
    const prev = snap([win({ zoomed: false })]);
    const next = snap([win()]);
    expect(preserveSnapshotIdentity(prev, next)).toBe(prev);
  });

  it('still preserves identity when nothing changed', () => {
    const prev = snap([win({ zoomed: true })]);
    const next = snap([win({ zoomed: true })]);
    expect(preserveSnapshotIdentity(prev, next)).toBe(prev);
  });
});
