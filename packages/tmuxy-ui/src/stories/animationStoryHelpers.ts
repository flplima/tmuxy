import { expect, within, waitFor } from 'storybook/test';

export interface AppActor {
  send: (event: unknown) => void;
  getSnapshot: () => {
    context: {
      activePaneId: string | null;
      enableAnimations: boolean;
      floatPanes: Record<string, { paneId: string }>;
    };
  };
}

export function getApp(): AppActor {
  const app = (window as unknown as { app?: AppActor }).app;
  if (!app) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return app;
}

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

/** Resolve once the app has settled and re-enabled layout animations. */
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

export const APPEARANCE = {
  opacity: 0.7,
  activePaneOpacity: 1,
  inactivePaneOpacity: 0.7,
  activeTextOpacity: 1,
  inactiveTextOpacity: 0.7,
  blur: false,
};

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

/** Sample every rAF frame to check whether any lifecycle classes appear on `layout`. */
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

/**
 * Sample ONE pinned element every frame — the pane about to gain focus —
 * never `active()`. Following the active pane means hopping to a different
 * node at the moment the class moves, so a frame lands on the outgoing
 * pane's text and the incoming pane's surface and they legitimately differ.
 */
export function sampleFocusCueOnElement(target: HTMLElement): {
  samples: { text: number; surface: number }[];
  stop: () => void;
} {
  const samples: { text: number; surface: number }[] = [];
  let sampling = true;
  const wrapper = target.firstElementChild as HTMLElement;
  const sampleFrame = () => {
    samples.push({
      text: parseFloat(getComputedStyle(wrapper).opacity),
      surface: alphaOf(getComputedStyle(target).backgroundColor),
    });
    if (sampling) requestAnimationFrame(sampleFrame);
  };
  requestAnimationFrame(sampleFrame);
  return {
    samples,
    stop: () => {
      sampling = false;
    },
  };
}
