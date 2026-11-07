import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { inputPause, tmuxCaughtUp, transitionsDone } from './tmuxBarrier';
import { withTmuxView } from './tmuxView';
import { armPaintProbe } from './immediacy';
import { GlitchRecorder } from './glitchRecorder';
import { SWAP_DWELL_MS } from '../machines/drag/dragMachine';
import {
  type Canvas,
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
} from './appStoryHelpers';
import { storyApp } from './storyApp';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Swap & Stability',
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

const findPane = (canvas: Canvas, id: string) =>
  paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;

async function fillWithSeq(
  canvas: Canvas,
  user: ReturnType<typeof userEvent.setup>,
  id: string,
  from: number,
  to: number,
): Promise<void> {
  await user.click(findPane(canvas, id));
  await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
  pasteLine(`seq ${from} ${to}`);
  await waitFor(() => expect(findPane(canvas, id).textContent ?? '').toContain(String(to)), {
    timeout: 30000,
    interval: 400,
  });
}

function numbersOf(canvas: Canvas, id: string): number[] {
  const g = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
  if (!g) return [];
  const cRect = (g.querySelector('.pane-content') as HTMLElement)?.getBoundingClientRect();
  return (Array.from(g.querySelectorAll('.terminal-line')) as HTMLElement[])
    .map((l) => ({ top: l.getBoundingClientRect().top, t: (l.textContent ?? '').trim() }))
    .filter((x) => cRect && x.top >= cRect.top - 1 && x.top <= cRect.bottom)
    .sort((a, b) => a.top - b.top)
    .map((x) => (/^\d+$/.test(x.t) ? Number(x.t) : NaN))
    .filter((v) => !Number.isNaN(v));
}

function breaks(ns: number[]): number {
  let b = 0;
  for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) b++;
  return b;
}

function sampleBreaks(canvas: Canvas): { stop: () => number } {
  let worst = 0;
  let sampling = true;
  const tick = () => {
    if (!sampling) return;
    const frameBreaks = paneIds(canvas).reduce((sum, id) => sum + breaks(numbersOf(canvas, id)), 0);
    if (frameBreaks > worst) worst = frameBreaks;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop: () => {
      sampling = false;
      return worst;
    },
  };
}

function expectRunsIntact(canvas: Canvas, maxes: number[]): void {
  const runs = paneIds(canvas).map((id) => numbersOf(canvas, id));
  for (const ns of runs) {
    expect(ns.length).toBeGreaterThan(2);
    expect(breaks(ns)).toBe(0);
  }
  expect(runs.map((ns) => ns[ns.length - 1]).sort((a, b) => a - b)).toEqual(maxes);
}

/**
 * Drag-to-swap: the optimistic swap retargets both panes within a few frames,
 * and tmux's `%layout-change` then lands with zero further rect movement and
 * no remount, so the user sees one continuous motion. No painted frame renders
 * either pane's run of numbers out of order, and no leftover drag transform
 * pushes content into the wrong rows.
 */
