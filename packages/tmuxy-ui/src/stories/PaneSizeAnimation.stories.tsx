/**
 * Panes changing size, on a clock (demo engine).
 *
 * A resize landing on whole cells, or a stack opening the row the focus moved
 * to, changes how big the panes ARE, and reads far better animated: the eye
 * can follow a row opening up, where a jump cut reads as a glitch. A swap
 * changes only WHICH pane is in which box and must keep snapping — animate a
 * permutation and the two panes slide through each other.
 *
 * The gate is `suppressLayoutTransition`, decided per model update in the app
 * machine (see machines/app/layoutChange.ts), and the config's
 * `@tmuxy-animations` switch overrides all of it.
 *
 * Each story samples the drawn boxes across frames rather than reading the
 * declared CSS: a transition that is declared and never runs looks exactly
 * like a snap to the user.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Pane Size Animation',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Pane size changes animate, swaps do not, and `@tmuxy-animations off` turns the lot into a single frame.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

const APPEARANCE = {
  opacity: 0.7,
  activePaneOpacity: 1,
  inactivePaneOpacity: 0.7,
  activeTextOpacity: 1,
  inactiveTextOpacity: 0.7,
  blur: false,
  cursorBlink: true,
};

interface AppActor {
  send: (event: unknown) => void;
  getSnapshot: () => { context: { activeWindowId: string | null; enableAnimations: boolean } };
}

function getApp(): AppActor {
  const app = (window as unknown as { app?: AppActor }).app;
  if (!app) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return app;
}

const run = (command: string) => getApp().send({ type: 'SEND_TMUX_COMMAND', command });

function paneNodes(canvasElement: HTMLElement): HTMLElement[] {
  return [...canvasElement.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]')];
}

function getPaneLayout(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.pane-layout');
  if (!el) throw new Error('.pane-layout not found');
  return el;
}

/** Resolve once the app has settled and re-enabled layout animations. */
async function waitForAnimationsEnabled(layout: HTMLElement): Promise<void> {
  await waitFor(() => expect(layout.classList.contains('pane-layout-no-animations')).toBe(false), {
    timeout: 8000,
  });
}

async function waitForPanes(count: number, canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await waitFor(
    () => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(count),
    {
      timeout: 8000,
    },
  );
}

/**
 * Every pane's box, once per animation frame, while `act` runs and for a
 * while after. What the user sees, not what the stylesheet claims.
 *
 * The first sample is taken synchronously, before `act`: a change that snaps
 * is already finished by the time the first frame callback runs, so without it
 * a snap and a no-op are the same reading.
 */
async function sampleBoxes(
  canvasElement: HTMLElement,
  act: () => void,
  ms = 700,
): Promise<Array<Record<string, { w: number; h: number; x: number; y: number }>>> {
  const frames: Array<Record<string, { w: number; h: number; x: number; y: number }>> = [];
  const shoot = () => {
    const shot: Record<string, { w: number; h: number; x: number; y: number }> = {};
    for (const node of paneNodes(canvasElement)) {
      const r = node.getBoundingClientRect();
      shot[node.dataset.paneId as string] = { w: r.width, h: r.height, x: r.left, y: r.top };
    }
    frames.push(shot);
  };
  let sampling = true;
  const frame = () => {
    shoot();
    if (sampling) requestAnimationFrame(frame);
  };
  shoot();
  requestAnimationFrame(frame);
  act();
  await new Promise((r) => setTimeout(r, ms));
  sampling = false;
  return frames;
}

/** How many distinct values a pane's measurement took across the samples. */
function distinctValues(
  frames: Array<Record<string, { w: number; h: number; x: number; y: number }>>,
  paneId: string,
  key: 'w' | 'h',
): number {
  const seen = new Set<number>();
  for (const shot of frames) {
    const box = shot[paneId];
    if (box) seen.add(Math.round(box[key]));
  }
  return seen.size;
}

/** The pane whose measurement moved the most between the first and last frame. */
function biggestMover(
  frames: Array<Record<string, { w: number; h: number; x: number; y: number }>>,
  key: 'w' | 'h',
): string {
  const first = frames[0];
  const last = frames[frames.length - 1];
  let best = '';
  let bestDelta = -1;
  for (const id of Object.keys(last)) {
    if (!first[id]) continue;
    const delta = Math.abs(last[id][key] - first[id][key]);
    if (delta > bestDelta) {
      bestDelta = delta;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// A commanded resize grows on a clock
// ---------------------------------------------------------------------------

export const AResizeGrowsOnAClock: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          '`resize-pane -R 8` moves the shared divider. The panes pass through intermediate widths on the way rather than arriving in a single frame, and they end where the command asked.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    const frames = await sampleBoxes(canvasElement, () => {
      run('select-pane -t %0');
      run('resize-pane -t %0 -R 8');
    });

    const mover = biggestMover(frames, 'w');
    expect(mover).not.toBe('');
    // More than a before and an after: the box was drawn on its way.
    expect(distinctValues(frames, mover, 'w')).toBeGreaterThan(2);
    const first = frames[0][mover].w;
    const last = frames[frames.length - 1][mover].w;
    expect(Math.abs(last - first)).toBeGreaterThan(4);
  },
};

// ---------------------------------------------------------------------------
// Stack navigation opens the row it moves to
// ---------------------------------------------------------------------------

