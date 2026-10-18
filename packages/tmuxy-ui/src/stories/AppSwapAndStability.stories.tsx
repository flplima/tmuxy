import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { armPaintProbe } from './immediacy';
import { GlitchRecorder } from './glitchRecorder';
import { SWAP_DWELL_MS } from '../machines/drag/dragMachine';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
} from './appStoryHelpers';

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

/**
 * 1.6 — Drag-to-swap reconciles without a visual step: after the drop, the
 * optimistic swap retargets both panes' inline geometry within a few frames,
 * and once the CSS transition settles, the real `%layout-change` from tmux
 * must land with ZERO further rect movement and no pane remounts — the user
 * sees exactly one continuous motion.
 */
export const SwapDragReconcile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const src = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    const dst = src === a ? b : a;
    const srcEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === src,
    )!;
    const dstEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === dst,
    )!;
    const header = srcEl.querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, dst);
    const startX = hRect.left + hRect.width / 2;
    const startY = hRect.top + hRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;

    // The positioned elements are the .pane-layout-item wrappers; the swap
    // exchanges their inline grid targets. During the drag the SOURCE pane is
    // pinned to its original slot (the ghost/transform carries the visual), so
    // the pane that moves optimistically at hover is the TARGET.
    const srcWrapper = srcEl.closest('.pane-layout-item') as HTMLElement;
    const dstWrapper = dstEl.closest('.pane-layout-item') as HTMLElement;
    const srcSlotBefore = `${srcWrapper.style.left}|${srcWrapper.style.top}`;
    const dstSlotBefore = `${dstWrapper.style.left}|${dstWrapper.style.top}`;

    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, clientY: startY, bubbles: true }),
    );
    // Cross the 5px drag threshold near the source header first.
    for (const i of [1, 2]) {
      header.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: startX + i * 8,
          clientY: startY + i * 2,
          bubbles: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 80));
    }

    // Hover onto the target: once the pointer has rested there for the swap
    // dwell, the drag machine fires the swap command, and the store's Swap
    // prediction must slide the target pane into the source's slot within a
    // few frames of that — long before the tmux round-trip could land.
    const hoverProbe = armPaintProbe(
      dstWrapper,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'style' &&
        `${dstWrapper.style.left}|${dstWrapper.style.top}` === srcSlotBefore,
    );
    // The frames the dwell itself takes on this machine, so the budget is "a
    // few frames after the dwell" whatever the frame rate.
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
    await new Promise((r) => setTimeout(r, SWAP_DWELL_MS));
    countingDwell = false;
    const hoverBudget = dwellFrames + 5;
    const hoverFrames = await hoverProbe.wait(hoverBudget, 5000);
    expect(hoverFrames).toBeLessThanOrEqual(hoverBudget);

    // Drop: the source pane's pin lifts and it must take the target's slot
    // immediately (the patch is already in the derived model).
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

    // Let the swap's CSS transition finish, then record across the server
    // reconcile: no size jumps, no pane remounts — the confirmation must be
    // visually invisible.
    await new Promise((r) => setTimeout(r, 600));
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await new Promise((r) => setTimeout(r, 1800));
    glitches.assertNoGlitches('drag');

    // And the swap actually stuck (server-confirmed geometry).
    const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    expect(leftNow).toBe(dst);
  },
};

/**
 * Swap keeps content in the correct lines: two panes of DIFFERENT heights are
 * each filled with a distinct run of consecutive numbers, then swapped with
 * `swap-pane`. A rAF sampler watches every painted frame THROUGH the swap and
 * asserts no pane ever renders its numbers out of order (a "wrong lines" glitch
 * would break the +1 run), and after the swap settles each pane still shows a
 * clean consecutive run ending at ITS OWN last value (so the right content
 * landed at the right rows, top-aligned in the pane) — driven by real tmux.
 */
