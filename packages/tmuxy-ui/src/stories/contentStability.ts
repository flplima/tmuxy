/**
 * Proves the terminal content never blinks away during a pane operation:
 * every animation frame, each marker string a pane shows must still be in the
 * scope's text. Sampling per frame means a clear-and-repaint within one frame
 * (which the user never sees) is not flagged; only a blank that survives a
 * paint is.
 */

export interface ContentBlink {
  readonly marker: string;
  /** ms since start(). */
  readonly firstMissingMs: number;
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

  constructor(scope: Element, markers: string[]) {
    this.scope = scope;
    this.markers = [...markers];
  }

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

  /** Narrow the markers mid-recording, e.g. just before killing a pane. */
  expect(markers: string[]): void {
    this.markers = [...markers];
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get sampledFrames(): number {
    return this.frames;
  }

  /**
   * The assertions are about painted frames: a loaded CI machine can spend a
   * whole wall-clock sleep inside one long task and sample a frame or two, so
   * the window waits for frames instead. Polls on a timer, not rAF, so a page
   * that never paints fails on the deadline instead of hanging.
   */
  waitForFrames(min: number, timeoutMs = 4000): Promise<void> {
    if (this.frames >= min || !this.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const timer = setInterval(() => {
        if (this.frames >= min || !this.running) {
          clearInterval(timer);
          resolve();
        } else if (performance.now() > deadline) {
          clearInterval(timer);
          reject(
            new Error(
              `content sampler saw only ${this.frames} frame(s) in ${timeoutMs}ms — the page never painted`,
            ),
          );
        }
      }, 50);
    });
  }

  blinks(): ContentBlink[] {
    return [...this.missing.entries()].map(([marker, r]) => ({
      marker,
      firstMissingMs: Math.round(r.firstMs),
      missingFrames: r.frames,
    }));
  }

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
