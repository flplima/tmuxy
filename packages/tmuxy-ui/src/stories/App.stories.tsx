import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { tmuxCaughtUp, transitionsDone } from './tmuxBarrier';
import { withTmuxView } from './tmuxView';
import { armPaintProbe, addsElement } from './immediacy';
import { GlitchRecorder } from './glitchRecorder';
import { ResizeGlitchRecorder } from './resizeGlitch';
import { LayoutMutationRecorder } from './animationObservers';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
  pickDivider,
  dragDivider,
  appError,
  realPaneIdsSorted,
  settleGeometry,
  rectSignature,
} from './appStoryHelpers';

/**
 * Full-application stories against real tmux 3.7a in a v86 emulator, its
 * control-mode stream parsed by tmuxy-core compiled to WASM. A booted machine
 * is non-deterministic, so these are `v86`-tagged and kept out of the CI story
 * probe.
 */

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application',
  component: V86AppHarness,
  tags: ['v86'],
  // One v86 engine for the group: the first story boots, the rest restore the
  // pinned snapshot for a clean start.
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The entire TmuxyApp rendered against real tmux (v86 + tmuxy-core WASM). Interact live; the state is reconstructed by the real Rust engine.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * The restored snapshot's 2-pane session renders with one active pane and its
 * cursor, and nothing is thrown while it boots and runs a command.
 */
export const Live: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const errors: string[] = [];
    // A benign browser back-pressure signal, fired as an error event and
    // whitelisted by every mainstream test harness.
    const BENIGN = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/;
    const onError = (e: ErrorEvent) => {
      if (!BENIGN.test(String(e.message))) errors.push(String(e.message));
    };
    const onRejection = (e: PromiseRejectionEvent) => errors.push(String(e.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    try {
      await waitFor(
        () => {
          const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
          expect(panes.length).toBeGreaterThanOrEqual(2);
          for (const pane of panes) {
            const rect = pane.getBoundingClientRect();
            expect(rect.width).toBeGreaterThan(0);
            expect(rect.height).toBeGreaterThan(0);
          }
        },
        { timeout: 45000, interval: 500 },
      );
      await waitFor(
        () => {
          expect(canvasElement.querySelectorAll('.pane-active').length).toBe(1);
          expect(canvasElement.querySelectorAll('.terminal-cursor').length).toBeGreaterThanOrEqual(
            1,
          );
        },
        { timeout: 15000, interval: 500 },
      );
      await focusFirstPane(canvas, userEvent.setup());
      pasteLine('echo NOERR_9');
      await waitFor(
        () =>
          expect(
            paneGroups(canvas).some((p: HTMLElement) => /NOERR_9/.test(p.textContent ?? '')),
          ).toBe(true),
        { timeout: 30000, interval: 500 },
      );
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    }
  },
};

/**
 * Pane widths changed by a divider drag must stick after mouseup, i.e. tmux
 * accepted the resize (a pure client-side ghost passes a during-drag check).
 */
export const ResizePaneDrag: Story = {
  tags: ['gate'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const [a] = paneIds(canvas);
    const before = paneRect(canvas, a).width;

    // Started before the drag, so a mid-drag shift or a flash-back to the old
    // size on release is caught.
    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await dragDivider(pickDivider(canvasElement, 'vertical'), rec, { dx: 80 });

    await waitFor(() => expect(Math.abs(paneRect(canvas, a).width - before)).toBeGreaterThan(30), {
      timeout: 30000,
      interval: 500,
    });
    await settleGeometry(canvas);
    await tmuxCaughtUp();
    const after = paneRect(canvas, a).width;
    expect(Math.abs(paneRect(canvas, a).width - after)).toBeLessThan(10);
    rec.assertNoBounces();
  },
};

/**
 * C-a `-` paints a placeholder pane within 5 frames (≈83ms absorbs userEvent's
 * dispatch overhead and is far below the serial round trip), and tmux's
 * confirmation swaps its id on the SAME DOM node: a remount is the flicker
 * users see.
 */
export const SplitOptimisticTimeline: Story = {
  tags: ['gate'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    expect(layoutRoot).not.toBeNull();
    const before = paneGroups(canvas).length;

    await user.keyboard('{Control>}a{/Control}');
    // Armed after the prefix, so the budget measures the mapped key.
    const recorder = new LayoutMutationRecorder(layoutRoot);
    const glitches = new GlitchRecorder(layoutRoot);
    const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_"]'));
    await user.keyboard('-');
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    const placeholderEl = layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')!;
    expect(placeholderEl).not.toBeNull();
    const rect = placeholderEl.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(50);
    expect(rect.height).toBeGreaterThan(20);

    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBe(before + 1);
        expect(layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')).toBeNull();
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
    recorder.disconnect();
    expect([...recorder.removedPaneIds]).toEqual([]);
    glitches.assertNoGlitches('split');
  },
};

/**
 * Splitting until tmux runs out of room: the refused split still paints its
 * placeholder first (prediction has no min-size model; the server is
 * authoritative), then rolls back to the exact pane set and geometry and
 * surfaces tmux's error.
 */
export const SplitRejectedRollback: Story = {
  tags: ['gate'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;

    // The previous attempt's round trip and CSS transition may still be landing.
    const stableSig = async (): Promise<string> => {
      await tmuxCaughtUp();
      await transitionsDone(layoutRoot);
      return rectSignature(canvas);
    };

    let sawRollback = false;
    for (let attempt = 0; attempt < 8 && !sawRollback; attempt++) {
      const beforeSig = await stableSig();
      const beforeIds = realPaneIdsSorted(canvas).join(',');
      await user.keyboard('{Control>}a{/Control}');
      const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_"]'));
      await user.keyboard('-');
      await probe.wait(5, 5000);
      await waitFor(
        () => {
          expect(paneIds(canvas).filter((id) => id.startsWith('__placeholder_')).length).toBe(0);
          expect(activePaneId()).toMatch(/^%\d+$/);
        },
        { timeout: 20000, interval: 250 },
      );
      if (realPaneIdsSorted(canvas).join(',') === beforeIds) {
        // Generous: a lingering acked op from a previous attempt can hold its
        // patch for several seconds before the restore settles.
        await waitFor(() => expect(rectSignature(canvas)).toBe(beforeSig), {
          timeout: 15000,
          interval: 400,
        });
        expect(appError()).toBeTruthy();
        sawRollback = true;
      }
    }
    expect(sawRollback).toBe(true);
  },
};
