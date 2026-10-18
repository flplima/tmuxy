/**
 * Animation integration stories for floats, drawers, focus cues, swaps, and config gates.
 *
 * Coverage:
 *  - OpenFloat            overlay portals into <body> and runs `float-appear`
 *  - OpenDrawer           drawer overlay runs the `slide-in-left` keyframe
 *  - CloseFloat           overlay node is removed (float close is instant)
 *  - FocusCueNeverHardFlips  switching panes fades surface + text on one clock,
 *                         under every layout-suppression gate
 *  - SwapPanes            the same two nodes trade boxes in one gated commit; the
 *                         gate releases after (command geometry snaps — BUG-6)
 *  - ConfigAnimationsOff  `@tmuxy-animations off`: a split lands in place, no morph
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import {
  LayoutMutationRecorder,
  observeChildList,
  waitForCssAnimation,
  wait,
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
  sampleFocusCueOnElement,
} from './animationStoryHelpers';

const meta: Meta<typeof AppHarness> = {
  title: 'Scenarios/Animations Tabs & Groups',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Integration stories that verify the DOM mutations and CSS animations behind float open/close, focus cues, pane swaps, and the animations-disabled state.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

// ---------------------------------------------------------------------------
// Open float — overlay lands in the pane container, float-appear keyframe runs
// ---------------------------------------------------------------------------

export const OpenFloat: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Creating a centered float inserts a `.modal-overlay` into the pane container and runs the `float-appear` keyframe on `.modal-container`. A MutationObserver on the container confirms the insertion, an `animationstart` listener confirms the keyframe actually ran, and the overlay is measured against the tab strip to prove the backdrop dims the tab content only.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const paneContainer = document.querySelector('.pane-container') as HTMLElement;
    const overlays = observeChildList(paneContainer, '.modal-overlay');
    const animationFired = waitForCssAnimation('.modal-container', {
      animationName: 'float-appear',
      timeout: 6000,
    });
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'tmuxy-float-create' });

      // The keyframe ran for real...
      await animationFired;
      // ...and the overlay node was inserted into the pane container.
      await waitFor(
        () => {
          expect(overlays.added.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 1000 },
      );
      const overlay = document.querySelector('.modal-overlay') as HTMLElement;
      expect(overlay).not.toBeNull();
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
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'A left drawer float runs the `slide-in-left` keyframe. The MutationObserver on the pane container confirms the overlay insertion and the `animationstart` listener confirms the slide-in keyframe was exercised.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const overlays = observeChildList(
      document.querySelector('.pane-container') as HTMLElement,
      '.modal-overlay',
    );
    const slideFired = waitForCssAnimation('.modal-container', {
      animationName: 'slide-in-left',
      timeout: 6000,
    });
    try {
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'tmuxy-float-create --left --width 40' });

      await slideFired;
      await waitFor(
        () => {
          expect(overlays.added.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 1000 },
      );
      expect(document.querySelector('.modal-overlay')).toHaveClass('drawer-left');
    } finally {
      overlays.disconnect();
    }
  },
};

// ---------------------------------------------------------------------------
// Close float — overlay node is removed (close is an instant unmount)
// ---------------------------------------------------------------------------

export const CloseFloat: Story = {
  args: { height: 600, initCommands: ['tmuxy-float-create'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Closing a float is an instant unmount (there is no exit keyframe), so the observable signal is the overlay node being removed. The MutationObserver on the pane container records the `.modal-overlay` removal and the DOM ends with no overlay.',
      },
    },
  },
  play: async () => {
    // The float opened from initCommands — wait for its overlay to appear.
    const overlay = await waitFor(
      () => {
        const el = document.querySelector('.modal-overlay');
        if (!el) throw new Error('no .modal-overlay yet');
        return el as HTMLElement;
      },
      { timeout: 8000 },
    );
    const paneId = overlay
      .querySelector('.float-container[data-pane-id]')
      ?.getAttribute('data-pane-id');
    expect(paneId).toBeTruthy();

    const overlays = observeChildList(
      document.querySelector('.pane-container') as HTMLElement,
      '.modal-overlay',
    );
    try {
      // Same event the × button / backdrop click / Esc dispatch.
      getApp().send({ type: 'CLOSE_FLOAT', paneId });

      await waitFor(
        () => {
          expect(overlays.removed.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 2000 },
      );
      expect(document.querySelector('.modal-overlay')).toBeNull();
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
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Switching the active pane must fade the pane SURFACE (background-color alpha) and its TEXT (the wrapper opacity) on the same clock. The regression: the text dim lives on `.pane-layout-item > *`, which no gate covers, while the surface lives on `.pane-layout-item`, which three gates reset — so a gate that dropped `background-color` left the surface hard-flipping in one frame while the text faded over 80ms. That mismatch reads as a blink on every pane navigation, and is loudest on a translucent surface over a blurred desktop. Samples both values per frame across a real click-to-focus and asserts they never diverge, then asserts each gate still declares the cue.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);

    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });
    await waitForPaneCount(canvas, 2);
    await waitFor(() => {
      expect(layout.querySelector('.pane-entering, .pane-shifting')).toBeNull();
    });

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

    const active = () => layout.querySelector<HTMLElement>('.pane-layout-item.pane-active');

    // Don't start sampling until the cue is actually live: the vars have to
    // have resolved into a translucent surface on the inactive pane, or every
    // sample compares a faded text opacity against an unresolved surface.
    await waitFor(() => {
      const inactive = layout.querySelector<HTMLElement>('.pane-layout-item:not(.pane-active)');
      expect(inactive).not.toBeNull();
      expect(alphaOf(getComputedStyle(inactive!).backgroundColor)).toBeCloseTo(0.7, 1);
      expect(parseFloat(getComputedStyle(inactive!.firstElementChild!).opacity)).toBeCloseTo(
        0.7,
        1,
      );
    });

    const before = active();
    expect(before).not.toBeNull();
    const target = paneNodes(canvasElement).find((p) => p !== before);
    expect(target).toBeDefined();

    const cueSampler = sampleFocusCueOnElement(target!);
    const { samples } = cueSampler;

    try {
      // Click inside the pane, not the layout box: the pane's mouse handler is
      // on the terminal element, and events bubble up — a click on the outer
      // `.pane-layout-item` never reaches it (which is also what a real user's
      // click hits, since the terminal fills the pane).
      const hit =
        target!.querySelector<HTMLElement>('.terminal-line') ??
        target!.querySelector<HTMLElement>('.terminal-content') ??
        target!;
      await userEvent.click(hit);
      await waitFor(() => expect(target!.classList.contains('pane-active')).toBe(true));
      await wait(150);
    } finally {
      cueSampler.stop();
    }
    expect(samples.length).toBeGreaterThan(6);

    const worst = samples.reduce((m, s) => Math.max(m, Math.abs(s.text - s.surface)), 0);
    // A hard flip is a gap of ~0.30 (the full dim), so this has wide margin
    // over the sub-frame jitter of two getComputedStyle reads under CI load.
    expect(
      worst,
      `surface alpha and text opacity diverged: ${JSON.stringify(samples.slice(0, 8))}`,
    ).toBeLessThanOrEqual(0.05);

    // ...and the cue really animated rather than both snapping in one frame:
    // at least one sampled frame sits strictly between the dim and full values.
    const dim = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--inactive-text-opacity'),
    );
    expect(samples.some((s) => s.text > dim + 0.01 && s.text < 0.99)).toBe(true);

    assertGatesDeclareFocusCue(layout, canvasElement);

    appearance.forEach(([k]) => root.style.removeProperty(k));
  },
};

// ---------------------------------------------------------------------------
// Swap — the same two nodes trade boxes in one commit, and the gate releases
// ---------------------------------------------------------------------------

export const SwapPanes: Story = {
  args: { height: 600, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'A swap rewrites both panes’ boxes in one commit. Command-driven geometry snaps by design (BUG-6: `suppressLayoutTransition` latches `.pane-layout-resizing` for exactly that commit so nothing wobbles through an intermediate box), so the assertion is about what a swap must and must not do: the same two DOM nodes end up with left and right exchanged — no node added or removed, no enter/leave lifecycle — and the gate lets go afterwards, the 0.1s layout transition back on both panes for whatever comes next.',
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
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: `select-pane -t ${rightPane.id}` });
      getApp().send({ type: 'SEND_TMUX_COMMAND', command: 'swap-pane -U' });

      // Same nodes, sides exchanged; nothing entered or left.
      await waitFor(
        () => {
          const after = new Map(
            paneNodes(canvasElement).map((n) => [
              n.dataset.paneId as string,
              n.getBoundingClientRect().left,
            ]),
          );
          expect(after.size).toBe(2);
          expect(after.get(leftPane.id)!).toBeGreaterThan(after.get(rightPane.id)!);
        },
        { timeout: 2000 },
      );
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
// Config off — `@tmuxy-animations off` draws a split in place, no morph at all
// ---------------------------------------------------------------------------

export const ConfigAnimationsOff: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          '`set -g @tmuxy-animations off` in tmuxy.conf reaches the client with the appearance (THEME_SETTINGS_RECEIVED). The switch holds `.pane-layout-no-animations` on the grid and `.app-no-animations` on the chrome whatever the settle logic decides, and PaneLayout skips the enter/leave lifecycle: a split lands as two tiled panes with no `transitionstart`, no `.pane-entering`, and a 0s geometry transition. Turning the option back on (a `source-file` re-push) restores the 0.1s transition.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForPaneCount(canvas, 1);
    const layout = getPaneLayout(canvasElement);
    await waitForAnimationsEnabled(layout);

    getApp().send({
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...APPEARANCE, animations: false },
    });
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
      await new Promise((r) => setTimeout(r, 400));
      lifecycle.stop();

      expect(lifecycle.sawLifecycle()).toBe(false);
      // Colour transitions (the focus cue) are allowed under the gate; no
      // geometry moved on a clock.
      const GEOMETRY = ['left', 'top', 'width', 'height', 'transform'];
      expect(starts.filter((p) => GEOMETRY.includes(p))).toEqual([]);
      for (const node of paneNodes(canvasElement)) {
        expect(getComputedStyle(node).transitionDuration).not.toContain('0.1s');
      }
      const [a, b] = paneNodes(canvasElement).map((n) => n.getBoundingClientRect());
      const ovX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const ovY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(Math.min(ovX, ovY)).toBeLessThanOrEqual(1);

      // Back on: the config's re-push lifts the gate once the app has settled.
      getApp().send({
        type: 'THEME_SETTINGS_RECEIVED',
        theme: 'default',
        mode: 'dark',
        appearance: { ...APPEARANCE, animations: true },
      });
      await waitForAnimationsEnabled(layout);
      expect(canvasElement.querySelector('.app-container.app-no-animations')).toBeNull();
      expect(getComputedStyle(paneNodes(canvasElement)[0]).transitionDuration).toContain('0.1s');
    } finally {
      lifecycle.stop();
      layout.removeEventListener('transitionstart', onTransitionStart);
    }
  },
};
