import { describe, it, expect, vi } from 'vitest';
import { Cause, Chunk, Effect, Exit, Option, Stream } from 'effect';
import { TmuxTransport, type TmuxTransportService } from '../TmuxTransport';
import { TransportEvent } from '../events';
import { TmuxOp } from '../../../domain/commands';
import { fakeTransport } from '../../../test/transport';
import { tracer } from '../../tracer';

const call = <A, E>(f: (t: TmuxTransportService) => Effect.Effect<A, E>) =>
  Effect.flatMap(TmuxTransport, f);

/** The failure an exit carries, or null. */
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrNull(Cause.failureOption(exit.cause)) : null;

describe('TmuxTransport over a driver', () => {
  it('a call answers its decoded result', async () => {
    const adapter = fakeTransport({ send: async () => [{ name: 'work', savedAt: 3 }] });
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.call('list_snapshots', {})));
    expect(exit).toEqual(Exit.succeed([{ name: 'work', savedAt: 3 }]));
    expect(adapter.invocations).toEqual([{ cmd: 'list_snapshots', args: {} }]);
  });

  it('an answer that does not match its command is a ProtocolError naming the command', async () => {
    const adapter = fakeTransport({ send: async () => [{ name: 'work', savedAt: 'yesterday' }] });
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.call('list_snapshots', {})));
    expect(failure(exit)).toMatchObject({ _tag: 'ProtocolError' });
    expect(JSON.stringify(exit)).toMatch(/list_snapshots/);
  });

  it('a refusal of kind tmux is a TmuxError, not a ProtocolError', async () => {
    const adapter = fakeTransport({
      send: async () => {
        throw { error: 'no such pane: %999', kind: 'tmux' };
      },
    });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.run(TmuxOp.RawCommand({ command: 'kill-pane -t %999' }))),
    );
    expect(failure(exit)).toMatchObject({
      _tag: 'TmuxError',
      command: 'kill-pane -t %999',
      stderr: 'no such pane: %999',
    });
  });

  it('a lost link (an Error) is a TransportError', async () => {
    const adapter = fakeTransport({
      send: async () => {
        throw new Error('socket hang up');
      },
    });
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.call('list_snapshots', {})));
    expect(failure(exit)).toMatchObject({ _tag: 'TransportError' });
  });

  it('answers queries only over a driver that can reach tmux', async () => {
    const live = fakeTransport({ answersQueries: true, send: async () => '%0\n' });
    const recorded = fakeTransport({});
    expect(await live.run(call((t) => t.query('list-panes')))).toBe('%0\n');
    expect(live.invocations).toEqual([{ cmd: 'query_tmux', args: { command: 'list-panes' } }]);
    const exit = await recorded.runtime.runPromiseExit(call((t) => t.query('list-panes')));
    expect(failure(exit)).toMatchObject({ _tag: 'TransportError' });
  });

  it('connect success completes', async () => {
    const adapter = fakeTransport({ connect: vi.fn(async () => {}) });
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.connect));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('a driver with no session switch of its own switches with switch-client on the lane', async () => {
    const adapter = fakeTransport();
    await adapter.run(call((t) => t.switchSession('demo')));
    expect(adapter.invocations).toEqual([
      { cmd: 'run_tmux_command', args: { command: 'switch-client -t demo' } },
    ]);
  });

  it('a fetched state is decoded, and the viewport it was asked at is the reported size', async () => {
    const adapter = fakeTransport({ send: async () => ({ not: 'a state' }) });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.fetchState({ cols: 100, rows: 30 })),
    );
    expect(failure(exit)).toMatchObject({ _tag: 'ProtocolError' });
    expect(adapter.invocations).toEqual([
      { cmd: 'get_initial_state', args: { cols: 100, rows: 30 } },
    ]);
  });

  it('keystrokes batch, and a call sent after them never overtakes them', async () => {
    const adapter = fakeTransport();
    const type = (text: string) => call((t) => t.run(TmuxOp.SendText({ target: '%1', text })));
    // 'a' goes at once (leading edge); 'b' and 'c' wait for the window, but a
    // call flushes them first. One program, so all of it lands in one window.
    await adapter.run(
      Effect.all([
        type('a'),
        type('b'),
        type('c'),
        call((t) => t.call('get_themes_list', {}).pipe(Effect.ignore)),
      ]),
    );
    expect(adapter.invocations.map((c) => c.cmd + ' ' + JSON.stringify(c.args))).toEqual([
      `run_tmux_command {"command":"send-keys -t %1 -l -- 'a'"}`,
      `run_tmux_command {"command":"send-keys -t %1 -l -- 'bc'"}`,
      'get_themes_list {}',
    ]);
  });

  it('counts what is batched or in flight as pending, until the backend has it', async () => {
    let release: () => void = () => {};
    const adapter = fakeTransport({
      send: () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    });
    const split = adapter.run(call((t) => t.run(TmuxOp.Split({ direction: 'vertical' }))));
    expect(await adapter.run(call((t) => Effect.sync(t.pendingCommands)))).toBe(1);
    await vi.waitFor(() => expect(adapter.invocations).toHaveLength(1));
    release();
    await split;
    expect(await adapter.run(call((t) => Effect.sync(t.pendingCommands)))).toBe(0);
  });

  it('a keystroke the backend refuses is reported, not dropped in silence', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = fakeTransport({
      send: async () => {
        throw { error: "can't find pane: %1", kind: 'tmux' };
      },
    });
    await adapter.run(call((t) => t.run(TmuxOp.SendKeys({ target: '%1', keys: 'Enter' }))));
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith('[transport] keystrokes lost:', expect.anything()),
    );
    errors.mockRestore();
  });

  it("follows the host's trace switch from its greeting", async () => {
    const transport = fakeTransport({ shipTrace: () => {} });
    const enabled = vi.spyOn(tracer, 'setServerEnabled');
    await transport.run(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* TmuxTransport).subscribe;
          transport.emit(
            TransportEvent.ConnectionInfo({
              defaultShell: 'zsh',
              hostname: null,
              traceEnabled: true,
            }),
          );
          return yield* Stream.runCollect(Stream.take(events, 1));
        }),
      ),
    );
    expect(enabled).toHaveBeenCalledWith(true);
    enabled.mockRestore();
    tracer.setServerEnabled(false);
    tracer.setSink(null);
  });

  it('publishes what the driver pushes, in order, to a subscriber taken before it is pushed', async () => {
    const transport = fakeTransport();
    const seen = await transport.run(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* TmuxTransport).subscribe;
          transport.emit(TransportEvent.ConnectionInfo({ defaultShell: 'zsh', hostname: null }));
          transport.emit(TransportEvent.Error({ message: 'boom' }));
          return yield* Stream.runCollect(Stream.take(events, 2));
        }),
      ),
    );
    expect(Chunk.toArray(seen).map((e) => e._tag)).toEqual(['ConnectionInfo', 'Error']);
  });
});
