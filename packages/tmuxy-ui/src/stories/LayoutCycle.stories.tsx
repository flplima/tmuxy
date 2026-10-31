/**
 * Cycling tmux's layouts from the keyboard, over states recorded from real
 * tmux (`fixtures/scenarios/next-layout.ts`).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import nextLayout from './fixtures/gen/next-layout.json';
import { GlitchRecorder } from './glitchRecorder';
import { ResizeGlitchRecorder } from './resizeGlitch';
import { activePaneId, paneGroups } from './appStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Layout Cycle',
  component: FixtureApp,
  args: {
    fixture: asFixture(nextLayout),
    start: 'three',
    // A prefix binding goes out pinned to the window and pane in front of the user.
    transitions: [
      { match: /^select-window -t @0 \\; select-pane -t %0 \\; next-layout$/, to: 'cycled' },
    ],
  },
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/**
 * With three panes, C-a Space (`next-layout`) lays them out the way tmux's
 * next layout does: every pane moves to its new box, all stay visible, and
 * the re-layout runs with no node flicker and no pane moving back the way it
 * came.
 *
 * tmux's answer arrives as one quiet update, which the app animates (the
 * geometry transition of a lone layout change), so the panes pass through
 * the frames between their two boxes. Those frames are the motion, not
 * jumps: the geometry is held to a monotonic morph instead — each pane's box
 * and the top of its rows move one way, start to end. A pane growing below a
 * top edge that holds keeps its rows there while it opens; hung from its
 * bottom edge, its new rows started 360px above where they land.
 */
export const LayoutCycle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitFor(() => expect(paneGroups(canvas).length).toBe(3), { timeout: 10000 });
    await user.click(canvas.getByRole('group', { name: /^Pane %0\b/ }));
    await waitFor(() => expect(activePaneId()).toBe('%0'), { timeout: 10000 });
    const signature = () =>
      paneGroups(canvas)
        .map((p: HTMLElement) => {
          const r = p.getBoundingClientRect();
          return `${p.getAttribute('data-pane-id')}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`;
        })
        .sort()
        .join('|');
    const before = signature();
    const layout = canvasElement.querySelector('.pane-layout')!;
    const glitches = new GlitchRecorder(layout);
    const motion = new ResizeGlitchRecorder(layout);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard(' ');
    await waitFor(() => expect(signature()).not.toBe(before), { timeout: 10000 });
    // Three columns side by side, as tmux laid them out.
    await waitFor(
      () => {
        const tops = paneGroups(canvas).map((p: HTMLElement) =>
          Math.round(p.getBoundingClientRect().top),
        );
        expect(new Set(tops).size).toBe(1);
      },
      { timeout: 10000 },
    );
    for (const p of paneGroups(canvas)) {
      const r = (p as HTMLElement).getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
    motion.assertMonotonicMorph();
    glitches.assertNoGlitches('layoutCycle', { sizeJumps: Number.POSITIVE_INFINITY });
  },
};
