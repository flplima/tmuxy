/**
 * The terminal content of a pane must never blink while the layout around it
 * changes (the Animations stories assert pane chrome; the GlitchRecorder
 * ignores `.terminal-line`). Two watchers run: marker text must never blank for
 * a painted frame, and no surviving pane's content container may be remounted.
 * Deterministic tier, so these gate merges in the `storybook-probe` CI job.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import twoPanes from './fixtures/gen/content-two-panes.json';
import threePanes from './fixtures/gen/content-three-panes.json';
import { ContentStabilityRecorder } from './contentStability';
import { ContentMutationRecorder } from './contentMutation';
import { getPaneLayout, waitForPaneCount } from './animationStoryHelpers';
import { storyApp } from './storyApp';
import { wait } from './animationObservers';

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

const cmd = (command: string) => storyApp().send({ type: 'SEND_TMUX_COMMAND', command });

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
 * Runs `operation` under both content watchers. The callback receives them so
 * a story can mark an intended teardown (the victim of a kill) beforehand.
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
    // Counted in painted frames, not wall-clock sleeps: under load a whole
    // sleep can pass inside one long task, leaving the assertions vacuous.
    await text.waitForFrames(MIN_SAMPLED_FRAMES);
  } finally {
    text.stop();
    dom.stop();
  }
  expect(text.sampledFrames).toBeGreaterThan(2);
  text.assertStable(label);
  dom.assertNoBlink(label);
}

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

    await recordStable(canvasElement, NAV_MARKERS, 'navigate between panes', async () => {
      for (let round = 0; round < 2; round++) {
        for (const id of ['%0', '%1', '%2']) {
          cmd(`select-pane -t ${id}`);
          await wait(120);
        }
      }
    });
  },
};

export const SplitPreservesContent: Story = {
  args: { start: 'one', transitions: [{ match: /^split-window -h$/, to: 'split' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForMarkers(canvasElement, 1, ['ZZ_A_ZZ']);

    await recordStable(canvasElement, ['ZZ_A_ZZ'], 'split', async () => {
      cmd('split-window -h');
      await waitForPaneCount(canvas, 2);
      await wait(500);
    });
  },
};

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
        await wait(120);
      }
      for (let i = 0; i < 4; i++) {
        cmd('resize-pane -t %1 -R 5');
        await wait(120);
      }
    });
  },
};

export const ZoomPreservesContent: Story = {
  args: {
    transitions: [
      { match: /^resize-pane -t %1 -Z$/, from: 'two', to: 'zoomed' },
      { match: /^resize-pane -t %1 -Z$/, from: 'zoomed', to: 'unzoomed' },
    ],
  },
  play: async ({ canvasElement }) => {
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    await recordStable(canvasElement, ['ZZ_B_ZZ'], 'zoom in', async () => {
      cmd('resize-pane -t %1 -Z');
      await wait(600);
    });
    await recordStable(canvasElement, ['ZZ_A_ZZ', 'ZZ_B_ZZ'], 'unzoom', async () => {
      cmd('resize-pane -t %1 -Z');
      await waitFor(
        () => expect(getPaneLayout(canvasElement).textContent ?? '').toContain('ZZ_A_ZZ'),
        { timeout: 8000 },
      );
      await wait(400);
    });
  },
};

export const KillPreservesSurvivorContent: Story = {
  args: { transitions: [{ match: /^kill-pane -t %1$/, to: 'killed' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    await recordStable(canvasElement, ['ZZ_A_ZZ'], 'kill neighbour', async (_text, dom) => {
      dom.expectGone(['%1']);
      cmd('kill-pane -t %1');
      await waitForPaneCount(canvas, 1);
      await wait(500);
    });
  },
};

// Both panes persist and only trade slots, so neither content container may be
// torn down (the "moving a pane blinks everything" report).

export const MovePreservesContent: Story = {
  args: {
    transitions: [
      { match: /^swap-pane -s %0 -t %1$/, from: 'two', to: 'swapped' },
      { match: /^swap-pane -s %0 -t %1$/, from: 'swapped', to: 'swapped-back' },
    ],
  },
  play: async ({ canvasElement }) => {
    await waitForMarkers(canvasElement, 2, ['ZZ_A_ZZ', 'ZZ_B_ZZ']);

    await recordStable(canvasElement, ['ZZ_A_ZZ', 'ZZ_B_ZZ'], 'move (swap)', async () => {
      cmd('swap-pane -s %0 -t %1');
      await wait(300);
      cmd('swap-pane -s %0 -t %1');
      await wait(300);
    });
  },
};