export const AStackOpensTheRowItMovesTo: Story = {
  args: { height: 500, initCommands: ['split-window -v'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'Stacked panes keep only the row holding the focus expanded, so moving the focus swaps which row is open. Both rows are drawn at heights in between on the way, which is the whole point of animating it — the row that opens is where the eye should end up.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    // The demo has no stack reshaper of its own — that lives in the backend —
    // so the shape a stack navigation produces is asked for directly: the row
    // holding the focus expands and the other collapses toward its header.
    const frames = await sampleBoxes(canvasElement, () => {
      run('select-pane -t %1');
      run('resize-pane -t %1 -D 12');
    });

    const mover = biggestMover(frames, 'h');
    expect(mover).not.toBe('');
    expect(distinctValues(frames, mover, 'h')).toBeGreaterThan(2);
    // The other row moved with it: a stack opening one row closes another, and
    // both have to be on the same clock or the boxes shear apart mid-flight.
    const others = Object.keys(frames[frames.length - 1]).filter((id) => id !== mover);
    expect(others.length).toBeGreaterThan(0);
    expect(distinctValues(frames, others[0], 'h')).toBeGreaterThan(1);
  },
};

// ---------------------------------------------------------------------------
// A swap still snaps — animating a permutation slides panes through each other
// ---------------------------------------------------------------------------

export const ASwapStillSnaps: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'A swap hands the same two boxes to the other pane. There is no size change to follow and an animated permutation would slide the panes through each other, so the boxes are exchanged in one frame — every sampled frame has each pane at one of the two positions and never between them.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    const settled = paneNodes(canvasElement).map((n) => n.getBoundingClientRect());
    const lefts = settled.map((r) => Math.round(r.left)).sort((a, b) => a - b);

    const frames = await sampleBoxes(canvasElement, () => run('swap-pane -s %0 -t %1'));

    // Every frame has both panes parked on one of the two starting columns.
    for (const shot of frames) {
      for (const box of Object.values(shot)) {
        const nearest = lefts.reduce((best, l) =>
          Math.abs(l - box.x) < Math.abs(best - box.x) ? l : best,
        );
        expect(Math.abs(nearest - box.x)).toBeLessThanOrEqual(2);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Config off — the same resize lands in one frame
// ---------------------------------------------------------------------------

export const ConfigAnimationsOffSnapsTheSize: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          '`set -g @tmuxy-animations off` in tmuxy.conf reaches the client with the appearance. The grid takes `.pane-layout-no-animations`, which drops geometry out of the transition entirely, and the same resize arrives in a single frame — the pane is at its old width or its new one, never between.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    getApp().send({
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...APPEARANCE, animations: false },
    });
    await waitFor(() => expect(layout.classList.contains('pane-layout-no-animations')).toBe(true));

    const frames = await sampleBoxes(canvasElement, () => {
      run('select-pane -t %0');
      run('resize-pane -t %0 -R 8');
    });

    const mover = biggestMover(frames, 'w');
    expect(mover).not.toBe('');
    // It did move — otherwise this proves nothing — and it did so in one step.
    const first = frames[0][mover].w;
    const last = frames[frames.length - 1][mover].w;
    expect(Math.abs(last - first)).toBeGreaterThan(4);
    expect(distinctValues(frames, mover, 'w')).toBe(2);
  },
};

// ---------------------------------------------------------------------------
// The cursor never flies in from off the window while a row opens
// ---------------------------------------------------------------------------

export const TheCursorStaysInsideTheOpeningRow: Story = {
  args: { height: 500, initCommands: ['split-window -v'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'A pane’s terminal is sized to its ROW COUNT and anchored to the bottom of the pane, so while a row is opening the terminal is taller than the pane and hangs off the top of it. A cursor on the first row is then inside the terminal and outside the pane — and the overlay used to follow it there, dragging in from above the window and landing with a jump when the pane caught up. Sampled per paint: while it is drawn at all, it is inside the pane area.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    const overlay = () => document.querySelector<HTMLElement>('.smooth-cursor');
    const shape = () => document.querySelector<HTMLElement>('.smooth-cursor-shape');
    const gridBox = () => getPaneLayout(canvasElement).getBoundingClientRect();

    /** The top of the painted cursor, from the clip polygon it is drawn with. */
    const paintedTop = (): number | null => {
      const el = shape();
      if (!el || overlay()?.style.opacity !== '1') return null;
      const polygon = getComputedStyle(el).clipPath.match(/polygon\(([^)]*)\)/);
      if (!polygon) return null;
      const ys = polygon[1].split(',').map((point) => parseFloat(point.trim().split(/\s+/)[1]));
      return ys.length ? Math.min(...ys) : null;
    };

    // Park the focus on the bottom row, with the top one collapsed.
    run('select-pane -t %1');
    run('resize-pane -t %1 -D 12');
    await new Promise((r) => setTimeout(r, 900));

    // Now move up: the top row opens, the bottom collapses.
    const seen: number[] = [];
    let sampling = true;
    const frame = () => {
      const top = paintedTop();
      if (top !== null) seen.push(top);
      if (sampling) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    run('select-pane -t %0');
    run('resize-pane -t %0 -D 12');
    await new Promise((r) => setTimeout(r, 1200));
    sampling = false;

    // It was drawn at some point, and never above the grid it lives in.
    expect(seen.length, 'the cursor was never drawn').toBeGreaterThan(0);
    const top = gridBox().top;
    const highest = Math.min(...seen);
    expect(
      highest,
      `the cursor was drawn ${Math.round(top - highest)}px above the pane grid`,
    ).toBeGreaterThanOrEqual(top - 2);
  },
};
