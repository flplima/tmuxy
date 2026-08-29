/**
 * ResizeGlitchRecorder — catches the two pane-resize glitches that a plain
 * size-jump recorder misses:
 *
 *   A. During a *monotonic* drag, a pane's `top`/`height` reverses direction —
 *      e.g. the whole grid shifts up then back down by a row (the centering
 *      offset re-rounding mid-resize). On a monotonic drag the geometry must be
 *      monotonic too; any A→B→A bounce is the glitch.
 *
 *   B. After mouse-up, a pane's size briefly reverts to an EARLIER value before
 *      settling on the new one — the optimistic preview cleared by a stale
 *      server snapshot. Also an A→B→A bounce, in the post-release phase.
 *
 * Both are value *reversals*, invisible to a threshold-on-consecutive-frames
 * detector but obvious in the full ordered value sequence. We capture that
 * sequence two ways and merge them:
 *   - a MutationObserver on each `.pane-layout-item` inline `style` (with
 *     attributeOldValue) — catches every React commit, including a 1-frame
 *     revert that never gets its own paint;
 *   - a requestAnimationFrame sampler of `getBoundingClientRect` — catches
 *     painted motion even if it came from CSS/transform rather than an inline
 *     style write.
 *
 * A "bounce" is an index i in the de-duplicated value sequence where
 * value[i] === value[i-2] && value[i] !== value[i-1] — the value left and came
 * back. Sub-pixel noise is filtered by rounding and a per-dimension minimum
 * amplitude (default ~half a cell), so only real ≥~1-cell reversals count.
 */

const STYLE_DIMS = ['top', 'left', 'width', 'height'] as const;
// `contentTop` is the top of the pane's terminal content ([role=log]); it moves
// when the header row appears/disappears, which the outer box (top/height)
// hides. Sampled via rAF only — it isn't an inline style on the pane element.
const RAF_DIMS = [...STYLE_DIMS, 'contentTop'] as const;
type Dim = (typeof RAF_DIMS)[number];

export interface ResizeBounce {
  paneId: string;
  dim: Dim;
  /** The three de-duplicated values that form the A→B→A reversal. */
  values: [number, number, number];
  /** ms since recorder start when the reversal completed. */
  ts: number;
  /** true if it happened after the named mark (e.g. 'mouseup'). */
  afterMark: boolean;
  source: 'style' | 'raf';
}

export interface ResizeGlitchReport {
  bounces: ResizeBounce[];
  duringDrag: ResizeBounce[];
  afterRelease: ResizeBounce[];
  samples: number;
}

interface Sample {
  ts: number;
  values: Partial<Record<Dim, number>>;
  source: 'style' | 'raf';
}

export interface ResizeGlitchOptions {
  /** Minimum |Δ| for a bounce to count, per dimension, in px. */
  minAmplitude?: Partial<Record<Dim, number>>;
}

const DEFAULT_MIN: Record<Dim, number> = {
  // ~half a 24px row / ~half a ~9px column: filters sub-pixel jitter, catches
  // any real 1-cell reversal.
  top: 10,
  height: 10,
  left: 4,
  width: 4,
  contentTop: 10,
};

