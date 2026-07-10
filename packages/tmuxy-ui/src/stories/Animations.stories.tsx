/**
 * Animation integration stories.
 *
 * These drive the full TmuxyApp against the DemoAdapter and verify that the
 * DOM mutations + CSS animations behind each layout/float transition actually
 * fire — using MutationObservers (and, for floats, a real `animationstart`
 * listener) rather than only asserting the post-animation end state.
 *
 * Coverage:
 *  - SplitPane            split runs the enter morph: the new pane transitions
 *                         from the source pane's pre-split box into place
 *  - SlowSplitOptimistic  optimistic placeholder node appears before a slow ack
 *  - SplitRejectedRollback optimistic node is inserted, then removed on reject
 *  - ClosePane            killed pane runs the leave morph (.pane-leaving) into
 *                         the survivor's box, then its node is removed
 *  - ResizePane           moving the divider rewrites pane geometry (animated)
 *  - OpenFloat            overlay portals into <body> and runs `float-appear`
 *  - OpenDrawer           drawer overlay runs the `slide-in-left` keyframe
 *  - CloseFloat           overlay node is removed (float close is instant)
 *  - AnimationsDisabled   new-window still flips `.pane-layout-no-animations`
 *
 * What "animation exercised" means here: a CSS transition can't be observed
 * by a MutationObserver directly, but its `transitionstart` events and the
 * mutations it animates between *can* (a node inserted/removed, an inline
 * `style`/`class` rewrite). For floats the keyframe is observed directly via
 * `animationstart`. Splits and kills run the PaneLayout enter/leave lifecycle
 * (`pane-entering` / `pane-shifting` / `pane-leaving`), asserted via
 * `transitionstart` plus bounding-rect sampling.
 *
 * Stories execute in real Chromium via `scripts/probe-stories.mjs`, so the
 * CSS animations and MutationObservers run for real and a throw in `play`
 * fails the probe.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import {
  LayoutMutationRecorder,
  observeChildList,
  waitForCssAnimation,
  wait,
} from './animationObservers';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Animations',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Integration stories that verify the DOM mutations and CSS animations behind pane splits, closes, resizes, float open/close, and the animations-disabled state. Uses MutationObservers to confirm each animation is exercised, and combines slow-tmux (optimistic) and rejected-command (rollback) timing via the DemoAdapter.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface AppActor {
  send: (event: unknown) => void;
  getSnapshot: () => {
    context: {
      activePaneId: string | null;
      enableAnimations: boolean;
      floatPanes: Record<string, { paneId: string }>;
    };
  };
}

function getApp(): AppActor {
  const app = (window as unknown as { app?: AppActor }).app;
  if (!app) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return app;
}

type Canvas = ReturnType<typeof within>;

function paneNodes(canvasElement: HTMLElement): HTMLElement[] {
  return Array.from(canvasElement.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]'));
}

function getPaneLayout(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.pane-layout');
  if (!el) throw new Error('.pane-layout not found');
  return el;
}

async function waitForPaneCount(canvas: Canvas, count: number, timeout = 8000): Promise<void> {
  await waitFor(
    () => {
      const panes = canvas.getAllByRole('group', { name: /^Pane /i });
      expect(panes.length).toBe(count);
    },
    { timeout },
  );
}

/** Resolve once the app has settled and re-enabled layout animations. */
async function waitForAnimationsEnabled(layout: HTMLElement, timeout = 6000): Promise<void> {
  await waitFor(
    () => {
      expect(layout.classList.contains('pane-layout-no-animations')).toBe(false);
    },
    { timeout },
  );
}

// ---------------------------------------------------------------------------
// Split — a pane node is inserted and the survivor re-lays-out
// ---------------------------------------------------------------------------

