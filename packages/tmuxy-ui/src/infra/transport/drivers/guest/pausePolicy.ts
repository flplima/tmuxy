/**
 * When a guest nobody looks at stops: its machine is paused while the
 * element showing it is out of view or the page's tab is hidden, and runs
 * again the moment either ends.
 *
 * The page counts as looking when the tab is visible and either a tenth of
 * the element is in view, or any of it is and focus is inside it (a person
 * typing into a half-scrolled demo is not idle). Pausing waits out a grace
 * period, so scrolling past does not stop and start the machine, and retries
 * while the engine refuses (a reply is still awaited).
 */

/** How long the guest keeps running after nobody looks at it. */
export const PAUSE_GRACE_MS = 2000;
/** How often a refused pause is asked again. */
export const PAUSE_RETRY_MS = 250;
/** The share of the element in view that counts as looked at. */
export const IN_VIEW_RATIO = 0.1;

export interface Pausable {
  pause(): boolean;
  resume(): void;
}

export class PausePolicy {
  private observer: IntersectionObserver | null = null;
  private element: Element | null = null;
  private ratio = 1;
  private focused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: Pausable,
    private readonly target: () => Element | null,
  ) {}

  start(): void {
    const element = this.target();
    if (!element || this.observer) return;
    this.element = element;
    this.observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) this.ratio = latest.intersectionRatio;
        this.evaluate();
      },
      { threshold: [0, IN_VIEW_RATIO] },
    );
    this.observer.observe(element);
    document.addEventListener('visibilitychange', this.evaluate);
    element.addEventListener('focusin', this.onFocusIn);
    element.addEventListener('focusout', this.onFocusOut as EventListener);
    this.focused = element.contains(document.activeElement);
    this.evaluate();
  }

  stop(): void {
    if (!this.observer || !this.element) return;
    this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.evaluate);
    this.element.removeEventListener('focusin', this.onFocusIn);
    this.element.removeEventListener('focusout', this.onFocusOut as EventListener);
    this.clearTimer();
    this.observer = null;
    this.element = null;
    this.engine.resume();
  }

  private readonly onFocusIn = () => {
    this.focused = true;
    this.evaluate();
  };

  private readonly onFocusOut = (event: FocusEvent) => {
    this.focused =
      event.relatedTarget instanceof Node && !!this.element?.contains(event.relatedTarget);
    this.evaluate();
  };

  private looked(): boolean {
    if (document.visibilityState === 'hidden') return false;
    return this.ratio >= IN_VIEW_RATIO || (this.ratio > 0 && this.focused);
  }

  private readonly evaluate = () => {
    if (this.looked()) {
      this.clearTimer();
      this.engine.resume();
    } else if (this.timer === null) {
      this.timer = setTimeout(this.tryPause, PAUSE_GRACE_MS);
    }
  };

  private readonly tryPause = () => {
    this.timer = null;
    if (this.looked()) return;
    if (!this.engine.pause()) this.timer = setTimeout(this.tryPause, PAUSE_RETRY_MS);
  };

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
