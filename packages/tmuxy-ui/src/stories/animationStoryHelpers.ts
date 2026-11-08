import { expect, within, waitFor } from 'storybook/test';
import { DEFAULT_APPEARANCE } from '../domain/tmuxyConstants.gen';

export type Canvas = ReturnType<typeof within>;

export function paneNodes(canvasElement: HTMLElement): HTMLElement[] {
  return Array.from(canvasElement.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]'));
}

export function getPaneLayout(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.pane-layout');
  if (!el) throw new Error('.pane-layout not found');
  return el;
}

export async function waitForPaneCount(
  canvas: Canvas,
  count: number,
  timeout = 8000,
): Promise<void> {
  await waitFor(
    () => {
      const panes = canvas.getAllByRole('group', { name: /^Pane /i });
      expect(panes.length).toBe(count);
    },
    { timeout },
  );
}

export async function waitForAnimationsEnabled(layout: HTMLElement, timeout = 6000): Promise<void> {
  await waitFor(
    () => {
      expect(layout.classList.contains('pane-layout-no-animations')).toBe(false);
    },
    { timeout },
  );
}

/**
 * Alpha channel of a computed color, 1 when fully opaque. Chrome serializes
 * the pane surface as `color(srgb r g b / a)` once `color-mix` resolves, but
 * as `rgba(r, g, b, a)` when it does not — both forms have to parse, or an
 * unresolved surface reads as fully opaque and hides the very mismatch this
 * story exists to catch.
 */
export function alphaOf(color: string): number {
  const slash = color.match(/\/\s*([0-9.]+)\s*\)/);
  if (slash) return parseFloat(slash[1]);
  const rgba = color.match(/^rgba?\(([^)]*)\)/);
  if (rgba) {
    const parts = rgba[1].split(',').map((v) => v.trim());
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  }
  return 1;
}

/** The shipped appearance, with no macOS blur behind a story. */
export const APPEARANCE = { ...DEFAULT_APPEARANCE, blur: false };

/**
 * The commit that moves the boxes must carry the gate — that is what
 * keeps a swap from sliding through the other pane. Watch the class flip.
 * The class can be set and cleared within one task, before the observer
 * callback runs: read the old value each record carries as well.
 */
export function watchResizingGate(layout: HTMLElement): {
  wasGated: () => boolean;
  disconnect: () => void;
} {
  let gated = false;
  const classWatcher = new MutationObserver((records) => {
    if (layout.classList.contains('pane-layout-resizing')) gated = true;
    for (const r of records) {
      if ((r.oldValue ?? '').includes('pane-layout-resizing')) gated = true;
    }
  });
  classWatcher.observe(layout, {
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  });
  return {
    wasGated: () => gated,
    disconnect: () => classWatcher.disconnect(),
  };
}

export function watchLifecycleClasses(layout: HTMLElement): {
  sawLifecycle: () => boolean;
  stop: () => void;
} {
  let saw = false;
  let sampling = true;
  const sampleFrame = () => {
    if (layout.querySelector('.pane-entering, .pane-shifting, .pane-leaving')) {
      saw = true;
    }
    if (sampling) requestAnimationFrame(sampleFrame);
  };
  requestAnimationFrame(sampleFrame);
  return {
    sawLifecycle: () => saw,
    stop: () => {
      sampling = false;
    },
  };
}

/**
 * Every layout-suppression gate must still declare the cue. These fire on
 * commits the user cannot reach on demand here (float creation, new-window,
 * disconnect, drag), so assert the CSS contract each one owns.
 */
export function assertGatesDeclareFocusCue(layout: HTMLElement, canvasElement: HTMLElement): void {
  for (const gate of [
    'pane-layout-no-animations',
    'pane-layout-resizing',
    'pane-layout-dragging',
  ]) {
    layout.classList.add(gate);
    const declared = getComputedStyle(paneNodes(canvasElement)[0]).transitionProperty;
    layout.classList.remove(gate);
    expect(declared, `${gate} dropped the focus cue`).toContain('opacity');
    expect(declared, `${gate} dropped the focus cue`).toContain('background-color');
  }
}

export interface FocusCueStep {
  progress: number;
  text: number;
  surface: number;
}

export interface FocusCueRun {
  steps: FocusCueStep[];
  /** The two transitions' timing, so a story can assert they share one clock. */
  surface: { duration: number; easing: string } | null;
  text: { duration: number; easing: string } | null;
}

const timingOf = (t: CSSTransition | undefined) => {
  if (!t) return null;
  const timing = t.effect!.getTiming();
  return { duration: Number(timing.duration), easing: String(timing.easing) };
};

/**
 * Pauses the focus cue's two transitions (the surface's `background-color`,
 * the text's `opacity`) as `target` turns active, before any frame, and steps
 * them. Sampling real frames missed the fade about one run in ten: a late
 * frame sees the transition already over. A surface that hard-flips has no
 * transition to step, which the run reports.
 */
export function stepFocusCueOnElement(target: HTMLElement, points = 11): Promise<FocusCueRun> {
  const content = target.querySelector<HTMLElement>('.pane-content')!;
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!target.classList.contains('pane-active')) return;
      observer.disconnect();
      // getAnimations() flushes style, so the class change has started its
      // transitions, at their very beginning.
      const transitions = target
        .getAnimations({ subtree: true })
        .filter((a): a is CSSTransition => a instanceof CSSTransition);
      const on = (t: CSSTransition) => (t.effect as KeyframeEffect | null)?.target;
      const surfaceT = transitions.find(
        (t) => on(t) === target && t.transitionProperty === 'background-color',
      );
      const textT = transitions.find(
        (t) => on(t) === content && t.transitionProperty === 'opacity',
      );
      const stepped = [surfaceT, textT].filter((t): t is CSSTransition => !!t);
      stepped.forEach((t) => t.pause());
      const steps: FocusCueStep[] = [];
      for (let i = 0; i < points; i++) {
        const progress = i / (points - 1);
        for (const t of stepped) t.currentTime = Number(t.effect!.getTiming().duration) * progress;
        steps.push({
          progress,
          text: parseFloat(getComputedStyle(content).opacity),
          surface: alphaOf(getComputedStyle(target).backgroundColor),
        });
      }
      stepped.forEach((t) => t.finish());
      resolve({ steps, surface: timingOf(surfaceT), text: timingOf(textT) });
    });
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
  });
}
