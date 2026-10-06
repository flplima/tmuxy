import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latencyTracker } from '../latencyTracker';

// Drive the tracker with a mocked monotonic clock so latency math is exact.
let clock = 0;

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  latencyTracker.setEnabled(true);
  latencyTracker.reset();
});

afterEach(() => {
  latencyTracker.setEnabled(false);
  vi.restoreAllMocks();
});

describe('latencyTracker', () => {
  it('is a no-op when disabled', () => {
    latencyTracker.setEnabled(false);
    latencyTracker.markInput();
    clock = 100;
    latencyTracker.recordUpdate();
    const snap = latencyTracker.getSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.input.count).toBe(0);
    expect(snap.pending).toBe(0);
  });

  it('records input→applied round-trip latency', () => {
    latencyTracker.markInput(); // t=0
    clock = 50;
    latencyTracker.recordUpdate(); // matches the input, 50ms round trip
    const snap = latencyTracker.getSnapshot();
    expect(snap.input.count).toBe(1);
    expect(snap.input.p50).toBe(50);
    expect(snap.input.max).toBe(50);
    expect(snap.pending).toBe(0);
    expect(snap.updates.count).toBe(1);
  });

  it('matches inputs FIFO and reflects stalls as rising pending + latency', () => {
    latencyTracker.markInput(); // t=0
    clock = 10;
    latencyTracker.markInput(); // t=10  (pending=2)
    expect(latencyTracker.getSnapshot().pending).toBe(2);

    clock = 100;
    latencyTracker.recordUpdate(); // matches t=0 → 100ms
    expect(latencyTracker.getSnapshot().pending).toBe(1);

    clock = 120;
    latencyTracker.recordUpdate(); // matches t=10 → 110ms
    const snap = latencyTracker.getSnapshot();
    expect(snap.pending).toBe(0);
    expect(snap.input.count).toBe(2);
    expect(snap.input.max).toBe(110);
  });

  it('leaves unmatched inputs pending when updates lag behind', () => {
    latencyTracker.markInput();
    latencyTracker.markInput();
    latencyTracker.markInput();
    clock = 40;
    latencyTracker.recordUpdate(); // matches one; two still outstanding
    expect(latencyTracker.getSnapshot().pending).toBe(2);
    expect(latencyTracker.getSnapshot().input.count).toBe(1);
  });

  it('tracks the worst inter-update gap (stall detector)', () => {
    latencyTracker.recordUpdate(); // t=0, no prior update
    clock = 30;
    latencyTracker.recordUpdate(); // gap 30
    clock = 100;
    latencyTracker.recordUpdate(); // gap 70
    expect(latencyTracker.getSnapshot().updates.maxGapMs).toBe(70);
  });

  it('computes percentiles over the sample window', () => {
    for (let i = 0; i < 100; i++) latencyTracker.markInput(); // all at t=0
    for (let i = 1; i <= 100; i++) {
      clock = i;
      latencyTracker.recordUpdate(); // latency = i (matches a t=0 input)
    }
    const snap = latencyTracker.getSnapshot();
    expect(snap.input.count).toBe(100);
    expect(snap.input.p50).toBe(50);
    expect(snap.input.p95).toBe(95);
    expect(snap.input.max).toBe(100);
  });

  it('returns a stable snapshot reference until the next event', () => {
    const a = latencyTracker.getSnapshot();
    const b = latencyTracker.getSnapshot();
    expect(a).toBe(b);
    latencyTracker.markInput();
    expect(latencyTracker.getSnapshot()).not.toBe(a);
  });

  it('notifies subscribers on each event', () => {
    const listener = vi.fn();
    const unsub = latencyTracker.subscribe(listener);
    latencyTracker.markInput();
    latencyTracker.recordUpdate();
    expect(listener).toHaveBeenCalled();
    unsub();
    const before = listener.mock.calls.length;
    latencyTracker.markInput();
    expect(listener.mock.calls.length).toBe(before);
  });

  it('reset clears samples and pending', () => {
    latencyTracker.markInput();
    clock = 10;
    latencyTracker.recordUpdate();
    latencyTracker.reset();
    const snap = latencyTracker.getSnapshot();
    expect(snap.input.count).toBe(0);
    expect(snap.pending).toBe(0);
    expect(snap.updates.count).toBe(0);
  });
});
