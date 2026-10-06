import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateSequencer } from '../stateSequencer';
import { ProtocolError } from '../AdapterError';

const state = (activePane = '%1') => ({
  session_name: 'tmuxy',
  active_window_id: '@1',
  active_pane_id: activePane,
  panes: [],
  windows: [{ id: '@1', index: 1, name: 'main', active: true, window_type: 'tab' }],
  total_width: 80,
  total_height: 24,
});

const full = (activePane?: string) => ({ type: 'full', state: state(activePane) });
const delta = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: 'delta',
  delta: { seq, ...extra },
});

describe('StateSequencer', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it('applies a full state, then deltas in sequence', () => {
    const stream = new StateSequencer();
    expect(stream.receive(full())).toMatchObject({ _tag: 'State', seq: null });
    const step = stream.receive(delta(1, { active_pane_id: '%2' }));
    expect(step).toMatchObject({ _tag: 'State', seq: 1 });
    expect(step._tag === 'State' && step.state.active_pane_id).toBe('%2');
  });

  it('asks for a resync on a sequence gap and applies nothing', () => {
    const stream = new StateSequencer();
    stream.receive(full());
    stream.receive(delta(1));
    expect(stream.receive(delta(3))).toEqual({ _tag: 'Resync' });
  });

  it('treats a payload that does not decode like a gap, and logs it', () => {
    const stream = new StateSequencer();
    stream.receive(full());
    expect(stream.receive(delta(1, { active_pane_id: '@not-a-pane' }))).toEqual({
      _tag: 'Resync',
    });
    expect(stream.receive({ type: 'full' })).toEqual({ _tag: 'Resync' });
    expect(stream.receive(undefined)).toEqual({ _tag: 'Resync' });
    expect(errors).toHaveBeenCalledTimes(3);
    // The next full state is a fresh start.
    expect(stream.receive(full('%5'))).toMatchObject({ _tag: 'State' });
  });

  it('ignores a delta before any full state', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(new StateSequencer().receive(delta(1))).toEqual({ _tag: 'Ignore' });
  });

  it('rejects an initial-state answer that does not decode with a ProtocolError', () => {
    const stream = new StateSequencer();
    expect(() => stream.adopt({ panes: [] })).toThrow(ProtocolError);
    expect(stream.adopt(state('%3')).active_pane_id).toBe('%3');
  });
});
