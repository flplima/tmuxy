/**
 * The SmoothCursor overlay is fixed to the viewport and drawn at the pane's
 * cursor element. A page embedding the app (the demo site) moves that anchor
 * without a render when it scrolls or re-lays out, so the overlay has to
 * follow the page itself; it once stayed put while the terminal moved away.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import { cursorPolygon } from './cursorShape';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Cursor On A Moving Page',
  component: FixtureApp,
  args: { fixture: asFixture(panes), start: 'one' },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="moving-page">
        <Story />
        <div style={{ height: 2000 }} />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

function overlayCorner(canvasElement: HTMLElement): { x: number; y: number } {
  const shape = canvasElement.ownerDocument.querySelector<HTMLElement>('.smooth-cursor-shape');
  const root = shape?.closest<HTMLElement>('.smooth-cursor');
  if (!shape || root?.style.opacity !== '1') throw new Error('the cursor overlay is not showing');
  const [corner] = cursorPolygon(shape.style.clipPath);
  if (!corner) throw new Error(`no polygon in ${shape.style.clipPath}`);
  return { x: corner[0], y: corner[1] };
}

function onACursorCell(canvasElement: HTMLElement): boolean {
  const corner = overlayCorner(canvasElement);
  return [...canvasElement.querySelectorAll<HTMLElement>('.terminal-cursor')].some((el) => {
    const r = el.getBoundingClientRect();
    return Math.abs(r.left - corner.x) < 1 && Math.abs(r.top - corner.y) < 1;
  });
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * The overlay on a cursor cell and done re-measuring: its corner the same two
 * frames running, so only the page moving can move it.
 */
async function settled(canvasElement: HTMLElement): Promise<{ x: number; y: number }> {
  for (;;) {
    await waitFor(() => expect(onACursorCell(canvasElement)).toBe(true), { timeout: 8000 });
    const corner = overlayCorner(canvasElement);
    await nextFrame();
    await nextFrame();
    const again = overlayCorner(canvasElement);
    if (again.x === corner.x && again.y === corner.y) return again;
  }
}

export const FollowsThePageScroll: Story = {
  play: async ({ canvasElement }) => {
    const before = await settled(canvasElement);

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

export const FollowsAResizedWindowsLayout: Story = {
  play: async ({ canvasElement }) => {
    const before = await settled(canvasElement);

    // What a narrower window does to the demo: the page re-centres the app,
    // whose grid keeps its size.
    const page = canvasElement.querySelector<HTMLElement>('.moving-page');
    if (!page) throw new Error('no .moving-page');
    page.style.marginLeft = '90px';
    window.dispatchEvent(new Event('resize'));

    await waitFor(
      () => {
        expect(overlayCorner(canvasElement).x).toBeCloseTo(before.x + 90, 0);
        expect(onACursorCell(canvasElement)).toBe(true);
      },
      { timeout: 2000 },
    );
    page.style.marginLeft = '';
  },
};
