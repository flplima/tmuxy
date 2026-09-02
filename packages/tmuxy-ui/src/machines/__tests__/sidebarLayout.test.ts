/**
 * The docked/overlay decision must be a pure function of the window's body
 * width — never of the pane container's width, which itself depends on the
 * decision. The old selector read the container, so at 600–1150 px the column
 * flipped between docked and overlay on every layout pass and tmux re-tiled
 * the panes each time.
 */
import { describe, expect, it } from 'vitest';
import { selectSidebarLayout } from '../selectors';
import { createInitialContext } from '../app/context';
import type { AppMachineContext, TmuxWindow } from '../types';
import { CONTAINER_PADDING_X } from '../../constants';

const CHAR = 9;

function sidebarWindow(side: 'left' | 'right', extra: Partial<TmuxWindow> = {}): TmuxWindow {
  return {
    id: side === 'left' ? '@1' : '@2',
    index: side === 'left' ? 2 : 3,
    name: `__sidebar-${side}`,
    active: false,
    windowType: `sidebar-${side}`,
    floatParent: null,
    floatWidth: null,
    floatHeight: null,
    floatDrawer: null,
    floatBg: null,
    floatNoheader: false,
    sidebarCols: null,
    sidebarHidden: false,
    zoomed: false,
    ...extra,
  };
}

function ctx(overrides: Partial<AppMachineContext>): AppMachineContext {
  return { ...createInitialContext(), charWidth: CHAR, ...overrides };
}

/** The pane container's content width for a body of `bodyWidth` with `dockedPx` taken by columns. */
const containerFor = (bodyWidth: number, dockedPx: number) =>
  bodyWidth - 2 * CONTAINER_PADDING_X - dockedPx;

describe('selectSidebarLayout', () => {
  it('docks a 30-col tree when the panes keep more than 60 columns', () => {
    const body = 1280;
    const layout = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        windows: [sidebarWindow('left')],
        bodyWidth: body,
        containerWidth: containerFor(body, 30 * CHAR),
      }),
    );
    expect(layout).toMatchObject({ leftOpen: true, overlay: false, leftWidth: 30 * CHAR });
  });

  it('overlays when the panes would be left with 60 columns or fewer', () => {
    // 700 px: (700 − 24 − 270) / 9 ≈ 45 columns for the panes.
    const body = 700;
    const layout = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        windows: [sidebarWindow('left')],
        bodyWidth: body,
        containerWidth: containerFor(body, 30 * CHAR),
      }),
    );
    expect(layout.overlay).toBe(true);
  });

  it('gives the same answer whether the column is currently docked or overlaying', () => {
    // The regression: in overlay the container is the full body width. If the
    // selector read the container, this state would flip back to docked and
    // the two would alternate forever.
    const body = 700;
    const base = { leftSidebarOpen: true, windows: [sidebarWindow('left')], bodyWidth: body };
    const whileDocked = selectSidebarLayout(
      ctx({ ...base, containerWidth: containerFor(body, 30 * CHAR) }),
    );
    const whileOverlaying = selectSidebarLayout(
      ctx({ ...base, containerWidth: containerFor(body, 0) }),
    );
    expect(whileDocked.overlay).toBe(true);
    expect(whileOverlaying.overlay).toBe(true);
  });

  it('shows only the tree when both columns would overlay', () => {
    const body = 1000;
    const layout = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        rightSidebarOpen: true,
        windows: [sidebarWindow('left'), sidebarWindow('right')],
        bodyWidth: body,
        containerWidth: containerFor(body, 0),
      }),
    );
    expect(layout).toMatchObject({ overlay: true, leftOpen: true, rightOpen: false });
  });

  it('falls back to the container plus docked columns before the body is measured', () => {
    const layout = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        windows: [sidebarWindow('left')],
        bodyWidth: 0,
        containerWidth: containerFor(1280, 30 * CHAR),
      }),
    );
    expect(layout.overlay).toBe(false);
  });

  it('draws a dragged width from the window, and a live preview ahead of it', () => {
    const body = 1280;
    const dragged = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        windows: [sidebarWindow('left', { sidebarCols: 40 })],
        bodyWidth: body,
        containerWidth: containerFor(body, 40 * CHAR),
      }),
    );
    expect(dragged.leftWidth).toBe(40 * CHAR);

    const previewed = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        windows: [sidebarWindow('left', { sidebarCols: 40 })],
        sidebarColsPreview: { side: 'left', cols: 52 },
        bodyWidth: body,
        containerWidth: containerFor(body, 40 * CHAR),
      }),
    );
    expect(previewed.leftWidth).toBe(52 * CHAR);

    // A preview of `null` means "the default" (a double-click on the divider).
    const reset = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        windows: [sidebarWindow('left', { sidebarCols: 40 })],
        sidebarColsPreview: { side: 'left', cols: null },
        bodyWidth: body,
        containerWidth: containerFor(body, 40 * CHAR),
      }),
    );
    expect(reset.leftWidth).toBe(30 * CHAR);
  });
});
