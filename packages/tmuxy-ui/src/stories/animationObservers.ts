/**
 * For the animation stories, which assert that the mutations and CSS
 * animations driving each transition fire in the browser, not merely that the
 * end state is reached.
 */

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function paneIdOf(node: Node): string | null {
  if (!(node instanceof HTMLElement)) return null;
  return node.getAttribute('data-pane-id');
}

/** The mutations the pane-layout CSS transition animates between. */
export class LayoutMutationRecorder {
  readonly addedPaneIds = new Set<string>();
  readonly removedPaneIds = new Set<string>();
  geometryRewrites = 0;
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

/** A real `animationstart` proves the keyframe ran, not just that the node mounted. */
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
