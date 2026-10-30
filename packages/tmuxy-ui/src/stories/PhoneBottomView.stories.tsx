/**
 * The phone's bottom view, under the key row: the tabs/panes tree, or, after
 * a sideways swipe, the side pane — the pinned terminal the desktop keeps in
 * its right column. The swipe is a slide like the one between tabs
 * (components/PhoneBottomView.tsx, utils/bottomSlide.ts).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx, swipeTimed, touch } from './phoneStoryHelpers';
import { SWIPE_SETTLE_MAX_MS } from '../utils/gestures';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Bottom View',
  component: FixtureApp,
  args: {
    fixture: asFixture(phoneTwoTabs),
    start: 'main-active',
    config: { phoneLayout: true },
  },
  // The phone's screen, not the grid's box: the layout fits the grid to it.
  render: ({ fixture, start, config }) => (
    <FixtureProvider fixture={fixture} start={start} config={config} width={390} height={844}>
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/** A released slide settles in up to 320 ms, then React re-renders: a slow runner needs more than waitFor's default second. */
const SETTLE = { timeout: 4000 };

export const BottomViewSlidesToTheSidePane: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'Under the keys, the tree; a sideways swipe on it slides the view to the side pane — the pinned terminal the desktop keeps in its right column, asked of tmux the same way on first use (here the recording answers nothing, so it waits on “starting…”). The view follows the finger with the side pane riding in from the right, as a tab slide shows both tabs; the release settles it in front. A swipe back slides the tree in from the left.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.phone-tree [role="treeitem"]')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const bottom = canvasElement.querySelector('[data-testid="phone-bottom"]')!;
    const frame = box(bottom);
    expect(bottom.getAttribute('data-view')).toBe('tree');
    expect(canvasElement.querySelector('.phone-dock')).toBeNull();

    // Half way through the swipe: the tree has moved with the finger and the
    // side pane rides at its right edge, not yet the view in front.
    const y = frame.top + 40;
    const [fromX, toX] = [frame.right - 20, frame.left + 20];
    touch(bottom, 'touchstart', fromX, y);
    for (let i = 1; i <= 3; i++) touch(bottom, 'touchmove', fromX + ((toX - fromX) * i) / 6, y);
    const pulled = (toX - fromX) / 2;
    await waitFor(() => {
      expect(bottom.getAttribute('data-sliding')).toBe('tracking');
      expect(bottom.getAttribute('data-view')).toBe('tree');
      const tree = box(canvasElement.querySelector('.phone-tree'));
      const dock = box(canvasElement.querySelector('.phone-dock'));
      expect(tree.left).toBeCloseTo(frame.left + pulled, 0);
      expect(dock.left).toBeCloseTo(tree.right, 0);
      expect(dock.width).toBeCloseTo(frame.width, 0);
    }, SETTLE);
    for (let i = 4; i <= 6; i++) touch(bottom, 'touchmove', fromX + ((toX - fromX) * i) / 6, y);
    touch(bottom, 'touchend', toX, y);

    // Released past the mark: it settles with the side pane in front, alone.
    await waitFor(() => {
      expect(bottom.getAttribute('data-view')).toBe('dock');
      expect(bottom.getAttribute('data-sliding')).toBeNull();
      const dock = box(canvasElement.querySelector('.phone-dock'));
      expect(dock.left).toBeCloseTo(frame.left, 0);
      // Read now, not at the start: the page may settle its height meanwhile.
      expect(dock.top).toBeGreaterThanOrEqual(box(bottom).top - 1);
      expect(dock.height).toBeGreaterThan(100);
      expect(canvasElement.querySelector('.phone-dock')!.textContent).toContain('starting');
    }, SETTLE);
    expect(canvasElement.querySelector('.phone-tree')).toBeNull();

    // A short, slow pull lets go short of the mark: it settles back where it
    // was. The settle is given its longest time before the view is read, so a
    // flip that was coming has come.
    const yNow = () => box(bottom).top + 40;
    await swipeTimed(bottom, yNow(), frame.left + 20, frame.left + 50, { steps: 3, stepMs: 150 });
    await new Promise((r) => setTimeout(r, SWIPE_SETTLE_MAX_MS + 150));
    await waitFor(() => {
      expect(bottom.getAttribute('data-sliding')).toBeNull();
      expect(bottom.getAttribute('data-view')).toBe('dock');
    }, SETTLE);

    // The way back: the tree rides in from the left.
    await swipeTimed(bottom, yNow(), frame.left + 20, frame.right - 20);
    await waitFor(() => {
      expect(bottom.getAttribute('data-view')).toBe('tree');
      expect(bottom.getAttribute('data-sliding')).toBeNull();
      expect(canvasElement.querySelector('.phone-tree [role="treeitem"]')).not.toBeNull();
      expect(box(canvasElement.querySelector('.phone-tree')).left).toBeCloseTo(frame.left, 0);
    }, SETTLE);
    expect(canvasElement.querySelector('.phone-dock')).toBeNull();
  },
};
