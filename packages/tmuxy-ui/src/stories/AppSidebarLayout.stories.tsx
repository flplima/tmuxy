/**
 * Sidebar columns against the grid, on real tmux (v86): a column takes its
 * width out of the client, and tmux re-tiles the panes into what is left —
 * which only a live tmux can answer, for whatever width the column asks.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { app, tabPanes } from './sidebarStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Sidebar Layout',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

const paneRects = (canvasElement: HTMLElement) =>
  [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map((el) =>
    el.getBoundingClientRect(),
  );

const findColumn = (side: 'left' | 'right') =>
  waitFor(
    () => {
      const el = document.querySelector(`.sidebar-column-${side}`) as HTMLElement | null;
      if (!el) throw new Error(`no ${side} sidebar column`);
      return el;
    },
    { timeout: 30000, interval: 200 },
  );

// ---------------------------------------------------------------------------
// Fixed sidebar reflows the panes into the remaining width (not an overlay)
// ---------------------------------------------------------------------------

export const FixedSidebarReflowsPanes: Story = {
  args: { initCommands: ['split-window -h'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(paneRects(canvasElement).length).toBeGreaterThanOrEqual(2), {
      timeout: 30000,
    });

    // Before: panes fill the whole width, starting at the container's left edge.
    const before = paneRects(canvasElement);
    const beforeLeft = Math.min(...before.map((r) => r.left));
    const beforeRight = Math.max(...before.map((r) => r.right));

    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 30000 },
    );
    await userEvent.click(toggle);
    const sidebar = await findColumn('left');
    // After: the sidebar is a real column, and every pane sits to the RIGHT of
    // it (no overlap) while still reaching the same right edge (fills the space
    // that's left — tmux re-tiled the grid for it).
    await waitFor(
      () => {
        const s = sidebar.getBoundingClientRect();
        expect(s.width).toBeGreaterThan(50);
        const after = paneRects(canvasElement);
        expect(after.length).toBeGreaterThanOrEqual(2);
        const afterLeft = Math.min(...after.map((r) => r.left));
        const afterRight = Math.max(...after.map((r) => r.right));
        // Panes shifted right, clear of the sidebar column.
        expect(afterLeft).toBeGreaterThanOrEqual(s.right - 1);
        expect(afterLeft).toBeGreaterThan(beforeLeft + 50);
        // Still filling to (about) the same right edge — no dead gap.
        expect(Math.abs(afterRight - beforeRight)).toBeLessThan(12);
      },
      { timeout: 30000, interval: 200 },
    );

    // Sidebar column is full-height (matches the pane area height).
    const paneArea = canvasElement.querySelector('.pane-container') as HTMLElement;
    expect(sidebar.getBoundingClientRect().height).toBeGreaterThan(
      paneArea.getBoundingClientRect().height - 4,
    );
  },
};

// ---------------------------------------------------------------------------
// Opening the RIGHT column leaves the panes' left edge exactly where it was
// ---------------------------------------------------------------------------

export const RightColumnDoesNotMoveTheLeftEdge: Story = {
  tags: ['nightly'],
  args: { initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          'Toggling the dock resizes the pane area from its right edge, so its LEFT edge must not move — not at the end, and not for a frame in between, while the grid is re-tiled for the width the column leaves.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leftEdge = () => {
      const rects = paneRects(canvasElement);
      return rects.length ? Math.min(...rects.map((r) => r.left)) : null;
    };
    await waitFor(() => expect(paneRects(canvasElement).length).toBeGreaterThanOrEqual(2), {
      timeout: 30000,
    });

    const before = leftEdge()!;
    const samples: number[] = [];
    let sampling = true;
    const tick = () => {
      const edge = leftEdge();
      if (edge !== null) samples.push(edge);
      if (sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle terminal sidebar/i },
      { timeout: 30000 },
    );
    await userEvent.click(toggle);

    // Sampled until tmux has re-tiled the grid into the width the dock left:
    // the dock really took width out of the pane area...
    const dock = await findColumn('right');
    await waitFor(
      () => {
        const box = dock.getBoundingClientRect();
        expect(box.width).toBeGreaterThan(20);
        const right = Math.max(...paneRects(canvasElement).map((r) => r.right));
        expect(right).toBeLessThanOrEqual(box.left + 1);
      },
      { timeout: 30000, interval: 200 },
    );
    sampling = false;

    // ...and the left edge never moved, at any frame of it. The tolerance is
    // the sub-cell remainder the grid is centred within.
    expect(samples.length).toBeGreaterThan(5);
    const drift = Math.max(...samples.map((x) => Math.abs(x - before)));
    expect(drift).toBeLessThan(6);
    expect(Math.abs(leftEdge()! - before)).toBeLessThan(6);
  },
};

// ---------------------------------------------------------------------------
// Dragging a column's inner edge resizes both the column and its tmux pane
// ---------------------------------------------------------------------------

export const DragResizesTheColumn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The width the grid has left. A column that grew without the grid giving
    // up the same space would be overlapping the panes, not docked beside them.
    const gridCols = () => Math.max(0, ...tabPanes().map((p) => p.width));
    const treeWindow = () => app().context.windows.find((w) => w.windowType === 'sidebar-left');
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 30000 },
    );
    await waitFor(() => expect(gridCols()).toBeGreaterThan(0), { timeout: 30000 });
    const closedGridCols = gridCols();
    await userEvent.click(toggle);

    const column = await findColumn('left');
    // The drag starts from tmux's answer to the column opening — its window
    // made, the grid re-tiled — not from the grid it had before.
    const handle = await waitFor(
      () => {
        expect(treeWindow()).toBeDefined();
        expect(gridCols()).toBeLessThan(closedGridCols);
        const el = column.querySelector('.sidebar-resize-handle') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 30000, interval: 200 },
    );
    const startWidth = column.getBoundingClientRect().width;
    const startGridCols = gridCols();
    expect(startGridCols).toBeGreaterThan(0);

    // Drag the inner edge 90px to the right. Driven as pointer events on the
    // handle, because the drag is what a user actually does — the column has no
    // width control to call. The handle captures the pointer, so the move and
    // the release go to the handle itself, as they would from a real mouse.
    const box = handle.getBoundingClientRect();
    const startX = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const pointer = (type: string, clientX: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      });
    handle.dispatchEvent(pointer('pointerdown', startX));
    // The drag state lands on the next render; a real drag has human-scale
    // delay here, so wait for it rather than moving synchronously.
    await waitFor(() => expect(handle.className).toContain('is-dragging'), { timeout: 8000 });
    handle.dispatchEvent(pointer('pointermove', startX + 90));
    // A real mouse never releases in the same task as the move it finished on.
    // The handler applies the move on the next frame, so releasing immediately
    // let the release be handled first and the drag end where it started.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    handle.dispatchEvent(pointer('pointerup', startX + 90));

    // The column is drawn wider, and the pane grid gave space up for it — the
    // resize re-tiles the panes rather than covering them. (How MUCH the grid
    // loses is the container's business, not the drag's.)
    await waitFor(
      () => {
        expect(column.getBoundingClientRect().width).toBeGreaterThan(startWidth + 40);
        expect(gridCols()).toBeLessThan(startGridCols);
      },
      { timeout: 30000, interval: 200 },
    );

    // The width is committed on the column's own tmux window, which is what
    // makes it outlive this client rather than being a local style.
    await waitFor(
      () =>
        expect(treeWindow()!.sidebarCols).toBe(
          Math.round(column.getBoundingClientRect().width / app().context.charWidth),
        ),
      { timeout: 30000, interval: 200 },
    );
  },
};
