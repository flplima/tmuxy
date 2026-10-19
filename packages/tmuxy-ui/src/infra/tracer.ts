/**
 * Client-side action tracer (docs/TRACING.md).
 *
 * Emits content-free "action shape" events — XState transitions, adapter
 * send/apply boundaries, Effect outcomes — and batch-ships them to the server's
 * single NDJSON trace file via a sink (POST /trace on web, Tauri IPC on
 * desktop). It records only variant names and ids; it never carries terminal
 * content. A client-side key allowlist drops anything else, and the server
 * re-sanitizes every field on ingest.
 *
 * OFF by default. It turns on when the server advertises tracing
 * (`connection-info.trace_enabled` → `setServerEnabled`), or explicitly via
 * `?trace`, `localStorage.tmuxyTrace = '1'`, or `window.__tmuxyTrace = true`.
 * When disabled, `event()` is a boolean early-return, so wiring it into the hot
 * adapter/XState paths costs nothing in production.
 */

/** Keys allowed onto a shipped event. Anything else is dropped client-side
 * (defense in depth; the server re-applies the same allowlist). All are
 * content-free: typed variants, ids, counts, timing, and error *tags*. */
const ALLOWED_KEYS = new Set<string>([
  'layer',
  'component',
  'name',
  'phase',
  'level',
  'op',
  'pane',
  'window',
  'session',
  'seq',
  'conn_id',
  'action_id',
  'kind',
  'variant',
  'count',
  'cols',
  'rows',
  'dur_us',
  'height',
  'error',
  'code',
  'ts_wall',
  'ts_mono',
]);

const FLUSH_INTERVAL_MS = 1000;
/** Cap the buffer so a disconnected sink can't leak memory. Oldest dropped. */
const MAX_BUFFER = 2000;

export interface TraceEvent {
  layer: string;
  name: string;
  phase?: 'event' | 'start' | 'end' | 'span';
  [key: string]: string | number | boolean | undefined;
}

/** Ships a batch of already-cleaned events. Set by the active adapter. */
export type TraceSink = (events: Record<string, unknown>[]) => void;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function detectForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if ((window as { __tmuxyTrace?: boolean }).__tmuxyTrace) return true;
    const params = new URLSearchParams(window.location.search);
    if (params.has('trace') && params.get('trace') !== '0') return true;
    if (window.localStorage?.getItem('tmuxyTrace') === '1') return true;
  } catch {
    // sandboxed frames can throw on location/localStorage access
  }
  return false;
}

class Tracer {
  /** Explicit client opt-in (URL/localStorage/window). Overrides the server. */
  private forced = detectForced();
  private enabled = this.forced;
  private buffer: Record<string, unknown>[] = [];
  /** Coalesced high-frequency events: `layer\0name` → count. Flushed as one
   * `phase:'count'` event per bucket so spammy updates don't drown the trace. */
  private counts = new Map<string, number>();
  private sink: TraceSink | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called from `connection-info`. A client opt-in wins over the server. */
  setServerEnabled(on: boolean): void {
    if (this.forced) return;
    this.enabled = on;
    if (!on) {
      this.buffer = [];
      this.counts.clear();
    }
  }

  /** Force on/off at runtime (also persists the flag), for console/E2E use. */
  setEnabled(on: boolean): void {
    this.forced = on;
    this.enabled = on;
    try {
      if (typeof window !== 'undefined') {
        (window as { __tmuxyTrace?: boolean }).__tmuxyTrace = on;
        window.localStorage?.setItem('tmuxyTrace', on ? '1' : '0');
      }
    } catch {
      // ignore storage failures
    }
    if (!on) {
      this.buffer = [];
      this.counts.clear();
    }
  }

  setSink(sink: TraceSink | null): void {
    this.sink = sink;
  }

  /** Record one content-free action event. Unknown keys are dropped. */
  event(ev: TraceEvent): void {
    if (!this.enabled) return;
    const clean: Record<string, unknown> = {
      ts_wall: Date.now(),
      ts_mono: Math.round(now() * 1000),
      phase: 'event',
    };
    for (const [key, value] of Object.entries(ev)) {
      if (value === undefined) continue;
      if (ALLOWED_KEYS.has(key)) clean[key] = value;
    }
    this.buffer.push(clean);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.scheduleFlush();
  }

  /** Record a high-frequency event by counting it instead of emitting one line
   * each. Flushed as a single `{name, count, phase:'count'}` event per window. */
  count(layer: string, name: string): void {
    if (!this.enabled) return;
    const key = `${layer}\0${name}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.scheduleFlush();
  }

  flush(): void {
    // Materialize coalesced counters into discrete count events first.
    if (this.counts.size > 0) {
      const tsWall = Date.now();
      const tsMono = Math.round(now() * 1000);
      for (const [key, n] of this.counts) {
        const [layer, name] = key.split('\0');
        this.buffer.push({
          ts_wall: tsWall,
          ts_mono: tsMono,
          layer,
          name,
          phase: 'count',
          count: n,
        });
      }
      this.counts.clear();
    }
    if (this.buffer.length === 0) return;
    const sink = this.sink;
    if (!sink) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      sink(batch);
    } catch {
      // A failed ship drops the batch rather than blocking; tracing is
      // best-effort and must never affect the app.
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    if (typeof setTimeout === 'undefined') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }
}

export const tracer = new Tracer();

// Expose for console-driven debugging / E2E harnesses.
if (typeof window !== 'undefined') {
  (window as { __tmuxyTracer?: Tracer }).__tmuxyTracer = tracer;
}
