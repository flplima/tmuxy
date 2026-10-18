import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { armPaintProbe, addsElement } from './immediacy';
import { GlitchRecorder } from './glitchRecorder';
import { LayoutMutationRecorder } from './animationObservers';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  windows,
  paneRect,
  paneIds,
  activeWindow,
  tabWindows,
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
 * 1.3 — Optimistic new-tab timeline via the tab bar `+` (pure mouse): the tab
 * strip AND the pane grid flip to the placeholder window within a few frames
 * of the click; real tmux then confirms with a real `@N`/`%N`, morphing the
 * placeholder pane in place (no pane-node removal). The rejection twin lives
 * in Mocked App/Resilience (TabCreateRejected) — real tmux has no
 * user-reachable failure mode for a plain new-window.
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
    // The tab strip already shows the optimistic tab.
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
 * 1.4a — Pane focus is optimistic and stable: clicking an inactive pane flips
 * `.pane-active` within a few frames of the click, and the highlight NEVER
 * passes through a non-active state again while real tmux confirms (the class
 * history is recorded by MutationObserver — polling would miss a one-frame
 * flap; the mutation log cannot).
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
    // `pane-active` lives on the .pane-layout-item wrapper, not the inner
    // role=group element the accessibility query returns.
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

    // Record every class value the pane passes through while the real
    // select-pane round-trips; none may lack `pane-active`.
    const classes = recordClassHistory(targetWrapper);
    await new Promise((r) => setTimeout(r, 1500));
    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(activePaneId()).toBe(target);
  },
};

/**
 * 1.4b — Tab switch is optimistic and stable: with two windows, clicking the
 * inactive tab flips `aria-selected` within a few frames, and the selection
 * never flaps back while the real select-window confirms (guards the
 * SELECT_TAB grace-window pinning).
 */
export const SelectTabImmediate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });

    const tabEl = windowTabEls(canvas)[0];
    const probe = armPaintProbe(
      canvasElement,
      (rec) =>
        rec.type === 'attributes' &&
        rec.attributeName === 'aria-selected' &&
        rec.target === tabEl &&
        tabEl.getAttribute('aria-selected') === 'true',
    );
    await user.click(tabEl);
    const frames = await probe.wait(5, 5000);
    expect(frames).toBeLessThanOrEqual(5);

    // The optimistic selection must hold through the server confirmation —
    // and the pane grid must swap with zero flicker/churn/jumps.
    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const flaps: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.attributeName === 'aria-selected') flaps.push(rec.oldValue ?? '');
      }
    });
    observer.observe(tabEl, { attributes: true, attributeOldValue: true });
    await new Promise((r) => setTimeout(r, 1500));
    observer.disconnect();
    expect([...flaps, tabEl.getAttribute('aria-selected')].filter((v) => v !== 'true')).toEqual([]);
    expect(activeWindow()?.index).toBe(1);
    glitches.assertNoGlitches('windowSwitch');
  },
};

