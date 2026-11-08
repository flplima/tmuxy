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
 * Dragging the horizontal divider between two stacked panes: no pane's
 * `top`/`height` may reverse. Catches the grid jumping a row mid-drag (the
 * centring offset re-rounding when not frozen during a resize) and the pane
 * snapping back for a blip after mouse-up (a stale server snapshot clearing the
 * preview before the final resize lands).
 */
export const ResizePaneDragVertical: Story = {
  tags: ['gate'],
  args: { initCommands: ['split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);

    // Divider and pane waited for together: the divider is placed from the new
    // layout as soon as the split lands while the panes still animate, so
    // waiting for the divider alone finds no pane edge on it yet.
    let hDiv!: HTMLElement;
    let grower!: string;
    await waitFor(
      () => {
        hDiv = pickDivider(canvasElement, 'horizontal');
        const dTop = hDiv.getBoundingClientRect().top;
        const above = paneIds(canvas).find((id) => {
          const r = paneRect(canvas, id);
          return Math.abs(r.top + r.height - dTop) < 14;
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
    rec.assertNoBounces();
  },
};

/**
 * In a tiled 2x2, dragging one divider leaves every other pane's row still.
 * tmux's intermediate %layout-change events during a resize report panes it
 * is not resizing at y=0 (the top border row momentarily gone), which paneBox
 * renders as that content jumping a row for a frame.
 */
export const ResizePaneDragGrid: Story = {
  tags: ['gate'],
  args: {
    initCommands: ['split-window -v', 'split-window -h', 'select-layout tiled'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(4), {
      timeout: 30000,
      interval: 500,
    });
    await settleGeometry(canvas);

    const sigBefore = paneIds(canvas)
      .map((id) => Math.round(paneRect(canvas, id).width + paneRect(canvas, id).height))
      .join();

    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await dragDivider(await waitForDivider(canvasElement, 'horizontal'), rec, {
      dy: 108,
      steps: 12,
    });

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
 * Splitting must not jump any existing pane's rows: during a split tmux's
 * intermediate %layout-change events briefly report an existing pane at y=0,
 * which paneBox would render as its content shifting up a row for a frame. The
 * TMUX_MODEL_UPDATE reconcile masks the dip. Checked in a two-pane layout, then
 * in a tiled 2x2 (more panes dropping to y=0 at once).
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
      rec.assertNoBounces();
    };

    await splitWithoutRowJump('split-window -v');

    sendTmux('split-window -h');
    sendTmux('select-layout tiled');
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(4), {
      timeout: 30000,
      interval: 500,
    });
    await splitWithoutRowJump('split-window -h');
  },
};
