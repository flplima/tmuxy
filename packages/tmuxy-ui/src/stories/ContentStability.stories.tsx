/**
 * Content-stability stories — the terminal *content* of a pane must never blink
 * or flicker away while the layout around it changes.
 *
 * These are the content-level counterpart of the Animations stories (which
 * assert pane *chrome* mutations) and the layout GlitchRecorder checks (which
 * ignore `.terminal-line`). Each story starts from panes recorded from real
 * tmux with a distinctive marker line printed in them, then drives a pane
 * operation — navigate, split, resize, move (swap), zoom, kill — answered with
 * the state tmux recorded for it, while TWO watchers run: a rAF
 * `ContentStabilityRecorder` (marker text must never blank for a painted
 * frame) and a MutationObserver `ContentMutationRecorder` (no surviving pane's
 * content container may be torn down and remounted). Either firing is the
 * user-visible "terminal blinked" bug.
 *
 * Deterministic tier (no v86), so they gate merges in the `storybook-probe`
 * CI job.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import twoPanes from './fixtures/gen/content-two-panes.json';
import threePanes from './fixtures/gen/content-three-panes.json';
import { ContentStabilityRecorder } from './contentStability';
import { ContentMutationRecorder } from './contentMutation';
import { getApp, getPaneLayout, waitForPaneCount } from './animationStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Content Stability',
  component: FixtureApp,
  args: { fixture: asFixture(twoPanes), start: 'two' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        component:
          'Verifies that rendered terminal content stays reliable across pane operations: a marker line parked in a pane must never blank out for a painted frame while navigating between panes, splitting, resizing, zooming, or killing a neighbour.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cmd = (command: string) => getApp().send({ type: 'SEND_TMUX_COMMAND', command });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The recorded panes are up, with every marker the story watches on screen. */
async function waitForMarkers(
  canvasElement: HTMLElement,
  count: number,
  markers: string[],
): Promise<void> {
  await waitForPaneCount(within(canvasElement), count);
  await waitFor(() => {
    const text = getPaneLayout(canvasElement).textContent ?? '';
    for (const marker of markers) expect(text).toContain(marker);
  });
}

/** Frames the sampler must observe before its assertions mean anything. */
const MIN_SAMPLED_FRAMES = 8;

/**
 * Run `operation` under BOTH content watchers, then assert neither fired:
 *  - a rAF `ContentStabilityRecorder` proves the marker *text* never blanks for
 *    a painted frame (`contentStability.ts`);
 *  - a `ContentMutationRecorder` (MutationObserver) proves no surviving pane's
 *    content container is torn down and remounted — the DOM-churn blink that a
 *    text-presence sampler can't see (`contentMutation.ts`).
 * The callback receives both so a story can mark a pane's teardown as intended
 * (e.g. the victim of a kill) before it happens.
 */
async function recordStable(
  canvasElement: HTMLElement,
  markers: string[],
  label: string,
  operation: (text: ContentStabilityRecorder, dom: ContentMutationRecorder) => Promise<void>,
): Promise<void> {
  const scope = getPaneLayout(canvasElement);
  const text = new ContentStabilityRecorder(scope, markers);
  const dom = new ContentMutationRecorder(scope);
  text.start();
  try {
    await operation(text, dom);
    // Close the window on painted frames, not on the operation's wall-clock
    // sleeps: under load a whole sleep can pass inside one long task, leaving
    // the window with a frame or two and the assertions below vacuous.
    await text.waitForFrames(MIN_SAMPLED_FRAMES);
  } finally {
    text.stop();
    dom.stop();
  }
  // The sampler must have actually observed frames, else the assertion is vacuous.
  expect(text.sampledFrames).toBeGreaterThan(2);
  text.assertStable(label);
  dom.assertNoBlink(label);
}

// ---------------------------------------------------------------------------
// Navigate between panes — switching the active pane must not blank any content
// ---------------------------------------------------------------------------

const NAV_MARKERS = ['ZZ_NAV_A_ZZ', 'ZZ_NAV_B_ZZ', 'ZZ_NAV_C_ZZ'];

