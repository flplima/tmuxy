/**
 * How long the server takes to answer over this link, as the browser timed
 * each `POST /commands`: the floor under every keystroke's echo, and the
 * number that tells a slow link from a slow program. Always on, since it
 * costs one observer and a few numbers; the dev-gated `latencyTracker`
 * measures something else (input to applied state, with tmux in it).
 *
 * Only the web transport posts commands, so the desktop app, whose backend
 * is in the same process, never has a sample and never shows a badge.
 */

/** A round trip a typist starts to notice; the badge appears from here. */
export const SLOW_LINK_MS = 100;
/** Past this, typing blind is the normal case. */
export const VERY_SLOW_LINK_MS = 300;

/** The answers the estimate is read from. */
const WINDOW = 9;

export type LinkLatencyLevel = 'slow' | 'very-slow';

export interface SlowLink {
  /** The round trip, rounded to 10 ms so the badge does not flicker between neighbours. */
  readonly ms: number;
  readonly level: LinkLatencyLevel;
}

/**
 * The link's round trip, from the last few answers: the fastest of them, not
 * the median, because an answer is the link plus whatever the command took
 * (a full state waits for a resize, a scrollback read is megabytes) and only
 * the link is common to all of them.
 */
export function estimateRoundTrip(samples: ReadonlyArray<number>): number | null {
  return samples.length < 3 ? null : Math.min(...samples);
}

export function slowLink(roundTripMs: number | null): SlowLink | null {
  if (roundTripMs === null || roundTripMs < SLOW_LINK_MS) return null;
  const ms = Math.round(roundTripMs / 10) * 10;
  return { ms, level: roundTripMs >= VERY_SLOW_LINK_MS ? 'very-slow' : 'slow' };
}

class LinkLatency {
  private samples: number[] = [];
  private current: SlowLink | null = null;
  private readonly listeners = new Set<() => void>();

  /** One answer's time to first byte, in ms. */
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > WINDOW) this.samples.shift();
    const next = slowLink(estimateRoundTrip(this.samples));
    if (next?.ms === this.current?.ms && next?.level === this.current?.level) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  /** A new connection may be a new link: what was measured is not about it. */
  reset(): void {
    this.samples = [];
    if (this.current === null) return;
    this.current = null;
    for (const listener of this.listeners) listener();
  }

  readonly getSnapshot = (): SlowLink | null => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const linkLatency = new LinkLatency();

/**
 * Feed `linkLatency` from the browser's own timing of each command's answer
 * (Resource Timing): request sent to first byte back. Nothing is added to the
 * request path, and a browser without the API records nothing.
 */
export function watchCommandTimings(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      if (entry.initiatorType !== 'fetch' || entry.requestStart === 0) continue;
      if (new URL(entry.name).pathname !== '/commands') continue;
      linkLatency.record(entry.responseStart - entry.requestStart);
    }
  });
  try {
    observer.observe({ type: 'resource' });
  } catch {
    return () => {};
  }
  return () => observer.disconnect();
}
