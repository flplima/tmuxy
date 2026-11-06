import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { tmuxCaughtUp } from './tmuxBarrier';
import { withTmuxView } from './tmuxView';
import { armPaintProbe, addsElement } from './immediacy';
import { GlitchRecorder } from './glitchRecorder';
import { LayoutMutationRecorder } from './animationObservers';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneRect,
  paneIds,
  activeWindow,
  realTabWindows,
  windowTabEls,
  realPaneIdsSorted,
  recordClassHistory,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Optimistic',
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
 * New tab via the tab bar `+`: the strip AND the pane grid flip to the
 * placeholder window within a few frames, and tmux's confirmation morphs the
 * placeholder pane in place. The rejection twin is Mocked App/Resilience
 * (TabCreateRejected): real tmux has no user-reachable failure for a plain
 * new window.
 */
export const TabCreateOptimisticTimeline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    const beforeTabs = windowTabEls(canvas).length;
    const beforeWindows = realTabWindows().map((w) => w.id);

    const recorder = new LayoutMutationRecorder(layoutRoot);
    const probe = armPaintProbe(layoutRoot, addsElement('[data-pane-id^="__placeholder_pane"]'));
    await user.click(canvas.getByLabelText('Create new tab'));
    await probe.wait(5, 5000);
    expect(windowTabEls(canvas).length).toBe(beforeTabs + 1);

    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(beforeWindows.length + 1);
        expect(activeWindow()?.id).toMatch(/^@\d+$/);
        expect(activePaneId()).toMatch(/^%\d+$/);
        expect(layoutRoot.querySelector('[data-pane-id^="__placeholder_"]')).toBeNull();
      },
      { timeout: 30000, interval: 500 },
    );
    recorder.disconnect();
    expect([...recorder.removedPaneIds]).toEqual([]);
  },
};

/**
 * Clicking an inactive pane flips `.pane-active` within a few frames, and the
 * highlight never leaves it while tmux confirms. The class history is recorded
 * by a MutationObserver: polling would miss a one-frame flap.
 */
export const SelectPaneImmediate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const active = activePaneId();
    const target = paneIds(canvas).find((id) => /^%\d+$/.test(id) && id !== active)!;
    const targetEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === target,
    )!;
    const targetWrapper = targetEl.closest('.pane-layout-item') as HTMLElement;
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;

    const probe = armPaintProbe(
      layoutRoot,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'class' &&
        rec.target === targetWrapper &&
        targetWrapper.classList.contains('pane-active'),
    );
    await user.click(targetEl);
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    const classes = recordClassHistory(targetWrapper);
    await tmuxCaughtUp();
    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(activePaneId()).toBe(target);
  },
};

/**
 * Directional navigation predicts the pane tmux picks, MRU tiebreak included:
 * from a full-height pane facing two stacked neighbours, Ctrl+←/→ flips focus
 * to the most-recently-used one, and the flip is final (a second flip after the
 * reply means the client predicted another pane than tmux chose).
 */
export const NavigateKeysImmediate: Story = {
  args: { initCommands: ['select-layout even-horizontal', 'split-window -v'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitFor(() => expect(realPaneIdsSorted(canvas).length).toBeGreaterThanOrEqual(3), {
      timeout: 30000,
      interval: 500,
    });

    const ids = realPaneIdsSorted(canvas);
    const rects = new Map(ids.map((id) => [id, paneRect(canvas, id)]));
    const byLeft = new Map<number, string[]>();
    for (const [id, r] of rects) {
      const key = Math.round(r.left / 10);
      byLeft.set(key, [...(byLeft.get(key) ?? []), id]);
    }
    const stackedCol = [...byLeft.values()].find((col) => col.length >= 2);
    const singleCol = [...byLeft.values()].find((col) => col.length === 1);
    expect(stackedCol).toBeTruthy();
    expect(singleCol).toBeTruthy();
    const single = singleCol![0];
    const stackedSorted = [...stackedCol!].sort((a, b) => rects.get(a)!.top - rects.get(b)!.top);
    const mruTarget = stackedSorted[stackedSorted.length - 1];

    const clickPane = async (id: string) => {
      const el = paneGroups(canvas).find(
        (p: HTMLElement) => p.getAttribute('data-pane-id') === id,
      )!;
      await user.click(el);
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
    };
    await clickPane(mruTarget);
    await clickPane(single);

    // Ctrl+hjkl, the default root binding for pane navigation.
    const towardStack =
      rects.get(single)!.left < rects.get(mruTarget)!.left
        ? '{Control>}l{/Control}'
        : '{Control>}h{/Control}';
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    const mruEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === mruTarget,
    )!;
    const mruWrapper = mruEl.closest('.pane-layout-item') as HTMLElement;
    const probe = armPaintProbe(
      layoutRoot,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'class' &&
        rec.target === mruWrapper &&
        mruWrapper.classList.contains('pane-active'),
    );
    await user.keyboard(towardStack);
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    const classes = recordClassHistory(mruWrapper);
    await tmuxCaughtUp();
    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(activePaneId()).toBe(mruTarget);
  },
};

