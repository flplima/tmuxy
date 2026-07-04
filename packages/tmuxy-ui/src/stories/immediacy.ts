/**
 * Immediacy probe — the reusable "was it optimistic?" assertion.
 *
 * Measures how many animation frames elapse between arming the probe (done
 * just before dispatching an input) and the first matching DOM mutation
 * inside a scope. Optimistic UI must paint within a couple of frames of the
 * input event — long before any server / emulator round-trip could possibly
 * land — so a small frame count is direct evidence the update came from the
 * client-side prediction, not from tmux.
 *
 * Frame counting is driven by requestAnimationFrame on the client, so the
 * measurement is independent of how slow the backend (or the v86 emulator)
 * is. Pure DOM — no Storybook / testing-library imports.
 */

export interface PaintProbe {
  /** Frames elapsed when the first matching mutation was seen; null until then. */
  readonly framesToFirstPaint: number | null;
  /**
   * Resolve with the frame count once the first matching mutation lands.
   * Rejects if the paint arrives after `maxFrames` or not at all within
   * `timeoutMs`.
   */
  wait(maxFrames?: number, timeoutMs?: number): Promise<number>;
  stop(): void;
}

/**
 * Arm a probe on `scope`. Every subsequent DOM mutation in the subtree is
 * matched against `matches` (default: any mutation); the frame counter starts
 * immediately.
 */
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

/**
 * Arm a probe, run `act` (the user input), and assert the first matching
 * mutation painted within `frames` animation frames. Returns the measured
 * frame count.
 */
export async function expectPaintWithin(
  scope: Element,
  act: () => void | Promise<void>,
  opts: {
    frames?: number;
    timeoutMs?: number;
    matches?: (rec: MutationRecord) => boolean;
  } = {},
): Promise<number> {
  const probe = armPaintProbe(scope, opts.matches);
  try {
    await act();
    return await probe.wait(opts.frames ?? 2, opts.timeoutMs ?? 3000);
  } finally {
    probe.stop();
  }
}

/**
 * Matcher factory: a mutation that adds an element matching `selector`
 * (directly or in the added subtree).
 */
export function addsElement(selector: string): (rec: MutationRecord) => boolean {
  return (rec) =>
    rec.type === 'childList' &&
    Array.from(rec.addedNodes).some(
      (n) => n instanceof Element && (n.matches(selector) || n.querySelector(selector) !== null),
    );
}

/**
 * Matcher factory: a mutation that removes an element matching `selector`
 * (directly or in the removed subtree).
 */
export function removesElement(selector: string): (rec: MutationRecord) => boolean {
  return (rec) =>
    rec.type === 'childList' &&
    Array.from(rec.removedNodes).some(
      (n) => n instanceof Element && (n.matches(selector) || n.querySelector(selector) !== null),
    );
}

/**
 * Matcher factory: `attr` changed on an element matching `selector`.
 */
export function changesAttribute(selector: string, attr: string): (rec: MutationRecord) => boolean {
  return (rec) =>
    rec.type === 'attributes' &&
    rec.attributeName === attr &&
    rec.target instanceof Element &&
    rec.target.matches(selector);
}
