/**
 * Animation integration stories for floats, drawers, focus cues, swaps, and config gates,
 * over states recorded from real tmux.
 *
 * Coverage:
 *  - OpenFloat            `tmuxy pane float`: an overlay runs `float-appear`
 *  - OpenDrawer           `tmuxy pane float --left`: the `slide-in-left` keyframe
 *  - FocusCueNeverHardFlips  switching panes fades surface + text on one clock,
 *                         under every layout-suppression gate
 *  - SwapPanes            the same two nodes trade boxes in one gated commit, never
 *                         drawn between them; the gate releases after (BUG-6)
 *  - ConfigAnimationsOff  `@tmuxy-animations off`: a split lands in place, no
 *                         morph, and a resize arrives in one frame
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import floats from './fixtures/gen/float-and-drawer.json';
import moves from './fixtures/gen/side-by-side-moves.json';
import {
  LayoutMutationRecorder,
  observeChildList,
  waitForCssAnimation,
} from './animationObservers';
import {
  getApp,
  paneNodes,
  getPaneLayout,
  waitForPaneCount,
  waitForAnimationsEnabled,
  alphaOf,
  APPEARANCE,
  watchResizingGate,
  watchLifecycleClasses,
  assertGatesDeclareFocusCue,
  stepFocusCueOnElement,
} from './animationStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Animations Tabs & Groups',
  component: FixtureApp,
  args: { fixture: asFixture(moves), start: 'two' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        component:
          'Integration stories that verify the DOM mutations and CSS animations behind float open/close, focus cues, pane swaps, and the animations-disabled state.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every pane's box, once per painted frame, from before `act` until `ms` after it. */
async function sampleFrames(
  canvasElement: HTMLElement,
  act: () => void,
  ms = 700,
): Promise<Array<Map<string, DOMRect>>> {
  const frames: Array<Map<string, DOMRect>> = [];
  const shoot = () =>
    frames.push(
      new Map(paneNodes(canvasElement).map((n) => [n.dataset.paneId!, n.getBoundingClientRect()])),
    );
  let sampling = true;
  const frame = () => {
    shoot();
    if (sampling) requestAnimationFrame(frame);
  };
  // Taken before `act`: a change that snaps is over by the first frame callback.
  shoot();
  requestAnimationFrame(frame);
  act();
  await wait(ms);
  sampling = false;
  return frames;
}

/** Type `command` at the prompt of the focused pane and run it, as a user does. */
async function runInPane(canvasElement: HTMLElement, command: string): Promise<void> {
  await waitForPaneCount(within(canvasElement), 1);
  await waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'));
  await userEvent.keyboard(`${command}{Enter}`);
}

/** tmux's answer once the typed command runs: the state it recorded for it. */
const ON_ENTER = (to: string) => [{ match: /^send-keys -t %0 Enter$/, to }];

// ---------------------------------------------------------------------------
// Open float — overlay lands in the pane container, float-appear keyframe runs
// ---------------------------------------------------------------------------

