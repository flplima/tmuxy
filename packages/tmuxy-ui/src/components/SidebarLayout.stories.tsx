/**
 * Sidebar layout, resize, scroll, and keyboard tab-order stories (demo engine).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';
import { fixColumn } from '../stories/fixColumn';
import { app, tabPanes, waitForTree } from '../stories/sidebarStoryHelpers';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Sidebar Layout',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

// ---------------------------------------------------------------------------
// Fixed sidebar reflows the panes into the remaining width (not an overlay)
// ---------------------------------------------------------------------------

export const FixedSidebarReflowsPanes: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const paneRects = () =>
      [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map((el) =>
        el.getBoundingClientRect(),
      );
    await waitFor(() => expect(paneRects().length).toBeGreaterThanOrEqual(2), { timeout: 8000 });

    // Before: panes fill the whole width, starting at the container's left edge.
    const before = paneRects();
    const beforeLeft = Math.min(...before.map((r) => r.left));
    const beforeRight = Math.max(...before.map((r) => r.right));

    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    const sidebar = await waitFor(
      () => {
        const el = document.querySelector('.sidebar-column-left') as HTMLElement | null;
        if (!el) throw new Error('no sidebar column');
        return el;
      },
      { timeout: 8000 },
    );
    // A column opens over the panes; `prefix s` on the open column fixes it.
    await userEvent.keyboard('{Control>}a{/Control}');
    await userEvent.keyboard('s');

    // After: the sidebar is a real column, and every pane sits to the RIGHT of
    // it (no overlap) while still reaching the same right edge (fills the space
    // that's left — the pane area recalculated, it's not an overlay).
    await waitFor(
      () => {
        const s = sidebar.getBoundingClientRect();
        expect(s.width).toBeGreaterThan(50);
        const after = paneRects();
        expect(after.length).toBeGreaterThanOrEqual(2);
        const afterLeft = Math.min(...after.map((r) => r.left));
        const afterRight = Math.max(...after.map((r) => r.right));
        // Panes shifted right, clear of the sidebar column.
        expect(afterLeft).toBeGreaterThanOrEqual(s.right - 1);
        expect(afterLeft).toBeGreaterThan(beforeLeft + 50);
        // Still filling to (about) the same right edge — no dead gap.
        expect(Math.abs(afterRight - beforeRight)).toBeLessThan(12);
      },
      { timeout: 6000, interval: 200 },
    );

    // Sidebar column is full-height (matches the pane area height).
    const paneArea = canvasElement.querySelector('.pane-container') as HTMLElement;
    expect(sidebar.getBoundingClientRect().height).toBeGreaterThan(
      paneArea.getBoundingClientRect().height - 4,
    );
  },
};

// ---------------------------------------------------------------------------
// The RIGHT column's slide leaves the panes' left edge exactly where it was
// ---------------------------------------------------------------------------

export const RightColumnSlideDoesNotMoveTheLeftEdge: Story = {
  tags: ['nightly'],
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          "Toggling the dock resizes the pane area from its right edge, so its LEFT edge must not move — not at the end, and not for a frame in between. The grid is re-tiled for the settled width the moment the toggle starts, so it is centred against that width rather than against the container's live one; centring a settled grid inside a still-moving container is what used to walk the panes sideways for the length of the animation.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leftEdge = () => {
      const rects = [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map(
        (el) => el.getBoundingClientRect(),
      );
      return rects.length ? Math.min(...rects.map((r) => r.left)) : null;
    };
    await waitFor(() => expect(leftEdge()).not.toBeNull(), { timeout: 8000 });
    // A docked dock is what resizes the pane area.
    await fixColumn(canvasElement, 'right');
    await waitFor(() => expect(leftEdge()).not.toBeNull(), { timeout: 8000 });

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
      { timeout: 8000 },
    );
    await userEvent.click(toggle);

    // Wait for the column to be there and the slide to be over.
    await waitFor(
      () => {
        const el = document.querySelector('.sidebar-column-right') as HTMLElement | null;
        if (!el) throw new Error('no dock column');
        expect(el.getBoundingClientRect().width).toBeGreaterThan(20);
      },
      { timeout: 8000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    sampling = false;

    // The dock really took width out of the pane area...
    const after = leftEdge()!;
    const rects = [...canvasElement.querySelectorAll('.pane-layout-item[data-pane-id]')].map((el) =>
      el.getBoundingClientRect(),
    );
    const dock = document.querySelector('.sidebar-column-right')!.getBoundingClientRect();
    expect(Math.max(...rects.map((r) => r.right))).toBeLessThanOrEqual(dock.left + 1);

    // ...and the left edge never moved, at any frame of it. The tolerance is
    // the sub-cell remainder the grid is centred within, not room for a slide.
    expect(samples.length).toBeGreaterThan(5);
    const drift = Math.max(...samples.map((x) => Math.abs(x - before)));
    expect(drift).toBeLessThan(6);
    expect(Math.abs(after - before)).toBeLessThan(6);
  },
};

// ---------------------------------------------------------------------------
// Dragging a column's inner edge resizes both the column and its tmux pane
// ---------------------------------------------------------------------------

export const DragResizesTheColumn: Story = {
  args: { height: 500 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A docked column, so the grid gives up what the column takes.
    await fixColumn(canvasElement, 'left');
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);

    const column = await waitFor(
      () => {
        const el = document.querySelector('.sidebar-column-left') as HTMLElement | null;
        if (!el) throw new Error('no sidebar column');
        return el;
      },
      { timeout: 8000 },
    );
    const handle = column.querySelector('.sidebar-resize-handle') as HTMLElement;
    expect(handle).not.toBeNull();
    // The column slides open; measure it once it has stopped moving, or the
    // widths below are mid-slide and a column short. Generously — on a loaded
    // machine the slide alone can take seconds, which is a slow runner rather
    // than a column that never settles.
    await waitFor(() => expect(column.className).not.toContain('is-moving'), { timeout: 8000 });

    const startWidth = column.getBoundingClientRect().width;
    // The width the grid has left. A column that grew without the grid giving
    // up the same space would be overlapping the panes, not docked beside them.
    const gridCols = () => Math.max(...tabPanes().map((p) => p.width));
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
      { timeout: 6000, interval: 200 },
    );

    // The width is committed on the column's own tmux window, which is what
    // makes it outlive this client rather than being a local style.
    const treeWindow = app().context.windows.find((w) => w.windowType === 'sidebar-left')!;
    expect(treeWindow.sidebarCols).toBe(
      Math.round(column.getBoundingClientRect().width / app().context.charWidth),
    );
  },
};

// ---------------------------------------------------------------------------
// A tree with more rows than the column is tall scrolls INSIDE the column
// ---------------------------------------------------------------------------

export const TallTreeScrollsInsideTheColumn: Story = {
  tags: ['nightly'],
  args: {
    height: 400,
    initCommands: ['rename-window main', ...Array.from({ length: 11 }, () => 'new-window')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Twelve tabs and their panes are more rows than a 400px column can show. The tree has to scroll within the column: its box stays inside the column (rather than growing past the bottom edge and being clipped away with no way to reach the rest), and walking the keyboard cursor down to the last row brings that row into view.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 1 });
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await user.click(toggle);
    const tree = await waitForTree();
    const column = document.querySelector('.sidebar-column-left') as HTMLElement;
    expect(column).not.toBeNull();
    await waitFor(() => expect(column.className).not.toContain('is-moving'), { timeout: 3000 });

    // Every tab and its pane got a row — far more rows than the column is tall.
    const rows = () => [...tree.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(20), { timeout: 8000 });

    // The tree is bounded by its column: a box that grew past the bottom edge
    // would have its extra rows clipped by the column with nothing to scroll.
    const columnBox = column.getBoundingClientRect();
    expect(tree.getBoundingClientRect().bottom).toBeLessThanOrEqual(columnBox.bottom + 1);

    // …and it overflows that box, so it is genuinely scrollable.
    expect(tree.scrollHeight).toBeGreaterThan(tree.clientHeight + 1);

    // It opens on the active pane's row, at the bottom of a tree this long, so
    // the top of it starts out scrolled off the column.
    const firstRow = () => rows()[0];
    const lastRow = () => rows()[rows().length - 1];
    const openedAt = tree.scrollTop;
    expect(openedAt).toBeGreaterThan(0);
    expect(firstRow().getBoundingClientRect().top).toBeLessThan(columnBox.top);

    // Walking the keyboard cursor up brings the top of the tree back into view —
    // which is what makes the rows past a fold reachable at all.
    await user.click(tree);
    await waitFor(() => expect(tree.getAttribute('data-focused')).toBe('true'), { timeout: 5000 });
    await user.keyboard('k'.repeat(rows().length));
    await waitFor(
      () => {
        // Scrolled back up (not necessarily to 0 — the tree's top padding sits
        // above the first row, and `block: 'nearest'` stops at the row itself).
        expect(tree.scrollTop).toBeLessThan(openedAt);
        const box = firstRow().getBoundingClientRect();
        expect(box.top).toBeGreaterThanOrEqual(columnBox.top - 1);
        expect(box.bottom).toBeLessThanOrEqual(columnBox.bottom + 1);
      },
      { timeout: 6000, interval: 100 },
    );

    // …and walking it back down scrolls the far end into view the same way.
    await user.keyboard('j'.repeat(rows().length));
    await waitFor(
      () => {
        expect(tree.scrollTop).toBeGreaterThan(0);
        const box = lastRow().getBoundingClientRect();
        expect(box.top).toBeGreaterThanOrEqual(columnBox.top - 1);
        expect(box.bottom).toBeLessThanOrEqual(columnBox.bottom + 1);
      },
      { timeout: 6000, interval: 100 },
    );
  },
};

// ---------------------------------------------------------------------------
// Keyboard only: Tab walks the chrome in order and always finds its way back
// ---------------------------------------------------------------------------

/**
 * Someone driving the app from the keyboard alone has to be able to walk the
 * chrome and get back where they started. With the tree column open, Tab is
 * pressed from the sidebar toggle until the focus wraps round to it again, and
 * every stop is recorded.
 *
 * The walk has to complete the loop rather than stalling or circling inside
 * one surface, take in the tab strip and the app menu on the way, stop only on
 * controls the user can actually see, and move in document order, which is the
 * order the controls are read in.
 */
