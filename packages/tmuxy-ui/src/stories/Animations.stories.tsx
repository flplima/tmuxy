/**
 * Layout and float animations over states recorded from real tmux, checked
 * through MutationObservers and `transitionstart` (a CSS transition cannot be
 * observed by a MutationObserver directly) rather than only the end state.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import { LayoutMutationRecorder, wait } from './animationObservers';
import {
  paneNodes,
  getPaneLayout,
  waitForPaneCount,
  waitForAnimationsEnabled,
} from './animationStoryHelpers';
import { storyApp } from './storyApp';

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

export const SplitPane: Story = {
  tags: ['nightly'],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Splitting runs the enter morph: the new pane mounts with `.pane-entering`, is FLIP-rewound to the source pane’s pre-split box, transparent, and transitions into its final half-width box while fading in; the cursor is drawn once it has landed, not along its slide; the source pane gets `.pane-shifting` and converges on the same clock. Asserted via `transitionstart` events, a paint-aligned rAF rect/opacity sampler on the entering pane (starts materially larger and translucent, converges smaller), and the settled end state (two panes, no lifecycle classes, no overlap).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    // transitionstart handlers can be dispatched late under load; the rAF
    // sampler is immune to that.
    const enterStarts = new Set<string>();
    const onTransitionStart = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains('pane-entering')) {
        enterStarts.add((e as TransitionEvent).propertyName);
      }
    };
    layout.addEventListener('transitionstart', onTransitionStart);

    // Read the moment the node lands: a per-frame sampler can miss that frame
    // on a loaded machine and compare two frames of a finished morph (what made
    // this flaky); a MutationObserver callback runs right after the commit, so
    // it reads the FLIP-rewound start state.
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

    // The cursor overlay on every paint: drawn while the new pane is still
    // entering? It used to ride the pane's slide and smear across the source.
    let drawnWhileEntering = 0;
    let sampling = true;
    const sampleCursor = () => {
      const overlay = document.querySelector<HTMLElement>('.smooth-cursor');
      if (layout.querySelector('.pane-entering') && overlay?.style.opacity === '1') {
        drawnWhileEntering++;
      }
      if (sampling) requestAnimationFrame(sampleCursor);
    };
    requestAnimationFrame(sampleCursor);

    const recorder = new LayoutMutationRecorder(layout);
    try {
      storyApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      await waitForPaneCount(canvas, 2);
      await waitFor(
        () => {
          expect(recorder.addedPaneIds.size).toBeGreaterThanOrEqual(1);
          expect(recorder.geometryRewrites).toBeGreaterThan(0);
          expect(enterStarts.has('opacity')).toBe(true);
          expect(enterStarts.has('width') || enterStarts.has('left')).toBe(true);
        },
        { timeout: 8000 },
      );

      await waitFor(
        () => {
          expect(
            canvasElement.querySelectorAll('.pane-entering, .pane-shifting, .pane-leaving').length,
          ).toBe(0);
        },
        { timeout: 8000 },
      );

      // The new pane starts at about the source pane's pre-split box,
      // transparent, and converges to its half.
      expect(enterStart, 'the entering pane was never seen').not.toBeNull();
      const settledArea = (() => {
        const r = entering!.getBoundingClientRect();
        return r.width * r.height;
      })();
      expect(enterStart!.area).toBeGreaterThan(settledArea * 1.3);
      // From nothing: anything more draws its empty ground over the source
      // pane's text on the first frame.
      expect(enterStart!.opacity).toBeLessThan(0.05);
      // The cursor waits for the pane to land, then is drawn in it.
      expect(drawnWhileEntering, 'frames the cursor was drawn mid-slide').toBe(0);
      await waitFor(() =>
        expect(document.querySelector<HTMLElement>('.smooth-cursor')?.style.opacity).toBe('1'),
      );

      const [a, b] = paneNodes(canvasElement).map((n) => n.getBoundingClientRect());
      const ovX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const ovY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(Math.min(ovX, ovY)).toBeLessThanOrEqual(1); // mosaic panes share only their 1px edge
    } finally {
      sampling = false;
      enterObserver.disconnect();
      recorder.disconnect();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};

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
      storyApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      await waitFor(
        () => {
          expect(recorder.addedPaneIds.size).toBe(1);
        },
        { timeout: 200 },
      );

      for (let i = 0; i < 6; i++) {
        expect(paneNodes(canvasElement).length).toBe(2);
        expect(recorder.removedPaneIds.size).toBe(0);
        await wait(40);
      }

      await wait(300);
      await waitForPaneCount(canvas, 2);
    } finally {
      recorder.disconnect();
    }
  },
};

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
      storyApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

      await waitFor(
        () => {
          expect(recorder.addedPaneIds.size).toBeGreaterThanOrEqual(1);
        },
        { timeout: 400 },
      );

      await waitFor(
        () => {
          expect(recorder.removedPaneIds.size).toBeGreaterThanOrEqual(1);
        },
        { timeout: 1500 },
      );
      await waitForPaneCount(canvas, 1);

      const added = [...recorder.addedPaneIds];
      expect(added.some((id) => recorder.removedPaneIds.has(id))).toBe(true);
    } finally {
      recorder.disconnect();
    }
  },
};

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

    const activeId = storyApp().view().activePaneId;
    expect(activeId).toBeTruthy();
    const survivorId = paneNodes(canvasElement)
      .map((n) => n.dataset.paneId as string)
      .find((id) => id !== activeId)!;
    const survivorBefore = paneNodes(canvasElement)
      .find((n) => n.dataset.paneId === survivorId)!
      .getBoundingClientRect();

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

    // A paint-aligned sampler can miss a 180ms growth on a loaded runner, so
    // the transition itself is asserted; the samples serve the negative check,
    // where missing frames only make it weaker.
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
      storyApp().send({ type: 'SEND_TMUX_COMMAND', command: `kill-pane -t ${activeId}` });
      requestAnimationFrame(sampleFrame);

      await waitForPaneCount(canvas, 1);
      await waitFor(
        () => {
          expect([...recorder.removedPaneIds]).toContain(activeId as string);
          expect(canvasElement.querySelector(`[data-pane-id="${activeId}"]`)).toBeNull();
        },
        { timeout: 2000 },
      );
      await wait(500);
      sampling = false;

      expect(sawKilledNode).toBe(false);
      expect(canvasElement.querySelector('.pane-leaving')).toBeNull();

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
