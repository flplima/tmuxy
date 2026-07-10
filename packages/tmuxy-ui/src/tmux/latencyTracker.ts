/**
 * Axis-B transport-latency instrumentation.
 *
 * This is the one thing the project's perf tooling was missing: the v86/wasm
 * probes (Axis A) measure the parse→aggregate→delta→render pipeline with the
 * network *removed*, so they can't see transport cost. This tracker measures
 * exactly that — the round trip from "the client sent a keystroke/command" to
 * "the client applied the resulting state update" — which is the number a
 * transport change (SSE+POST → QUIC/WebTransport, local → remote-VM) would
 * actually move. See docs/PERFORMANCE.md.
 *
 * It is DEV-GATED: when disabled (the default), `markInput`/`recordUpdate` are
 * a single boolean check and a cheap early return, so wiring it into the hot
 * adapter paths costs nothing in production. Enable via any of:
 *   - `?perf` (or `?perf=1`) in the URL query string
 *   - `localStorage.tmuxyPerf = '1'`
 *   - `window.__tmuxyPerf = true` before the adapter connects
 *   - `latencyTracker.setEnabled(true)` at runtime (also flips the HUD on)
 */

/** Rolling window of input→paint latency samples (ms). */
const MAX_SAMPLES = 512;
/** Cap on outstanding un-matched inputs so a long stall can't leak memory. */
const MAX_PENDING = 256;
/** Window over which the update rate (updates/sec) is computed. */
const RATE_WINDOW_MS = 2000;

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  count: number;
}

export interface LatencySnapshot {
  enabled: boolean;
  /** Input→applied-state latency distribution, in milliseconds. */
  input: LatencyStats;
  /** Inputs sent but not yet reflected by an applied update. */
  pending: number;
  /** Applied state updates: total, recent rate, and worst recent gap (stalls). */
  updates: { count: number; ratePerSec: number; maxGapMs: number };
  /** ms since the tracker was last reset (wall-clock span of the samples). */
  sinceMs: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function detectEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if ((window as { __tmuxyPerf?: boolean }).__tmuxyPerf) return true;
    const params = new URLSearchParams(window.location.search);
    if (params.has('perf') && params.get('perf') !== '0') return true;
    if (window.localStorage?.getItem('tmuxyPerf') === '1') return true;
  } catch {
    // Access to window.location / localStorage can throw in sandboxed frames.
  }
  return false;
}

const EMPTY_STATS: LatencyStats = { p50: 0, p95: 0, p99: 0, max: 0, mean: 0, count: 0 };

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx];
}

class LatencyTracker {
  private enabled = detectEnabled();

  private samples: number[] = [];
  private pending: number[] = [];
  private updateCount = 0;
  private updateTimes: number[] = [];
  private maxGapMs = 0;
  private lastUpdateAt: number | null = null;
  private startedAt = now();

  private listeners = new Set<() => void>();
  private cached: LatencySnapshot | null = null;

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Turn tracking on/off at runtime (also re-syncs the persisted flag). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      if (typeof window !== 'undefined') {
        (window as { __tmuxyPerf?: boolean }).__tmuxyPerf = on;
        window.localStorage?.setItem('tmuxyPerf', on ? '1' : '0');
      }
    } catch {
      // ignore storage failures
    }
    if (!on) this.reset();
    this.invalidate();
  }

  /** Record that an input (keystroke/command) just left the client. */
  markInput(): void {
    if (!this.enabled) return;
    this.pending.push(now());
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.invalidate();
  }

  /**
   * Record that a state update was just applied to the UI. Matches the oldest
   * outstanding input FIFO and records its round-trip latency; leftover pending
   * inputs stay queued, so a burst of inputs with few applies (a stall) shows
   * up as a growing pending count and inflating latency — the HoL-blocking
   * signal QUIC would flatten.
   */
  recordUpdate(): void {
    if (!this.enabled) return;
    const t = now();

    const issued = this.pending.shift();
    if (issued !== undefined) {
      const latency = t - issued;
      this.samples.push(latency);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    }

    this.updateCount++;
    if (this.lastUpdateAt !== null) {
      const gap = t - this.lastUpdateAt;
      if (gap > this.maxGapMs) this.maxGapMs = gap;
    }
    this.lastUpdateAt = t;
    this.updateTimes.push(t);
    const cutoff = t - RATE_WINDOW_MS;
    while (this.updateTimes.length > 0 && this.updateTimes[0] < cutoff) {
      this.updateTimes.shift();
    }
    this.invalidate();
  }

  reset(): void {
    this.samples = [];
    this.pending = [];
    this.updateCount = 0;
    this.updateTimes = [];
    this.maxGapMs = 0;
    this.lastUpdateAt = null;
    this.startedAt = now();
    this.invalidate();
  }

  private stats(): LatencyStats {
    if (this.samples.length === 0) return EMPTY_STATS;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((n, v) => n + v, 0);
    return {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      count: sorted.length,
    };
  }

  /** Stable snapshot for `useSyncExternalStore` — cached until the next event. */
  getSnapshot(): LatencySnapshot {
    if (this.cached) return this.cached;
    const spanMs = now() - this.startedAt;
    const ratePerSec =
      this.updateTimes.length > 0
        ? (this.updateTimes.length / Math.min(RATE_WINDOW_MS, Math.max(1, spanMs))) * 1000
        : 0;
    this.cached = {
      enabled: this.enabled,
      input: this.stats(),
      pending: this.pending.length,
      updates: {
        count: this.updateCount,
        ratePerSec,
        maxGapMs: this.maxGapMs,
      },
      sinceMs: spanMs,
    };
    return this.cached;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private invalidate(): void {
    this.cached = null;
    this.listeners.forEach((l) => l());
  }
}

export const latencyTracker = new LatencyTracker();

// Expose for console-driven debugging / the latency-injection harness runner.
if (typeof window !== 'undefined') {
  (window as { __tmuxyLatency?: LatencyTracker }).__tmuxyLatency = latencyTracker;
}