export const SplitPane: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Splitting runs the enter morph: the new pane mounts with `.pane-entering`, is FLIP-rewound to the source pane’s pre-split box at reduced opacity, and transitions into its final half-width box while fading in; the source pane gets `.pane-shifting` and converges on the same clock. Asserted via `transitionstart` events, a paint-aligned rAF rect/opacity sampler on the entering pane (starts materially larger and translucent, converges smaller), and the settled end state (two panes, no lifecycle classes, no overlap).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    // transitionstart bubbles — record which properties actually started
    // transitioning on the entering pane. A paint-aligned rAF sampler
    // records the entering pane's rect + opacity each frame (transitionstart
    // handlers can be dispatched late under load, and the demo engine may
    // retarget the morph mid-flight with a client resize — rAF sampling is
    // immune to both).
    const enterStarts = new Set<string>();
    const onTransitionStart = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('pane-entering')) {
        enterStarts.add((e as TransitionEvent).propertyName);
      }
    };
    layout.addEventListener('transitionstart', onTransitionStart);

    const enterSamples: { area: number; opacity: number }[] = [];
    let sampling = true;
    const sampleFrame = () => {
      const entering = layout.querySelector<HTMLElement>('.pane-layout-item.pane-entering');
      if (entering) {
        const r = entering.getBoundingClientRect();
        enterSamples.push({
          area: r.width * r.height,
          opacity: parseFloat(getComputedStyle(entering).opacity),
        });
      }
      if (sampling) requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);

    const recorder = new LayoutMutationRecorder(layout);
    try {
      // SEND_TMUX_COMMAND routes through TmuxStore (optimistic predict → cmd →
      // reconcile); the new pane node is inserted as part of that patch.
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      await waitForPaneCount(canvas, 2);
      await waitFor(
        () => {
          // A new pane node was inserted AND a sibling was re-laid-out.
          expect(recorder.addedPaneIds.size).toBeGreaterThanOrEqual(1);
          expect(recorder.geometryRewrites).toBeGreaterThan(0);
          // The enter morph actually ran: geometry + opacity transitions
          // started on the .pane-entering node.
          expect(enterStarts.has('opacity')).toBe(true);
          expect(enterStarts.has('width') || enterStarts.has('left')).toBe(true);
        },
        { timeout: 2000 },
      );

      // The morph settles: lifecycle classes drop off and the two panes are
      // visibly tiled, no longer overlapping.
      await waitFor(
        () => {
          expect(
            canvasElement.querySelectorAll('.pane-entering, .pane-shifting, .pane-leaving').length,
          ).toBe(0);
        },
        { timeout: 2000 },
      );
      sampling = false;

      // Per the sketch: the new pane starts at (≈) the source pane's full
      // pre-split box at reduced opacity and converges to its half-box — so
      // the first painted sample is materially larger than the last, and it
      // starts translucent.
      expect(enterSamples.length).toBeGreaterThan(1);
      const first = enterSamples[0];
      const last = enterSamples[enterSamples.length - 1];
      expect(first.area).toBeGreaterThan(last.area * 1.3);
      expect(first.opacity).toBeLessThan(1);

      const [a, b] = paneNodes(canvasElement).map((n) => n.getBoundingClientRect());
      const ovX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const ovY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(Math.min(ovX, ovY)).toBeLessThanOrEqual(1); // mosaic panes share only their 1px edge
    } finally {
      sampling = false;
      recorder.disconnect();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};

// ---------------------------------------------------------------------------
// Slow split — the optimistic placeholder node appears before the slow ack
// ---------------------------------------------------------------------------

