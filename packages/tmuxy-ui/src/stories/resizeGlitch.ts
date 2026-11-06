/**
 * Catches the two pane-resize glitches a size-jump recorder misses, both
 * A→B→A value reversals:
 *
 *   A. During a monotonic drag, a pane's `top`/`height` reverses direction
 *      (the grid shifts up and back down a row as the centering offset
 *      re-rounds mid-resize).
 *   B. After mouse-up, a pane's size briefly reverts to an earlier value
 *      before settling: the optimistic preview cleared by a stale server
 *      snapshot.
 *
 * The style observer catches a one-frame revert that never gets its own
 * paint; the rAF sampler catches painted motion from CSS or a transform.
 */

const STYLE_DIMS = ['top', 'left', 'width', 'height'] as const;
// `contentTop` (the top of [role=log]) moves when the header row appears or
// disappears, which the outer box hides. Not an inline style: rAF only.
const RAF_DIMS = [...STYLE_DIMS, 'contentTop'] as const;
type Dim = (typeof RAF_DIMS)[number];

export interface ResizeBounce {
  paneId: string;
  dim: Dim;
  values: [number, number, number];
  /** ms since recorder start. */
  ts: number;
  /** After the 'mouseup' mark. */
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
  // About half a 24px row / a ~9px column: above sub-pixel jitter, below a
  // 1-cell reversal.
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
  private readonly byPane = new Map<string, Sample[]>();
  private rafId = 0;
  private stopped = false;

  constructor(scope: Element, options: ResizeGlitchOptions = {}) {
    this.scope = scope;
    this.opts = { ...DEFAULT_MIN, ...options.minAmplitude };

    this.sampleRaf();

    this.observer = new MutationObserver((records) => {
      const ts = performance.now() - this.startTime;
      for (const rec of records) {
        if (rec.type !== 'attributes' || rec.attributeName !== 'style') continue;
        const el = rec.target as HTMLElement;
        if (!el.classList?.contains('pane-layout-item')) continue;
        const id = el.dataset.paneId;
        if (!id) continue;
        // The batch has applied by callback time: the live style is its net value.
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

  mark(label: string): void {
    this.marks.set(label, performance.now() - this.startTime);
  }

  private sampleRaf(): void {
    const ts = performance.now() - this.startTime;
    this.scope.querySelectorAll<HTMLElement>('.pane-layout-item[data-pane-id]').forEach((el) => {
      const id = el.dataset.paneId!;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
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
    this.sampleRaf();

    const mark = this.marks.get('mouseup') ?? Infinity;
    const bounces: ResizeBounce[] = [];

    for (const [paneId, samples] of this.byPane) {
      for (const dim of RAF_DIMS) {
        for (const source of ['style', 'raf'] as const) {
          const seq = samples
            .filter((s) => s.source === source && s.values[dim] !== undefined)
            .map((s) => ({ v: s.values[dim]!, ts: s.ts }));
          const dedup: Array<{ v: number; ts: number }> = [];
          for (const p of seq) {
            if (dedup.length === 0 || dedup[dedup.length - 1].v !== p.v) dedup.push(p);
          }
          const minAmp = this.opts[dim];
          for (let i = 2; i < dedup.length; i++) {
            const a = dedup[i - 2].v;
            const b = dedup[i - 1].v;
            const c = dedup[i].v;
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

    // The style and rAF sources report the same reversal within a frame.
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

  /**
   * A morph is one transition per pane, so each dimension travels one way.
   * `assertNoBounces` only sees a turn that lands back on its exact start in
   * one step, which is what a runner dropping frames shows of it; a runner
   * painting every frame shows the way back in between, caught here.
   */
  assertMonotonicMorph(): ResizeGlitchReport {
    const report = this.assertNoBounces();
    const turns: string[] = [];
    for (const [paneId, samples] of this.byPane) {
      for (const dim of RAF_DIMS) {
        const seq = samples.filter((s) => s.source === 'raf' && s.values[dim] !== undefined);
        if (seq.length === 0) continue;
        const start = seq[0].values[dim]!;
        const minAmp = this.opts[dim];
        let dir = 0;
        let peak = start;
        for (const s of seq) {
          const v = s.values[dim]!;
          if (dir === 0) {
            if (Math.abs(v - start) >= minAmp) {
              dir = Math.sign(v - start);
              peak = v;
            }
          } else if ((v - peak) * dir > 0) {
            peak = v;
          } else if ((peak - v) * dir >= minAmp) {
            turns.push(`${paneId} ${dim} ${start}→${peak}→${v} @${Math.round(s.ts)}ms`);
            break;
          }
        }
      }
    }
    if (turns.length > 0) {
      throw new Error(`morph turned back on itself:\n  ${turns.slice(0, 8).join('\n  ')}`);
    }
    return report;
  }

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