export const TabOrderNeverTrapsTheKeyboard: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'new-window', 'rename-window logs'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle tree sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);
    await waitForTree();

    const sidebar = document.querySelector('.sidebar-column-left') as HTMLElement;
    expect(sidebar).not.toBeNull();
    // The column slides in; walking it mid-slide measures boxes that are still
    // moving and can tab onto a control that has not arrived yet.
    await waitFor(() => expect(sidebar.className).not.toContain('is-moving'), { timeout: 8000 });

    // Walk both ways from the toggle until the focus leaves the page, which is
    // what Tab past the last control does in any browser: a walk that never
    // leaves is the trap. (Back into the page is the browser's own move, which
    // a page cannot press for; from nothing focused, Tab is the terminal's.)
    // The toggle is focused the way a keyboard user arrives, not by the click
    // above: a clicked button keeps the focus, and the Tab typed next is the
    // shell's.
    toggle.blur();
    toggle.focus();
    const walk = async (shift: boolean): Promise<HTMLElement[]> => {
      toggle.focus();
      const stops: HTMLElement[] = [toggle];
      for (let press = 0; press < 30; press++) {
        await userEvent.tab({ shift });
        const focused = document.activeElement as HTMLElement;
        if (focused === document.body) return stops.slice(1);
        const trace = stops.map((el) => el.className || el.tagName).join(' -> ');
        expect(
          focused,
          `Tab did not move the focus off ${focused.className || focused.outerHTML.slice(0, 120)}: ${trace}`,
        ).not.toBe(stops[stops.length - 1]);
        expect(
          stops.includes(focused),
          `Tab came back to ${focused.className} without leaving the page: ${trace}`,
        ).toBe(false);
        // Every stop is a control the user can see — a focus ring on a clipped
        // or zero-sized element is a stop nobody can find.
        const box = focused.getBoundingClientRect();
        expect(box.width, `a stop with no width: ${focused.className}`).toBeGreaterThan(0);
        expect(box.height, `a stop with no height: ${focused.className}`).toBeGreaterThan(0);
        stops.push(focused);
      }
      throw new Error('Tab never left the page in 30 presses');
    };
    const stops = [...(await walk(true)).reverse(), toggle, ...(await walk(false))];

    // In document order: the reading order and the tab order are the same.
    for (let i = 1; i < stops.length; i++) {
      const follows =
        stops[i - 1].compareDocumentPosition(stops[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(
        Boolean(follows),
        `${stops[i].className} is reached after ${stops[i - 1].className} but comes before it`,
      ).toBe(true);
    }

    // The tab strip is on the way: its "new tab" control is a stop. The trace
    // goes in the message so a walk that changes shape says how it changed.
    const trace = stops.map((el) => el.className || el.tagName).join(' -> ');
    expect(
      stops.some((el) => el.closest('.tab-add') !== null),
      `the tab strip is not in the tab order: ${trace}`,
    ).toBe(true);
    expect(stops.length, `too few stops to be the whole chrome: ${trace}`).toBeGreaterThan(2);
  },
};
