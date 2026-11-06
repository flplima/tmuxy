/**
 * Flags a content container torn down for a pane that survives: React
 * remounting the pane's terminal instead of updating it, which blanks the
 * pane for a paint. `glitchRecorder.ts` ignores the terminal content, and
 * `contentStability.ts` cannot see a subtree rebuilt with identical text.
 * Lines added and removed on a resize, the cursor moving with focus, and a
 * killed pane's removal are legitimate and not flagged.
 */

const CONTENT_CONTAINER = [
  '.pane-wrapper',
  '.pane-content',
  '.terminal-container',
  '.terminal-content',
];

/**
 * A removed node is already detached when the MutationObserver runs, so
 * `closest` finds nothing on it: the record's `target`, the surviving parent,
 * is the fallback.
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
  readonly paneId: string;
  readonly selector: string;
  /** ms since the recorder started. */
  readonly ts: number;
  readonly remounted: boolean;
}

export class ContentMutationRecorder {
  private readonly observer: MutationObserver;
  private readonly startTs = performance.now();
  private dead = new Set<string>();
  private readonly removals: { paneId: string; selector: string; ts: number }[] = [];
  private readonly readds = new Set<string>();
  private removedNodeTotal = 0;
  private stopped = false;

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

  /** Panes about to be killed or moved to another tab. */
  expectGone(paneIds: string[]): void {
    for (const id of paneIds) this.dead.add(id);
  }

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

  /** Lets a story assert it observed churn at all. */
  get observedRemovals(): number {
    return this.removedNodeTotal;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.observer.disconnect();
  }

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
