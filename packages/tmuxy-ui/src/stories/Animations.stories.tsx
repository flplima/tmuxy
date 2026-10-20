/**
 * Animation integration stories.
 *
 * These drive the full TmuxyApp over states recorded from real tmux and verify that the
 * DOM mutations + CSS animations behind each layout/float transition actually
 * fire — using MutationObservers (and, for floats, a real `animationstart`
 * listener) rather than only asserting the post-animation end state.
 *
 * Coverage:
 *  - SplitPane            split runs the enter morph: the new pane transitions
 *                         from the source pane's pre-split box into place
 *  - SlowSplitOptimistic  optimistic placeholder node appears before a slow ack
 *  - SplitRejectedRollback optimistic node is inserted, then removed on reject
 *  - ClosePane            killed pane goes at once; the survivor grows into it
 *                         under the growing survivor, then its node is removed
 *
 * What "animation exercised" means here: a CSS transition can't be observed
 * by a MutationObserver directly, but its `transitionstart` events and the
 * mutations it animates between *can* (a node inserted/removed, an inline
 * `style`/`class` rewrite). Splits and kills run the PaneLayout enter/leave lifecycle
 * (`pane-entering` / `pane-shifting` / `pane-leaving`), asserted via
 * `transitionstart` plus bounding-rect sampling.
 *
 * Stories execute in real Chromium via `scripts/probe-stories.mjs`, so the
 * CSS animations and MutationObservers run for real and a throw in `play`
 * fails the probe.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import { LayoutMutationRecorder, wait } from './animationObservers';
import {
  getApp,
  paneNodes,
  getPaneLayout,
  waitForPaneCount,
  waitForAnimationsEnabled,
} from './animationStoryHelpers';

/** A split answered with the two panes tmux drew; a kill with the one left. */
const SPLIT = [{ match: /^split-window\b/, to: 'side-by-side' }];
const KILL = [{ match: /^kill-pane\b/, to: 'one' }];

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Animations',
  component: FixtureApp,
  args: { fixture: asFixture(panes), start: 'one', transitions: SPLIT },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Integration stories that verify the DOM mutations and CSS animations behind pane splits, closes, and resizes. Uses MutationObservers to confirm each animation is exercised, and combines slow-tmux (optimistic) and rejected-command (rollback) timing over a recording of real tmux.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

// ---------------------------------------------------------------------------
// Split — a pane node is inserted and the survivor re-lays-out
// ---------------------------------------------------------------------------

export const SplitPane: Story = {
  tags: ['nightly'],
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
    // handlers can be dispatched late under load — rAF sampling is immune to
    // that).
    const enterStarts = new Set<string>();
    const onTransitionStart = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('pane-entering')) {
        enterStarts.add((e as TransitionEvent).propertyName);
      }
    };
    layout.addEventListener('transitionstart', onTransitionStart);

    // What box and opacity the new pane was GIVEN, read the moment its node
    // lands. A per-frame sampler can miss that frame entirely on a loaded
    // machine and then compare two frames of an already-finished morph, which
    // is what made this story flaky; a MutationObserver callback runs right
    // after the commit that inserted the node, so the FLIP-rewound start state
    // is what it reads, however few frames the machine paints.
    let entering: HTMLElement | null = null;
    let enterStart: { area: number; opacity: number } | null = null;
    const enterObserver = new MutationObserver(() => {
      if (enterStart) return;
      const el = layout.querySelector<HTMLElement>('.pane-layout-item.pane-entering');
      if (!el) return;
      const r = el.getBoundingClientRect();
      entering = el;
      enterStart = { area: r.width * r.height, opacity: parseFloat(getComputedStyle(el).opacity) };
    });
    enterObserver.observe(layout, {
      childList: true,
      subtree: true,
      attributeFilter: ['class'],
    });

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
        { timeout: 8000 },
      );

      // The morph settles: lifecycle classes drop off and the two panes are
      // visibly tiled, no longer overlapping.
      await waitFor(
        () => {
          expect(
            canvasElement.querySelectorAll('.pane-entering, .pane-shifting, .pane-leaving').length,
          ).toBe(0);
        },
        { timeout: 8000 },
      );

      // Per the sketch: the new pane starts at (≈) the source pane's full
      // pre-split box at reduced opacity and converges to its half-box — so
      // the box it was given is materially larger than the one it settled in,
      // and it started translucent.
      expect(enterStart, 'the entering pane was never seen').not.toBeNull();
      const settledArea = (() => {
        const r = entering!.getBoundingClientRect();
        return r.width * r.height;
      })();
      expect(enterStart!.area).toBeGreaterThan(settledArea * 1.3);
      expect(enterStart!.opacity).toBeLessThan(1);

      const [a, b] = paneNodes(canvasElement).map((n) => n.getBoundingClientRect());
      const ovX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const ovY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(Math.min(ovX, ovY)).toBeLessThanOrEqual(1); // mosaic panes share only their 1px edge
    } finally {
      enterObserver.disconnect();
      recorder.disconnect();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};

