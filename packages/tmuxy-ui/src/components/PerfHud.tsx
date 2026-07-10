/**
 * Axis-B latency HUD — a dev-only overlay reading `latencyTracker`.
 *
 * Shows the input→paint round-trip distribution, outstanding (pending) inputs,
 * the applied-update rate, and the worst recent inter-update gap (the stall
 * signal). This is what you watch while driving the app over the
 * latency-injection proxy (scripts/latency-proxy.mjs) to compare transports.
 *
 * Only mounted when `latencyTracker.isEnabled()` (via `?perf` / localStorage),
 * so it — and the store subscription below — cost nothing in production.
 *
 * Store notifications are coalesced to one animation frame so a heavy-output
 * burst can't storm React re-renders and distort the numbers being measured.
 */

import { useSyncExternalStore } from 'react';
import { latencyTracker, type LatencySnapshot } from '../tmux/latencyTracker';

let rafPending = false;
const hudListeners = new Set<() => void>();

latencyTracker.subscribe(() => {
  if (rafPending) return;
  rafPending = true;
  const raf =
    typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
  raf(() => {
    rafPending = false;
    hudListeners.forEach((l) => l());
  });
});

function subscribe(cb: () => void): () => void {
  hudListeners.add(cb);
  return () => hudListeners.delete(cb);
}

function getSnapshot(): LatencySnapshot {
  return latencyTracker.getSnapshot();
}

const ms = (n: number): string => `${n.toFixed(n < 10 ? 1 : 0)}ms`;

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 8,
  right: 8,
  zIndex: 99999,
  font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#e6edf3',
  background: 'rgba(13, 17, 23, 0.86)',
  border: '1px solid rgba(240, 246, 252, 0.15)',
  borderRadius: 6,
  padding: '6px 8px',
  minWidth: 172,
  pointerEvents: 'auto',
  userSelect: 'none',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
};

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={rowStyle}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color: warn ? '#f0883e' : undefined, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

export function PerfHud() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { input, updates, pending } = snap;

  return (
    <div style={containerStyle} data-testid="perf-hud">
      <div style={{ ...rowStyle, marginBottom: 4, opacity: 0.9, fontWeight: 600 }}>
        <span>input → paint</span>
        <span style={{ opacity: 0.6 }}>{input.count}</span>
      </div>
      <Row label="p50" value={ms(input.p50)} />
      <Row label="p95" value={ms(input.p95)} warn={input.p95 > 150} />
      <Row label="p99 / max" value={`${ms(input.p99)} / ${ms(input.max)}`} />
      <Row label="pending" value={String(pending)} warn={pending > 3} />
      <div style={{ height: 1, background: 'rgba(240,246,252,0.12)', margin: '5px 0' }} />
      <Row label="updates/s" value={updates.ratePerSec.toFixed(0)} />
      <Row label="max gap" value={ms(updates.maxGapMs)} warn={updates.maxGapMs > 250} />
      <button
        type="button"
        onClick={() => latencyTracker.reset()}
        style={{
          marginTop: 6,
          width: '100%',
          font: 'inherit',
          color: 'inherit',
          background: 'rgba(240,246,252,0.08)',
          border: '1px solid rgba(240,246,252,0.15)',
          borderRadius: 4,
          padding: '2px 0',
          cursor: 'pointer',
        }}
      >
        reset
      </button>
    </div>
  );
}