export const SwapDragReconcile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const src = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    const dst = src === a ? b : a;
    await fillWithSeq(canvas, user, src, 100, 200);
    await fillWithSeq(canvas, user, dst, 500, 640);

    const srcEl = findPane(canvas, src);
    const dstEl = findPane(canvas, dst);
    const header = srcEl.querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, dst);
    const startX = hRect.left + hRect.width / 2;
    const startY = hRect.top + hRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;

    // During the drag the SOURCE pane is pinned to its slot (the ghost carries
    // the visual), so the pane that moves at hover is the TARGET.
    const srcWrapper = srcEl.closest('.pane-layout-item') as HTMLElement;
    const dstWrapper = dstEl.closest('.pane-layout-item') as HTMLElement;
    const srcSlotBefore = `${srcWrapper.style.left}|${srcWrapper.style.top}`;
    const dstSlotBefore = `${dstWrapper.style.left}|${dstWrapper.style.top}`;

    const sampler = sampleBreaks(canvas);
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, clientY: startY, bubbles: true }),
    );
    for (const i of [1, 2]) {
      header.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: startX + i * 8,
          clientY: startY + i * 2,
          bubbles: true,
        }),
      );
      await inputPause(80);
    }

    const hoverProbe = armPaintProbe(
      dstWrapper,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'style' &&
        `${dstWrapper.style.left}|${dstWrapper.style.top}` === srcSlotBefore,
    );
    // The dwell's own frames, so the budget is "a few frames after the dwell"
    // whatever the frame rate.
    let dwellFrames = 0;
    let countingDwell = true;
    const countDwell = () => {
      if (!countingDwell) return;
      dwellFrames += 1;
      requestAnimationFrame(countDwell);
    };
    requestAnimationFrame(countDwell);
    dstEl.dispatchEvent(
      new MouseEvent('mousemove', { clientX: endX, clientY: endY, bubbles: true }),
    );
    await inputPause(SWAP_DWELL_MS);
    countingDwell = false;
    const hoverBudget = dwellFrames + 5;
    const hoverFrames = await hoverProbe.wait(hoverBudget, 5000);
    expect(hoverFrames).toBeLessThanOrEqual(hoverBudget);

    const dropProbe = armPaintProbe(
      srcWrapper,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'style' &&
        `${srcWrapper.style.left}|${srcWrapper.style.top}` === dstSlotBefore,
    );
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));
    const dropFrames = await dropProbe.wait(5, 5000);
    expect(dropFrames).toBeLessThanOrEqual(5);

    const layout = canvasElement.querySelector('.pane-layout')!;
    await transitionsDone(layout);
    const glitches = new GlitchRecorder(layout);
    await tmuxCaughtUp();
    glitches.assertNoGlitches('drag');

    // tmux redraws a swapped pane at its new size, and on a shared engine that
    // has run other stories the redraw can land after the glitch window.
    const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    expect(leftNow).toBe(dst);
    await waitFor(
      () => {
        expect(numbersOf(canvas, src).slice(-1)[0]).toBe(200);
        expect(numbersOf(canvas, dst).slice(-1)[0]).toBe(640);
      },
      { timeout: 20000, interval: 200 },
    );

    expect(sampler.stop(), 'terminal content rendered in wrong lines during drag-swap').toBe(0);
    expectRunsIntact(canvas, [200, 640]);
    for (const id of paneIds(canvas)) {
      const item = canvasElement.querySelector(
        `.pane-layout-item[data-pane-id="${id}"]`,
      ) as HTMLElement;
      const t = getComputedStyle(item).transform;
      const translated =
        t !== 'none' && /matrix\([^)]*\)/.test(t) && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(t);
      expect(translated, `pane ${id} has a leftover drag transform: ${t}`).toBe(false);
    }
  },
};

/**
 * `swap-pane` on two panes of different heights keeps each pane's run of
 * numbers in order on every painted frame, and each still ends at its own last
 * value afterwards (a "wrong lines" glitch breaks the +1 run).
 */
export const SwapKeepsContentInCorrectLines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const cmd = (c: string) => storyApp().send({ type: 'SEND_TMUX_COMMAND', command: c });
    const byTop = () =>
      paneIds(canvas)
        .map((id) => ({ id, top: paneRect(canvas, id).top }))
        .sort((a, b) => a.top - b.top)
        .map((x) => x.id);

    // A mild resize, so neither pane collapses to a header-only row.
    const ids0 = paneIds(canvas);
    cmd(`kill-pane -t ${ids0[1]}`);
    await waitFor(() => expect(paneGroups(canvas).length).toBe(1), {
      timeout: 20000,
      interval: 300,
    });
    cmd('split-window -v');
    await waitFor(() => expect(paneGroups(canvas).length).toBe(2), {
      timeout: 20000,
      interval: 300,
    });
    let [top, bottom] = byTop();
    cmd(`resize-pane -t ${bottom} -U 4`);
    await tmuxCaughtUp();
    [top, bottom] = byTop();

    await fillWithSeq(canvas, user, top, 100, 200);
    await fillWithSeq(canvas, user, bottom, 500, 640);

    const sampler = sampleBreaks(canvas);

    // Waited for, not paused: on a shared engine that has run other stories
    // the round trip is slower, and a fixed pause read a pane still mid-reflow.
    cmd(`swap-pane -U -t ${bottom}`);
    await waitFor(
      () => {
        expect(byTop()).toEqual([bottom, top]);
        expect(numbersOf(canvas, top).slice(-1)[0]).toBe(200);
        expect(numbersOf(canvas, bottom).slice(-1)[0]).toBe(640);
      },
      { timeout: 20000, interval: 200 },
    );

    expect(sampler.stop(), 'terminal content rendered in wrong lines during swap').toBe(0);

    expectRunsIntact(canvas, [200, 640]);
  },
};
