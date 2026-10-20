import { expect, waitFor } from 'storybook/test';

export interface Snap {
  context: {
    activeWindowId: string | null;
  };
}

export function tabButton(canvasElement: HTMLElement, name: string): HTMLElement {
  const el = [...canvasElement.querySelectorAll<HTMLElement>('.tab-name[data-window-id]')].find(
    (t) => t.textContent?.includes(name),
  );
  if (!el) throw new Error(`no tab button for ${name}`);
  return el;
}

/** The preview card, wherever it has been portalled to. */
export function preview(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="tab-preview"]');
}

export async function waitForPreview(windowId?: string): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = preview();
      expect(el, 'no preview card').not.toBeNull();
      if (windowId) expect(el!.dataset.windowId).toBe(windowId);
      return el!;
    },
    { timeout: 5000 },
  );
}

/**
 * The declared CSS animations on `el` by name, after a style flush. A
 * finished animation with no fill drops out of `getAnimations()`, so this
 * has to be read while the animation is current — which is why the card
 * is caught at insertion and at the class change, not on a later poll.
 */
export const animationNames = (el: HTMLElement) => {
  void getComputedStyle(el).opacity;
  return el.getAnimations().map((a) => (a as CSSAnimation).animationName);
};

/** The animation named `name` on `el`, which must be running and real. */
export const runningAnimation = (el: HTMLElement, name: string) => {
  const animation = el.getAnimations().find((a) => (a as CSSAnimation).animationName === name);
  expect(animation, `no running ${name} animation on the card`).toBeDefined();
  expect(animation!.playState).toBe('running');
  expect(animation!.effect!.getTiming().duration).toBeGreaterThan(0);
  return animation!;
};

/**
 * Catch the preview card the moment it enters the DOM, by mutation rather than
 * by polling, so a busy runner that paints the card only after its 150ms
 * entrance has finished still sees it.
 */
export function waitForPreviewInserted(): Promise<HTMLElement> {
  return new Promise<HTMLElement>((resolve) => {
    const seen = preview();
    if (seen) return resolve(seen);
    const observer = new MutationObserver(() => {
      const el = preview();
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** Catch `card` as soon as it receives `.is-leaving`. */
export function waitForCardLeaving(card: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (card.classList.contains('is-leaving')) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(card, { attributes: true, attributeFilter: ['class'] });
  });
}
