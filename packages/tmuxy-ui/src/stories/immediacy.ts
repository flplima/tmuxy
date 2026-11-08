/**
 * "Was it optimistic?": frames between arming the probe (just before an
 * input) and the first matching DOM mutation. A paint within a couple of
 * frames is long before any server or emulator round trip could land, so it
 * came from the client's prediction. Counted in frames, so the measurement
 * does not depend on how slow the backend is.
 */

export interface PaintProbe {
  /** Null until the first matching mutation. */
  readonly framesToFirstPaint: number | null;
  /** Rejects if the paint arrives after `maxFrames`, or not within `timeoutMs`. */
  wait(maxFrames?: number, timeoutMs?: number): Promise<number>;
  stop(): void;
}

export function armPaintProbe(
  scope: Element,
  matches: (rec: MutationRecord) => boolean = () => true,
): PaintProbe {
  let frames = 0;
  let firstPaintFrames: number | null = null;
  let rafId = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    frames += 1;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  const observer = new MutationObserver((records) => {
    if (firstPaintFrames !== null) return;
    if (records.some(matches)) {
      firstPaintFrames = frames;
      observer.disconnect();
    }
  });
  observer.observe(scope, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  });

  const stop = (): void => {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(rafId);
  };

  return {
    get framesToFirstPaint() {
      return firstPaintFrames;
    },
    wait(maxFrames = 2, timeoutMs = 3000) {
      return new Promise<number>((resolve, reject) => {
        const started = performance.now();
        const poll = (): void => {
          if (firstPaintFrames !== null) {
            stop();
            if (firstPaintFrames <= maxFrames) {
              resolve(firstPaintFrames);
            } else {
              reject(
                new Error(
                  `first paint took ${firstPaintFrames} frames (budget: ${maxFrames}) — ` +
                    `the update was not optimistic`,
                ),
              );
            }
            return;
          }
          if (performance.now() - started > timeoutMs) {
            stop();
            reject(new Error(`no matching DOM mutation within ${timeoutMs}ms`));
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    },
    stop,
  };
}

export function addsElement(selector: string): (rec: MutationRecord) => boolean {
  return (rec) =>
    rec.type === 'childList' &&
    Array.from(rec.addedNodes).some(
      (n) => n instanceof Element && (n.matches(selector) || n.querySelector(selector) !== null),
    );
}