export const OpenFloat: Story = {
  args: { fixture: asFixture(floats), start: 'one', transitions: ON_ENTER('float') },
  parameters: {
    docs: {
      description: {
        story:
          '`tmuxy pane float` typed at the prompt opens a centered float: a `.modal-overlay` is inserted into the pane container and runs the `float-appear` keyframe on `.modal-container`. A MutationObserver on the container confirms the insertion, an `animationstart` listener confirms the keyframe actually ran, and the overlay is measured against the tab strip to prove the backdrop dims the tab content only.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const paneContainer = document.querySelector('.pane-container') as HTMLElement;
    const overlays = observeChildList(paneContainer, '.modal-overlay');
    const animationFired = waitForCssAnimation('.modal-container', {
      animationName: 'float-appear',
      timeout: 6000,
    });
    try {
      await runInPane(canvasElement, 'tmuxy pane float');

      // The keyframe ran for real...
      await animationFired;
      // ...and the overlay node was inserted into the pane container.
      await waitFor(() => expect(overlays.added.length).toBeGreaterThanOrEqual(1), {
        timeout: 1000,
      });
      const overlay = document.querySelector('.modal-overlay') as HTMLElement;
      expect(overlay).toHaveClass('float-modal');

      // The backdrop dims the tab's content and nothing else: it fills the pane
      // container exactly, and the tab strip above it stays uncovered.
      const backdrop = overlay.querySelector('.modal-backdrop') as HTMLElement;
      const box = backdrop.getBoundingClientRect();
      const container = paneContainer.getBoundingClientRect();
      expect(Math.abs(box.top - container.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.bottom - container.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.left - container.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.right - container.right)).toBeLessThanOrEqual(1);
      const strip = document.querySelector('.tab-list') as HTMLElement;
      expect(strip.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.top + 1);
    } finally {
      overlays.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Open drawer — slide-in keyframe on an edge-docked float
// ---------------------------------------------------------------------------

export const OpenDrawer: Story = {
  args: { fixture: asFixture(floats), start: 'float-closed', transitions: ON_ENTER('drawer') },
  parameters: {
    docs: {
      description: {
        story:
          '`tmuxy pane float --left --width 40` opens a left drawer, which runs the `slide-in-left` keyframe. The MutationObserver on the pane container confirms the overlay insertion and the `animationstart` listener confirms the slide-in keyframe was exercised.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const overlays = observeChildList(
      document.querySelector('.pane-container') as HTMLElement,
      '.modal-overlay',
    );
    const slideFired = waitForCssAnimation('.modal-container', {
      animationName: 'slide-in-left',
      timeout: 6000,
    });
    try {
      await runInPane(canvasElement, 'tmuxy pane float --left --width 40');

      await slideFired;
      await waitFor(() => expect(overlays.added.length).toBeGreaterThanOrEqual(1), {
        timeout: 1000,
      });
      expect(document.querySelector('.modal-overlay')).toHaveClass('drawer-left');
    } finally {
      overlays.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Focus cue — surface alpha and text dim must move on one clock
// ---------------------------------------------------------------------------

export const FocusCueNeverHardFlips: Story = {
  tags: ['nightly'],
  args: { transitions: [{ match: /^select-pane -t %0$/, to: 'left-active' }] },
  parameters: {
    docs: {
      description: {
        story:
          'Switching the active pane must fade the pane SURFACE (background-color alpha) and its TEXT (the terminal opacity) on the same clock. The regression: the text dim lives on `.pane-content`, which no gate covers, while the surface lives on `.pane-layout-item`, which three gates reset — so a gate that dropped `background-color` left the surface hard-flipping in one frame while the text faded. That mismatch reads as a blink on every pane navigation, and is loudest on a translucent surface over a blurred desktop. Samples both values per frame across a real click-to-focus and asserts they never diverge, then asserts each gate still declares the cue.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 2);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    // The appearance opacities are published from tmux options by the running
    // app; Storybook mounts no such actor, so they are unset here and both the
    // dim and the surface alpha collapse to their fallbacks. Set the shipped
    // defaults so there is a cue to observe at all.
    const root = document.documentElement;
    const appearance: [string, string][] = [
      ['--active-pane-opacity', '1'],
      ['--inactive-pane-opacity', '0.7'],
      ['--active-text-opacity', '1'],
      ['--inactive-text-opacity', '0.7'],
    ];
    appearance.forEach(([k, v]) => root.style.setProperty(k, v));

    // The cue must be live first: the vars resolved into a translucent
    // surface on the inactive pane.
    await waitFor(() => {
      const inactive = layout.querySelector<HTMLElement>('.pane-layout-item:not(.pane-active)');
      expect(inactive).not.toBeNull();
      expect(alphaOf(getComputedStyle(inactive!).backgroundColor)).toBeCloseTo(0.7, 1);
      const content = inactive!.querySelector<HTMLElement>('.pane-content')!;
      expect(parseFloat(getComputedStyle(content).opacity)).toBeCloseTo(0.7, 1);
    });

    const before = layout.querySelector<HTMLElement>('.pane-layout-item.pane-active');
    expect(before).not.toBeNull();
    const target = paneNodes(canvasElement).find((p) => p !== before);
    expect(target).toBeDefined();

    // Armed before the click, so it steps the fade before any frame of it runs.
    const cue = stepFocusCueOnElement(target!);

    // Click the terminal, as a user does: the pane's mouse handler is there,
    // and a click on the outer `.pane-layout-item` never reaches it.
    const hit =
      target!.querySelector<HTMLElement>('.terminal-line') ??
      target!.querySelector<HTMLElement>('.terminal-content') ??
      target!;
    await userEvent.click(hit);
    await waitFor(() => expect(target!.classList.contains('pane-active')).toBe(true));
    const run = await cue;

    // Both halves are transitions on one clock; a hard flip has none.
    expect(run.surface, 'the surface hard-flipped: no background-color transition').not.toBeNull();
    expect(run.text, 'the text hard-flipped: no opacity transition').not.toBeNull();
    expect(run.surface).toEqual(run.text);

    // The two agree at every point; a hard flip is a gap of ~0.30.
    const worst = run.steps.reduce((m, s) => Math.max(m, Math.abs(s.text - s.surface)), 0);
    expect(
      worst,
      `surface alpha and text opacity diverged: ${JSON.stringify(run.steps)}`,
    ).toBeLessThanOrEqual(0.05);

    // ...and it really fades: from the dim to full, rising at every point.
    const dim = parseFloat(getComputedStyle(root).getPropertyValue('--inactive-text-opacity'));
    expect(run.steps[0].text).toBeCloseTo(dim, 2);
    expect(run.steps[run.steps.length - 1].text).toBeCloseTo(1, 2);
    const rising = run.steps.every((s, i) => i === 0 || s.text > run.steps[i - 1].text);
    expect(rising, `the text did not fade: ${JSON.stringify(run.steps)}`).toBe(true);

    assertGatesDeclareFocusCue(layout, canvasElement);

    appearance.forEach(([k]) => root.style.removeProperty(k));
  },
};

// ---------------------------------------------------------------------------
// Swap — the same two nodes trade boxes in one commit, and the gate releases
// ---------------------------------------------------------------------------

export const SwapPanes: Story = {
  args: { transitions: [{ match: /^swap-pane -U$/, to: 'swapped' }] },
  parameters: {
    docs: {
      description: {
        story:
          'A swap hands the same two boxes to the other pane, in one commit. There is no size change to follow and an animated permutation would slide the panes through each other, so command-driven geometry snaps by design (BUG-6: `suppressLayoutTransition` latches `.pane-layout-resizing` for exactly that commit): every sampled frame has each pane at one of the two positions and never between them. The same two DOM nodes end up with left and right exchanged — no node added or removed, no enter/leave lifecycle — and the gate lets go afterwards, the 0.1s layout transition back on both panes for whatever comes next.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 2);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    const before = paneNodes(canvasElement).map((n) => ({
      id: n.dataset.paneId as string,
      left: n.getBoundingClientRect().left,
    }));
    expect(before).toHaveLength(2);
    const [leftPane, rightPane] = [...before].sort((a, b) => a.left - b.left);

    const gateWatcher = watchResizingGate(layout);
    const lifecycle = watchLifecycleClasses(layout);
    const recorder = new LayoutMutationRecorder(layout);
    try {
      // The active pane is the split's new one (right); `-U` swaps it with the
      // pane before it, so both exchange places.
      const frames = await sampleFrames(canvasElement, () => {
        getApp().send({ type: 'SEND_TMUX_COMMAND', command: `select-pane -t ${rightPane.id}` });
        getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'swap-pane -U' });
      });

      // Same nodes, sides exchanged; nothing entered or left.
      await waitFor(
        () => {
          const after = new Map(
            paneNodes(canvasElement).map((n) => [n.dataset.paneId!, n.getBoundingClientRect()]),
          );
          expect(after.size).toBe(2);
          expect(after.get(leftPane.id)!.left).toBeGreaterThan(after.get(rightPane.id)!.left);
        },
        { timeout: 2000 },
      );
      // Every frame has both panes parked on one of the two starting columns.
      const lefts = before.map((b) => b.left);
      for (const shot of frames) {
        for (const box of shot.values()) {
          expect(Math.min(...lefts.map((l) => Math.abs(l - box.left)))).toBeLessThanOrEqual(2);
        }
      }
      expect(recorder.geometryRewrites).toBeGreaterThan(0);
      expect(recorder.addedPaneIds.size).toBe(0);
      expect(recorder.removedPaneIds.size).toBe(0);
      expect(gateWatcher.wasGated()).toBe(true);
      lifecycle.stop();
      expect(lifecycle.sawLifecycle()).toBe(false);

      // The gate is for that commit only: animations are back for the next thing.
      await waitFor(
        () => {
          expect(layout.classList.contains('pane-layout-resizing')).toBe(false);
          expect(layout.classList.contains('pane-layout-no-animations')).toBe(false);
        },
        { timeout: 4000 },
      );
      for (const node of paneNodes(canvasElement)) {
        expect(getComputedStyle(node).transitionDuration).toContain('0.1s');
      }
    } finally {
      lifecycle.stop();
      recorder.disconnect();
      gateWatcher.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Config off — `@tmuxy-animations off` draws a split in place and snaps a resize
// ---------------------------------------------------------------------------

/** `@tmuxy-animations` as tmuxy.conf pushes it with the appearance. */
const pushAnimations = (animations: boolean) =>
  getApp().send({
    type: 'THEME_SETTINGS_RECEIVED',
    theme: 'default',
    mode: 'dark',
    appearance: { ...APPEARANCE, animations },
  });

export const ConfigAnimationsOff: Story = {
  args: {
    start: 'one',
    transitions: [
      { match: /^split-window -h$/, to: 'two' },
      { match: /^select-pane -t %0$/, to: 'left-active' },
      { match: /^resize-pane -t %0 -R 8$/, to: 'left-grown' },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          '`set -g @tmuxy-animations off` in tmuxy.conf reaches the client with the appearance (THEME_SETTINGS_RECEIVED). The switch holds `.pane-layout-no-animations` on the grid and `.app-no-animations` on the chrome whatever the settle logic decides, and PaneLayout skips the enter/leave lifecycle: a split lands as two tiled panes with no `transitionstart`, no `.pane-entering`, and a 0s geometry transition, and a resize arrives in a single frame — the pane is at its old width or its new one, never between. Turning the option back on (a `source-file` re-push) restores the 0.1s transition.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    pushAnimations(false);
    await waitFor(() => {
      expect(layout.classList.contains('pane-layout-no-animations')).toBe(true);
      expect(canvasElement.querySelector('.app-container.app-no-animations')).not.toBeNull();
    });

    const starts: string[] = [];
    const onTransitionStart = (e: Event) => starts.push((e as TransitionEvent).propertyName);
    layout.addEventListener('transitionstart', onTransitionStart);
    const lifecycle = watchLifecycleClasses(layout);
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });
      await waitForPaneCount(canvas, 2);
      // Give any morph that was going to start its chance, then check nothing did.
      await wait(400);
      lifecycle.stop();

      expect(lifecycle.sawLifecycle()).toBe(false);
      // Colour transitions (the focus cue) are allowed under the gate; no
      // geometry moved on a clock.
      const GEOMETRY = ['left', 'top', 'width', 'height', 'transform'];
      expect(starts.filter((p) => GEOMETRY.includes(p))).toEqual([]);
      // Nor is any geometry declared on one (the box-shadow and colours may be).
      for (const node of paneNodes(canvasElement)) {
        const style = getComputedStyle(node);
        const durations = style.transitionDuration.split(', ');
        style.transitionProperty.split(', ').forEach((p, i) => {
          if (p === 'all' || GEOMETRY.includes(p)) expect(durations[i]).toBe('0s');
        });
      }
      const [a, b] = paneNodes(canvasElement).map((n) => n.getBoundingClientRect());
      const ovX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const ovY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(Math.min(ovX, ovY)).toBeLessThanOrEqual(1);

      // The resize lands in one step: `%0` moved, and took exactly two widths.
      const frames = await sampleFrames(canvasElement, () => {
        getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'select-pane -t %0' });
        getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'resize-pane -t %0 -R 8' });
      });
      expect(frames.filter((shot) => !shot.has('%0')).length, '%0 went undrawn').toBe(0);
      const widths = frames.map((shot) => Math.round(shot.get('%0')!.width));
      expect(widths[widths.length - 1] - widths[0]).toBeGreaterThan(4);
      expect(new Set(widths).size).toBe(2);

      // Back on: the config's re-push lifts the gate once the app has settled.
      pushAnimations(true);
      await waitForAnimationsEnabled(layout);
      expect(canvasElement.querySelector('.app-container.app-no-animations')).toBeNull();
      expect(getComputedStyle(paneNodes(canvasElement)[0]).transitionDuration).toContain('0.1s');
    } finally {
      lifecycle.stop();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};
