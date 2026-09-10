/**
 * Dragging a divider only as far as tmux would actually go (demo engine).
 *
 * tmux will not shrink a pane below one cell, so a drag that asks for more
 * than the panes across the line can give up is refused. Until it is, the
 * preview keeps drawing a layout that will never exist: the near pane grows
 * under the pointer while the far one bottoms out, and the two overlap. The
 * drag is therefore clamped to what the layout can give
 * (machines/resize/limits.ts), and a divider with nothing to give on either
 * side refuses the gesture outright.
 *
 * These stories drive the real pointer sequence and assert on the boxes the
 * panes actually occupy — a pane can be the right size in the model and still
 * be drawn over its neighbour.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, fireEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Resize Limits',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The divider stops where tmux stops: no pane is ever drawn below one cell and no two panes overlap. A divider with no room at all refuses the drag outright — see Components/ResizeDividers, where a fully collapsed stack can be staged.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface Snap {
  context: {
    activeWindowId: string | null;
    charWidth: number;
    charHeight: number;
    panes: Array<{ tmuxId: string; windowId: string; width: number; height: number }>;
  };
}

function app(): Snap {
  const a = (window as unknown as { app?: { getSnapshot(): Snap } }).app;
  if (!a) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return a.getSnapshot();
}

/** The drawn box of every pane in the visible tab, left-to-right, top-to-bottom. */
function paneBoxes(canvasElement: HTMLElement): DOMRect[] {
  return [...canvasElement.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]')]
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

/** How much two boxes overlap, in px². Adjacent panes share an edge, not an area. */
function overlapArea(a: DOMRect, b: DOMRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 1 && h > 1 ? w * h : 0;
}

function dividers(canvasElement: HTMLElement): HTMLElement[] {
  return [...canvasElement.querySelectorAll<HTMLElement>('.resize-divider')];
}

function centreOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Dispatch at whatever is under the point, the way the browser does. */
function fireAt(type: string, x: number, y: number): void {
  const target = document.elementFromPoint(x, y) ?? document.body;
  fireEvent[type as 'mouseMove'](target, { clientX: x, clientY: y });
}

/** Press the divider and haul it to (x, y) in steps. */
async function dragDivider(divider: HTMLElement, x: number, y: number): Promise<void> {
  const from = centreOf(divider);
  fireEvent.mouseDown(divider, { clientX: from.x, clientY: from.y, button: 0, bubbles: true });
  for (const t of [0.2, 0.5, 0.8, 1]) {
    fireAt('mouseMove', from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForPanes(count: number, canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await waitFor(
    () => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(count),
    {
      timeout: 8000,
    },
  );
}

// ---------------------------------------------------------------------------
// Hauled past the end — the divider stops, nothing overlaps
// ---------------------------------------------------------------------------

export const DragStopsAtTheMinimum: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'The pointer is dragged far past the right edge of the window. The divider follows only as far as the right pane can shrink; the panes stay side by side instead of the left one growing out over the right, and letting go corrects nothing, because the clamped delta is also what was sent.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    const vertical = dividers(canvasElement).find(
      (d) => d.getBoundingClientRect().height > d.getBoundingClientRect().width,
    );
    if (!vertical) throw new Error('no vertical divider between the two panes');
    expect(vertical.classList.contains('resize-divider-locked')).toBe(false);

    const start = centreOf(vertical);
    const wall = canvasElement.getBoundingClientRect().right;
    await dragDivider(vertical, wall + 600, start.y);

    // What the user sees: two panes, still side by side, neither overlapping
    // the other, and the right one still wide enough to draw a cell.
    await waitFor(() => {
      const [left, right] = paneBoxes(canvasElement).sort((a, b) => a.left - b.left);
      expect(overlapArea(left, right)).toBe(0);
      expect(right.width).toBeGreaterThan(0);
      expect(left.right).toBeLessThanOrEqual(right.left + 2);
    });

    // The model agrees: nothing went below a single column.
    const cols = app().context.panes.map((p) => p.width);
    expect(Math.min(...cols)).toBeGreaterThanOrEqual(1);

    fireAt('mouseUp', wall + 600, start.y);
    await new Promise((r) => setTimeout(r, 500));
    // And the layout the engine settles on holds the same invariant — the
    // clamp is what was sent, so the release has nothing new to correct.
    const [left, right] = paneBoxes(canvasElement).sort((a, b) => a.left - b.left);
    expect(overlapArea(left, right)).toBe(0);
    expect(right.width).toBeGreaterThan(0);
    expect(Math.min(...app().context.panes.map((p) => p.width))).toBeGreaterThanOrEqual(1);
  },
};
