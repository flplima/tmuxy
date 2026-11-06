/**
 * Panes changing size animate, over states recorded from real tmux: the eye
 * can follow a row opening up, where a jump cut reads as a glitch. A swap only
 * changes which pane is in which box and must keep snapping (animated, the two
 * panes slide through each other); that, and `@tmuxy-animations off`, are
 * Animations Tabs & Groups' `SwapPanes` and `ConfigAnimationsOff`.
 *
 * Each story samples the drawn boxes rather than the declared CSS: a declared
 * transition that never runs looks exactly like a snap.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, fireEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import moves from './fixtures/gen/side-by-side-moves.json';
import stack from './fixtures/gen/stack-rows.json';
import {
  getApp,
  getPaneLayout,
  paneNodes,
  waitForAnimationsEnabled,
  waitForPaneCount,
} from './animationStoryHelpers';
import { cursorPolygon } from './cursorShape';

const SIDE_BY_SIDE = {
  fixture: asFixture(moves),
  start: 'two',
  transitions: [
    { match: /^select-pane -t %0$/, to: 'left-active' },
    { match: /^resize-pane -t %0 -R 8$/, to: 'left-grown' },
  ],
};

/** A stack with the bottom row open; the server opens the row the focus moves to. */
const STACK = {
  fixture: asFixture(stack),
  start: 'bottom-open',
  transitions: [{ match: /^select-pane -t %0$/, to: 'top-open' }],
};

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Pane Size Animation',
  component: FixtureApp,
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        component:
          'Pane size changes animate: a commanded resize, a stack opening the row the focus moved to.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const run = (command: string) => getApp().send({ type: 'SEND_TMUX_COMMAND', command });

const waitForPanes = (count: number, canvasElement: HTMLElement) =>
  waitForPaneCount(within(canvasElement), count);

/**
 * Which geometry properties started transitioning after `act` ran. Unlike
 * counting sampled frames this does not depend on the machine keeping up: a
 * loaded runner can paint twice across a 150ms animation. It waits for the
 * evidence rather than a fixed stretch, because on a loaded runner the round
 * trip alone outlasted the window.
 */
async function geometryTransitions(canvasElement: HTMLElement, act: () => void): Promise<string[]> {
  const layout = getPaneLayout(canvasElement);
  const seen = new Set<string>();
  const onStart = (e: Event) => {
    const property = (e as TransitionEvent).propertyName;
    if (['left', 'top', 'width', 'height'].includes(property)) seen.add(property);
  };
  layout.addEventListener('transitionstart', onStart);
  try {
    act();
    await waitFor(() => expect(seen.size, 'no geometry transition started').toBeGreaterThan(0), {
      timeout: 8000,
    });
    // Transitions starting a frame later than the first get recorded too, and
    // the caller measures settled boxes.
    await new Promise((r) => setTimeout(r, 700));
  } finally {
    layout.removeEventListener('transitionstart', onStart);
  }
  return [...seen];
}

export const AResizeGrowsOnAClock: Story = {
  tags: ['nightly'],
  args: SIDE_BY_SIDE,
  parameters: {
    docs: {
      description: {
        story:
          '`resize-pane -R 8` moves the shared divider. The panes pass through intermediate widths on the way rather than arriving in a single frame, and they end where the command asked.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    const before = paneNodes(canvasElement).map((n) => n.getBoundingClientRect().width);
    const animated = await geometryTransitions(canvasElement, () => {
      run('select-pane -t %0');
      run('resize-pane -t %0 -R 8');
    });

    expect(animated).not.toEqual([]);
    const after = paneNodes(canvasElement).map((n) => n.getBoundingClientRect().width);
    expect(Math.max(...after.map((w, i) => Math.abs(w - before[i])))).toBeGreaterThan(4);
  },
};

export const AStackOpensTheRowItMovesTo: Story = {
  args: STACK,
  parameters: {
    docs: {
      description: {
        story:
          'Stacked panes keep only the row holding the focus expanded, so moving the focus swaps which row is open. Both rows are drawn at heights in between on the way, which is the whole point of animating it — the row that opens is where the eye should end up.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    const before = paneNodes(canvasElement).map((n) => n.getBoundingClientRect().height);
    const animated = await geometryTransitions(canvasElement, () => run('select-pane -t %0'));

    // A stack opening one row closes another, and they have to share the clock
    // or the boxes shear apart mid-flight.
    expect(animated).not.toEqual([]);
    const after = paneNodes(canvasElement).map((n) => n.getBoundingClientRect().height);
    const moved = after.filter((h, i) => Math.abs(h - before[i]) > 4);
    expect(moved.length).toBeGreaterThan(1);
  },
};

export const TheCursorStaysInsideTheOpeningRow: Story = {
  tags: ['nightly'],
  args: STACK,
  parameters: {
    docs: {
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

    const paintedTop = (): number | null => {
      const el = shape();
      if (!el || overlay()?.style.opacity !== '1') return null;
      const ys = cursorPolygon(getComputedStyle(el).clipPath).map(([, y]) => y);
      return ys.length ? Math.min(...ys) : null;
    };

    const seen: number[] = [];
    let sampling = true;
    const frame = () => {
      const top = paintedTop();
      if (top !== null) seen.push(top);
      if (sampling) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    run('select-pane -t %0');
    await new Promise((r) => setTimeout(r, 1200));
    sampling = false;

    expect(seen.length, 'the cursor was never drawn').toBeGreaterThan(0);
    const top = gridBox().top;
    const highest = Math.min(...seen);
    expect(
      highest,
      `the cursor was drawn ${Math.round(top - highest)}px above the pane grid`,
    ).toBeGreaterThanOrEqual(top - 2);
  },
};

export const PressingAHeaderTakesThePane: Story = {
  args: SIDE_BY_SIDE,
  parameters: {
    docs: {
      description: {
        story:
          'Clicking a pane’s header focuses that pane, the same as clicking its body. Without it the only way to focus a pane was to click INSIDE it — which is exactly what you avoid doing when what you want is to move or rename the pane rather than type in it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitForPanes(2, canvasElement);
    await waitForAnimationsEnabled(getPaneLayout(canvasElement));

    const app = (
      window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
    ).app;
    const panes = paneNodes(canvasElement);
    const other = panes
      .map((n) => n.dataset.paneId as string)
      .find((id) => id !== app.getSnapshot().context.activePaneId)!;

    const header = canvasElement.querySelector<HTMLElement>(
      `.pane-layout-item[data-pane-id="${other}"] .pane-header`,
    )!;
    // The header's own background, not a tab or a button on it.
    const box = header.getBoundingClientRect();
    fireEvent.mouseDown(header, {
      clientX: box.right - 60,
      clientY: box.top + box.height / 2,
      button: 0,
      bubbles: true,
    });

    await waitFor(() => expect(app.getSnapshot().context.activePaneId).toBe(other), {
      timeout: 6000,
    });
    await waitFor(() =>
      expect(
        canvasElement.querySelector(`.pane-layout-item[data-pane-id="${other}"] .pane-header`),
      ).toHaveClass('pane-header-active'),
    );
  },
};
