/**
 * Trackpad gesture stories (demo engine) — the desktop app's gestures, run
 * on the web build (docs/DESKTOP.md).
 *
 * The gesture actor is opted in with `config.desktopGestures`, and the
 * stories drive it the way the shell does: a slide as calls to
 * `window.tmuxyGesture` with the phases the native side reports, a pinch as
 * ctrl+wheel (WebKitGTK) or WebKit's gesturestart / gesturechange /
 * gestureend (the macOS WKWebView). They travel the real chain: gestureActor,
 * the app machine, GestureStage and PaneLayout drawing each step, and
 * SELECT_TAB / ZOOM_PANE / TOGGLE_TAB_OVERVIEW / TAB_OVERVIEW_ACTIVATE into
 * the demo tmux when the fingers lift.
 *
 * Motion is sampled once a frame after the fingers lift, so a bounce, an
 * overshoot or a zoom that steps back before going on shows up as a sample
 * moving the wrong way.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import { SWIPE_COMMIT_SHARE, SWIPE_EDGE_LIMIT_SHARE } from '../utils/gestures';
import {
  activePaneEl,
  actor,
  APPEARANCE,
  atRest,
  ctx,
  cursorLeft,
  expectOneWay,
  Fingers,
  layout,
  nextFrame,
  ownPanes,
  paneEl,
  paneOf,
  pause,
  pinchSteps,
  ready,
  repeat,
  sampleUntil,
  settled,
  tabs,
  translateX,
  TWO_TABS,
  webkitGesture,
  zoomed,
} from './trackpadGestureHelpers';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Trackpad Gestures',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
  args: { config: { desktopGestures: true } },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

export const SlideBetweenTabs: Story = {
  args: { height: 500, initCommands: TWO_TABS },
  parameters: {
    docs: {
      description: {
        story:
          'Two fingers sliding right pull in the previous tab. While they move, the grid follows them with that tab’s real panes beside it at the same height, and the cursor rides along. Released past the mark the tab switches on the release itself, and the new tab then slides the rest of the way in on one ease-out curve, never past its place and never back. Past the first tab the grid gives with resistance and slides back, and a short slow slide slides back too. A flick short of the mark is carried the rest of the way by the speed it lifts at.',
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
    // same height, the cursor with it, and nothing has switched yet. Far
    // enough that the distance alone is past the commit share.
    const fingers = new Fingers();
    fingers.down();
    const far = ctx().containerWidth * SWIPE_COMMIT_SHARE * 1.3;
    await fingers.move(repeat(Math.ceil(far / 16), 16));
    const moved = logsPane.getBoundingClientRect();
    expect(moved.left - rest.left).toBeGreaterThan(300);
    expect(mainPane.classList).toContain('pane-swipe-neighbor');
    const incoming = mainPane.getBoundingClientRect();
    expect(Math.abs(moved.left - incoming.right)).toBeLessThan(40);
    expect(Math.abs(incoming.top - moved.top)).toBeLessThan(1);
    expect(Math.abs(incoming.height - moved.height)).toBeLessThan(1);
    expect(cursorLeft() - cursorStart).toBeGreaterThan((moved.left - rest.left) * 0.7);
    expect(ctx().activeWindowId).toBe(logs.id);

    // They lift: the tab switches at once — the keyboard and the strip do not
    // wait for any animation — and only then does "main" slide the rest of
    // the way in, one way only.
    await fingers.lift();
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
    // slides straight back.
    const edge = new Fingers();
    edge.down();
    await edge.move(repeat(24, 16));
    const give = mainPane.getBoundingClientRect().left - rest.left;
    expect(give).toBeGreaterThan(60);
    expect(give).toBeLessThan(rest.width * SWIPE_EDGE_LIMIT_SHARE);
    expect(document.querySelector('.pane-swipe-neighbor')).toBeNull();
    await edge.lift();
    const back = await sampleUntil(() => mainPane.getBoundingClientRect().left, settled);
    expectOneWay(back, -1, 'slide back');
    expect(Math.min(...back)).toBeGreaterThanOrEqual(rest.left - 1);
    expect(ctx().activeWindowId).toBe(main.id);

    // A short, slow slide toward "logs" follows the fingers, then slides back.
    const short = new Fingers(80);
    short.down();
    await short.move(repeat(-4, 5));
    expect(mainPane.getBoundingClientRect().left).toBeLessThan(rest.left - 10);
    await short.lift();
    await sampleUntil(() => mainPane.getBoundingClientRect().left, settled);
    expect(ctx().activeWindowId).toBe(main.id);

    // A flick that lifts short of the mark: the speed it lifts at carries it
    // to "logs".
    const flick = new Fingers(8);
    flick.down();
    await flick.move(repeat(-Math.round(ctx().containerWidth * 0.04), 8));
    await flick.lift();
    await waitFor(() => expect(ctx().activeWindowId).toBe(logs.id));
    await waitFor(() => expect(settled()).toBe(true));
  },
};

export const FingersRestingMidSlide: Story = {
  args: { height: 500, initCommands: TWO_TABS },
  parameters: {
    docs: {
      description: {
        story:
          'The fingers stop on the pad half way, to look, and go on. The shell sends nothing while they rest and the slide does not end: the grid stays exactly where they left it — for 400ms here, for as long as they like in fact — and the steps after the pause are the same slide, which switches tabs when they lift. This is the case a web page cannot have, and the reason the gesture is the desktop’s.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(tabs()).toHaveLength(2), { timeout: 8000 });
    const [main, logs] = tabs();
    await waitFor(() => expect(ctx().activeWindowId).toBe(logs.id));

    const step = Math.ceil((ctx().containerWidth * SWIPE_COMMIT_SHARE * 1.3) / 14);
    const fingers = new Fingers(40);
    fingers.down();
    await fingers.move(repeat(step, 6));
    const held = translateX();
    expect(held).toBeGreaterThan(0);
    await fingers.rest(400);
    expect(translateX(), 'the grid moved while the fingers were still').toBe(held);
    expect(ctx().activeWindowId).toBe(logs.id);
    await fingers.move(repeat(step, 8));
    expect(translateX()).toBeGreaterThan(held);
    await fingers.lift();
    await waitFor(() => expect(ctx().activeWindowId).toBe(main.id), { timeout: 4000 });
    await waitFor(() => expect(settled()).toBe(true));
    await atRest();
  },
};

export const PinchZoomsThePaneUnderTheFingers: Story = {
  tags: ['nightly'],
  args: { height: 500, initCommands: ['split-window -h'] },
  parameters: {
    docs: {
      description: {
        story:
          'A pinch out (ctrl+wheel, the WebKitGTK dialect) grows the pane under the fingers toward the box it fills zoomed; lifting them zooms that pane, and the zoom carries on from where the fingers left it without stepping back toward the slot first. A pinch in on the zoomed pane shrinks the grid with the fingers, and the unzoom carries on down from there.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await ready(canvasElement);
    await waitFor(() => expect(ownPanes()).toHaveLength(2), { timeout: 8000 });
    const target = ownPanes().find((p) => p.tmuxId !== ctx().activePaneId)!.tmuxId;
    const pane = paneEl(target);
    const before = pane.getBoundingClientRect();

    await pinchSteps(pane, repeat(-8, 5));
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

    await pinchSteps(pane, repeat(8, 5));
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
          'A pinch in on a tab that is not zoomed, in the dialect the macOS WKWebView speaks (gesturestart / gesturechange / gestureend). The grid shrinks about its centre as the fingers close; when they lift the "all tabs" view opens and the grid carries on from there into the current tab’s card.',
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
  tags: ['nightly'],
  args: { height: 500, initCommands: TWO_TABS },
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
          '`set -g @tmuxy-gesture-swipe-tabs off` (and the two pinch flags) reach the client with the appearance. A slide the shell reports and a pinch then draw nothing and change nothing, and the WebKit gesture events are left unclaimed for the webview.',
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

    const fingers = new Fingers();
    fingers.down();
    await fingers.move(repeat(24, 16));
    expect(getComputedStyle(layout()).transform).toBe('none');
    expect(document.querySelector('.pane-swipe-neighbor')).toBeNull();
    await fingers.lift();
    await pinchSteps(pane, repeat(-8, 8));
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