/**
 * 1.5 — Directional pane navigation predicts the pane tmux will pick,
 * including the MRU tiebreak: with a full-height pane facing two stacked
 * neighbours, Ctrl+←/→ must flip focus to the most-recently-used neighbour
 * within a few frames — and the flip must be FINAL (a second flip after the
 * server reply means the client predicted a different pane than tmux chose).
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

    // Identify the geometry: one column holds two stacked panes, the other a
    // single (tallest) pane. All coordinates from live rects — no assumptions
    // about which boot pane got split.
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
    // Bottom pane of the stacked column — the one we'll make most-recently-used.
    const stackedSorted = [...stackedCol!].sort((a, b) => rects.get(a)!.top - rects.get(b)!.top);
    const mruTarget = stackedSorted[stackedSorted.length - 1];

    const clickPane = async (id: string) => {
      const el = paneGroups(canvas).find(
        (p: HTMLElement) => p.getAttribute('data-pane-id') === id,
      )!;
      await user.click(el);
      await waitFor(() => expect(activePaneId()).toBe(id), { timeout: 15000, interval: 200 });
    };
    // MRU order: touch the bottom stacked pane, then move to the single pane.
    await clickPane(mruTarget);
    await clickPane(single);

    // Navigate from the single pane toward the stacked column.
    // Ctrl+hjkl, the default root binding for pane navigation.
    const towardStack =
      rects.get(single)!.left < rects.get(mruTarget)!.left
        ? '{Control>}l{/Control}'
        : '{Control>}h{/Control}';
    const layoutRoot = canvasElement.querySelector('.pane-layout') as HTMLElement;
    const mruEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === mruTarget,
    )!;
    // `pane-active` lives on the .pane-layout-item wrapper.
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

    // The predicted target must BE tmux's choice — no second flip.
    const classes = recordClassHistory(mruWrapper);
    await new Promise((r) => setTimeout(r, 1500));
    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(activePaneId()).toBe(mruTarget);
  },
};

/**
 * 1.7 — Two splits in flight at once: press C-a `-` twice back-to-back, faster
 * than the round-trip. Both placeholders must resolve to DISTINCT real panes
 * (guards the claimedPanes reconcile sets) and no placeholder may survive.
 * Also guards the keyboardActor's placeholder-safe send targeting: the second
 * binding fires while the active pane is still `__placeholder_*`, which must
 * not be sent to tmux as a target.
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
 * 1.9 — Typing round-trip latency canary (NOT local echo — that's an explicit
 * non-goal): pasting a command must render its real `%output` within a budget
 * that catches serial-pacing / aggregator-debounce regressions. Generous for
 * emulator + CI variance; a 10x pacing regression still fails loudly.
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

// ─────────── §13 Optimistic ops: kill / zoom / rename (predict → confirm) ───────────

/**
 * 2.1 — Kill pane, optimistic end-to-end: C-a `x` routes through the KillPane
 * prediction (removal + neighbor expansion on dispatch, exit-animation grace,
 * server confirm invisible). The mock twin (Mocked App/Resilience —
 * SlowKillPane / KillPaneRejected) proves the ordering crisply under
 * controlled latency; this proves the real chain agrees: the doomed pane is
 * gone within the animation grace + margin, focus lands on a surviving real
 * pane, and the reconcile never resurrects it.
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
    const removedAt = { t: 0 };
    const observer = new MutationObserver(() => {
      if (removedAt.t === 0 && !paneIds(canvas).includes(doomed)) {
        removedAt.t = performance.now();
      }
    });
    observer.observe(canvasElement.querySelector('.pane-layout')!, {
      childList: true,
      subtree: true,
    });
    const pressed = performance.now();
    await user.keyboard('x');

    await waitFor(() => expect(paneIds(canvas)).not.toContain(doomed), {
      timeout: 5000,
      interval: 100,
    });
    observer.disconnect();
    // Removal within the 300ms exit grace + margin — the optimistic path.
    // (The pure server path adds the round-trip + capture refresh on top.)
    expect((removedAt.t || performance.now()) - pressed).toBeLessThan(700);

    // No resurrection while the server confirms; focus is a real survivor.
    await new Promise((r) => setTimeout(r, 1500));
    expect(paneIds(canvas)).not.toContain(doomed);
    expect(activePaneId()).toMatch(/^%\d+$/);
    expect(activePaneId()).not.toBe(doomed);
    glitches.assertNoGlitches('kill');
  },
};

/**
 * 2.3 — Kill window (tab), optimistic: C-a `&` removes the active tab via the
 * KillWindow prediction — the tab strip drops the tab within the exit grace,
 * an adjacent tab activates, and the server confirm never flaps it back.
 */
export const TabKillOptimistic: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    const doomedWindow = activeWindow()!.id;

    // Focus a pane in the new tab so the keybinding targets it.
    await user.click(paneGroups(canvas)[0]);
    await waitFor(() => expect(activePaneId()).toMatch(/^%\d+$/), { timeout: 10000 });

    await user.keyboard('{Control>}a{/Control}');
    const pressed = performance.now();
    await user.keyboard('{Shift>}7{/Shift}'); // '&'

    await waitFor(() => expect(windowTabEls(canvas).length).toBe(1), {
      timeout: 5000,
      interval: 100,
    });
    const droppedAfter = performance.now() - pressed;
    expect(droppedAfter).toBeLessThan(1200);

    // Stays dropped through the server confirm; the surviving tab is active.
    await new Promise((r) => setTimeout(r, 1500));
    expect(windowTabEls(canvas).length).toBe(1);
    expect(windows().every((w) => w.id !== doomedWindow)).toBe(true);
    expect(activeWindow()?.id).toMatch(/^@\d+$/);
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};
