/**
 * The bar between the phone's terminal and its bottom view, at a 390 × 844
 * phone's width (components/phone/PhoneDivider.tsx, domain/phoneSplit.ts): dragged
 * down it zooms the terminal — the panes, their headers and tmux's status
 * line as one picture — as far as the bottom view gives room; dragged up from
 * the terminal's own size it folds the terminal and the keys away, and down
 * again brings them back. The split is kept for the device's next load.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx } from './phoneStoryHelpers';
import { forgetPhoneSplitPref, loadPhoneSplitPref } from '../infra/prefs';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Divider',
  component: FixtureApp,
  args: {
    fixture: asFixture(phoneTwoTabs),
    start: 'main-active',
    config: { phoneLayout: true },
  },
  render: ({ fixture, start, config }) => (
    <FixtureProvider fixture={fixture} start={start} config={config} width={390} height={844}>
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/** The mouse's pointer, the one a browser always has: capture works on it. */
function pointer(el: Element, type: string, y: number) {
  const x = box(el).left + box(el).width / 2;
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  );
}

/** Drag the bar `dy` px, in steps a frame apart. */
async function dragBar(bar: Element, dy: number, steps = 6) {
  const y0 = box(bar).top + box(bar).height / 2;
  pointer(bar, 'pointerdown', y0);
  for (let i = 1; i <= steps; i++) {
    await new Promise((r) => setTimeout(r, 16));
    pointer(bar, 'pointermove', y0 + (dy * i) / steps);
  }
  pointer(bar, 'pointerup', y0 + dy);
}

export const DragTheBarToZoomOrFold: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'Dragged down 150px, the bar zooms the terminal by the height it gives it: the grid and tmux’s status line grow together from the top-left corner, the keys stay under them and the bottom view gives up the room. Dragged back up, the terminal settles on its own size; dragged up past that, the terminal and the keys fold away and the bottom view takes the screen, the bar along its top; dragged down again, they come back. Each release is kept for the next load.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.phone-pty .pane-layout-item')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const bar = canvasElement.querySelector('[data-testid="phone-divider"]')!;
    const q = (sel: string) => box(canvasElement.querySelector(sel));
    const screen = q('.app-container');
    const grid = q('.phone-pty .pane-container');
    const line = q('.phone-pty .tmux-status-bar');
    const lower = q('.phone-lower');
    const barTop = box(bar).top;
    try {
      // 1. Down: the picture grows by the height dragged, the status line
      //    under the grid at the same scale, from the top-left corner.
      await dragBar(bar, 150);
      await waitFor(() => expect(ctx().phoneZoom).toBeGreaterThan(1.3));
      const zoom = ctx().phoneZoom;
      await waitFor(() => {
        expect(box(bar).top).toBeCloseTo(barTop + 150, -1);
        const g = q('.phone-pty .pane-container');
        expect(g.height).toBeCloseTo(grid.height * zoom, 0);
        expect(g.left).toBeCloseTo(grid.left, 0);
        expect(g.top).toBeCloseTo(grid.top, 0);
        expect(q('.phone-pty .tmux-status-bar').height).toBeCloseTo(line.height * zoom, 0);
        expect(q('.key-row').top).toBeGreaterThanOrEqual(
          q('.phone-pty .tmux-status-bar').bottom - 1,
        );
        expect(q('.phone-lower').height).toBeCloseTo(lower.height - 150, -1);
        expect(
          canvasElement.querySelector('[data-key-row="zoom"]')!.getAttribute('aria-pressed'),
        ).toBe('true');
      });
      expect(loadPhoneSplitPref()).toEqual({
        zoom,
        collapsed: false,
      });

      // 2. Back up past the start: the terminal settles on its own size.
      await dragBar(bar, -300);
      await waitFor(() => {
        expect(ctx().phoneZoom).toBe(1);
        expect(box(bar).top).toBeCloseTo(barTop, 0);
      });

      // 3. Up from its own size: folded away, the bottom view the screen.
      await dragBar(bar, -90);
      await waitFor(() => {
        expect(ctx().phoneCollapsed).toBe(true);
        expect(q('.phone-top').height).toBe(0);
        expect(box(bar).top).toBeCloseTo(screen.top, 0);
        expect(q('.phone-lower').bottom).toBeCloseTo(screen.bottom, 0);
        expect(q('.phone-tabs').top).toBeCloseTo(box(bar).bottom, 0);
      });

      // 4. Down again past the threshold: back, at the terminal's own size
      //    (released where it came back, the drag going on from there).
      await dragBar(bar, 70);
      await waitFor(() => {
        expect(ctx().phoneCollapsed).toBe(false);
        expect(q('.phone-pty .pane-container').height).toBeCloseTo(grid.height, 0);
      });
    } finally {
      forgetPhoneSplitPref();
    }
  },
};