// ---------------------------------------------------------------------------
// Slow split — the optimistic placeholder node appears before the slow ack
// ---------------------------------------------------------------------------

export const SlowSplitOptimistic: Story = {
  args: { commandDelayMs: 400 },
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
// Close — the killed pane goes at once; the survivor grows into the space
// ---------------------------------------------------------------------------

export const ClosePane: Story = {
  tags: ['nightly'],
  args: { start: 'side-by-side', transitions: KILL },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Closing a pane is instant: the node is gone on the commit that dropped it, with nothing left fading or shrinking where it was. What animates is the space it left — the survivor grows into it on the enter/shift clock, sampled per paint so the growth is measured as drawn rather than as declared.',
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
    const survivorId = paneNodes(canvasElement)
      .map((n) => n.dataset.paneId as string)
      .find((id) => id !== activeId)!;
    const survivorBefore = paneNodes(canvasElement)
      .find((n) => n.dataset.paneId === survivorId)!
      .getBoundingClientRect();

    // Paint-aligned samples: how wide the survivor is drawn, and whether the
    // killed pane is ever drawn again after the model let it go.
    const widths: number[] = [];
    let sawKilledNode = false;
    let sampling = true;
    const sampleFrame = () => {
      const nodes = paneNodes(canvasElement);
      if (nodes.some((n) => n.dataset.paneId === activeId) && widths.length > 0) {
        sawKilledNode = true;
      }
      const survivor = nodes.find((n) => n.dataset.paneId === survivorId);
      if (survivor) widths.push(survivor.getBoundingClientRect().width);
      if (sampling) requestAnimationFrame(sampleFrame);
    };

    // Whether the survivor's box was put on a clock, which is the claim here.
    // A paint-aligned sampler can miss a 180ms growth entirely on a loaded
    // runner, so the transition itself is what is asserted; the samples are
    // kept for the negative check, where missing frames only make it weaker.
    const grewOnAClock = new Set<string>();
    const onTransitionStart = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target?.dataset?.paneId === survivorId) {
        grewOnAClock.add((e as TransitionEvent).propertyName);
      }
    };
    layout.addEventListener('transitionstart', onTransitionStart);

    const recorder = new LayoutMutationRecorder(layout);
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: `kill-pane -t ${activeId}` });
      requestAnimationFrame(sampleFrame);

      await waitForPaneCount(canvas, 1);
      await waitFor(
        () => {
          expect([...recorder.removedPaneIds]).toContain(activeId as string);
          expect(canvasElement.querySelector(`[data-pane-id="${activeId}"]`)).toBeNull();
        },
        { timeout: 2000 },
      );
      // Let the growth finish, then stop sampling.
      await wait(500);
      sampling = false;

      // Nothing of the closed pane was drawn after it went: no shrinking
      // ghost, no fade, no leftover node.
      expect(sawKilledNode).toBe(false);
      expect(canvasElement.querySelector('.pane-leaving')).toBeNull();

      // The survivor grew, and did it on a clock rather than in one frame.
      const grown = widths[widths.length - 1];
      expect(grown).toBeGreaterThan(survivorBefore.width + 10);
      expect(
        [...grewOnAClock].some((property) => ['width', 'height', 'left', 'top'].includes(property)),
        `the survivor's geometry never started a transition (saw ${[...grewOnAClock]})`,
      ).toBe(true);
    } finally {
      sampling = false;
      recorder.disconnect();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};
