import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { tmuxCaughtUp } from './tmuxBarrier';
import { withTmuxView } from './tmuxView';
import { ResizeGlitchRecorder } from './resizeGlitch';
import {
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
  pickDivider,
  waitForDivider,
  dragDivider,
  sendTmux,
  settleGeometry,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Resize & Layout',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * Vertical drag resize: mouse-drag the HORIZONTAL divider between two stacked
 * panes down by ~4 rows. The top pane grows and the bottom shrinks
 * monotonically — so no pane's `top`/`height` may reverse direction. Catches
 * the two resize glitches on the vertical axis: (1) the whole grid jumping up
 * and then back down a row mid-drag (the centering offset re-rounding because
 * it isn't frozen during resize), and (2) the pane snapping back to its old
 * height for a blip after mouse-up (a stale server snapshot clearing the
 * optimistic preview before the final resize lands).
 */
export const ResizePaneDragVertical: Story = {
  args: { initCommands: ['split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);

    // The horizontal divider resizes the two stacked panes; find the one
    // directly above it (its height grows as we drag down).
    //
    // Both halves are waited for TOGETHER. The divider is positioned from the
    // new layout the moment the split lands, while the panes animate into
    // theirs — so there is a window where the divider exists and no pane's
    // bottom edge lines up with it yet. Waiting for the divider alone lands
    // squarely in it.
    let hDiv!: HTMLElement;
    let grower!: string;
    await waitFor(
      () => {
        hDiv = pickDivider(canvasElement, 'horizontal');
        const dTop = hDiv.getBoundingClientRect().top;
        const above = paneIds(canvas).find((id) => {
          const r = paneRect(canvas, id);
          return Math.abs(r.top + r.height - dTop) < 14; // its bottom edge is the divider
        });
        if (!above) throw new Error('no pane above the horizontal divider');
        grower = above;
      },
      { timeout: 30000, interval: 250 },
    );
    const before = paneRect(canvas, grower).height;

    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await dragDivider(hDiv, rec, { dy: 144, steps: 12 });

    await waitFor(
      () => expect(Math.abs(paneRect(canvas, grower).height - before)).toBeGreaterThan(30),
      { timeout: 30000, interval: 500 },
    );
    await settleGeometry(canvas);
    await tmuxCaughtUp();
    const after = paneRect(canvas, grower).height;
    expect(Math.abs(paneRect(canvas, grower).height - after)).toBeLessThan(10);
    // No pane's top/height may reverse: not the resized panes flashing back to
    // their old height on release, nor an uninvolved pane's row jumping and
    // returning as the grid re-centers mid-resize.
    rec.assertNoBounces();
  },
};

/**
 * Complex-layout resize: a tiled 4-pane grid. Dragging ONE divider must leave
 * every OTHER pane's row perfectly still. tmux emits intermediate
 * %layout-change events during a resize in which panes it isn't resizing
 * transiently report y=0 (the top border row momentarily gone), which
 * computePaneBox renders as that pane's content jumping up a row for a frame.
 * The recorder watches all four panes; any top/height reversal — on the
 * resized panes OR an uninvolved one — fails.
 */
export const ResizePaneDragGrid: Story = {
  args: {
    initCommands: ['split-window -v', 'split-window -h', 'select-layout tiled'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    // A tiled 2x2 needs all four panes; wait for them before measuring.
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(4), {
      timeout: 30000,
      interval: 500,
    });
    await settleGeometry(canvas);

    const sigBefore = paneIds(canvas)
      .map((id) => Math.round(paneRect(canvas, id).width + paneRect(canvas, id).height))
      .join();

    // Drag the horizontal divider (vertical resize between the rows): tmux
    // then transiently drops the top row to y=0 — every top pane, not just the
    // resized one, must hold its header row.
    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await dragDivider(await waitForDivider(canvasElement, 'horizontal'), rec, {
      dy: 108,
      steps: 12,
    });

    // The resize took effect somewhere.
    await waitFor(
      () =>
        expect(
          paneIds(canvas)
            .map((id) => Math.round(paneRect(canvas, id).width + paneRect(canvas, id).height))
            .join(),
        ).not.toBe(sigBefore),
      { timeout: 30000, interval: 500 },
    );
    await settleGeometry(canvas);
    await tmuxCaughtUp();
    rec.assertNoBounces();
  },
};

/**
 * Splitting a pane must not jump any EXISTING pane's rows. During a split tmux
 * emits transient intermediate %layout-change events in which an existing pane
 * briefly reports y=0 (its top border row momentarily gone); computePaneBox
 * would drop that pane's header and shift its terminal content up a row for a
 * frame — the same root cause as the resize row-jump, on a different operation.
 * The reconcile masks the dip (appMachine TMUX_MODEL_UPDATE). The recorder
 * watches every pane's box AND content top ([role=log]) through the split:
 * first in the plain two-pane layout, then inside a tiled 2x2 grid, a larger
 * re-layout burst (more panes momentarily dropping to y=0).
 */
export const SplitPaneInGridNoRowJump: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());

    const splitWithoutRowJump = async (command: string) => {
      await settleGeometry(canvas);
      const before = paneGroups(canvas).length;
      const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
      sendTmux(command);
      await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThan(before), {
        timeout: 30000,
        interval: 500,
      });
      await settleGeometry(canvas);
      await tmuxCaughtUp();
      // No existing pane's content jumped a row while the new pane appeared.
      rec.assertNoBounces();
    };

    await splitWithoutRowJump('split-window -v');

    // Three panes become the tiled 2x2 grid.
    sendTmux('split-window -h');
    sendTmux('select-layout tiled');
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(4), {
      timeout: 30000,
      interval: 500,
    });
    await splitWithoutRowJump('split-window -h');
  },
};
