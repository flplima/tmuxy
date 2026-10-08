/**
 * The glitch detector: a MutationObserver finds unintended DOM churn (node
 * flicker — an element added and removed within a short window — and rapid
 * attribute rewrites), while a frame sampler catches pane-geometry jumps.
 * Where `animationObservers.ts` proves the *intended* mutations happened, this
 * proves no *unintended* ones did.
 *
 * One implementation serves two harnesses. Storybook play functions use the
 * `GlitchRecorder` class in-page. The Jest E2E helper
 * (`tests/helpers/glitch-detector.js`) loads this file through Node's own
 * loader — Node strips the types itself — serialises `startGlitchCollector`
 * into the page with Playwright, and runs `analyzeGlitches` on what comes
 * back. That is why the collector is self-contained and this file uses only
 * erasable TypeScript syntax (no enums, no parameter properties), and why
 * the JSON import carries its attribute.
 *
 * Budgets are code, not prose: per-operation thresholds live in
 * `glitch-thresholds.json`, so loosening one is a reviewable diff.
 *
 * Pure DOM — no Storybook / testing-library imports — usable from any play
 * function without coupling to a test runner.
 */

import OPERATION_THRESHOLDS from './glitch-thresholds.json' with { type: 'json' };

export { OPERATION_THRESHOLDS };

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
  /** Pane rects are sampled every animation frame, or on this interval (ms)
   *  when set: a background tab stops animation frames but not timers. */
  sizePollIntervalMs?: number;
}

export interface GlitchNodeEvent {
  readonly type: 'add' | 'remove';
  readonly ts: number;
  readonly element: string;
}

export interface GlitchAttrEvent {
  readonly ts: number;
  readonly attr: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly target: string;
}

export interface GlitchPaneRect {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  /** Pane carried an enter/leave/shift lifecycle class at sample time —
   * its rect motion is the deliberate split/kill morph, not a glitch. */
  readonly animating: boolean;
}

export interface GlitchFrame {
  readonly ts: number;
  readonly panes: GlitchPaneRect[];
}

/** Everything the collector saw, plain data so it survives a page boundary. */
export interface GlitchRecording {
  readonly nodes: GlitchNodeEvent[];
  readonly attrs: GlitchAttrEvent[];
  readonly frames: GlitchFrame[];
  readonly durationMs: number;
}

