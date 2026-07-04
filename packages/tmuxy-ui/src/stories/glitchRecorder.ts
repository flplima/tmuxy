/**
 * In-page glitch recorder for Storybook play functions.
 *
 * The browser-native counterpart of `tests/helpers/glitch-detector.js` (the
 * Playwright/Jest harness): a MutationObserver detects unintended DOM churn
 * (node flicker — an element added and removed within a short window — and
 * rapid attribute rewrites), while a rAF sampler catches pane-geometry jumps.
 * Where `animationObservers.ts` proves the *intended* mutations happened,
 * this recorder proves no *unintended* ones did.
 *
 * Budgets are code, not prose: per-operation thresholds live in
 * `glitch-thresholds.json`, shared with the Jest helper, so loosening one is
 * a reviewable diff.
 *
 * Pure DOM — no Storybook / testing-library imports — usable from any play
 * function without coupling to a test runner.
 */

import OPERATION_THRESHOLDS from './glitch-thresholds.json';

export type GlitchOperation = keyof typeof OPERATION_THRESHOLDS;

export interface GlitchThresholds {
  readonly nodeFlickers: number;
  readonly attrChurnEvents: number;
  readonly sizeJumps: number;
}

export interface GlitchRecorderOptions {
  /** Selectors whose subtrees are expected to mutate constantly (terminal
   *  output, cursor blink) and are excluded from analysis. */
  ignoreSelectors?: string[];
  /** Attributes tracked for churn detection. */
  attributeFilter?: string[];
  /** Window (ms) for an add→remove / remove→add pair to count as flicker. */
  flickerWindowMs?: number;
  /** Window (ms) for repeated same-attribute rewrites to count as churn. */
  churnWindowMs?: number;
  /** Minimum per-frame pane size delta (px) to count as a jump. */
  sizeJumpThreshold?: number;
}

interface NodeEvent {
  readonly type: 'add' | 'remove';
  readonly ts: number;
  readonly element: string;
}

interface AttrEvent {
  readonly ts: number;
  readonly attr: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly target: string;
}

interface PaneRect {
  readonly id: string;
  readonly w: number;
  readonly h: number;
}

export interface GlitchFlicker {
  readonly element: string;
  readonly sequence: ReadonlyArray<'add' | 'remove'>;
  readonly windowMs: number;
}

export interface GlitchChurn {
  readonly target: string;
  readonly changeCount: number;
  readonly rapidChanges: number;
}

export interface GlitchJump {
  readonly paneId: string;
  readonly ts: number;
  readonly from: { w: number; h: number };
  readonly to: { w: number; h: number };
}

export interface GlitchReport {
  readonly flickers: ReadonlyArray<GlitchFlicker>;
  readonly churn: ReadonlyArray<GlitchChurn>;
  readonly jumps: ReadonlyArray<GlitchJump>;
  readonly summary: {
    readonly nodeFlickers: number;
    readonly attrChurnEvents: number;
    readonly sizeJumps: number;
    readonly totalNodeMutations: number;
    readonly totalAttrMutations: number;
    readonly durationMs: number;
  };
}

const DEFAULTS: Required<GlitchRecorderOptions> = {
  ignoreSelectors: ['.terminal-content', '.terminal-cursor', '.terminal-line'],
  attributeFilter: ['class', 'style', 'data-active', 'data-pane-id'],
  flickerWindowMs: 100,
  churnWindowMs: 200,
  sizeJumpThreshold: 20,
};

function elementId(el: Element | null): string {
  if (!el) return 'null';
  const tag = el.tagName.toLowerCase();
  const classes =
    typeof el.className === 'string'
      ? el.className.split(' ').filter(Boolean).slice(0, 3).join('.')
      : '';
  const paneId =
    (el as HTMLElement).dataset?.paneId ??
    (el.closest('[data-pane-id]') as HTMLElement | null)?.dataset?.paneId ??
    '';
  return `${tag}${classes ? '.' + classes : ''}${paneId ? `[pane=${paneId}]` : ''}`;
}

