/**
 * Dragging a divider only as far as tmux would go, over a recording of real
 * tmux. tmux will not shrink a pane below one cell and refuses a drag asking
 * for more, so until then the preview drew a layout that would never exist,
 * the two panes overlapping; the drag is clamped (machines/resize/limits.ts).
 * Asserted on the drawn boxes: a pane can be right in the model and still be
 * drawn over its neighbour.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, fireEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import dividerAtMinimum from './fixtures/gen/divider-at-minimum.json';
import { waitForPaneCount } from './animationStoryHelpers';

const RESIZE = [{ match: /^resize-pane\b/, to: 'right-at-minimum' }];

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Resize Limits',
  component: FixtureApp,
  args: { fixture: asFixture(dividerAtMinimum), start: 'side-by-side', transitions: RESIZE },
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
type Story = StoryObj<typeof FixtureApp>;

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
  if (!a) throw new Error('window.app actor is not available — FixtureApp not mounted?');
  return a.getSnapshot();
}

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

function fireAt(type: string, x: number, y: number): void {
  const target = document.elementFromPoint(x, y) ?? document.body;
  fireEvent[type as 'mouseMove'](target, { clientX: x, clientY: y });
}

async function dragDivider(divider: HTMLElement, x: number, y: number): Promise<void> {
  const from = centreOf(divider);
  fireEvent.mouseDown(divider, { clientX: from.x, clientY: from.y, button: 0, bubbles: true });
  for (const t of [0.2, 0.5, 0.8, 1]) {
    fireAt('mouseMove', from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const waitForPanes = (count: number, canvasElement: HTMLElement) =>
  waitForPaneCount(within(canvasElement), count);

export const DragStopsAtTheMinimum: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
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

    await waitFor(() => {
      const [left, right] = paneBoxes(canvasElement).sort((a, b) => a.left - b.left);
      expect(overlapArea(left, right)).toBe(0);
      expect(right.width).toBeGreaterThan(0);
      expect(left.right).toBeLessThanOrEqual(right.left + 2);
    });

    const cols = app().context.panes.map((p) => p.width);
    expect(Math.min(...cols)).toBeGreaterThanOrEqual(1);

    fireAt('mouseUp', wall + 600, start.y);
    await new Promise((r) => setTimeout(r, 500));
    // The clamp is what was sent, so the release has nothing to correct.
    const [left, right] = paneBoxes(canvasElement).sort((a, b) => a.left - b.left);
    expect(overlapArea(left, right)).toBe(0);
    expect(right.width).toBeGreaterThan(0);
    expect(Math.min(...app().context.panes.map((p) => p.width))).toBeGreaterThanOrEqual(1);
  },
};