function parseStyleDims(style: string | null): Partial<Record<Dim, number>> {
  const out: Partial<Record<Dim, number>> = {};
  if (!style) return out;
  for (const dim of STYLE_DIMS) {
    // Property-name-anchored so `transform: translate3d(0px,...)` isn't matched.
    const m = new RegExp(`(?:^|;)\\s*${dim}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(style);
    if (m) out[dim] = Math.round(parseFloat(m[1]));
  }
  return out;
}

export class ResizeGlitchRecorder {
  private readonly scope: Element;
  private readonly opts: Record<Dim, number>;
  private readonly observer: MutationObserver;
  private readonly startTime = performance.now();
  private readonly marks = new Map<string, number>();
  /** paneId -> ordered samples (style + raf interleaved by ts). */
  private readonly byPane = new Map<string, Sample[]>();
  private rafId = 0;
  private stopped = false;

  constructor(scope: Element, options: ResizeGlitchOptions = {}) {
    this.scope = scope;
    this.opts = { ...DEFAULT_MIN, ...options.minAmplitude };

    // Seed with the current geometry so the very first change is comparable.
    this.sampleRaf();

    this.observer = new MutationObserver((records) => {
      const ts = performance.now() - this.startTime;
      for (const rec of records) {
        if (rec.type !== 'attributes' || rec.attributeName !== 'style') continue;
        const el = rec.target as HTMLElement;
        if (!el.classList?.contains('pane-layout-item')) continue;
        const id = el.dataset.paneId;
        if (!id) continue;
        // The batch already applied by callback time, so the live style IS the
        // net value; oldValue gives the pre-batch value (a 1-frame revert shows
        // as old != live across two batches).
        this.push(id, { ts, values: parseStyleDims(el.getAttribute('style')), source: 'style' });
      }
    });
    this.observer.observe(scope, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['style'],
    });

    const loop = (): void => {
      if (this.stopped) return;
      this.sampleRaf();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Timestamp a phase boundary (e.g. mark('mouseup') right before dispatch). */
  mark(label: string): void {
    this.marks.set(label, performance.now() - this.startTime);
  }

  private sampleRaf(): void {
    const ts = performance.now() - this.startTime;
    this.scope.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]').forEach((el) => {
      const id = el.dataset.paneId!;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // hidden/transitional
      const log = el.querySelector('[role="log"]');
      const values: Partial<Record<Dim, number>> = {
        top: Math.round(r.top),
        left: Math.round(r.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      if (log) values.contentTop = Math.round(log.getBoundingClientRect().top);
      this.push(id, { ts, values, source: 'raf' });
    });
  }

  private push(id: string, s: Sample): void {
    const list = this.byPane.get(id) ?? [];
    list.push(s);
    if (list.length > 4000) list.splice(0, list.length - 2000);
    this.byPane.set(id, list);
  }

  stop(): ResizeGlitchReport {
    this.stopped = true;
    this.observer.disconnect();
    cancelAnimationFrame(this.rafId);
    // One final read so a settle after the last rAF is included.
    this.sampleRaf();

    const mark = this.marks.get('mouseup') ?? Infinity;
    const bounces: ResizeBounce[] = [];

    for (const [paneId, samples] of this.byPane) {
      for (const dim of RAF_DIMS) {
        for (const source of ['style', 'raf'] as const) {
          const seq = samples
            .filter((s) => s.source === source && s.values[dim] !== undefined)
            .map((s) => ({ v: s.values[dim]!, ts: s.ts }));
          // De-duplicate consecutive equal values.
          const dedup: Array<{ v: number; ts: number }> = [];
          for (const p of seq) {
            if (dedup.length === 0 || dedup[dedup.length - 1].v !== p.v) dedup.push(p);
          }
          const minAmp = this.opts[dim];
          for (let i = 2; i < dedup.length; i++) {
            const a = dedup[i - 2].v;
            const b = dedup[i - 1].v;
            const c = dedup[i].v;
            // A→B→A reversal, with both legs above the noise floor.
            if (c === a && Math.abs(b - a) >= minAmp) {
              bounces.push({
                paneId,
                dim,
                values: [a, b, c],
                ts: dedup[i].ts,
                afterMark: dedup[i].ts >= mark,
                source,
              });
            }
          }
        }
      }
    }

    // Dedupe style/raf reports of the same reversal (same pane/dim/values within
    // a frame) — keep the earliest.
    bounces.sort((x, y) => x.ts - y.ts);
    const seen = new Set<string>();
    const unique = bounces.filter((b) => {
      const key = `${b.paneId}:${b.dim}:${b.values.join(',')}:${Math.round(b.ts / 32)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      bounces: unique,
      duringDrag: unique.filter((b) => !b.afterMark),
      afterRelease: unique.filter((b) => b.afterMark),
      samples: [...this.byPane.values()].reduce((n, l) => n + l.length, 0),
    };
  }

  /** Stop and throw if any reversal was recorded. */
  assertNoBounces(): ResizeGlitchReport {
    const report = this.stop();
    if (report.bounces.length > 0) {
      const detail = report.bounces
        .slice(0, 8)
        .map(
          (b) =>
            `${b.paneId} ${b.dim} ${b.values[0]}→${b.values[1]}→${b.values[2]} ` +
            `@${Math.round(b.ts)}ms ${b.afterMark ? '(after release)' : '(during drag)'} [${b.source}]`,
        )
        .join('\n  ');
      throw new Error(
        `resize glitch: ${report.bounces.length} geometry reversal(s) ` +
          `(${report.duringDrag.length} during drag, ${report.afterRelease.length} after release):\n  ${detail}`,
      );
    }
    return report;
  }
}
