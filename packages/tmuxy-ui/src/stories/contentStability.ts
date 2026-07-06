/**
 * In-page terminal-content stability recorder for Storybook play functions.
 *
 * Where `glitchRecorder.ts` proves the pane *chrome* (layout nodes, geometry)
 * doesn't churn — and deliberately IGNORES `.terminal-line` / `.terminal-content`
 * — this recorder proves the opposite: that the rendered terminal *content*
 * never blinks or flickers away during a pane operation (navigate, split,
 * resize, zoom, kill, …).
 *
 * The method is a rAF sampler over a scope element's `textContent`. Callers seed
 * it with the distinctive marker strings that some panes are currently showing
 * (e.g. `echo ZZ_MARK_A_ZZ`); every animation frame during the operation it
 * checks each marker is still present. A marker that was visible and then
 * vanishes for one or more painted frames — while its pane is meant to persist —
 * is exactly the user-visible content flicker we want to catch. rAF granularity
 * means a synchronous clear-and-repaint within a single frame is not flagged
 * (the user never sees it); only a blank that survives a paint is a flicker.
 *
 * Pure DOM — no Storybook / testing-library imports — usable from any play
 * function.
 */

export interface ContentBlink {
  /** The marker text that went missing. */
  readonly marker: string;
  /** ms after start() at which the marker first went missing. */
  readonly firstMissingMs: number;
  /** Number of sampled frames in which the marker was absent. */
  readonly missingFrames: number;
}

export class ContentStabilityRecorder {
  private readonly scope: Element;
  private markers: string[];
  private running = false;
  private startTs = 0;
  private frames = 0;
  private readonly missing = new Map<string, { frames: number; firstMs: number }>();
  private rafId = 0;

  /**
   * @param scope   Element whose subtree text is sampled (usually `.pane-layout`).
   * @param markers Marker strings expected to remain continuously visible.
   */
  constructor(scope: Element, markers: string[]) {
    this.scope = scope;
    this.markers = [...markers];
  }

  /** Begin sampling. Idempotent while running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTs = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.frames += 1;
      const text = this.scope.textContent ?? '';
      const now = performance.now() - this.startTs;
      for (const m of this.markers) {
        if (!text.includes(m)) {
          const rec = this.missing.get(m);
          if (rec) rec.frames += 1;
          else this.missing.set(m, { frames: 1, firstMs: now });
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Narrow the tracked marker set mid-recording — e.g. just before killing a
   * pane, drop its marker so its (intentional) disappearance isn't flagged.
   */
  expect(markers: string[]): void {
    this.markers = [...markers];
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** How many frames were sampled — lets a story assert it actually observed. */
  get sampledFrames(): number {
    return this.frames;
  }

  blinks(): ContentBlink[] {
    return [...this.missing.entries()].map(([marker, r]) => ({
      marker,
      firstMissingMs: Math.round(r.firstMs),
      missingFrames: r.frames,
    }));
  }

  /** Throw with a readable report if any tracked marker blinked. */
  assertStable(operation: string): void {
    const blinks = this.blinks();
    if (blinks.length > 0) {
      const detail = blinks
        .map(
          (b) =>
            `"${b.marker}" vanished for ${b.missingFrames} frame(s) (first at ${b.firstMissingMs}ms)`,
        )
        .join('; ');
      throw new Error(`Terminal content flicker during ${operation}: ${detail}`);
    }
  }
}
