/**
 * A sidebar column is always docked beside the grid, at any window width: the
 * layout is which columns are open and how wide they are, nothing else.
 */
import { describe, expect, it } from 'vitest';
import { wid } from '../../test/wire';
import { selectSettledPaneWidth, selectSidebarLayout } from '../selectors/panesAndSidebars';
import { createInitialContext } from '../app/context';
import type { AppMachineContext } from '../types/context';
import type { TmuxWindow } from '../../domain/client';
import { CONTAINER_PADDING_X } from '../../constants/layout';

const CHAR = 9;

function sidebarWindow(side: 'left' | 'right', extra: Partial<TmuxWindow> = {}): TmuxWindow {
  return {
    id: side === 'left' ? wid('@1') : wid('@2'),
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
  it.each([1280, 700, 400])('docks both columns, side by side, in a %ipx window', (body) => {
    const docked = 30 * CHAR + 35 * CHAR;
    const layout = selectSidebarLayout(
      ctx({
        leftSidebarOpen: true,
        rightSidebarOpen: true,
        windows: [sidebarWindow('left'), sidebarWindow('right')],
        bodyWidth: body,
        containerWidth: containerFor(body, docked),
      }),
    );
    expect(layout).toMatchObject({ leftOpen: true, rightOpen: true, leftWidth: 30 * CHAR });
    expect(selectSettledPaneWidth(ctx({ leftSidebarOpen: true, bodyWidth: body }))).toBe(
      body - 2 * CONTAINER_PADDING_X - 30 * CHAR,
    );
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