export const NavigateBetweenPanes: Story = {
  args: {
    fixture: asFixture(threePanes),
    start: 'three',
    transitions: [0, 1, 2].map((n) => ({
      match: new RegExp(`^select-pane -t %${n}$`),
      to: `at-${n}`,
    })),
  },
  play: async ({ canvasElement }) => {
    await waitForMarkers(canvasElement, 3, NAV_MARKERS);

    // Cycle focus across every pane twice; all three markers must stay visible.
    await recordStable(canvasElement, NAV_MARKERS, 'navigate between panes', async () => {
      for (let round = 0; round < 2; round++) {
        for (const id of ['%0', '%1', '%2']) {
          cmd(`select-pane -t ${id}`);
          await sleep(120);
        }
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Split — the survivor's existing content must not flicker while a pane is added
// ---------------------------------------------------------------------------

export const SplitPreservesContent: Story = {
  args: { start: 'one', transitions: [{ match: /^split-window -h$/, to: 'split' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForMarkers(canvasElement, 1, ['ZZ_A_ZZ']);

    await recordStable(canvasElement, ['ZZ_A_ZZ'], 'split', async () => {
      cmd('split-window -h');
      await waitForPaneCount(canvas, 2);
      await sleep(500); // let the layout settle / animations run
    });
  },
};

// ---------------------------------------------------------------------------
// Resize — moving a divider must not blank either pane's content
// ---------------------------------------------------------------------------

/** Each 5-column step of the divider, from the state tmux was in when it came. */
const LEFT = ['two', 'left-5', 'left-10', 'left-15', 'left-20'];
const BACK = ['left-20', 'back-15', 'back-10', 'back-5', 'back-0'];

export const ResizePreservesContent: Story = {
  args: {
    transitions: [
      ...LEFT.slice(1).map((to, i) => ({ match: /^resize-pane -t %1 -L 5$/, from: LEFT[i], to })),
      ...BACK.slice(1).map((to, i) => ({ match: /^resize-pane -t %1 -R 5$/, from: BACK[i], to })),
    ],
  },
  play: async ({ canvasElement }) => {
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    await recordStable(canvasElement, ['ZZ_A_ZZ', 'ZZ_B_ZZ'], 'resize', async () => {
      for (let i = 0; i < 4; i++) {
        cmd('resize-pane -t %1 -L 5');
        await sleep(120);
      }
      for (let i = 0; i < 4; i++) {
        cmd('resize-pane -t %1 -R 5');
        await sleep(120);
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Zoom — zooming the active pane must not blink its content; unzoom restores both
// ---------------------------------------------------------------------------

export const ZoomPreservesContent: Story = {
  args: {
    transitions: [
      { match: /^resize-pane -t %1 -Z$/, from: 'two', to: 'zoomed' },
      { match: /^resize-pane -t %1 -Z$/, from: 'zoomed', to: 'unzoomed' },
    ],
  },
  play: async ({ canvasElement }) => {
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    // Zoom the active pane: its own marker must never blink while it maximises.
    await recordStable(canvasElement, ['ZZ_B_ZZ'], 'zoom in', async () => {
      cmd('resize-pane -t %1 -Z');
      await sleep(600);
    });
    // Unzoom: both panes return; neither marker should flicker as the grid restores.
    await recordStable(canvasElement, ['ZZ_A_ZZ', 'ZZ_B_ZZ'], 'unzoom', async () => {
      cmd('resize-pane -t %1 -Z');
      await waitFor(
        () => expect(getPaneLayout(canvasElement).textContent ?? '').toContain('ZZ_A_ZZ'),
        { timeout: 8000 },
      );
      await sleep(400);
    });
  },
};

// ---------------------------------------------------------------------------
// Kill — killing a neighbour must not blank the survivor's content
// ---------------------------------------------------------------------------

export const KillPreservesSurvivorContent: Story = {
  args: { transitions: [{ match: /^kill-pane -t %1$/, to: 'killed' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    // Track only the survivor's marker — the victim's disappearance is intended.
    await recordStable(canvasElement, ['ZZ_A_ZZ'], 'kill neighbour', async (_text, dom) => {
      dom.expectGone(['%1']); // the victim's content teardown is expected
      cmd('kill-pane -t %1');
      await waitForPaneCount(canvas, 1);
      await sleep(500);
    });
  },
};

// ---------------------------------------------------------------------------
// Move (swap) — swapping two panes must not blank either one's content. Both
// panes persist and only trade grid slots, so neither content container may be
// torn down (the "moving a pane blinks everything" report).
// ---------------------------------------------------------------------------

export const MovePreservesContent: Story = {
  args: {
    transitions: [
      { match: /^swap-pane -s %0 -t %1$/, from: 'two', to: 'swapped' },
      { match: /^swap-pane -s %0 -t %1$/, from: 'swapped', to: 'swapped-back' },
    ],
  },
  play: async ({ canvasElement }) => {
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    // Swap the two panes back and forth; both markers must stay put through it.
    await recordStable(canvasElement, ['ZZ_A_ZZ', 'ZZ_B_ZZ'], 'move (swap)', async () => {
      cmd('swap-pane -s %0 -t %1');
      await sleep(300);
      cmd('swap-pane -s %0 -t %1');
      await sleep(300);
    });
  },
};
