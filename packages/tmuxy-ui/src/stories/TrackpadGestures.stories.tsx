/**
 * Trackpad gesture stories (demo engine).
 *
 * A play function cannot touch a trackpad, so these dispatch exactly what one
 * sends a page: wheel events with deltaX for a two-finger slide, ctrl+wheel for
 * a pinch in Chromium and Firefox, and WebKit's gesturestart / gesturechange /
 * gestureend for a pinch in Safari and the desktop app. They land on the
 * element under the "fingers" and travel the real chain: gestureActor, the app
 * machine, GestureStage and PaneLayout drawing each step, and SELECT_TAB /
 * ZOOM_PANE / TOGGLE_TAB_OVERVIEW / TAB_OVERVIEW_ACTIVATE into the demo tmux
 * when the fingers lift.
 *
 * Motion is sampled once a frame after the fingers lift, so a bounce, an
 * overshoot or a zoom that steps back before going on shows up as a sample
 * moving the wrong way.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import { SWIPE_COOLDOWN_MS } from '../machines/actors/gestureActor';
import { SWIPE_COMMIT_SHARE, SWIPE_EDGE_LIMIT_SHARE } from '../utils/gestures';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Trackpad Gestures',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface AppActor {
  getSnapshot(): {
    context: {
      activeWindowId: string | null;
      activePaneId: string | null;
      tabOverviewOpen: boolean;
      /** The pane area's width — what a slide's commit share is measured against. */
      containerWidth: number;
      gesture: unknown;
      windows: Array<{ id: string; index: number; windowType: string | null; zoomed?: boolean }>;
      panes: Array<{ tmuxId: string; windowId: string }>;
    };
  };
  send(event: unknown): void;
}
const actor = () => (window as unknown as { app: AppActor }).app;
const ctx = () => actor().getSnapshot().context;
const tabs = () =>
  ctx()
    .windows.filter((w) => w.windowType === 'tab')
    .sort((a, b) => a.index - b.index);
