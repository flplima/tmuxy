/**
 * What a read-only client draws differently: the grid it is sent rather than
 * one sized to its window, and no sidebar it would have no way to close.
 */
import { describe, expect, it } from 'vitest';
import { selectContainerSize, selectFitScale, selectSidebarLayout } from '../selectors';
import { createInitialContext } from '../app/context';
import type { AppMachineContext } from '../types';
import { CONTAINER_PADDING_BOTTOM, CONTAINER_PADDING_X } from '../../constants';

const CHAR_W = 10;
const CHAR_H = 20;

function ctx(overrides: Partial<AppMachineContext>): AppMachineContext {
  return {
    ...createInitialContext(),
    charWidth: CHAR_W,
    charHeight: CHAR_H,
    totalWidth: 200,
    totalHeight: 50,
    ...overrides,
  };
}

describe('selectFitScale', () => {
  it('is 1 for a client that sizes the session itself, whatever the grid', () => {
    expect(selectFitScale(ctx({ containerWidth: 500, containerHeight: 300 }))).toBe(1);
  });

  it('never enlarges a grid smaller than the viewer', () => {
    const scale = selectFitScale(
      ctx({ readOnly: true, containerWidth: 4000, containerHeight: 3000 }),
    );
    expect(scale).toBe(1);
  });

  it('shrinks the pane area until the whole grid fits, by the tighter axis', () => {
    const viewer = ctx({ readOnly: true, containerWidth: 976, containerHeight: 796 });
    const scale = selectFitScale(viewer);
    // Width: (976 + 24) / (2000 + 24) ≈ 0.494; height: 800 / 1004 ≈ 0.797.
    expect(scale).toBeCloseTo(0.494, 3);

    // Seen from inside the zoom, the content box holds the grid on both axes.
    const inner = selectContainerSize(viewer);
    expect(inner.width).toBeGreaterThanOrEqual(200 * CHAR_W);
    expect(inner.height).toBeGreaterThanOrEqual(50 * CHAR_H);
    expect((inner.width + 2 * CONTAINER_PADDING_X) * scale).toBeCloseTo(976 + 24, 0);
    expect((inner.height + CONTAINER_PADDING_BOTTOM) * scale).toBeLessThanOrEqual(800);
  });

  it('leaves the measured box alone for every other client', () => {
    expect(selectContainerSize(ctx({ containerWidth: 500, containerHeight: 300 }))).toEqual({
      width: 500,
      height: 300,
    });
  });
});

describe('selectSidebarLayout for a read-only client', () => {
  const narrow = { leftSidebarOpen: true, bodyWidth: 700, containerWidth: 676 };

  it('never overlays a column it could not close', () => {
    expect(selectSidebarLayout(ctx({ ...narrow, readOnly: true }))).toMatchObject({
      leftOpen: false,
      rightOpen: false,
    });
    expect(selectSidebarLayout(ctx(narrow))).toMatchObject({ leftOpen: true, overlay: true });
  });

  it("still docks the writer's columns when there is room", () => {
    const layout = selectSidebarLayout(
      ctx({ leftSidebarOpen: true, bodyWidth: 1600, containerWidth: 1276, readOnly: true }),
    );
    expect(layout).toMatchObject({ leftOpen: true, overlay: false });
  });
});
