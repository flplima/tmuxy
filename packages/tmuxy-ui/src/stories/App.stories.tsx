import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
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
 * Full-application stories driven by REAL tmux.
 *
 * The harness mounts the production `TmuxyApp` against `V86TmuxAdapter`: real
 * tmux 3.7a runs inside a v86 x86 emulator, and its `tmux -CC` control-mode
 * stream is parsed by tmuxy-core compiled to WASM — the exact code the native
 * server runs. Splits, new windows, and send-keys flow through
 * `invoke('run_tmux_command')` → the emulated tmux → back through the Rust core.
 * There is no lifo.sh shell simulation and no client-side VT emulator.
 *
 * These boot a real machine (~4s from a state snapshot) and are inherently
 * non-deterministic, so they are `v86`-tagged and excluded from the CI story
 * probe; each carries a `play` function for manual review and the dedicated
 * real-tmux e2e check.
 */

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application',
  component: V86AppHarness,
  tags: ['v86'],
  // Share one v86 engine across every story in this group: the first story cold-
  // boots (~5s), the rest restore the pinned snapshot (~1s) for an isolated clean
  // start. Switching stories in the Storybook UI is near-instant as a result.
  //
  // Every story runs a plain 80x30 terminal (V86_DEFAULT_COLS/ROWS) — the
  // harness is sized in CELLS, not pixels, so the grid is the same on any host
  // font instead of whatever a fixed pixel box happened to measure out to. A
  // story that needs a different terminal passes `cols`/`rows`.
  args: { shared: true },
  // Toolbar "tmux view": the guest's VGA console (tmux drawing itself) beside
  // or over the tmuxy rendering — see stories/tmuxView.tsx.
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
 * The restored snapshot has a live 2-pane session; the real UI renders it,
 * including the **active-pane style** (`.pane-active`) and the **terminal
 * cursor** — both driven by the active window/pane the Rust WASM core
 * reconstructs from the initial list-panes/list-windows sync.
 *
 * The page throws nothing while it boots and runs a typed command: the
 * `error` / `unhandledrejection` hooks go in before the first wait, so
 * anything thrown during the cycle is caught.
 */
export const Live: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const errors: string[] = [];
    // "ResizeObserver loop completed with undelivered notifications" is a benign
    // browser back-pressure signal (fired as an error event, harmless, and
    // whitelisted by every mainstream test harness) — not an app defect.
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
      // Exactly one pane is styled active, and its cursor is rendered.
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
 * Drag resize: mouse-drag the invisible `.resize-divider` between the two panes.
 * Pane widths must change and STICK after mouseup — i.e. tmux accepted the
 * resize-pane commands the drag generated (asserting only during-drag state would
 * pass on a pure client-side ghost).
 */
export const ResizePaneDrag: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const [a] = paneIds(canvas);
    const before = paneRect(canvas, a).width;

    // Record the ENTIRE interaction — through the drag AND the post-mouseup
    // reconcile — so a mid-drag grid shift or a flash-back to the old size on
    // release is caught (a recorder started after settle would miss both).
    const rec = new ResizeGlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await dragDivider(pickDivider(canvasElement, 'vertical'), rec, { dx: 80 });

    // Width changed AND persists after the tmux round-trip settles.
    await waitFor(() => expect(Math.abs(paneRect(canvas, a).width - before)).toBeGreaterThan(30), {
      timeout: 30000,
      interval: 500,
    });
    await settleGeometry(canvas);
    // Let the trailing per-command layout confirms and the preview-clear land.
    await new Promise((res) => setTimeout(res, 800));
    const after = paneRect(canvas, a).width;
    expect(Math.abs(paneRect(canvas, a).width - after)).toBeLessThan(10);
    // No geometry reversal at any point — not the post-release flash-back to
    // the old width, nor a mid-drag horizontal wobble.
    rec.assertNoBounces();
  },
};

/**
 * 1.1 — Split, the full optimistic timeline: C-a `-` paints a placeholder pane
 * within a few frames of the keypress (≤5 frames ≈ 83ms absorbs userEvent
 * dispatch overhead and is far below the serial round-trip), and when real
 * tmux confirms, the placeholder morphs into the real `%N` by an attribute
 * swap on the SAME DOM node — zero pane-node removals during reconcile
 * (the paneKeyOverrides anti-flicker contract).
 */
export const SplitOptimisticTimeline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    expect(layoutRoot).not.toBeNull();
    const before = paneGroups(canvas).length;

    await user.keyboard('{Control>}a{/Control}');
    // Arm AFTER the prefix press so the frame budget measures the mapped key.
    const recorder = new LayoutMutationRecorder(layoutRoot);
    const glitches = new GlitchRecorder(layoutRoot);
    const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_"]'));
    await user.keyboard('-');
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // The optimistic pane is genuinely visible, not just in the DOM.
    const placeholderEl = layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')!;
    expect(placeholderEl).not.toBeNull();
    const rect = placeholderEl.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(50);
    expect(rect.height).toBeGreaterThan(20);

    // Real tmux confirms: placeholder id swaps to %N, same node count.
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBe(before + 1);
        expect(layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')).toBeNull();
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
    recorder.disconnect();
    // No pane node was removed while the optimistic pane became real — the
    // element survived the id swap (a remount here is the flicker users see).
    expect([...recorder.removedPaneIds]).toEqual([]);
    glitches.assertNoGlitches('split');
  },
};

/**
 * 1.2 — Real-tmux rejection rolls the optimistic split back: keep splitting
 * until tmux runs out of vertical space. The failing attempt must still paint
 * its placeholder first (prediction has no min-size model — by design: the
 * server is authoritative), then roll back to the EXACT pre-attempt pane set
 * and geometry, leave a real active pane and no placeholder, and surface the
 * tmux error to the app (context.error → status-line message).
 */
export const SplitRejectedRollback: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;

    // Geometry must be at rest before we snapshot it — the previous attempt's
    // CSS transition / layout refresh may still be settling.
    const stableSig = async (): Promise<string> => {
      for (let i = 0; i < 20; i++) {
        const a = rectSignature(canvas);
        await new Promise((r) => setTimeout(r, 350));
        if (rectSignature(canvas) === a) return a;
      }
      throw new Error('pane geometry never settled');
    };

    let sawRollback = false;
    for (let attempt = 0; attempt < 8 && !sawRollback; attempt++) {
      const beforeSig = await stableSig();
      const beforeIds = realPaneIdsSorted(canvas).join(',');
      await user.keyboard('{Control>}a{/Control}');
      const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_"]'));
      await user.keyboard('-');
      // Success or failure, the placeholder paints first.
      await probe.wait(5, 5000);
      // Settle: no placeholder left either way (confirmed real, or rolled back).
      await waitFor(
        () => {
          expect(paneIds(canvas).filter((id) => id.startsWith('__placeholder_')).length).toBe(0);
          expect(activePaneId()).toMatch(/^%\d+$/);
        },
        { timeout: 20000, interval: 250 },
      );
      if (realPaneIdsSorted(canvas).join(',') === beforeIds) {
        // tmux rejected this split: geometry must be restored exactly. The
        // window is generous — a lingering acked op from a previous attempt
        // can hold its patch for several seconds before the restore settles.
        await waitFor(() => expect(rectSignature(canvas)).toBe(beforeSig), {
          timeout: 15000,
          interval: 400,
        });
        // And the rejection reached the app's error surface.
        expect(appError()).toBeTruthy();
        sawRollback = true;
      }
    }
    expect(sawRollback).toBe(true);
  },
};
