/**
 * Content-stability stories — the terminal *content* of a pane must never blink
 * or flicker away while the layout around it changes.
 *
 * These are the content-level counterpart of the Animations stories (which
 * assert pane *chrome* mutations) and the layout GlitchRecorder checks (which
 * ignore `.terminal-line`). Each story parks a distinctive marker line in one
 * or more panes, then drives a pane operation — navigate, split, resize, move
 * (swap), zoom, kill — while TWO watchers run: a rAF `ContentStabilityRecorder`
 * (marker text must never blank for a painted frame) and a MutationObserver
 * `ContentMutationRecorder` (no surviving pane's content container may be torn
 * down and remounted). Either firing is the user-visible "terminal blinked" bug.
 *
 * Deterministic `DemoAdapter` tier (no v86), so they gate merges in the
 * `storybook-probe` CI job.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import { ContentStabilityRecorder } from './contentStability';
import { ContentMutationRecorder } from './contentMutation';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Content Stability',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Verifies that rendered terminal content stays reliable across pane operations: a marker line parked in a pane must never blank out for a painted frame while navigating between panes, splitting, resizing, zooming, or killing a neighbour.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AppActor {
  send: (event: unknown) => void;
  getSnapshot: () => {
    context: { activePaneId: string | null; panes: Array<{ tmuxId: string }> };
  };
}

function getApp(): AppActor {
  const app = (window as unknown as { app?: AppActor }).app;
  if (!app) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return app;
}

type Canvas = ReturnType<typeof within>;

function getPaneLayout(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.pane-layout');
  if (!el) throw new Error('.pane-layout not found');
  return el;
}

function paneIds(): string[] {
  return getApp()
    .getSnapshot()
    .context.panes.map((p) => p.tmuxId);
}

function activeId(): string {
  const id = getApp().getSnapshot().context.activePaneId;
  if (!id) throw new Error('no active pane');
  return id;
}

const cmd = (command: string) => getApp().send({ type: 'SEND_TMUX_COMMAND', command });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForPaneCount(canvas: Canvas, count: number, timeout = 8000): Promise<void> {
  await waitFor(
    () => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(count),
    { timeout },
  );
}

/** Print a distinctive marker line into a specific pane and wait for it to render. */
async function parkMarker(
  canvasElement: HTMLElement,
  paneId: string,
  marker: string,
): Promise<void> {
  cmd(`send-keys -t ${paneId} -l 'echo ${marker}'`);
  cmd(`send-keys -t ${paneId} Enter`);
  await waitFor(() => expect(getPaneLayout(canvasElement).textContent ?? '').toContain(marker), {
    timeout: 8000,
  });
}

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

export const NavigateBetweenPanes: Story = {
  args: { height: 600 },
  parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    // Three panes, each parking a unique marker.
    const first = activeId();
    await parkMarker(canvasElement, first, 'ZZ_NAV_A_ZZ');
    cmd('split-window -h');
    await waitForPaneCount(canvas, 2);
    await parkMarker(canvasElement, activeId(), 'ZZ_NAV_B_ZZ');
    cmd('split-window -v');
    await waitForPaneCount(canvas, 3);
    await parkMarker(canvasElement, activeId(), 'ZZ_NAV_C_ZZ');

    const ids = paneIds();
    const markers = ['ZZ_NAV_A_ZZ', 'ZZ_NAV_B_ZZ', 'ZZ_NAV_C_ZZ'];

    // Cycle focus across every pane twice; all three markers must stay visible.
    await recordStable(canvasElement, markers, 'navigate between panes', async () => {
      for (let round = 0; round < 2; round++) {
        for (const id of ids) {
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
  args: { height: 600 },
  parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    await parkMarker(canvasElement, activeId(), 'ZZ_SPLIT_KEEP_ZZ');

    await recordStable(canvasElement, ['ZZ_SPLIT_KEEP_ZZ'], 'split', async () => {
      cmd('split-window -h');
      await waitForPaneCount(canvas, 2);
      await sleep(500); // let the layout settle / animations run
    });
  },
};

// ---------------------------------------------------------------------------
// Resize — dragging a divider must not blank either pane's content
// ---------------------------------------------------------------------------

export const ResizePreservesContent: Story = {
  args: { height: 600 },
  parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    const left = activeId();
    await parkMarker(canvasElement, left, 'ZZ_RSZ_L_ZZ');
    cmd('split-window -h');
    await waitForPaneCount(canvas, 2);
    const right = activeId();
    await parkMarker(canvasElement, right, 'ZZ_RSZ_R_ZZ');

    await recordStable(canvasElement, ['ZZ_RSZ_L_ZZ', 'ZZ_RSZ_R_ZZ'], 'resize', async () => {
      for (let i = 0; i < 4; i++) {
        cmd(`resize-pane -t ${right} -L 5`);
        await sleep(120);
      }
      for (let i = 0; i < 4; i++) {
        cmd(`resize-pane -t ${right} -R 5`);
        await sleep(120);
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Zoom — zooming the active pane must not blink its content; unzoom restores both
// ---------------------------------------------------------------------------

export const ZoomPreservesContent: Story = {
  args: { height: 600 },
  parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    await parkMarker(canvasElement, activeId(), 'ZZ_ZOOM_A_ZZ');
    cmd('split-window -h');
    await waitForPaneCount(canvas, 2);
    const zoomed = activeId();
    await parkMarker(canvasElement, zoomed, 'ZZ_ZOOM_B_ZZ');

    // Zoom the active pane: its own marker must never blink while it maximises.
    await recordStable(canvasElement, ['ZZ_ZOOM_B_ZZ'], 'zoom in', async () => {
      cmd(`resize-pane -t ${zoomed} -Z`);
      await sleep(600);
    });
    // Unzoom: both panes return; neither marker should flicker as the grid restores.
    await recordStable(canvasElement, ['ZZ_ZOOM_A_ZZ', 'ZZ_ZOOM_B_ZZ'], 'unzoom', async () => {
      cmd(`resize-pane -t ${zoomed} -Z`);
      await waitFor(
        () => expect(getPaneLayout(canvasElement).textContent ?? '').toContain('ZZ_ZOOM_A_ZZ'),
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
  args: { height: 600 },
  parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    const survivor = activeId();
    await parkMarker(canvasElement, survivor, 'ZZ_KILL_KEEP_ZZ');
    cmd('split-window -h');
    await waitForPaneCount(canvas, 2);
    const victim = activeId();
    await parkMarker(canvasElement, victim, 'ZZ_KILL_GONE_ZZ');

    // Track only the survivor's marker — the victim's disappearance is intended.
    await recordStable(canvasElement, ['ZZ_KILL_KEEP_ZZ'], 'kill neighbour', async (_text, dom) => {
      dom.expectGone([victim]); // the victim's content teardown is expected
      cmd(`kill-pane -t ${victim}`);
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
  args: { height: 600 },
  parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    const a = activeId();
    await parkMarker(canvasElement, a, 'ZZ_MOVE_A_ZZ');
    cmd('split-window -h');
    await waitForPaneCount(canvas, 2);
    const b = activeId();
    await parkMarker(canvasElement, b, 'ZZ_MOVE_B_ZZ');

    // Swap the two panes back and forth; both markers must stay put through it.
    await recordStable(canvasElement, ['ZZ_MOVE_A_ZZ', 'ZZ_MOVE_B_ZZ'], 'move (swap)', async () => {
      cmd(`swap-pane -s ${a} -t ${b}`);
      await sleep(300);
      cmd(`swap-pane -s ${a} -t ${b}`);
      await sleep(300);
    });
  },
};