export class GlitchRecorder {
  private readonly scope: Element;
  private readonly opts: Required<GlitchRecorderOptions>;
  private readonly observer: MutationObserver;
  private readonly nodes: NodeEvent[] = [];
  private readonly attrs: AttrEvent[] = [];
  private readonly frames: Array<{ ts: number; panes: PaneRect[] }> = [];
  private readonly startTime = performance.now();
  private rafId = 0;
  private stopped = false;

  constructor(scope: Element, options: GlitchRecorderOptions = {}) {
    this.scope = scope;
    this.opts = { ...DEFAULTS, ...options };
    this.observer = new MutationObserver((records) => this.ingest(records));
    this.observer.observe(scope, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: this.opts.attributeFilter,
    });
    const sample = (): void => {
      if (this.stopped) return;
      const panes = this.scope.querySelectorAll('.pane-layout-item');
      this.frames.push({
        ts: performance.now() - this.startTime,
        panes: Array.from(panes).map((p) => {
          const r = p.getBoundingClientRect();
          return {
            id: (p as HTMLElement).dataset.paneId ?? elementId(p),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        }),
      });
      if (this.frames.length > 600) this.frames.splice(0, this.frames.length - 300);
      this.rafId = requestAnimationFrame(sample);
    };
    this.rafId = requestAnimationFrame(sample);
  }

  private shouldIgnore(node: Node): boolean {
    if (!(node instanceof Element)) return true;
    return this.opts.ignoreSelectors.some((sel) => {
      try {
        return node.matches(sel) || node.closest(sel) !== null;
      } catch {
        return false;
      }
    });
  }

  private ingest(records: MutationRecord[]): void {
    const ts = performance.now() - this.startTime;
    for (const rec of records) {
      if (this.shouldIgnore(rec.target)) continue;
      if (rec.type === 'childList') {
        rec.addedNodes.forEach((n) => {
          if (n instanceof Element && !this.shouldIgnore(n)) {
            this.nodes.push({ type: 'add', ts, element: elementId(n) });
          }
        });
        rec.removedNodes.forEach((n) => {
          if (n instanceof Element && !this.shouldIgnore(n)) {
            this.nodes.push({ type: 'remove', ts, element: elementId(n) });
          }
        });
      } else if (rec.type === 'attributes' && rec.target instanceof Element) {
        this.attrs.push({
          ts,
          attr: rec.attributeName ?? '',
          oldValue: rec.oldValue,
          newValue: rec.target.getAttribute(rec.attributeName ?? ''),
          target: elementId(rec.target),
        });
      }
    }
  }