export const SlowSplitOptimistic: Story = {
  args: { height: 600, commandDelayMs: 400 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'The backend takes 400ms to ack `split-window`. The optimistic placeholder pane node must be inserted into the DOM within a frame (well before the ack) and must stay — the MutationObserver records exactly one insertion and no removal while we wait.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const recorder = new LayoutMutationRecorder(getPaneLayout(canvasElement));
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      // Optimistic placeholder is inserted immediately — long before the 400ms ack.
      await waitFor(
        () => {
          expect(recorder.addedPaneIds.size).toBe(1);
        },
        { timeout: 200 },
      );

      // It must not flicker away while the backend is still processing.
      for (let i = 0; i < 6; i++) {
        expect(paneNodes(canvasElement).length).toBe(2);
        expect(recorder.removedPaneIds.size).toBe(0);
        await wait(40);
      }

      // After the ack, still two panes (now from the reconciled server state).
      await wait(300);
      await waitForPaneCount(canvas, 2);
    } finally {
      recorder.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Rejected split — optimistic node is inserted, then removed (rollback)
// ---------------------------------------------------------------------------

export const SplitRejectedRollback: Story = {
  args: {
    height: 600,
    commandDelayMs: 60,
    failCommand: (cmd) => (cmd.startsWith('split-window') ? "can't split pane: no space" : false),
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'The backend rejects `split-window`. The optimistic pane node is inserted, then the rejection rolls it back. The MutationObserver captures both the insertion and the subsequent removal of the same pane id, and the count returns to 1.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const recorder = new LayoutMutationRecorder(getPaneLayout(canvasElement));
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      // Optimistic insertion lands first.
      await waitFor(
        () => {
          expect(recorder.addedPaneIds.size).toBeGreaterThanOrEqual(1);
        },
        { timeout: 400 },
      );

      // Rejection rolls it back: the inserted pane node is removed again.
      await waitFor(
        () => {
          expect(recorder.removedPaneIds.size).toBeGreaterThanOrEqual(1);
        },
        { timeout: 1500 },
      );
      await waitForPaneCount(canvas, 1);

      // The same pane id that was optimistically added is the one removed.
      const added = [...recorder.addedPaneIds];
      expect(added.some((id) => recorder.removedPaneIds.has(id))).toBe(true);
    } finally {
      recorder.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Close — the killed pane node is removed; survivor re-lays-out to fill
// ---------------------------------------------------------------------------

export const ClosePane: Story = {
  args: { height: 600, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Killing a pane runs the leave morph: the model drops the pane but its node stays mounted with `.pane-leaving`, transitioning into the survivor’s expanded box while fading to 0, then the node is removed. Asserted via the `.pane-leaving` node’s presence + geometry target, `transitionstart`, the eventual removal of the exact pane id, and the survivor’s re-layout.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 2);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    const activeId = getApp().getSnapshot().context.activePaneId;
    expect(activeId).toBeTruthy();

    const leaveStarts = new Set<string>();
    const onTransitionStart = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('pane-leaving')) {
        leaveStarts.add((e as TransitionEvent).propertyName);
      }
    };
    layout.addEventListener('transitionstart', onTransitionStart);

    const recorder = new LayoutMutationRecorder(layout);
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: `kill-pane -t ${activeId}` });

      // The killed pane's node survives the model drop as .pane-leaving,
      // retargeted at the absorber's box (inline width = full grid width,
      // wider than the half-box it is morphing from).
      const leaving = await waitFor(
        () => {
          const el = canvasElement.querySelector<HTMLElement>('.pane-layout-item.pane-leaving');
          if (!el) throw new Error('no .pane-leaving node yet');
          return el;
        },
        { timeout: 1000 },
      );
      expect(leaving.getAttribute('data-pane-id')).toBe(activeId);

      // The leave morph runs (opacity + geometry transitions started), the
      // node is removed after it, and the survivor re-laid-out to fill.
      await waitForPaneCount(canvas, 1);
      await waitFor(
        () => {
          expect(leaveStarts.has('opacity')).toBe(true);
          expect(recorder.removedPaneIds.has(activeId as string)).toBe(true);
          expect(recorder.geometryRewrites).toBeGreaterThan(0);
          expect(canvasElement.querySelector('.pane-leaving')).toBeNull();
        },
        { timeout: 2000 },
      );
    } finally {
      recorder.disconnect();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};

// ---------------------------------------------------------------------------
// Resize — moving the divider rewrites pane geometry (animated when enabled)
// ---------------------------------------------------------------------------

