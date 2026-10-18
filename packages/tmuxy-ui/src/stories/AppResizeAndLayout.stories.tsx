import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { GlitchRecorder } from './glitchRecorder';
import { ResizeGlitchRecorder } from './resizeGlitch';
import {
  paneGroups,
  focusFirstPane,
  paneCols,
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
 * Resize: shrinking the client container fires the app's ResizeObserver, which
 * issues `refresh-client -C <cols>x<rows>` to real tmux. tmux re-lays out and
 * reports narrower panes over the control stream, and the WASM core reconstructs
 * the reduced column counts — a full client→tmux→client resize round-trip.
 */
export const Resize: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    // Let the initial size settle: the widest pane reads the same twice in a
    // row. Waiting for it to cross an absolute column count instead made the
    // precondition depend on how wide the runner's layout happened to land —
    // a run that settled at exactly 40 columns failed with "expected 40 to be
    // greater than 40" without anything being wrong.
    let settled = -1;
    await waitFor(
      () => {
        const widest = Math.max(...paneCols());
        const stable = widest > 0 && widest === settled;
        settled = widest;
        expect(stable).toBe(true);
      },
      { timeout: 15000, interval: 500 },
    );
    const before = settled;
    const harness = canvasElement.firstElementChild as HTMLElement;
    harness.style.width = '480px';
    await waitFor(() => expect(Math.max(...paneCols())).toBeLessThan(before), {
      timeout: 30000,
      interval: 500,
    });
  },
};

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
    await new Promise((res) => setTimeout(res, 800));
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
    await new Promise((res) => setTimeout(res, 800));
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
 * watches every pane's box AND content top ([role=log]) through the split.
 */
export const SplitPaneNoRowJump: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const before = paneGroups(canvas).length;

    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    sendTmux('split-window -v');
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThan(before), {
      timeout: 30000,
      interval: 500,
    });
    await settleGeometry(canvas);
    await new Promise((res) => setTimeout(res, 800));
    // No existing pane's content jumped a row while the new pane appeared.
    rec.assertNoBounces();
  },
};

/**
 * Same guard on a busier layout: split inside a 2x2 grid, a larger re-layout
 * burst (more panes momentarily dropping to y=0).
 */
export const SplitPaneInGridNoRowJump: Story = {
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
    const before = paneGroups(canvas).length;

    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    sendTmux('split-window -h');
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThan(before), {
      timeout: 30000,
      interval: 500,
    });
    await settleGeometry(canvas);
    await new Promise((res) => setTimeout(res, 800));
    rec.assertNoBounces();
  },
};

/**
 * Layout cycle: with 3 panes, C-a Space (next-layout) rearranges them — the rect
 * signature (id→x,y,w) must actually change, and the geometry comes from tmux's
 * %layout-change, not a client-side shuffle.
 */
export const LayoutCycle: Story = {
  args: { initCommands: ['split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3), {
      timeout: 45000,
      interval: 500,
    });
    await focusFirstPane(canvas, user);
    const signature = () =>
      paneGroups(canvas)
        .map((p: HTMLElement) => {
          const r = p.getBoundingClientRect();
          return `${p.getAttribute('data-pane-id')}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`;
        })
        .sort()
        .join('|');
    const before = signature();
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard(' ');
    await waitFor(() => expect(signature()).not.toBe(before), { timeout: 30000, interval: 500 });
    // All panes still visible after the re-layout.
    for (const p of paneGroups(canvas)) {
      const r = (p as HTMLElement).getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
    glitches.assertNoGlitches('layoutCycle');
  },
};
