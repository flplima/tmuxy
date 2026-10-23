/**
 * The cursor on a page that scrolls, over a pane recorded from real tmux.
 *
 * What the user sees is the SmoothCursor overlay, fixed to the viewport and
 * drawn at the pane's own cursor element (its anchor). Scrolling the page the
 * app is embedded in — the demo site — moves the anchor without a render, so
 * the overlay has to follow the scroll itself: it once stayed put while the
 * terminal scrolled away under it.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Cursor Scroll',
  component: FixtureApp,
  args: { fixture: asFixture(panes), start: 'one' },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div>
        <Story />
        {/* Page below the app, so the page itself scrolls. */}
        <div style={{ height: 2000 }} />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/** The overlay's top-left corner, once it is showing. */
function overlayCorner(canvasElement: HTMLElement): { x: number; y: number } {
  const shape = canvasElement.ownerDocument.querySelector<HTMLElement>('.smooth-cursor-shape');
  const root = shape?.closest<HTMLElement>('.smooth-cursor');
  if (!shape || root?.style.opacity !== '1') throw new Error('the cursor overlay is not showing');
  const m = shape.style.clipPath.match(/polygon\(([-\d.]+)px ([-\d.]+)px/);
  if (!m) throw new Error(`no polygon in ${shape.style.clipPath}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Whether the overlay sits on a pane's cursor cell. */
function onACursorCell(canvasElement: HTMLElement): boolean {
  const corner = overlayCorner(canvasElement);
  return [...canvasElement.querySelectorAll<HTMLElement>('.terminal-cursor')].some((el) => {
    const r = el.getBoundingClientRect();
    return Math.abs(r.left - corner.x) < 1 && Math.abs(r.top - corner.y) < 1;
  });
}

export const FollowsThePageScroll: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(onACursorCell(canvasElement)).toBe(true), { timeout: 8000 });
    // Past the overlay's re-measuring after the last render, so only the
    // scroll can move it.
    await new Promise((r) => setTimeout(r, 1000));
    const before = overlayCorner(canvasElement);

    window.scrollBy(0, 120);

    await waitFor(
      () => {
        expect(overlayCorner(canvasElement).y).toBeCloseTo(before.y - 120, 0);
        expect(onACursorCell(canvasElement)).toBe(true);
      },
      { timeout: 2000 },
    );
    window.scrollTo(0, 0);
  },
};