const ownPanes = () => ctx().panes.filter((p) => p.windowId === ctx().activeWindowId);
const paneOf = (windowId: string) => ctx().panes.find((p) => p.windowId === windowId)!.tmuxId;
const zoomed = () => Boolean(ctx().windows.find((w) => w.id === ctx().activeWindowId)?.zoomed);
const settled = () => ctx().gesture === null;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const layout = () => document.querySelector('.pane-container > .pane-layout') as HTMLElement;
const paneEl = (id: string) =>
  document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`) as HTMLElement;
const activePaneEl = () => paneEl(ctx().activePaneId!);
const atRest = () => waitFor(() => expect(getComputedStyle(layout()).transform).toBe('none'));

function centre(el: Element) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

/** One wheel step per value over `el`, one a frame: the fingers are down until the steps stop. */
async function wheelSteps(el: Element, steps: number[], init: WheelEventInit = {}) {
  for (const step of steps) {
    const delta = init.ctrlKey ? { deltaY: step } : { deltaX: step };
    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ...centre(el),
        ...init,
        ...delta,
      }),
    );
    await nextFrame();
  }
}
const repeat = (step: number, n: number) => Array.from({ length: n }, () => step);

/**
 * Wheel steps that pull the grid `px` to the right (fingers moving right), in a
 * fixed, small number of steps.
 *
 * Long in distance, short in time, because a loaded machine breaks this test
 * two different ways and they pull against each other. What a release commits
 * to is `dx + speed × SWIPE_PROJECT_MS`, and `speed` is px per ms BETWEEN wheel
 * events — one per animation frame here — so a fixed step SIZE reads as a
 * slower gesture on a busy runner and lands on the other side of the commit
 * share. Distance is the part a test can hold still. But spreading that
 * distance over many more steps is worse, not better: one frame stalling longer
 * than SWIPE_IDLE_MS ends the slide mid-push, and the steps after it are a
 * second slide.
 *
 * So: the same number of frames a slide always took, each step simply longer.
 * Fewer still would be worse in another way — the cursor overlay eases toward
 * the panes, so a slide crammed into half the frames is measured while the
 * cursor is still catching up.
 */
const slideSteps = (px: number, count = 16) => repeat(-Math.ceil(px / count), count);

/** A WebKit gesture event (Safari, the desktop app's WKWebView) over `el`. */
function webkitGesture(el: Element, type: string, scale: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { scale, ...centre(el) });
  el.dispatchEvent(e);
  return e;
}

/**
 * Where the cursor overlay draws the cursor: the left edge of its clip polygon
 * (the overlay element itself spans the window).
 */
function cursorLeft(): number {
  const shape = document.querySelector<HTMLElement>('.smooth-cursor-shape');
  const m = shape?.style.clipPath.match(/polygon\(\s*(-?[\d.]+)px/);
  return m ? parseFloat(m[1]) : NaN;
}

/** `read()` once a frame until `done()` holds and the value has stopped changing (2s cap). */
async function sampleUntil(read: () => number, done: () => boolean): Promise<number[]> {
  const samples: number[] = [];
  const started = performance.now();
  while (performance.now() - started < 2000) {
    samples.push(read());
    const last = samples.slice(-4);
    if (done() && last.length === 4 && Math.max(...last) - Math.min(...last) < 0.5) break;
    await nextFrame();
  }
  return samples;
}

/** Every sample moved `direction` (1 up, -1 down) or held, within a pixel. */
function expectOneWay(samples: number[], direction: 1 | -1, what: string) {
  const trace = samples.map((s) => Math.round(s)).join(', ');
  for (let i = 1; i < samples.length; i++) {
    expect((samples[i] - samples[i - 1]) * direction, `${what}: ${trace}`).toBeGreaterThanOrEqual(
      -1,
    );
  }
}

const APPEARANCE = {
  opacity: 0.7,
  activePaneOpacity: 1,
  inactivePaneOpacity: 0.7,
  activeTextOpacity: 1,
  inactiveTextOpacity: 0.7,
  blur: false,
  animations: true,
  cursorBlink: true,
  tabOverviewCols: 3,
  gestureSwipeTabs: true,
  gesturePinchZoom: true,
  gesturePinchOverview: true,
};

async function ready(canvasElement: HTMLElement) {
  await within(canvasElement).findAllByRole('group', { name: /Pane/i }, { timeout: 8000 });
}

export const SlideBetweenTabs: Story = {
  args: { height: 500, initCommands: ['rename-window main', 'new-window', 'rename-window logs'] },
  parameters: {
    docs: {
      description: {
        story:
          'Two fingers sliding right pull in the previous tab. While they move, the grid follows them with that tab’s real panes beside it at the same height, and the cursor rides along. Released half way across - or short of it but still moving, as a flick - the tab switches on the release itself, and the new tab then slides the rest of the way in on one ease-out curve whose length comes from the distance left and the speed the fingers had, never past its place and never back. Past the first tab the grid gives with resistance and slides back, and a short slow slide slides back too.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(tabs()).toHaveLength(2), { timeout: 8000 });
    const [main, logs] = tabs();
    await waitFor(() => expect(ctx().activeWindowId).toBe(logs.id));
    const logsPane = paneEl(paneOf(logs.id));
    const mainPane = paneEl(paneOf(main.id));
    const rest = logsPane.getBoundingClientRect();
    await waitFor(() => expect(Number.isNaN(cursorLeft())).toBe(false));
    const cursorStart = cursorLeft();

    // Fingers slide right: the grid moves with them, "main" alongside at the
    // same height, the cursor with it, and nothing has switched yet. Far enough
    // that the DISTANCE alone is past the commit share (see slideSteps).
    await wheelSteps(logsPane, slideSteps(ctx().containerWidth * SWIPE_COMMIT_SHARE * 1.3));
    const moved = logsPane.getBoundingClientRect();
    expect(moved.left - rest.left).toBeGreaterThan(300);
    expect(mainPane.classList).toContain('pane-swipe-neighbor');
    const incoming = mainPane.getBoundingClientRect();
    expect(Math.abs(moved.left - incoming.right)).toBeLessThan(40);
    expect(Math.abs(incoming.top - moved.top)).toBeLessThan(1);
    expect(Math.abs(incoming.height - moved.height)).toBeLessThan(1);
    expect(cursorLeft() - cursorStart).toBeGreaterThan((moved.left - rest.left) * 0.7);
    expect(ctx().activeWindowId).toBe(logs.id);

    // They lift: the tab switches at once - the keyboard and the strip do not
    // wait for any animation - and only then does "main" slide the rest of the
    // way in, one way only.
    //
    // "At once" is measured against the slide, not against a clock: the frame
    // the switch is first seen on still has "main" a long way from its resting
    // place, so the switch cannot have waited for the slide to finish. A
    // wall-clock budget here read a loaded runner's slow frames as a product
    // bug and was the single biggest source of red runs for this story.
    const switchLeft = await (async () => {
      for (let frame = 0; frame < 240; frame++) {
        if (ctx().activeWindowId === main.id) return mainPane.getBoundingClientRect().left;
        await nextFrame();
      }
      throw new Error('the fingers lifted past the commit share and the tab never switched');
    })();
    expect(rest.left - switchLeft, 'the switch waited for the slide to finish').toBeGreaterThan(20);
    const inbound = await sampleUntil(
      () => mainPane.getBoundingClientRect().left,
      () => settled() && ctx().activeWindowId === main.id,
    );
    expectOneWay(inbound, 1, 'incoming tab');
    expect(Math.max(...inbound)).toBeLessThanOrEqual(rest.left + 1);
    expect(Math.abs(mainPane.getBoundingClientRect().left - rest.left)).toBeLessThan(1);
    expect(mainPane.classList).not.toContain('pane-swipe-neighbor');
    await waitFor(() => {
      const p = mainPane.getBoundingClientRect();
      expect(cursorLeft()).toBeGreaterThanOrEqual(p.left);
      expect(cursorLeft()).toBeLessThanOrEqual(p.right);
    });

    // Past the first tab: the grid gives a little with nothing beside it, and
    // slides straight back. (A new slide, once the last one's coast is over.)
    await pause(SWIPE_COOLDOWN_MS);
    await wheelSteps(mainPane, repeat(-24, 16));
    // Resistance: it gives, but far less than the 384px the fingers moved,
    // and never past the limit.
    const give = mainPane.getBoundingClientRect().left - rest.left;
    expect(give).toBeGreaterThan(60);
    expect(give).toBeLessThan(rest.width * SWIPE_EDGE_LIMIT_SHARE);
    expect(document.querySelector('.pane-swipe-neighbor')).toBeNull();
    const back = await sampleUntil(() => mainPane.getBoundingClientRect().left, settled);
    expectOneWay(back, -1, 'slide back');
    expect(Math.min(...back)).toBeGreaterThanOrEqual(rest.left - 1);
    expect(ctx().activeWindowId).toBe(main.id);

    // A short, slow slide toward "logs" follows the fingers, then slides back.
    await pause(SWIPE_COOLDOWN_MS);
    await wheelSteps(mainPane, repeat(4, 5));
    expect(mainPane.getBoundingClientRect().left).toBeLessThan(rest.left - 10);
    await sampleUntil(() => mainPane.getBoundingClientRect().left, settled);
    expect(ctx().activeWindowId).toBe(main.id);

    // A flick that lifts short of half way: the momentum tail says the fingers
    // are off and how fast they were going, and that carries it to "logs".
    await pause(SWIPE_COOLDOWN_MS);
    // Sized from the pane area, so the tail still reads as a flick however far
    // apart the frames land: it stops well short of the commit share on
    // distance, and only the speed it lifts at carries it to "logs".
    const flick = Math.round(ctx().containerWidth * 0.08);
    await wheelSteps(
      mainPane,
      [1, 1, 1, 0.9, 0.6, 0.34, 0.18, 0.09].map((share) => Math.round(flick * share)),
    );
    await waitFor(() => expect(ctx().activeWindowId).toBe(logs.id));
    await waitFor(() => expect(settled()).toBe(true));
  },
};

export const PinchZoomsThePaneUnderTheFingers: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          'A pinch out (ctrl+wheel, the Chromium dialect) grows the pane under the fingers toward the box it fills zoomed; lifting them zooms that pane, and the zoom carries on from where the fingers left it without stepping back toward the slot first. A pinch in on the zoomed pane shrinks the grid with the fingers, and the unzoom carries on down from there.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(ownPanes()).toHaveLength(2), { timeout: 8000 });
    const target = ownPanes().find((p) => p.tmuxId !== ctx().activePaneId)!.tmuxId;
    const pane = paneEl(target);
    const before = pane.getBoundingClientRect();

    await wheelSteps(pane, repeat(-8, 5), { ctrlKey: true });
    const lifted = pane.getBoundingClientRect();
    expect(lifted.width).toBeGreaterThan(before.width * 1.3);
    expect(zoomed()).toBe(false);

    // Done when the zoom's own morph is over, not merely when the width holds
    // still for a few frames (a transition can take a frame or two to start).
    const morphing = () => pane.style.transition !== '';
    const growth = await sampleUntil(
      () => pane.getBoundingClientRect().width,
      () => settled() && zoomed() && !morphing(),
    );
    expect(Math.min(...growth)).toBeGreaterThanOrEqual(lifted.width - 1);
    expectOneWay(growth, 1, 'zooming pane width');
    expect(pane.classList).toContain('pane-zoomed');
    expect(ctx().activePaneId).toBe(target);
    const full = pane.getBoundingClientRect();

    await wheelSteps(pane, repeat(8, 5), { ctrlKey: true });
    const pinched = pane.getBoundingClientRect();
    expect(pinched.width).toBeLessThan(full.width * 0.8);
    expect(zoomed()).toBe(true);

    const shrink = await sampleUntil(
      () => pane.getBoundingClientRect().width,
      () => settled() && !zoomed() && !morphing(),
    );
    expect(Math.max(...shrink)).toBeLessThanOrEqual(pinched.width + 1);
    expectOneWay(shrink, -1, 'unzooming pane width');
    await atRest();
  },
};

export const PinchInOpensAllTabs: Story = {
  args: { height: 500, initCommands: ['rename-window main', 'new-window'] },
  parameters: {
    docs: {
      description: {
        story:
          'A pinch in on a tab that is not zoomed, in the WebKit dialect the desktop app and Safari speak (gesturestart / gesturechange / gestureend). The grid shrinks about its centre as the fingers close; when they lift the "all tabs" view opens and the grid carries on from there into the current tab’s card.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(tabs()).toHaveLength(2), { timeout: 8000 });
    const pane = activePaneEl();
    const rest = layout().getBoundingClientRect();

    webkitGesture(pane, 'gesturestart', 1);
    for (const scale of [0.95, 0.85, 0.75, 0.65]) {
      webkitGesture(pane, 'gesturechange', scale);
      await nextFrame();
    }
    const shrunk = layout().getBoundingClientRect();
    expect(shrunk.width).toBeLessThan(rest.width * 0.7);
    expect(Math.abs(shrunk.left + shrunk.width / 2 - (rest.left + rest.width / 2))).toBeLessThan(2);
    expect(ctx().tabOverviewOpen).toBe(false);

    webkitGesture(pane, 'gestureend', 0.65);
    await waitFor(() => expect(ctx().tabOverviewOpen).toBe(true));
    const card = document.querySelector('.tab-overview-slot.is-active .tab-overview-frame')!;
    await waitFor(() => {
      const f = card.getBoundingClientRect();
      const l = layout().getBoundingClientRect();
      expect(Math.abs(l.left - f.left)).toBeLessThan(2);
      expect(Math.abs(l.width - f.width)).toBeLessThan(2);
    });
  },
};

export const PinchOutOfAllTabsEntersTheCurrentTab: Story = {
  args: { height: 500, initCommands: ['rename-window main', 'new-window', 'rename-window logs'] },
  parameters: {
    docs: {
      description: {
        story:
          'In the "all tabs" view a pinch out - wherever the fingers are, here over the other tab’s card - grows the live grid out of the current tab’s card as they spread. When they lift, the view closes on the current tab with the same grow the card click uses, carrying on from where the fingers left it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(tabs()).toHaveLength(2), { timeout: 8000 });
    const current = ctx().activeWindowId;
    const rest = layout().getBoundingClientRect();

    await userEvent.setup({ delay: 5 }).keyboard('{Control>}0{/Control}');
    await waitFor(() => expect(ctx().tabOverviewOpen).toBe(true));
    const card = document.querySelector('.tab-overview-slot.is-active .tab-overview-frame')!;
    await waitFor(() =>
      expect(
        Math.abs(layout().getBoundingClientRect().width - card.getBoundingClientRect().width),
      ).toBeLessThan(2),
    );
    const cardWidth = card.getBoundingClientRect().width;
    const other = document.querySelector('.tab-overview-slot:not(.is-active)')!;

    webkitGesture(other, 'gesturestart', 1);
    for (const scale of [1.1, 1.2, 1.3]) {
      webkitGesture(other, 'gesturechange', scale);
      await nextFrame();
    }
    const grown = layout().getBoundingClientRect().width;
    expect(grown).toBeGreaterThan(cardWidth + 20);
    expect(grown).toBeLessThan(rest.width - 20);
    expect(ctx().tabOverviewOpen).toBe(true);

    webkitGesture(other, 'gestureend', 1.3);
    const widths = await sampleUntil(
      () => layout().getBoundingClientRect().width,
      () => !ctx().tabOverviewOpen && settled(),
    );
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(grown - 1);
    expectOneWay(widths, 1, 'grid width');
    await atRest();
    expect(ctx().activeWindowId).toBe(current);
  },
};

export const TurnedOffInTheConfig: Story = {
  args: { height: 500, initCommands: ['rename-window main', 'new-window', 'split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          '`set -g @tmuxy-gesture-swipe-tabs off` (and the two pinch flags) reach the client with the appearance. Slides and pinches then draw nothing and change nothing, and the WebKit gesture events are left unclaimed for the webview.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(ownPanes()).toHaveLength(2), { timeout: 8000 });
    actor().send({
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: {
        ...APPEARANCE,
        gestureSwipeTabs: false,
        gesturePinchZoom: false,
        gesturePinchOverview: false,
      },
    });
    const tab = ctx().activeWindowId;
    const pane = activePaneEl();

    await wheelSteps(pane, repeat(-24, 16));
    expect(getComputedStyle(layout()).transform).toBe('none');
    expect(document.querySelector('.pane-swipe-neighbor')).toBeNull();
    await wheelSteps(pane, repeat(-8, 8), { ctrlKey: true });
    expect(pane.classList).not.toContain('pane-gesture-growing');
    expect(webkitGesture(pane, 'gesturestart', 1).defaultPrevented).toBe(false);
    expect(webkitGesture(pane, 'gesturechange', 0.5).defaultPrevented).toBe(false);
    expect(getComputedStyle(layout()).transform).toBe('none');
    webkitGesture(pane, 'gestureend', 0.5);

    await pause(400);
    expect(ctx().activeWindowId).toBe(tab);
    expect(zoomed()).toBe(false);
    expect(ctx().tabOverviewOpen).toBe(false);
  },
};
