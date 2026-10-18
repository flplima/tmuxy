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
 */
export const Live: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
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
        expect(canvasElement.querySelectorAll('.terminal-cursor').length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15000, interval: 500 },
    );
  },
};

/**
 * Mouse: clicking an inactive pane selects it — the active-pane style and cursor
 * move to the clicked pane (a `select-pane` round-trip through real tmux).
 */
export const MouseSelectPane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const getActive = () =>
      (
        window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
      ).app.getSnapshot().context.activePaneId;
    await waitFor(
      () =>
        expect(canvas.getAllByRole('group', { name: /^Pane %/i }).length).toBeGreaterThanOrEqual(2),
      { timeout: 45000, interval: 500 },
    );
    await waitFor(() => expect(getActive()).toBeTruthy(), { timeout: 10000 });
    const initial = getActive();
    const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
    // Click the pane that isn't currently active.
    const target =
      panes.find((p: HTMLElement) => p.getAttribute('data-pane-id') !== initial) ?? panes[0];
    await userEvent.click(target);
    await waitFor(() => expect(getActive()).not.toBe(initial), { timeout: 10000, interval: 300 });
  },
};

/**
 * Keyboard with the tmuxy default keybindings (C-a prefix): pressing the prefix
 * then `c` (new-window) runs the mapped command through real tmux and a new
 * window tab appears.
 */
export const PrefixKeybinding: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const prefixActive = () =>
      (
        window as unknown as { app: { getSnapshot(): { context: { prefixActive?: boolean } } } }
      ).app.getSnapshot().context.prefixActive === true;
    await waitFor(
      () =>
        expect(canvas.getAllByRole('group', { name: /^Pane %/i }).length).toBeGreaterThanOrEqual(2),
      { timeout: 45000, interval: 500 },
    );
    await user.click(canvas.getAllByRole('group', { name: /^Pane %/i })[0]);
    // C-a (the tmuxy prefix) must arm prefix mode…
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => expect(prefixActive()).toBe(true), { timeout: 5000, interval: 200 });
    // …and the next mapped key (c = new-window) consumes it.
    await user.keyboard('c');
    await waitFor(() => expect(prefixActive()).toBe(false), { timeout: 5000, interval: 200 });
  },
};

/** Real `split-window` commands issued at startup produce real extra panes. */
export const Splits: Story = {
  args: { initCommands: ['split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 45000, interval: 500 },
    );
  },
};

/**
 * Keyboard split (regression): pressing the prefix then `-` runs the mapped
 * `split-window -v` through real tmux and a third pane appears. The keyboardActor
 * pins the command to the active pane with a `select-pane -t %N \; split-window`
 * compound; the adapter must translate the shell-escaped `\;` separator to the
 * bare `;` control-mode wants — otherwise the split silently errors and the
 * app's optimistic placeholder pane never reconciles, freezing the UI. This
 * asserts the split completes and the active pane is a real pane (not a stuck
 * `__placeholder_op_*`).
 */
export const KeyboardSplit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('-');
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Interactive: click a pane and TYPE a command on the keyboard — the keystrokes
 * flow keyboardActor → `send-keys` → real tmux in v86 → bash, and the output is
 * re-rendered from the live `%output` stream via the Rust WASM core. Proves the
 * tmuxy UI is genuinely interactive client-side (not a static render).
 */
export const Interactive: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('echo STORY_INTERACT');
    // The echoed output must appear in the active pane (rendered from live
    // %output). Keystrokes route to whichever pane tmux has active, so accept a
    // match in any pane.
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /STORY_INTERACT/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 25000, interval: 500 },
    );
  },
};

/**
 * Runs real commands in real bash and drives the real **tmuxy CLI** inside the
 * guest — exactly like server-side mode, but fully client-side. We enter a
 * `tmuxy pane split` command into the focused pane's bash; the CLI runs in-guest
 * and routes the split through `tmux run-shell`, and the resulting new pane shows
 * up in the tmuxy UI (reconstructed by the Rust WASM core).
 */
export const TmuxyCli: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const before = paneGroups(canvas).length;
    pasteLine('tmuxy pane split');
    // The new pane created by the CLI must show up in the UI (reconstructed by
    // the Rust WASM core from the live control-mode stream).
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThan(before), {
      timeout: 30000,
      interval: 500,
    });
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
