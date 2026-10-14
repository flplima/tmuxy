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

  it('after a gap, applies no delta until an answer is adopted, then carries on from it', () => {
    const stream = new StateSequencer();
    stream.receive(full());
    stream.receive(delta(1));
    expect(stream.receive(delta(3))).toEqual({ _tag: 'Resync' });
    // The next delta follows the lost one, so it would apply to the wrong state.
    expect(stream.receive(delta(4, { active_pane_id: '%7' }))).toEqual({ _tag: 'Resync' });

    stream.adopt(state('%4'));
    const step = stream.receive(delta(5, { active_pane_id: '%5' }));
    expect(step._tag === 'State' && step.state.active_pane_id).toBe('%5');
    // What a refetch publishes is the state now, not the older answer.
    const now = stream.current();
    expect(now._tag === 'State' && now.state.active_pane_id).toBe('%5');
  });

  it('a delta lost right after a numbered sync point is a gap, not a delta applied over the hole', () => {
    // A full state numbered by the stream: the next delta has to follow it.
    const stream = new StateSequencer();
    stream.receive({ type: 'full', state: { ...state(), seq: 7 } });
    expect(stream.receive(delta(9))).toEqual({ _tag: 'Resync' });

    // An adopted answer after a gap, numbered: the same rule.
    stream.adopt({ ...state('%4'), seq: 12 });
    expect(stream.receive(delta(14, { active_pane_id: '%9' }))).toEqual({ _tag: 'Resync' });
    stream.adopt({ ...state('%4'), seq: 14 });
    expect(stream.receive(delta(15, { active_pane_id: '%9' }))).toMatchObject({ _tag: 'State' });

    // A state no stream numbered (a fixture, an engine) starts the count at
    // the next delta, whatever its number.
    const unnumbered = new StateSequencer();
    unnumbered.receive(full());
    expect(unnumbered.receive(delta(9))).toMatchObject({ _tag: 'State', seq: 9 });
  });

  it('the deltas the stream delivers while a refetch is out apply on top of its numbered answer', () => {
    const stream = new StateSequencer();
    stream.receive({ type: 'full', state: { ...state(), seq: 1 } });
    // Delta 2 is lost; 3, 4 and 5 arrive while the refetch is out.
    expect(stream.receive(delta(3, { active_pane_id: '%3' }))).toEqual({ _tag: 'Resync' });
    expect(stream.receive(delta(4, { active_pane_id: '%4' }))).toEqual({ _tag: 'Resync' });
    expect(stream.receive(delta(5, { active_pane_id: '%5' }))).toEqual({ _tag: 'Resync' });
    // The answer was taken at 3: 4 and 5 are applied on it, 3 is already in it.
    expect(stream.adopt({ ...state('%3'), seq: 3 }).active_pane_id).toBe('%5');
    expect(stream.current()).toMatchObject({ _tag: 'State' });
    expect(stream.receive(delta(6, { active_pane_id: '%6' }))).toMatchObject({ _tag: 'State' });

    // A hole among the held deltas is a delta lost during the refetch: the
    // answer is adopted up to the hole, and the stream is still not caught up.
    expect(stream.receive(delta(8))).toEqual({ _tag: 'Resync' });
    expect(stream.receive(delta(10, { active_pane_id: '%10' }))).toEqual({ _tag: 'Resync' });
    expect(stream.adopt({ ...state('%7'), seq: 7 }).active_pane_id).toBe('%7');
    expect(stream.current()).toEqual({ _tag: 'Resync' });
    expect(stream.adopt({ ...state('%10'), seq: 10 }).active_pane_id).toBe('%10');
    expect(stream.current()).toMatchObject({ _tag: 'State' });
    expect(stream.receive(delta(11))).toMatchObject({ _tag: 'State', seq: 11 });

    // An unnumbered answer cannot place them: the next live delta starts the count.
    const unnumbered = new StateSequencer();
    unnumbered.receive(full());
    unnumbered.receive(delta(1));
    expect(unnumbered.receive(delta(3, { active_pane_id: '%3' }))).toEqual({ _tag: 'Resync' });
    expect(unnumbered.adopt(state('%9')).active_pane_id).toBe('%9');
    expect(unnumbered.receive(delta(4))).toMatchObject({ _tag: 'State', seq: 4 });
  });

  it('holds a bounded number of deltas, the newest, while a refetch is out', () => {
    const stream = new StateSequencer();
    stream.receive({ type: 'full', state: { ...state(), seq: 1 } });
    // Delta 2 is lost; 3..=300 arrive while the refetch hangs.
    for (let seq = 3; seq <= 300; seq += 1) {
      expect(stream.receive(delta(seq, { active_pane_id: `%${seq}` }))).toEqual({
        _tag: 'Resync',
      });
    }
    // An answer older than the oldest delta still held cannot be caught up:
    // one more refetch, as before deltas were held at all.
    expect(stream.adopt({ ...state('%3'), seq: 3 }).active_pane_id).toBe('%3');
    expect(stream.current()).toEqual({ _tag: 'Resync' });
    // An answer within the held window is caught up to the newest delta.
    expect(stream.adopt({ ...state('%100'), seq: 100 }).active_pane_id).toBe('%300');
    expect(stream.current()).toMatchObject({ _tag: 'State' });
    expect(stream.receive(delta(301))).toMatchObject({ _tag: 'State', seq: 301 });
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