  /** Disconnect observers and analyze what was recorded. */
  stop(): GlitchReport {
    this.stopped = true;
    this.observer.disconnect();
    cancelAnimationFrame(this.rafId);

    const { flickerWindowMs, churnWindowMs, sizeJumpThreshold } = this.opts;

    // Node flicker: the same element identity added and removed (either
    // order) within the flicker window.
    const flickers: GlitchFlicker[] = [];
    const byElement = new Map<string, NodeEvent[]>();
    for (const n of this.nodes) {
      const list = byElement.get(n.element) ?? [];
      list.push(n);
      byElement.set(n.element, list);
    }
    for (const [element, events] of byElement) {
      for (let i = 0; i < events.length - 1; i++) {
        const curr = events[i];
        const next = events[i + 1];
        if (curr.type !== next.type && next.ts - curr.ts < flickerWindowMs) {
          flickers.push({
            element,
            sequence: [curr.type, next.type],
            windowMs: next.ts - curr.ts,
          });
        }
      }
    }

    // Attribute churn: the same attribute on the same element rewritten more
    // than twice in rapid succession.
    const churn: GlitchChurn[] = [];
    const byTarget = new Map<string, AttrEvent[]>();
    for (const a of this.attrs) {
      const key = `${a.target}:${a.attr}`;
      const list = byTarget.get(key) ?? [];
      list.push(a);
      byTarget.set(key, list);
    }
    for (const [target, events] of byTarget) {
      let rapid = 0;
      for (let i = 1; i < events.length; i++) {
        if (events[i].ts - events[i - 1].ts < churnWindowMs) rapid++;
      }
      if (rapid > 2) {
        churn.push({ target, changeCount: events.length, rapidChanges: rapid });
      }
    }

    // Size jumps: a pane's rect changing by more than the threshold between
    // two consecutive sampled frames.
    const jumps: GlitchJump[] = [];
    for (let i = 1; i < this.frames.length; i++) {
      const prev = this.frames[i - 1];
      const curr = this.frames[i];
      for (const pane of curr.panes) {
        const prevPane = prev.panes.find((p) => p.id === pane.id);
        if (!prevPane) continue;
        // Hide/show transitions (display:none tab switches) pass through
        // 0x0 by design — only movements between two VISIBLE states count.
        if (pane.w === 0 || pane.h === 0 || prevPane.w === 0 || prevPane.h === 0) continue;
        const dw = Math.abs(pane.w - prevPane.w);
        const dh = Math.abs(pane.h - prevPane.h);
        if (dw > sizeJumpThreshold || dh > sizeJumpThreshold) {
          jumps.push({
            paneId: pane.id,
            ts: curr.ts,
            from: { w: prevPane.w, h: prevPane.h },
            to: { w: pane.w, h: pane.h },
          });
        }
      }
    }

    return {
      flickers,
      churn,
      jumps,
      summary: {
        nodeFlickers: flickers.length,
        attrChurnEvents: churn.length,
        sizeJumps: jumps.length,
        totalNodeMutations: this.nodes.length,
        totalAttrMutations: this.attrs.length,
        durationMs: performance.now() - this.startTime,
      },
    };
  }

  /**
   * Stop and throw if the recording exceeds the operation's budget from
   * `glitch-thresholds.json` (plus any explicit overrides). Returns the
   * report when within budget.
   */
  assertNoGlitches(
    operation: GlitchOperation = 'default',
    overrides: Partial<GlitchThresholds> = {},
  ): GlitchReport {
    const report = this.stop();
    const thresholds: GlitchThresholds = {
      ...OPERATION_THRESHOLDS.default,
      ...OPERATION_THRESHOLDS[operation],
      ...overrides,
    };

    const failures: string[] = [];
    if (report.summary.nodeFlickers > thresholds.nodeFlickers) {
      failures.push(
        `node flickers: ${report.summary.nodeFlickers} (max ${thresholds.nodeFlickers})\n` +
          report.flickers
            .map((f) => `  - ${f.element}: ${f.sequence.join('→')} in ${f.windowMs.toFixed(1)}ms`)
            .join('\n'),
      );
    }
    if (report.summary.attrChurnEvents > thresholds.attrChurnEvents) {
      failures.push(
        `attribute churn: ${report.summary.attrChurnEvents} (max ${thresholds.attrChurnEvents})\n` +
          report.churn
            .map((c) => `  - ${c.target}: ${c.changeCount} changes (${c.rapidChanges} rapid)`)
            .join('\n'),
      );
    }
    if (report.summary.sizeJumps > thresholds.sizeJumps) {
      failures.push(
        `size jumps: ${report.summary.sizeJumps} (max ${thresholds.sizeJumps})\n` +
          report.jumps
            .slice(0, 10)
            .map(
              (j) =>
                `  - ${j.paneId} at ${j.ts.toFixed(0)}ms: ${j.from.w}x${j.from.h} → ${j.to.w}x${j.to.h}`,
            )
            .join('\n'),
      );
    }
    if (failures.length > 0) {
      throw new Error(
        `glitches detected during "${operation}" (${report.summary.durationMs.toFixed(0)}ms, ` +
          `${report.summary.totalNodeMutations} node / ${report.summary.totalAttrMutations} attr mutations):\n\n` +
          failures.join('\n\n'),
      );
    }
    return report;
  }
}

/** Convenience: construct + start in one call. */
export function startGlitchRecorder(
  scope: Element,
  options: GlitchRecorderOptions = {},
): GlitchRecorder {
  return new GlitchRecorder(scope, options);
}