export interface GlitchCollector {
  /** Disconnect the observers and hand back what was recorded. */
  stop(): GlitchRecording;
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

export const GLITCH_DEFAULTS: Required<GlitchRecorderOptions> = {
  ignoreSelectors: ['.terminal-content', '.terminal-cursor', '.terminal-line'],
  attributeFilter: ['class', 'style', 'data-active', 'data-pane-id'],
  flickerWindowMs: 100,
  churnWindowMs: 200,
  sizeJumpThreshold: 20,
  sizePollIntervalMs: 0,
};

/**
 * Start observing `scope` (an element, or a selector resolved in the
 * document). Returns null when the selector matches nothing.
 *
 * SELF-CONTAINED ON PURPOSE: Playwright serialises this function's source
 * into the page, so it must not reference anything outside its own body.
 */
export function startGlitchCollector(
  scope: Element | string,
  options: Required<GlitchRecorderOptions>,
): GlitchCollector | null {
  const root = typeof scope === 'string' ? document.querySelector(scope) : scope;
  if (!root) return null;

  const elementId = (el: Element | null): string => {
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
  };

  const shouldIgnore = (node: Node): boolean => {
    if (!(node instanceof Element)) return true;
    return options.ignoreSelectors.some((sel) => {
      try {
        return node.matches(sel) || node.closest(sel) !== null;
      } catch {
        return false;
      }
    });
  };

  const startTime = performance.now();
  const nodes: GlitchNodeEvent[] = [];
  const attrs: GlitchAttrEvent[] = [];
  const frames: GlitchFrame[] = [];

  const observer = new MutationObserver((records) => {
    const ts = performance.now() - startTime;
    // Coalesce same-target-same-attribute mutations within ONE observer batch
    // (one microtask flush = at most one paint). React writes style properties
    // individually — a single geometry commit produces left/top/width/height
    // as 3-4 separate records on the same element — and counting those as
    // "rapid changes" flags a perfectly clean single-paint update as churn.
    // Only the batch's net transition (first oldValue → final live value)
    // is a user-visible change; cross-batch flapping is still fully counted.
    const attrBatch = new Map<
      string,
      { oldValue: string | null; target: string; attr: string; el: Element }
    >();
    for (const rec of records) {
      if (shouldIgnore(rec.target)) continue;
      if (rec.type === 'childList') {
        rec.addedNodes.forEach((n) => {
          if (n instanceof Element && !shouldIgnore(n)) {
            nodes.push({ type: 'add', ts, element: elementId(n) });
          }
        });
        rec.removedNodes.forEach((n) => {
          if (n instanceof Element && !shouldIgnore(n)) {
            nodes.push({ type: 'remove', ts, element: elementId(n) });
          }
        });
      } else if (rec.type === 'attributes' && rec.target instanceof Element) {
        const attr = rec.attributeName ?? '';
        const target = elementId(rec.target);
        const key = `${target} ${attr}`;
        if (!attrBatch.has(key)) {
          attrBatch.set(key, { oldValue: rec.oldValue, target, attr, el: rec.target });
        }
        // Later records for the same key keep the FIRST oldValue; the final
        // value is read live below, after the whole batch applied.
      }
    }
    for (const entry of attrBatch.values()) {
      attrs.push({
        ts,
        attr: entry.attr,
        oldValue: entry.oldValue,
        // All batch mutations have applied by observer-callback time, so the
        // live attribute IS the batch's net result.
        newValue: entry.el.getAttribute(entry.attr),
        target: entry.target,
      });
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: options.attributeFilter,
  });

  // Sample only .pane-layout-item (the geometry owner) — its inner
  // .pane-wrapper mirrors every rect change, so sampling both would count
  // each snap twice for the same pane id.
  const sample = (): void => {
    const panes = root.querySelectorAll('.pane-layout-item');
    frames.push({
      ts: performance.now() - startTime,
      panes: Array.from(panes).map((p) => {
        const r = p.getBoundingClientRect();
        return {
          id: (p as HTMLElement).dataset.paneId ?? elementId(p),
          w: Math.round(r.width),
          h: Math.round(r.height),
          animating:
            p.classList.contains('pane-entering') ||
            p.classList.contains('pane-shifting') ||
            p.classList.contains('pane-leaving'),
        };
      }),
    });
    if (frames.length > 600) frames.splice(0, frames.length - 300);
  };
  let stopped = false;
  let rafId = 0;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  if (options.sizePollIntervalMs > 0) {
    intervalId = setInterval(sample, options.sizePollIntervalMs);
  } else {
    const tick = (): void => {
      if (stopped) return;
      sample();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  return {
    stop: () => {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(rafId);
      if (intervalId !== undefined) clearInterval(intervalId);
      return { nodes, attrs, frames, durationMs: performance.now() - startTime };
    },
  };
}

/** Classify a recording: flickers, attribute churn and pane size jumps. */
export function analyzeGlitches(
  recording: GlitchRecording,
  options: Pick<
    Required<GlitchRecorderOptions>,
    'flickerWindowMs' | 'churnWindowMs' | 'sizeJumpThreshold'
  >,
): GlitchReport {
  const { flickerWindowMs, churnWindowMs, sizeJumpThreshold } = options;

  // Node flicker: the same element identity added and removed (either
  // order) within the flicker window.
  const flickers: GlitchFlicker[] = [];
  const byElement = new Map<string, GlitchNodeEvent[]>();
  for (const n of recording.nodes) {
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
  const byTarget = new Map<string, GlitchAttrEvent[]>();
  for (const a of recording.attrs) {
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
  for (let i = 1; i < recording.frames.length; i++) {
    const prev = recording.frames[i - 1];
    const curr = recording.frames[i];
    for (const pane of curr.panes) {
      const prevPane = prev.panes.find((p) => p.id === pane.id);
      if (!prevPane) continue;
      // Hide/show transitions (display:none tab switches) pass through
      // 0x0 by design — only movements between two VISIBLE states count.
      if (pane.w === 0 || pane.h === 0 || prevPane.w === 0 || prevPane.h === 0) continue;
      // Split/kill morphs animate rects on purpose — not flicker.
      if (pane.animating || prevPane.animating) continue;
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
      totalNodeMutations: recording.nodes.length,
      totalAttrMutations: recording.attrs.length,
      durationMs: recording.durationMs,
    },
  };
}

/**
 * The budget for an operation: the table's default, the operation's own row
 * when it has one, then explicit overrides. An operation the table does not
 * know gets the default.
 */
export function glitchThresholds(
  operation: string,
  overrides: Partial<GlitchThresholds> = {},
): GlitchThresholds {
  const table: Record<string, Partial<GlitchThresholds> | undefined> = OPERATION_THRESHOLDS;
  return { ...OPERATION_THRESHOLDS.default, ...table[operation], ...overrides };
}

/** The failure message when a report exceeds its budget, or null within it. */
export function describeGlitches(
  operation: string,
  report: GlitchReport,
  thresholds: GlitchThresholds,
): string | null {
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
  if (failures.length === 0) return null;
  return (
    `glitches detected during "${operation}" (${report.summary.durationMs.toFixed(0)}ms, ` +
    `${report.summary.totalNodeMutations} node / ${report.summary.totalAttrMutations} attr mutations):\n\n` +
    failures.join('\n\n')
  );
}

/** In-page recorder for Storybook play functions. */
export class GlitchRecorder {
  private readonly collector: GlitchCollector;
  private readonly opts: Required<GlitchRecorderOptions>;

  constructor(scope: Element, options: GlitchRecorderOptions = {}) {
    this.opts = { ...GLITCH_DEFAULTS, ...options };
    this.collector = startGlitchCollector(scope, this.opts)!;
  }

  /** Disconnect observers and analyze what was recorded. */
  stop(): GlitchReport {
    return analyzeGlitches(this.collector.stop(), this.opts);
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
    const failure = describeGlitches(operation, report, glitchThresholds(operation, overrides));
    if (failure) throw new Error(failure);
    return report;
  }
}
