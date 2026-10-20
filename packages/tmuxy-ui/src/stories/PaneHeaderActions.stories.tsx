/**
 * What a pane's header does, by mouse alone, over states recorded from real
 * tmux (`fixtures/scenarios/pane-header-ops.ts`):
 *
 *  - KillPaneViaHeaderButton  the header's ✕ closes that pane
 *  - ZoomViaHeaderDoubleClick double-clicking a header zooms its pane, and again unzooms it
 *  - PaneDragSwap             dragging a header onto another pane swaps the two
 *  - PaneContextMenuSplit     the header tab's context menu splits its pane below
 *
 * Each story sends what the app sends and is answered with the screen tmux
 * drew for that command, so what is asserted is the app's rendering of tmux's
 * real reply.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import paneHeaderOps from './fixtures/gen/pane-header-ops.json';
import { activePaneId, findMenuItem, paneGroups, paneIds, paneRect } from './appStoryHelpers';
import type { Canvas } from './appStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Pane Header Actions',
  component: FixtureApp,
  args: { fixture: asFixture(paneHeaderOps), start: 'two' },
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const paneEl = (canvas: Canvas, id: string) =>
  paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;

/** The recorded panes are on screen, each with a visible box. */
async function waitForPanes(canvas: Canvas, ids: string[]) {
  await waitFor(
    () => {
      expect([...paneIds(canvas)].sort()).toEqual([...ids].sort());
      for (const id of ids) expect(paneRect(canvas, id).width).toBeGreaterThan(0);
    },
    { timeout: 10000 },
  );
}

const leftmost = (canvas: Canvas, a: string, b: string) =>
  paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;

/**
 * The header's ✕ is PaneHeader's group-aware CLOSE_PANE, which for a plain
 * pane is `kill-pane -t <it>`: the clicked pane goes, its neighbours stay.
 */
export const KillPaneViaHeaderButton: Story = {
  args: {
    start: 'split-below',
    transitions: [{ match: /^kill-pane -t %0$/, to: 'closed' }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForPanes(canvas, ['%0', '%1', '%2']);
    const closeBtn = paneEl(canvas, '%0').querySelector(
      '[aria-label="Close pane"]',
    ) as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    await user.click(closeBtn!);
    await waitForPanes(canvas, ['%1', '%2']);
    expect(paneIds(canvas)).not.toContain('%0');
  },
};

/**
 * Double-clicking a header dispatches ZOOM_PANE — `select-pane` then
 * `resize-pane -t <it> -Z` — and the pane fills the window; double-clicking
 * it again sends the same toggle and it is back in its half.
 */
export const ZoomViaHeaderDoubleClick: Story = {
  args: {
    // The same command both ways: what it is answered with depends on the
    // state it finds.
    transitions: [
      { match: /^resize-pane -t %1 -Z$/, from: 'two', to: 'zoomed' },
      { match: /^resize-pane -t %1 -Z$/, from: 'zoomed', to: 'unzoomed' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForPanes(canvas, ['%0', '%1']);
    const before = paneRect(canvas, '%1').width;
    const header = () => paneEl(canvas, '%1').querySelector('.pane-header') as HTMLElement;

    await user.dblClick(header());
    await waitFor(() => expect(paneRect(canvas, '%1').width).toBeGreaterThan(before * 1.5), {
      timeout: 10000,
    });

    await user.dblClick(header());
    await waitFor(() => expect(Math.abs(paneRect(canvas, '%1').width - before)).toBeLessThan(20), {
      timeout: 10000,
    });
    expect(paneRect(canvas, '%0').width).toBeGreaterThan(0);
  },
};

/**
 * Drag a header onto another pane: mousedown on the source header, move past
 * the drag threshold onto the target, release. The drag machine sends
 * `swap-pane -d -s <src> -t <target>`, and the two exchange places.
 */
export const PaneDragSwap: Story = {
  args: {
    start: 'closed',
    transitions: [{ match: /^swap-pane -d -s %2 -t %1$/, to: 'swapped' }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPanes(canvas, ['%1', '%2']);
    const src = leftmost(canvas, '%1', '%2');
    expect(src).toBe('%2');
    const header = paneEl(canvas, src).querySelector('.pane-header') as HTMLElement;
    const dstEl = paneEl(canvas, '%1');
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, '%1');
    const startX = hRect.left + hRect.width / 2;
    const startY = hRect.top + hRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, clientY: startY, bubbles: true }),
    );
    // The first steps cross the 5px threshold (PaneHeader promotes the press
    // to DRAG_START); later ones feed DRAG_MOVE so the drag machine picks the
    // drop target under the cursor.
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      (i <= 2 ? header : dstEl).dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: startX + ((endX - startX) * i) / steps,
          clientY: startY + ((endY - startY) * i) / steps,
          bubbles: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 120));
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));
    await waitFor(() => expect(leftmost(canvas, '%1', '%2')).toBe('%1'), { timeout: 10000 });
  },
};

/**
 * Right-click a pane's header tab → the context menu opens; "Split Pane Below"
 * splits that pane, and the new pane is the active one.
 */
export const PaneContextMenuSplit: Story = {
  args: { transitions: [{ match: /^split-window -v$/, to: 'split-below' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForPanes(canvas, ['%0', '%1']);
    const headerTab = paneEl(canvas, '%0').querySelector('.pane-tab') as HTMLElement | null;
    expect(headerTab).not.toBeNull();
    const hr = headerTab!.getBoundingClientRect();
    headerTab!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: hr.left + 5,
        clientY: hr.top + 5,
      }),
    );
    await user.click(await findMenuItem(canvasElement.ownerDocument, /Split Pane Below/i));
    await waitForPanes(canvas, ['%0', '%1', '%2']);
    await waitFor(() => expect(activePaneId()).toBe('%2'), { timeout: 10000 });
    // Once its enter morph (which starts from the split pane's box) settles,
    // the new pane sits under the one whose menu split it.
    await waitFor(
      () => {
        expect(paneRect(canvas, '%2').top).toBeGreaterThan(paneRect(canvas, '%0').bottom - 4);
        expect(Math.abs(paneRect(canvas, '%2').left - paneRect(canvas, '%0').left)).toBeLessThan(4);
      },
      { timeout: 10000 },
    );
  },
};
