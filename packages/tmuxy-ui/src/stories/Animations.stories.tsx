/**
 * Animation integration stories.
 *
 * These drive the full TmuxyApp against the DemoAdapter and verify that the
 * DOM mutations + CSS animations behind each layout/float transition actually
 * fire — using MutationObservers (and, for floats, a real `animationstart`
 * listener) rather than only asserting the post-animation end state.
 *
 * Coverage:
 *  - SplitPane            split inserts a pane node and re-lays-out siblings
 *  - SlowSplitOptimistic  optimistic placeholder node appears before a slow ack
 *  - SplitRejectedRollback optimistic node is inserted, then removed on reject
 *  - ClosePane            killed pane node is removed; survivor re-lays-out
 *  - ResizePane           moving the divider rewrites pane geometry (animated)
 *  - OpenFloat            overlay portals into <body> and runs `float-appear`
 *  - OpenDrawer           drawer overlay runs the `slide-in-left` keyframe
 *  - CloseFloat           overlay node is removed (float close is instant)
 *  - AnimationsDisabled   TMUX_DISCONNECTED flips `.pane-layout-no-animations`
 *
 * What "animation exercised" means here: a CSS transition can't be observed
 * by a MutationObserver directly, but the mutations it animates between *can*
 * (a node inserted/removed, an inline `style`/`class` rewrite). For floats the
 * keyframe is observed directly via `animationstart`. Note the split layout
 * transition is deliberately suppressed by the app during the placeholder→real
 * id swap (see appMachine `enableAnimations:false` on split dispatch), so the
 * split stories assert the driving DOM mutation, not a transition event.
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
  title: 'App/Animations',
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
          'Splitting inserts a new `.pane-layout-item[data-pane-id]` node and rewrites the existing pane’s inline geometry to make room. A MutationObserver over `.pane-layout` confirms both the insertion and the re-layout mutation fire.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const recorder = new LayoutMutationRecorder(getPaneLayout(canvasElement));
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
        },
        { timeout: 2000 },
      );
    } finally {
      recorder.disconnect();
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
          'Killing a pane removes its `.pane-layout-item` node and rewrites the surviving pane’s geometry to fill the space. The MutationObserver confirms the removal of the exact pane id and the survivor’s re-layout.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 2);

    const activeId = getApp().getSnapshot().context.activePaneId;
    expect(activeId).toBeTruthy();

    const recorder = new LayoutMutationRecorder(getPaneLayout(canvasElement));
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: `kill-pane -t ${activeId}` });

      await waitForPaneCount(canvas, 1);
      await waitFor(
        () => {
          expect(recorder.removedPaneIds.has(activeId as string)).toBe(true);
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
          'The app turns off layout animations whenever a transition would look wrong — here, while a split’s placeholder→real-id swap is in flight, so the React key change doesn’t fade. The `.pane-layout` flips to `pane-layout-no-animations` (which makes `.pane-layout-item { transition: none }`) for that window and back. The toggle is a single frame — too fast for live polling — so a MutationObserver on the layout root’s class is used to prove the disabled state was applied. Baseline first confirms animations are on (pane transition is 0.1s).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    // Baseline: animations on → no disabled class, and the pane carries a real
    // layout transition.
    expect(layout.classList.contains('pane-layout-no-animations')).toBe(false);
    expect(getComputedStyle(paneNodes(canvasElement)[0]).transitionDuration).toContain('0.1s');

    // Observe the layout root's class before the split so the brief disabled
    // window (re-enabled within a frame once the swap renders) is captured even
    // though it is too short to observe by polling.
    const recorder = new LayoutMutationRecorder(layout);
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      await waitFor(
        () => {
          expect(
            recorder.rootClassChanges.some((c) => c.includes('pane-layout-no-animations')),
          ).toBe(true);
        },
        { timeout: 4000 },
      );
    } finally {
      recorder.disconnect();
    }
  },
};