export const ResizePane: Story = {
  args: { height: 600, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Resizing moves the shared divider, rewriting both panes’ inline geometry. The MutationObserver records the `style` rewrites, and the computed `transition` on a pane confirms the layout transition is active (animations enabled after settle), so the geometry change is animated.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 2);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    // Computed transition proves the geometry change will animate (not snap).
    const before = getComputedStyle(paneNodes(canvasElement)[0]);
    expect(before.transitionDuration).toContain('0.1s');

    const recorder = new LayoutMutationRecorder(layout);
    try {
      // Grow the first pane into the shared divider — moves the divider and
      // rewrites both panes' geometry regardless of which pane is active.
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'select-pane -t %0' });
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'resize-pane -R 8' });

      await waitFor(
        () => {
          expect(recorder.geometryRewrites).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );
    } finally {
      recorder.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Open float — overlay portals into <body> and runs the float-appear keyframe
// ---------------------------------------------------------------------------

export const OpenFloat: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Creating a centered float portals a `.modal-overlay` into `document.body` and runs the `float-appear` keyframe on `.modal-container`. A body MutationObserver confirms the overlay insertion and an `animationstart` listener confirms the keyframe actually ran.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const overlays = observeChildList(document.body, '.modal-overlay');
    const animationFired = waitForCssAnimation('.modal-container', {
      animationName: 'float-appear',
      timeout: 6000,
    });
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'tmuxy-float-create' });

      // The keyframe ran for real...
      await animationFired;
      // ...and the overlay node was inserted into <body>.
      await waitFor(
        () => {
          expect(overlays.added.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 1000 },
      );
      const overlay = document.querySelector('.modal-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay).toHaveClass('float-modal');
    } finally {
      overlays.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Open drawer — slide-in keyframe on an edge-docked float
// ---------------------------------------------------------------------------

export const OpenDrawer: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'A left drawer float runs the `slide-in-left` keyframe. The body MutationObserver confirms the overlay insertion and the `animationstart` listener confirms the slide-in keyframe was exercised.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const overlays = observeChildList(document.body, '.modal-overlay');
    const slideFired = waitForCssAnimation('.modal-container', {
      animationName: 'slide-in-left',
      timeout: 6000,
    });
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'tmuxy-float-create --left --width 40' });

      await slideFired;
      await waitFor(
        () => {
          expect(overlays.added.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 1000 },
      );
      expect(document.querySelector('.modal-overlay')).toHaveClass('drawer-left');
    } finally {
      overlays.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Close float — overlay node is removed (close is an instant unmount)
// ---------------------------------------------------------------------------

export const CloseFloat: Story = {
  args: { height: 600, initCommands: ['tmuxy-float-create'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Closing a float is an instant unmount (there is no exit keyframe), so the observable signal is the overlay node being removed. The body MutationObserver records the `.modal-overlay` removal and the DOM ends with no overlay.',
      },
    },
  },
  play: async () => {
    // The float opened from initCommands — wait for its overlay to portal in.
    const overlay = await waitFor(
      () => {
        const el = document.querySelector('.modal-overlay');
        if (!el) throw new Error('no .modal-overlay yet');
        return el as HTMLElement;
      },
      { timeout: 8000 },
    );
    const paneId = overlay
      .querySelector('.float-container[data-pane-id]')
      ?.getAttribute('data-pane-id');
    expect(paneId).toBeTruthy();

    const overlays = observeChildList(document.body, '.modal-overlay');
    try {
      // Same event the × button / backdrop click / Esc dispatch.
      getApp().send({ type: 'CLOSE_FLOAT', paneId });

      await waitFor(
        () => {
          expect(overlays.removed.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 2000 },
      );
      expect(document.querySelector('.modal-overlay')).toBeNull();
    } finally {
      overlays.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Animations disabled — the no-animations class flips and transitions go away
// ---------------------------------------------------------------------------

export const AnimationsDisabled: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'The app turns off layout animations whenever a transition would look wrong — deterministically observable on disconnect, which holds `enableAnimations: false` until the connection settles again. The `.pane-layout` flips to `pane-layout-no-animations`, whose rule strips the geometry transitions from every `.pane-layout-item` (only the enter/leave/shift lifecycle classes are allowed to out-specify that gate). Baseline first confirms animations are on (pane geometry transition is 0.1s).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    // Baseline: animations on → no disabled class, and the pane carries a
    // real transition (note `.pane-layout-resizing` may be latched from the
    // last layout commit, so the property set varies — the duration doesn't).
    expect(layout.classList.contains('pane-layout-no-animations')).toBe(false);
    expect(getComputedStyle(paneNodes(canvasElement)[0]).transitionDuration).toContain('0.1s');

    getApp().send({ type: 'TMUX_DISCONNECTED' });

    await waitFor(
      () => {
        expect(layout.classList.contains('pane-layout-no-animations')).toBe(true);
      },
      { timeout: 4000 },
    );
  },
};
