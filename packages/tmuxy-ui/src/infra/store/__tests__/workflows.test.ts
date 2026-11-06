import { describe, it, expect } from 'vitest';
import { makeTmuxStore } from '../TmuxStore';
import type {
  ServerState,
  ServerStateEncoded,
  WirePaneEncoded,
  WireWindowEncoded,
} from '../../../domain/wire';
import { pid, wid, wireState } from '../../../test/wire';
import { dispatchRaw } from '../../../test/store';
import { fakeTransport, type FakeTransport } from '../../../test/transport';
import { TmuxError } from '../../transport/AdapterError';

const serverPane = (over: Partial<WirePaneEncoded> = {}): WirePaneEncoded => ({
  id: 0,
  tmux_id: pid('%0'),
  window_id: wid('@0'),
  content: [],
  cursor_x: 0,
  cursor_y: 0,
  width: 80,
  height: 24,
  x: 0,
  y: 0,
  active: true,
  command: 'bash',
  title: '',
  border_title: '',
  in_mode: false,
  copy_cursor_x: 0,
  copy_cursor_y: 0,
  alternate_on: false,
  mouse_any_flag: false,
  history_size: 0,
  selection_present: false,
  selection_start_x: 0,
  selection_start_y: 0,
  cursor_shape: 0,
  cursor_hidden: false,
  ...over,
});

const serverWindow = (over: Partial<WireWindowEncoded> = {}): WireWindowEncoded => ({
  id: wid('@0'),
  index: 0,
  name: 'main',
  active: true,
  window_type: 'tab',
  ...over,
});

const serverState = (over: Partial<ServerStateEncoded> = {}): ServerState =>
  wireState({
    session_name: 'tmuxy',
    active_window_id: wid('@0'),
    active_pane_id: pid('%0'),
    panes: [serverPane()],
    windows: [serverWindow()],
    total_width: 80,
    total_height: 24,
    ...over,
  });

/** What reached tmux, each as `cmd|args-json`. */
const sent = (fake: FakeTransport) =>
  fake.invocations.map((i) => `${i.cmd}|${JSON.stringify(i.args ?? {})}`);

describe('TmuxStore — verbatim command preservation', () => {
  it('sends the caller-provided command string, not the op canonical form', async () => {
    const fake = fakeTransport();
    const store = makeTmuxStore();
    store.reconcile(serverState());

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
      serverState({
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
        ],
        active_pane_id: pid('%1'),
      }),
    );

    fake.setNextResult({ kind: 'ok', value: undefined });
    await fake.runtime.runPromiseExit(store.dispatch({ _tag: 'Split', direction: 'vertical' }));
    store.reconcile(
      serverState({
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 20 }),
          serverPane({ tmux_id: pid('%2'), x: 61, width: 19, active: true }),
        ],
        active_pane_id: pid('%2'),
      }),
    );
    expect(Object.keys(store.getModel().paneKeyOverrides)).toContain(pid('%2'));

    store.reconcile(
      serverState({
        panes: [
          serverPane({ tmux_id: pid('%0'), x: 0, width: 39 }),
          serverPane({ tmux_id: pid('%1'), x: 40, width: 40, active: true }),
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
    store.reconcile(serverState());

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

    store.reconcile(serverState());
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
    store.reconcile(serverState());

    fake.setNextResult({ kind: 'ok', value: undefined });
    // SELECT_TAB constructs a SelectWindow op directly with no original
    // command string — the store should send `select-window -t N`.
    await fake.runtime.runPromise(store.dispatch({ _tag: 'SelectWindow', target: 3 }));
    expect(sent(fake)[0]).toContain('select-window -t 3');
  });
});
