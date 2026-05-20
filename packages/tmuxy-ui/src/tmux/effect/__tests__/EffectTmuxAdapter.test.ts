import { describe, it, expect, vi } from 'vitest';
import { Effect, Exit } from 'effect';
import { toEffectAdapter } from '../EffectTmuxAdapter';
// AdapterError types are imported indirectly via the wrapper; tests
// inspect serialized cause JSON for _tag matching.
import type { TmuxAdapter } from '../../types';

/**
 * Build a minimal TmuxAdapter stub. Only the methods exercised by each
 * test need to be defined; the others throw if accidentally called.
 */
function makeStubAdapter(overrides: Partial<TmuxAdapter>): TmuxAdapter {
  const unimplemented = () => {
    throw new Error('not implemented in stub');
  };
  return {
    connect: unimplemented,
    disconnect: unimplemented as () => void,
    isConnected: () => false,
    isReconnecting: () => false,
    invoke: unimplemented,
    onStateChange: () => () => {},
    onError: () => () => {},
    onConnectionInfo: () => () => {},
    onReconnection: () => () => {},
    onKeyBindings: () => () => {},
    onLog: () => () => {},
    onFatal: () => () => {},
    ...overrides,
  };
}

describe('toEffectAdapter', () => {
  it('invoke success returns the resolved value', async () => {
    const adapter = makeStubAdapter({
      invoke: (async () => 42) as TmuxAdapter['invoke'],
    });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.invoke<number>('get_initial_state'));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(42);
    }
  });

  it('invoke promise rejection classifies as TmuxError when backend returns { error }', async () => {
    const adapter = makeStubAdapter({
      invoke: (async () => {
        throw { error: 'no such pane: %999' };
      }) as TmuxAdapter['invoke'],
    });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.invoke<void>('kill-pane -t %999'));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TmuxError/);
      expect(json).toMatch(/kill-pane -t %999/);
    }
  });

  it('invoke promise rejection with Error instance classifies as TransportError', async () => {
    const adapter = makeStubAdapter({
      invoke: (async () => {
        throw new Error('socket hang up');
      }) as TmuxAdapter['invoke'],
    });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.invoke<void>('connect'));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TransportError/);
    }
  });

  it('connect success completes', async () => {
    const adapter = makeStubAdapter({
      connect: vi.fn(async () => {}),
    });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.connect());
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('switchSession falls back to TransportError when adapter lacks the method', async () => {
    const adapter = makeStubAdapter({});
    delete (adapter as Partial<TmuxAdapter>).switchSession;
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.switchSession('demo'));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TransportError/);
      expect(json).toMatch(/switchSession not supported/);
    }
  });

  it('disconnect forwards to underlying adapter synchronously', () => {
    const disconnect = vi.fn();
    const adapter = makeStubAdapter({ disconnect });
    const eff = toEffectAdapter(adapter);
    eff.disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('decodingInvoke returns decoded value when payload matches the schema', async () => {
    const { Schema } = await import('effect');
    const adapter = makeStubAdapter({
      invoke: (async () => ({ count: 3, label: 'ok' })) as TmuxAdapter['invoke'],
    });
    const schema = Schema.Struct({ count: Schema.Number, label: Schema.String });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.decodingInvoke('some_cmd', schema));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ count: 3, label: 'ok' });
    }
  });

  it('decodingInvoke surfaces ProtocolError (not TmuxError) when payload fails to decode', async () => {
    const { Schema } = await import('effect');
    const adapter = makeStubAdapter({
      invoke: (async () => ({ count: 'three' })) as TmuxAdapter['invoke'],
    });
    const schema = Schema.Struct({ count: Schema.Number });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.decodingInvoke('some_cmd', schema));
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
    const adapter = makeStubAdapter({
      invoke: (async () => {
        throw { error: 'no such command' };
      }) as TmuxAdapter['invoke'],
    });
    const schema = Schema.Struct({ count: Schema.Number });
    const eff = toEffectAdapter(adapter);
    const exit = await Effect.runPromiseExit(eff.decodingInvoke('bogus_cmd', schema));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TmuxError/);
      expect(json).not.toMatch(/ProtocolError/);
    }
  });

  it('typed errors enable exhaustive pattern matching on _tag', async () => {
    const adapter = makeStubAdapter({
      invoke: (async () => {
        throw { error: 'pane does not exist' };
      }) as TmuxAdapter['invoke'],
    });
    const eff = toEffectAdapter(adapter);

    // The whole point of typing errors: handle them by tag.
    const program = eff.invoke<void>('kill-pane').pipe(
      Effect.catchTags({
        TmuxError: (e) => Effect.succeed(`tmux said: ${e.stderr}`),
        TransportError: () => Effect.succeed('network down'),
        ProtocolError: () => Effect.succeed('bad protocol'),
        Cancelled: () => Effect.succeed('cancelled'),
      }),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe('tmux said: pane does not exist');
  });
});
