/**
 * DOM observation helpers for the animation integration stories.
 *
 * The animation stories assert that the *mutations and CSS animations that
 * drive each transition* actually fire in the browser — not merely that the
 * post-animation end state is reached. Two complementary mechanisms:
 *
 *  - LayoutMutationRecorder — a MutationObserver over `.pane-layout` that
 *    records pane nodes being inserted / removed (split, close, optimistic
 *    rollback) and pane geometry (the inline `style` rewrite) being changed
 *    (resize, re-layout). These are the exact DOM changes the CSS layout
 *    transition animates between.
 *  - observeChildList — a MutationObserver used for float overlays portaled
 *    into `document.body`, capturing the overlay being added (open) and
 *    removed (close).
 *  - waitForCssAnimation — resolves when a real `animationstart` event fires
 *    for a matching element, proving the keyframe (float-appear / slide-in-*)
 *    was exercised, not just that the node mounted.
 *
 * Pure DOM only — no Storybook / testing-library imports — so it can be used
 * from any play function without coupling to a test runner.
 */

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function paneIdOf(node: Node): string | null {
  if (!(node instanceof HTMLElement)) return null;
  return node.getAttribute('data-pane-id');
}

/**
 * Watches a `.pane-layout` subtree and accumulates the layout mutations that
 * the pane-layout CSS transition animates: pane insert/remove and inline
 * geometry (`style`) rewrites, plus class changes on the layout root (used to
 * detect the `pane-layout-no-animations` toggle).
 */
export class LayoutMutationRecorder {
  readonly addedPaneIds = new Set<string>();
  readonly removedPaneIds = new Set<string>();
  /** Count of inline-`style` rewrites on `.pane-layout-item` elements. */
  geometryRewrites = 0;
  /** `className` snapshots captured each time the layout root's class changes. */
  readonly rootClassChanges: string[] = [];

  private readonly observer: MutationObserver;

  constructor(private readonly root: HTMLElement) {
    this.observer = new MutationObserver((records) => this.ingest(records));
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  private ingest(records: MutationRecord[]): void {
    for (const rec of records) {
      if (rec.type === 'childList') {
        rec.addedNodes.forEach((n) => {
          const id = paneIdOf(n);
          if (id) this.addedPaneIds.add(id);
        });
        rec.removedNodes.forEach((n) => {
          const id = paneIdOf(n);
          if (id) this.removedPaneIds.add(id);
        });
      } else if (rec.type === 'attributes' && rec.target instanceof HTMLElement) {
        const el = rec.target;
        if (rec.attributeName === 'style' && el.classList.contains('pane-layout-item')) {
          this.geometryRewrites += 1;
        } else if (rec.attributeName === 'class' && el === this.root) {
          this.rootClassChanges.push(el.className);
        }
      }
    }
  }

  disconnect(): void {
    this.observer.disconnect();
  }
}

export interface ChildListRecorder {
  readonly added: Element[];
  readonly removed: Element[];
  disconnect(): void;
}

/**
 * Records direct-child elements matching `selector` being added to / removed
 * from `root`. Used to watch float overlays (`.modal-overlay`) portaled into
 * `document.body`.
 */
export function observeChildList(root: HTMLElement, selector: string): ChildListRecorder {
  const added: Element[] = [];
  const removed: Element[] = [];
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      rec.addedNodes.forEach((n) => {
        if (n instanceof Element && n.matches(selector)) added.push(n);
      });
      rec.removedNodes.forEach((n) => {
        if (n instanceof Element && n.matches(selector)) removed.push(n);
      });
    }
  });
  observer.observe(root, { childList: true });
  return { added, removed, disconnect: () => observer.disconnect() };
}

/**
 * Resolves with the first `animationstart` whose target matches `selector`
 * (and, if given, whose `animationName` matches). Rejects on timeout. The
 * listener is registered in the capture phase so it sees the event even
 * though `animationstart` is dispatched at the animating element.
 */
export function waitForCssAnimation(
  selector: string,
  opts: { animationName?: string; timeout?: number } = {},
): Promise<AnimationEvent> {
  const { animationName, timeout = 4000 } = opts;
  return new Promise<AnimationEvent>((resolve, reject) => {
    const onStart = (e: Event): void => {
      const ev = e as AnimationEvent;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (!target.matches(selector) && !target.closest(selector)) return;
      if (animationName && ev.animationName !== animationName) return;
      cleanup();
      resolve(ev);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `animationstart for "${selector}"${
            animationName ? ` (${animationName})` : ''
          } did not fire within ${timeout}ms`,
        ),
      );
    }, timeout);
    function cleanup(): void {
      clearTimeout(timer);
      document.removeEventListener('animationstart', onStart, true);
    }
    document.addEventListener('animationstart', onStart, true);
  });
}

/**
 * Resolves with the first `transform` CSS *transition* that starts on an element
 * matching `selector`. The scroll-shift animation is a transform transition (not
 * a @keyframes animation), so `waitForCssAnimation` won't see it — this listens
 * for `transitionrun`/`transitionstart` instead. Rejects on timeout.
 */
export function waitForTransform(
  selector: string,
  opts: { timeout?: number } = {},
): Promise<TransitionEvent> {
  const { timeout = 4000 } = opts;
  return new Promise<TransitionEvent>((resolve, reject) => {
    const onStart = (e: Event): void => {
      const ev = e as TransitionEvent;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (!target.matches(selector) && !target.closest(selector)) return;
      if (ev.propertyName !== 'transform') return;
      cleanup();
      resolve(ev);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`transform transition for "${selector}" did not start within ${timeout}ms`));
    }, timeout);
    function cleanup(): void {
      clearTimeout(timer);
      document.removeEventListener('transitionrun', onStart, true);
      document.removeEventListener('transitionstart', onStart, true);
    }
    document.addEventListener('transitionrun', onStart, true);
    document.addEventListener('transitionstart', onStart, true);
  });
}
