import { describe, it, expect, vi } from 'vitest';
import { Chunk, Effect, Exit, Stream } from 'effect';
import { TmuxTransport, type TmuxTransportService } from '../TmuxTransport';
import { TransportEvent } from '../events';
import type { TmuxAdapter } from '../../../tmux/types';
import { fakeTransport } from '../../../test/transport';

const call = <A, E>(f: (t: TmuxTransportService) => Effect.Effect<A, E>) =>
  Effect.flatMap(TmuxTransport, f);

describe('TmuxTransport over a driver', () => {
  it('invoke success returns the resolved value', async () => {
    const adapter = fakeTransport({
      invoke: (async () => 42) as TmuxAdapter['invoke'],
    });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.invoke<number>('get_initial_state')),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(42);
    }
  });

  it('invoke promise rejection classifies as TmuxError when the backend says tmux refused it', async () => {
    const adapter = fakeTransport({
      invoke: (async () => {
        throw { error: 'no such pane: %999', kind: 'tmux' };
      }) as TmuxAdapter['invoke'],
    });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.invoke<void>('kill-pane -t %999')),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TmuxError/);
      expect(json).toMatch(/kill-pane -t %999/);
    }
  });

  it('invoke promise rejection with Error instance classifies as TransportError', async () => {
    const adapter = fakeTransport({
      invoke: (async () => {
        throw new Error('socket hang up');
      }) as TmuxAdapter['invoke'],
    });
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.invoke<void>('connect')));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TransportError/);
    }
  });

  it('connect success completes', async () => {
    const adapter = fakeTransport({
      connect: vi.fn(async () => {}),
    });
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.connect));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('switchSession falls back to TransportError when adapter lacks the method', async () => {
    const adapter = fakeTransport();
    const exit = await adapter.runtime.runPromiseExit(call((t) => t.switchSession('demo')));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TransportError/);
      expect(json).toMatch(/switchSession not supported/);
    }
  });

  it('decodingInvoke returns decoded value when payload matches the schema', async () => {
    const { Schema } = await import('effect');
    const adapter = fakeTransport({
      invoke: (async () => ({ count: 3, label: 'ok' })) as TmuxAdapter['invoke'],
    });
    const schema = Schema.Struct({ count: Schema.Number, label: Schema.String });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.decodingInvoke('some_cmd', schema)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ count: 3, label: 'ok' });
    }
  });

  it('decodingInvoke surfaces ProtocolError (not TmuxError) when payload fails to decode', async () => {
    const { Schema } = await import('effect');
    const adapter = fakeTransport({
      invoke: (async () => ({ count: 'three' })) as TmuxAdapter['invoke'],
    });
    const schema = Schema.Struct({ count: Schema.Number });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.decodingInvoke('some_cmd', schema)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/ProtocolError/);
      // Command name preserved in the reason for debuggability
      expect(json).toMatch(/some_cmd/);
    }
  });

  it('decodingInvoke surfaces TmuxError (not ProtocolError) when the underlying invoke rejects', async () => {
    const { Schema } = await import('effect');
    const adapter = fakeTransport({
      invoke: (async () => {
        throw { error: 'no such command', kind: 'tmux' };
      }) as TmuxAdapter['invoke'],
    });
    const schema = Schema.Struct({ count: Schema.Number });
    const exit = await adapter.runtime.runPromiseExit(
      call((t) => t.decodingInvoke('bogus_cmd', schema)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TmuxError/);
      expect(json).not.toMatch(/ProtocolError/);
    }
  });

  it('typed errors enable exhaustive pattern matching on _tag', async () => {
    const adapter = fakeTransport({
      invoke: (async () => {
        throw { error: 'pane does not exist', kind: 'tmux' };
      }) as TmuxAdapter['invoke'],
    });

    // The whole point of typing errors: handle them by tag.
    const program = call((t) => t.invoke<void>('kill-pane')).pipe(
      Effect.catchTags({
        TmuxError: (e) => Effect.succeed(`tmux said: ${e.stderr}`),
        TransportError: () => Effect.succeed('network down'),
        ProtocolError: () => Effect.succeed('bad protocol'),
        Cancelled: () => Effect.succeed('cancelled'),
      }),
    );

    const result = await adapter.run(program);
    expect(result).toBe('tmux said: pane does not exist');
  });

  it('publishes what the driver pushes, in order, to a subscriber taken before it is pushed', async () => {
    const transport = fakeTransport();
    const seen = await transport.run(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* TmuxTransport).subscribe;
          transport.emit(TransportEvent.ConnectionInfo({ defaultShell: 'zsh', readOnly: false }));
          transport.emit(TransportEvent.Error({ message: 'boom' }));
          return yield* Stream.runCollect(Stream.take(events, 2));
        }),
      ),
    );
    expect(Chunk.toArray(seen).map((e) => e._tag)).toEqual(['ConnectionInfo', 'Error']);
  });
});
