/**
 * Axis-B latency HUD (docs/PERFORMANCE.md), mounted only when
 * `latencyTracker.isEnabled()` (`?perf` / localStorage). While it is mounted,
 * the tracker's notifications are coalesced to one animation frame so an
 * output burst cannot storm React re-renders and distort the numbers being
 * measured.
 */

import { useSyncExternalStore } from 'react';
import { latencyTracker, type LatencySnapshot } from '../infra/latencyTracker';

function subscribe(cb: () => void): () => void {
  let framePending = false;
  return latencyTracker.subscribe(() => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      cb();
    });
  });
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
  borderRadius: 'var(--radius-lg)',
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
          borderRadius: 'var(--radius-md)',
          padding: '2px 0',
          cursor: 'pointer',
        }}
      >
        reset
      </button>
    </div>
  );
}
