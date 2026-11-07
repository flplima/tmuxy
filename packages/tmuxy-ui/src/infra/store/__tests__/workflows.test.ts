import { describe, it, expect } from 'vitest';
import { makeTmuxStore } from '../TmuxStore';
import { pid, wid, wirePane, wireSession, wireWindow } from '../../../test/wire';
import { dispatchRaw } from '../../../test/store';
import { fakeTransport, type FakeTransport } from '../../../test/transport';
import { TmuxError } from '../../transport/AdapterError';

/** What reached tmux, each as `cmd|args-json`. */
const sent = (fake: FakeTransport) =>
  fake.invocations.map((i) => `${i.cmd}|${JSON.stringify(i.args ?? {})}`);

describe('TmuxStore — verbatim command preservation', () => {
  it('sends the caller-provided command string, not the op canonical form', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(wireSession());

    const original = 'select-pane -t %0 \\; split-window -v -c "#{pane_current_path}"';
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromise(dispatchRaw(store, original));

    // The invocations array stringifies args via JSON, so the `\;` becomes
    // `\\;` — assert the meaningful tokens instead.
    expect(fake.invocations).toHaveLength(1);
    expect(sent(fake)[0]).toContain('split-window -v');
    expect(sent(fake)[0]).toContain('#{pane_current_path}');
    expect(sent(fake)[0]).toContain('select-pane -t %0');
  });
});

describe('TmuxStore — kill-pane reconcile', () => {
  it('drops paneKeyOverrides for removed panes', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();

    store.reconcile(
      wireSession({
        panes: [
          wirePane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          wirePane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );

    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    store.reconcile(
      wireSession({
        panes: [
          wirePane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          wirePane({ tmux_id: pid('%1'), x: 40, width: 20 }),
          wirePane({ tmux_id: pid('%2'), x: 61, width: 19, active: true }),
        ],
        active_pane_id: pid('%2'),
      }),
    );
    expect(Object.keys(store.getModel().paneKeyOverrides)).toContain(pid('%2'));

    store.reconcile(
      wireSession({
        panes: [
          wirePane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          wirePane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );

    expect(store.getModel().paneKeyOverrides).not.toHaveProperty(pid('%2'));
    expect(store.getModel().derived.panes.map((p) => p.tmuxId)).toEqual([pid('%0'), pid('%1')]);
  });
});

describe('TmuxStore — typed errors', () => {
  it('TmuxError surfaces as OpRejectedByTmux carrying stderr', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(wireSession());

    fake.setNextResult({
      kind: 'reject',
      error: new TmuxError({
        command: 'split-window -h',
        stderr: "can't split pane: insufficient space",
      }),
    });
    const exit = await fake.runtime.runPromiseExit(
      store.dispatch({ _tag: 'Split', direction: 'vertical' }),
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      const cause = exit.cause;
      const causeStr = JSON.stringify(cause);
      expect(causeStr).toContain('OpRejectedByTmux');
      expect(causeStr).toContain('insufficient space');
    }
    expect(store.getModel().ops).toHaveLength(0);
  });
});

describe('TmuxStore — clear (session switch)', () => {
  it('drops committed + pending ops and notifies subscribers', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();

    store.reconcile(wireSession());
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    expect(store.getModel().committed.panes).toHaveLength(1);
    expect(store.getModel().ops).toHaveLength(1);

    const snaps: number[] = [];
    const unsub = store.subscribe((m) => snaps.push(m.committed.panes.length));
    snaps.length = 0; // ignore the immediate "current" callback fired on subscribe
    store.clear();
    unsub();
    expect(snaps).toEqual([0]);

    const m = store.getModel();
    expect(m.committed.panes).toHaveLength(0);
    expect(m.committed.windows).toHaveLength(0);
    expect(m.ops).toHaveLength(0);
    expect(m.derived.panes).toHaveLength(0);
    expect(Object.keys(m.paneKeyOverrides)).toHaveLength(0);
  });
});

describe('TmuxStore — toTmuxCommand fallback for in-code ops', () => {
  it('uses the canonical form when no command override is supplied', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(wireSession());

    fake.setNextResult({ kind: 'ok', value: undefined });
    // SELECT_TAB constructs a SelectWindow op directly with no original
    // command string — the store should send `select-window -t N`.
    await fake.runtime.runPromise(store.dispatch({ _tag: 'SelectWindow', target: 3 }));
    expect(sent(fake)[0]).toContain('select-window -t 3');
  });
});

describe('TmuxStore — last-window after a tab switch', () => {
  it('follows tmux at once: the switch it supersedes stops pinning its tab', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    const on = (active: '@1' | '@3') =>
      wireSession({
        panes: [
          wirePane({ tmux_id: pid('%1'), window_id: wid('@1'), active: active === '@1' }),
          wirePane({ tmux_id: pid('%3'), window_id: wid('@3'), active: active === '@3' }),
        ],
        windows: [
          wireWindow({ id: wid('@1'), index: 1, active: active === '@1' }),
          wireWindow({ id: wid('@3'), index: 3, active: active === '@3' }),
        ],
        active_window_id: wid(active),
        active_pane_id: pid(active === '@1' ? '%1' : '%3'),
      });
    store.reconcile(on('@3'));

    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromise(dispatchRaw(store, 'select-window -t @1'));
    store.reconcile(on('@1'));
    expect(store.getModel().derived.activeWindowId).toBe(wid('@1'));

    // tmux goes back to @3 — the window the switch left, which a stale
    // snapshot would also name — because the user asked it to.
    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromise(dispatchRaw(store, 'last-window'));
    store.reconcile(on('@3'));
    expect(store.getModel().derived.activeWindowId).toBe(wid('@3'));
  });
});
