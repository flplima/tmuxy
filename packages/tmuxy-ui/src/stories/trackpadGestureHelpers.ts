import { expect, within, waitFor } from 'storybook/test';
import type { NativeSlidePhase } from '../machines/actors/gestureActor';

export interface AppActor {
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
export const actor = () => (window as unknown as { app: AppActor }).app;
export const ctx = () => actor().getSnapshot().context;
export const tabs = () =>
  ctx()
    .windows.filter((w) => w.windowType === 'tab')
    .sort((a, b) => a.index - b.index);
export const ownPanes = () => ctx().panes.filter((p) => p.windowId === ctx().activeWindowId);
export const paneOf = (windowId: string) =>
  ctx().panes.find((p) => p.windowId === windowId)!.tmuxId;
export const zoomed = () =>
  Boolean(ctx().windows.find((w) => w.id === ctx().activeWindowId)?.zoomed);
export const settled = () => ctx().gesture === null;

export const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const layout = () => document.querySelector('.pane-container > .pane-layout') as HTMLElement;
export const paneEl = (id: string) =>
  document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`) as HTMLElement;
export const activePaneEl = () => paneEl(ctx().activePaneId!);
export const atRest = () =>
  waitFor(() => expect(getComputedStyle(layout()).transform).toBe('none'));
export const translateX = () =>
  Math.round(new DOMMatrixReadOnly(getComputedStyle(layout()).transform).m41);

export function centre(el: Element) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

/**
 * The shell's calls for a slide: `began`, one `changed` per step, then the
 * phase the fingers end on. The clock is the device's (`t`, seconds), so the
 * speed a release carries on at is set by the steps' spacing here, not by
 * how long the page took between them.
 */
export class Fingers {
  private t = performance.now() / 1000;
  constructor(private readonly everyMs = 16) {}
  private call(phase: NativeSlidePhase, dx = 0) {
    this.t += this.everyMs / 1000;
    window.tmuxyGesture?.('slide', phase, dx, 0, this.t);
  }
  down() {
    this.call('began');
  }
  /** Each step is one native event; a frame between them so the grid is drawn. */
  async move(steps: number[]) {
    for (const dx of steps) {
      this.call('changed', dx);
      await nextFrame();
    }
  }
  /** The fingers stay on the pad: no event for `ms`. */
  async rest(ms: number) {
    await pause(ms);
    this.t += ms / 1000;
  }
  async lift() {
    this.call('ended');
    await nextFrame();
  }
}
export const repeat = (step: number, n: number) => Array.from({ length: n }, () => step);

/** One pinch step per value over `el`, as ctrl+wheel (WebKitGTK's dialect). */
export async function pinchSteps(el: Element, steps: number[]) {
  for (const step of steps) {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ...centre(el),
        ctrlKey: true,
        deltaY: step,
      }),
    );
    await pause(0);
  }
  await nextFrame();
}

/** A WebKit gesture event (the macOS WKWebView) over `el`. */
export function webkitGesture(el: Element, type: string, scale: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { scale, ...centre(el) });
  el.dispatchEvent(e);
  return e;
}

/**
 * Where the cursor overlay draws the cursor: the left edge of its clip polygon
 * (the overlay element itself spans the window).
 */
export function cursorLeft(): number {
  const shape = document.querySelector<HTMLElement>('.smooth-cursor-shape');
  const m = shape?.style.clipPath.match(/polygon\(\s*(-?[\d.]+)px/);
  return m ? parseFloat(m[1]) : NaN;
}

/** `read()` once a frame until `done()` holds and the value has stopped changing (2s cap). */
export async function sampleUntil(read: () => number, done: () => boolean): Promise<number[]> {
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
export function expectOneWay(samples: number[], direction: 1 | -1, what: string) {
  const trace = samples.map((s) => Math.round(s)).join(', ');
  for (let i = 1; i < samples.length; i++) {
    expect((samples[i] - samples[i - 1]) * direction, `${what}: ${trace}`).toBeGreaterThanOrEqual(
      -1,
    );
  }
}

export const APPEARANCE = {
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

export async function ready(canvasElement: HTMLElement) {
  await within(canvasElement).findAllByRole('group', { name: /Pane/i }, { timeout: 8000 });
}

export const TWO_TABS = ['rename-window main', 'new-window', 'rename-window logs'];
