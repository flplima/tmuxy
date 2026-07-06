/**
 * MutationObserver content-blink recorder for Storybook play functions.
 *
 * The three existing recorders leave a gap:
 *   - `glitchRecorder.ts` watches the pane *chrome* and deliberately IGNORES
 *     `.terminal-content` / `.terminal-line` / `.terminal-cursor`.
 *   - `contentStability.ts` (rAF) proves marker *text* stays present, but only
 *     samples `textContent.includes(marker)` — it can't see a content subtree
 *     being torn down and rebuilt if the text ends up identical.
 *   - `animationObservers.ts` proves *intended* mutations happened.
 *
 * This recorder watches the terminal *content* subtree with a MutationObserver
 * and flags the one mutation that reads as a user-visible blink: a whole content
 * container (`.pane-wrapper` / `.pane-content` / `.terminal-container` /
 * `.terminal-content`) being REMOVED for a pane that is supposed to persist —
 * i.e. React remounting the pane's terminal instead of updating it in place. A
 * remount blanks the pane for a paint and repopulates it: the "everything
 * blinked" bug.
 *
 * What it deliberately does NOT flag (all legitimate, measured against real
 * tmux): `.terminal-line` add/remove as a pane's height changes on split/resize,
 * the `.terminal-cursor` span moving with focus, and the removal of a whole
 * `.pane-layout-item` when its pane is killed. Container teardown for a SURVIVING
 * pane is the only signal.
 *
 * Pure DOM — no Storybook / testing-library imports — usable from any play
 * function.
 */

/** Selectors for the per-pane content containers whose teardown = a blink. */
const CONTENT_CONTAINER = [
  '.pane-wrapper',
  '.pane-content',
  '.terminal-container',
  '.terminal-content',
];

/**
 * Resolve the owning pane id. Prefer the node itself, but a removed node is
 * already detached by the time the (async) MutationObserver runs, so `closest`
 * finds nothing — pass the MutationRecord's `target` (the surviving parent,
 * still connected and carrying `data-pane-id`) as a fallback.
 */
function paneIdOf(el: Element, parent?: Node | null): string {
  const own =
    (el as HTMLElement).dataset?.paneId ??
    (el.closest?.('[data-pane-id]') as HTMLElement | null)?.dataset?.paneId;
  if (own) return own;
  if (parent instanceof Element) {
    return (
      (parent as HTMLElement).dataset?.paneId ??
      (parent.closest('[data-pane-id]') as HTMLElement | null)?.dataset?.paneId ??
      '?'
    );
  }
  return '?';
}

function matchesContainer(node: Node): string | null {
  if (!(node instanceof Element)) return null;
  for (const sel of CONTENT_CONTAINER) {
    if (node.matches(sel)) return sel;
  }
  return null;
}

export interface ContentTeardown {
  /** tmux id of the pane whose content container was torn down. */
  readonly paneId: string;
  /** Which container selector was removed (e.g. `.terminal-container`). */
  readonly selector: string;
  /** ms after start() at which it was removed. */
  readonly ts: number;
  /** True if a fresh container for the same pane was re-added (a remount). */
  readonly remounted: boolean;
}

export class ContentMutationRecorder {
  private readonly observer: MutationObserver;
  private readonly startTs = performance.now();
  /** Pane ids whose teardown is intentional (killed / moved away). */
  private dead = new Set<string>();
  private readonly removals: { paneId: string; selector: string; ts: number }[] = [];
  private readonly readds = new Set<string>();
  private removedNodeTotal = 0;
  private stopped = false;

  /**
   * @param scope Element whose subtree is watched — usually `.pane-layout`.
   */
  constructor(scope: Element) {
    this.observer = new MutationObserver((records) => this.ingest(records));
    this.observer.observe(scope, { childList: true, subtree: true });
  }

  private ingest(records: MutationRecord[]): void {
    const ts = performance.now() - this.startTs;
    for (const rec of records) {
      if (rec.type !== 'childList') continue;
      rec.removedNodes.forEach((n) => {
        this.removedNodeTotal += 1;
        const selector = matchesContainer(n);
        if (selector)
          this.removals.push({ paneId: paneIdOf(n as Element, rec.target), selector, ts });
      });
      rec.addedNodes.forEach((n) => {
        if (matchesContainer(n)) this.readds.add(paneIdOf(n as Element, rec.target));
      });
    }
  }

  /**
   * Mark pane ids whose content teardown is EXPECTED (e.g. just before killing a
   * pane, or moving it to another tab). Their removals won't be flagged.
   */
  expectGone(paneIds: string[]): void {
    for (const id of paneIds) this.dead.add(id);
  }

  /** Teardowns of containers belonging to panes that were meant to survive. */
  teardowns(): ContentTeardown[] {
    return this.removals
      .filter((r) => !this.dead.has(r.paneId))
      .map((r) => ({
        paneId: r.paneId,
        selector: r.selector,
        ts: Math.round(r.ts),
        remounted: this.readds.has(r.paneId),
      }));
  }

  /** Total nodes removed anywhere in scope — lets a story assert it observed churn. */
  get observedRemovals(): number {
    return this.removedNodeTotal;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.observer.disconnect();
  }

  /** Stop and throw a readable report if any surviving pane's content was torn down. */
  assertNoBlink(operation: string): void {
    this.stop();
    const teardowns = this.teardowns();
    if (teardowns.length > 0) {
      const detail = teardowns
        .map(
          (t) =>
            `${t.selector} for pane ${t.paneId} removed at ${t.ts}ms` +
            (t.remounted ? ' (remounted)' : ''),
        )
        .join('; ');
      throw new Error(`Terminal content blink during ${operation}: ${detail}`);
    }
  }
}

/** Convenience: construct + start observing in one call. */
export function startContentMutationRecorder(scope: Element): ContentMutationRecorder {
  return new ContentMutationRecorder(scope);
}