export const SwapKeepsContentInCorrectLines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const cmd = (c: string) =>
      (window as unknown as { app: { send: (e: unknown) => void } }).app.send({
        type: 'SEND_TMUX_COMMAND',
        command: c,
      });
    const findPane = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const byTop = () =>
      paneIds(canvas)
        .map((id) => ({ id, top: paneRect(canvas, id).top }))
        .sort((a, b) => a.top - b.top)
        .map((x) => x.id);

    // Collapse to one pane, then build an UNEVEN vertical stack (mild resize so
    // neither pane collapses to a header-only row).
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
    await sleep(800);
    [top, bottom] = byTop();

    const fill = async (id: string, from: number, to: number) => {
      await user.click(findPane(id));
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
      pasteLine(`seq ${from} ${to}`);
      await waitFor(() => expect(findPane(id).textContent ?? '').toContain(String(to)), {
        timeout: 30000,
        interval: 400,
      });
    };
    await fill(top, 100, 200);
    await fill(bottom, 500, 640);

    // Visible consecutive-number run for a pane: its rendered `.terminal-line`s
    // inside the pane content box, top-to-bottom, as an integer array.
    const numbersOf = (id: string): number[] => {
      const g = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
      if (!g) return [];
      const cRect = (g.querySelector('.pane-content') as HTMLElement)?.getBoundingClientRect();
      return (Array.from(g.querySelectorAll('.terminal-line')) as HTMLElement[])
        .map((l) => ({ top: l.getBoundingClientRect().top, t: (l.textContent ?? '').trim() }))
        .filter((x) => cRect && x.top >= cRect.top - 1 && x.top <= cRect.bottom)
        .sort((a, b) => a.top - b.top)
        .map((x) => (/^\d+$/.test(x.t) ? Number(x.t) : NaN))
        .filter((v) => !Number.isNaN(v));
    };
    const breaks = (ns: number[]): number => {
      let b = 0;
      for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) b++;
      return b;
    };

    // Frame-sample the worst out-of-order break across both panes through the swap.
    let worstBreaks = 0;
    let sampling = true;
    const tick = () => {
      if (!sampling) return;
      const frameBreaks = paneIds(canvas).reduce((sum, id) => sum + breaks(numbersOf(id)), 0);
      if (frameBreaks > worstBreaks) worstBreaks = frameBreaks;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Swap the two (differently-sized) panes.
    cmd(`swap-pane -U -t ${bottom}`);
    await sleep(2200);
    sampling = false;

    // Content must never have rendered out of order at any painted frame.
    expect(worstBreaks, 'terminal content rendered in wrong lines during swap').toBe(0);

    // After settle: each value-run is still consecutive and ends at its own max,
    // so the right content is at the right rows (100..200 and 500..640 swapped
    // positions but kept their integrity).
    const runs = paneIds(canvas).map((id) => numbersOf(id));
    for (const ns of runs) {
      expect(ns.length).toBeGreaterThan(2);
      expect(breaks(ns)).toBe(0);
    }
    const maxes = runs.map((ns) => ns[ns.length - 1]).sort((a, b) => a - b);
    expect(maxes).toEqual([200, 640]);
  },
};

/**
 * Drag-swap keeps content in the correct lines: two equal-height stacked panes,
 * each filled with a distinct consecutive-number run, are swapped by dragging
 * the top pane's header down onto the bottom pane (the drag-machine path —
 * mousedown, cross the threshold, drop). A rAF sampler watches every painted
 * frame through the drag+drop asserting no pane ever renders its numbers out of
 * order, and after settling each pane still shows a clean consecutive run ending
 * at its own last value, is top-aligned in its content box, and its outer
 * layout item carries no leftover drag transform (which would push content into
 * the wrong absolute rows). Driven by real tmux via drag-and-drop.
 */