/**
 * Two splits in flight at once must resolve to DISTINCT real panes, with no
 * placeholder left. The second binding fires while the active pane is still a
 * `__placeholder_*`, which must not be sent to tmux as a target.
 */
export const ConcurrentSplitsClaimIds: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realPaneIdsSorted(canvas).length;

    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('-');
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('-');

    await waitFor(
      () => {
        const real = realPaneIdsSorted(canvas);
        expect(real.length).toBe(before + 2);
        expect(new Set(real).size).toBe(real.length);
        expect(paneIds(canvas).filter((id) => id.startsWith('__placeholder_')).length).toBe(0);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * A split tmux refuses ("no space for a new pane") rolls back at once with
 * tmux's own reason. tmux stops a command list at its first error, so an END
 * marker on the command's own `;` line never ran: the tracker waited out its
 * 8 s timeout and reported "tmux did not respond" for every reply behind it.
 * Invariant A6: the markers are their own lines.
 */
export const RefusedSplitReportsTmuxsReason: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const refusal = /no space for a new pane/;
    const snackbarTexts = () =>
      Array.from(document.querySelectorAll('[data-testid="snackbar"] .snackbar-text')).map(
        (el) => el.textContent ?? '',
      );
    const placeholders = () =>
      paneIds(canvas).filter((id) => id.startsWith('__placeholder_')).length;

    let refusedAfterMs = 0;
    for (let attempt = 0; attempt < 8 && refusedAfterMs === 0; attempt++) {
      const before = realPaneIdsSorted(canvas).length;
      const pressedAt = performance.now();
      await user.keyboard('{Control>}a{/Control}');
      await user.keyboard('-');
      await waitFor(
        () => {
          const refused = snackbarTexts().some((t) => refusal.test(t));
          const confirmed = realPaneIdsSorted(canvas).length === before + 1;
          expect(placeholders()).toBe(0);
          expect(refused || confirmed).toBe(true);
        },
        { timeout: 20000, interval: 100 },
      );
      if (snackbarTexts().some((t) => refusal.test(t))) {
        refusedAfterMs = performance.now() - pressedAt;
      }
    }
    expect(refusedAfterMs).toBeGreaterThan(0);
    expect(refusedAfterMs).toBeLessThan(4000);
    expect(snackbarTexts().some((t) => /did not respond/.test(t))).toBe(false);
  },
};

/**
 * Typing round-trip latency canary (not local echo, a non-goal): a pasted
 * command renders its real `%output` within a budget that catches serial
 * pacing or aggregator debounce regressions. Generous for emulator and CI
 * variance; a 10x pacing regression still fails.
 */
export const TypingRoundTripLatencyBudget: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const started = performance.now();
    pasteLine('echo STORY_LATENCY_$((6000+42))');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) =>
            (p.textContent ?? '').includes('STORY_LATENCY_6042'),
          ),
        ).toBe(true),
      { timeout: 10000, interval: 100 },
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5000);
  },
};

/**
 * C-a `x` through the KillPane prediction against real tmux: the pane goes,
 * focus lands on a real survivor, the reconcile never resurrects it, and the
 * grid shows no glitch. The mock twin (Mocked App/Resilience, SlowKillPane /
 * KillPaneRejected) proves the ordering under controlled latency.
 */
export const KillPaneOptimisticTimeline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doomed = activePaneId();
    expect(doomed).toMatch(/^%\d+$/);

    await user.keyboard('{Control>}a{/Control}');
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    await user.keyboard('x');

    await waitFor(() => expect(paneIds(canvas)).not.toContain(doomed), {
      timeout: 5000,
      interval: 100,
    });

    await tmuxCaughtUp();
    expect(paneIds(canvas)).not.toContain(doomed);
    expect(activePaneId()).toMatch(/^%\d+$/);
    expect(activePaneId()).not.toBe(doomed);
    glitches.assertNoGlitches('kill');
  },
};