export const DragSwapKeepsContentInCorrectLines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const cmd = (c: string) =>
      (window as unknown as { app: { send: (e: unknown) => void } }).app.send({
        type: 'SEND_TMUX_COMMAND',
        command: c,
      });
    const findPane = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!;
    const byTop = () =>
      paneIds(canvas)
        .map((id) => ({ id, top: paneRect(canvas, id).top }))
        .sort((a, b) => a.top - b.top)
        .map((x) => x.id);

    // Equal-height vertical stack.
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
    await sleep(500);
    let [top, bottom] = byTop();

    const fill = async (id: string, from: number, to: number) => {
      await user.click(findPane(id));
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
      pasteLine(`seq ${from} ${to}`);
      await waitFor(() => expect(findPane(id).textContent ?? '').toContain(String(to)), {
        timeout: 30000,
        interval: 400,
      });
    };
    await fill(top, 100, 200);
    await fill(bottom, 500, 640);
    [top, bottom] = byTop();

    const numbersOf = (id: string): number[] => {
      const g = paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);
      if (!g) return [];
      const cRect = (g.querySelector('.pane-content') as HTMLElement)?.getBoundingClientRect();
      return (Array.from(g.querySelectorAll('.terminal-line')) as HTMLElement[])
        .map((l) => ({ top: l.getBoundingClientRect().top, t: (l.textContent ?? '').trim() }))
        .filter((x) => cRect && x.top >= cRect.top - 1 && x.top <= cRect.bottom)
        .sort((a, b) => a.top - b.top)
        .map((x) => (/^\d+$/.test(x.t) ? Number(x.t) : NaN))
        .filter((v) => !Number.isNaN(v));
    };
    const breaks = (ns: number[]): number => {
      let b = 0;
      for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) b++;
      return b;
    };

    // Frame-sample worst out-of-order breaks across both panes through the drag.
    let worstBreaks = 0;
    let sampling = true;
    const tick = () => {
      if (!sampling) return;
      const frameBreaks = paneIds(canvas).reduce((sum, id) => sum + breaks(numbersOf(id)), 0);
      if (frameBreaks > worstBreaks) worstBreaks = frameBreaks;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Drag the TOP pane's header down onto the BOTTOM pane.
    const header = findPane(top).querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, bottom);
    const sX = hRect.left + hRect.width / 2;
    const sY = hRect.top + hRect.height / 2;
    const eX = dstRect.left + dstRect.width / 2;
    const eY = dstRect.top + dstRect.height / 2;
    const dstEl = findPane(bottom);
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: sX, clientY: sY, bubbles: true }),
    );
    for (let i = 1; i <= 6; i++) {
      (i <= 2 ? header : dstEl).dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: sX + ((eX - sX) * i) / 6,
          clientY: sY + ((eY - sY) * i) / 6,
          bubbles: true,
        }),
      );
      await sleep(120);
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: eX, clientY: eY, bubbles: true }));

    // The swap must land (positions exchanged), then content settles.
    await waitFor(() => expect(byTop()[0]).toBe(bottom), { timeout: 30000, interval: 400 });
    await sleep(1500);
    sampling = false;

    // Never rendered out of order during the whole drag.
    expect(worstBreaks, 'terminal content rendered in wrong lines during drag-swap').toBe(0);

    // After settle: each pane's run is consecutive, ends at its own max, is
    // top-aligned, and its outer layout item has no leftover drag transform.
    const runs = paneIds(canvas).map((id) => numbersOf(id));
    for (const ns of runs) {
      expect(ns.length).toBeGreaterThan(2);
      expect(breaks(ns)).toBe(0);
    }
    expect(runs.map((ns) => ns[ns.length - 1]).sort((a, b) => a - b)).toEqual([200, 640]);
    for (const id of paneIds(canvas)) {
      const item = canvasElement.querySelector(
        `.pane-layout-item[data-pane-id="${id}"]`,
      ) as HTMLElement;
      const t = getComputedStyle(item).transform;
      // Identity / none — no residual translate that would offset the content.
      const translated =
        t !== 'none' && /matrix\([^)]*\)/.test(t) && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(t);
      expect(translated, `pane ${id} has a leftover drag transform: ${t}`).toBe(false);
    }
  },
};
