import { describe, it, expect, vi } from 'vitest';
import { Effect, Exit } from 'effect';
import {
  CompoundOps,
  createAndRenameWindow,
  withTemporaryWindow,
  type CompoundOpsContext,
} from '../compoundOps';
import { TmuxError, type AdapterError } from '../AdapterError';

/** Build a CompoundOps context with a scripted invoke. */
function mockCtx(
  responses: Array<
    | { cmd: 'new-window'; result: unknown }
    | { cmd: 'rename-window'; result?: void; throws?: AdapterError }
    | { cmd: 'kill-window'; result?: void; throws?: AdapterError }
  >,
): { ctx: CompoundOpsContext; calls: Array<{ cmd: string; args: unknown }> } {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  let i = 0;
  const ctx: CompoundOpsContext = {
    invoke: <T>(
      _adapterCmd: string,
      args?: Record<string, unknown>,
    ): Effect.Effect<T, AdapterError> => {
      const command = String((args as { command: string }).command);
      const kind = command.startsWith('new-window')
        ? 'new-window'
        : command.startsWith('rename-window')
          ? 'rename-window'
          : command.startsWith('kill-window')
            ? 'kill-window'
            : 'unknown';
      calls.push({ cmd: kind, args: command });
      const step = responses[i++];
      if (!step) {
        return Effect.fail(
          new TmuxError({ command, stderr: `unscripted call: ${command}` }),
        );
      }
      if (step.cmd !== kind) {
        return Effect.fail(
          new TmuxError({ command, stderr: `expected ${step.cmd}, got ${kind}` }),
        );
      }
      if ('throws' in step && step.throws) {
        return Effect.fail(step.throws);
      }
      return Effect.succeed('result' in step ? (step.result as T) : (undefined as T));
    },
  };
  return { ctx, calls };
}

describe('createAndRenameWindow', () => {
  it('returns the new window ID on success', async () => {
    const { ctx, calls } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@7' } },
      { cmd: 'rename-window' },
    ]);
    const exit = await Effect.runPromiseExit(
      createAndRenameWindow('hello').pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe('@7');
    }
    expect(calls.map((c) => c.cmd)).toEqual(['new-window', 'rename-window']);
  });

  it('accepts a plain string window_id return', async () => {
    const { ctx } = mockCtx([
      { cmd: 'new-window', result: '@9' },
      { cmd: 'rename-window' },
    ]);
    const exit = await Effect.runPromiseExit(
      createAndRenameWindow('x').pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe('@9');
  });

  it('escapes single quotes in the rename name', async () => {
    const { ctx, calls } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@1' } },
      { cmd: 'rename-window' },
    ]);
    await Effect.runPromiseExit(
      createAndRenameWindow("my'name").pipe(Effect.provideService(CompoundOps, ctx)),
    );
    const renameCall = calls[1];
    expect(renameCall.args).toContain("'my'\\''name'");
  });

  it('rolls back (kill-window) if rename fails', async () => {
    const renameErr = new TmuxError({
      command: 'rename-window',
      stderr: 'duplicate name',
    });
    const { ctx, calls } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@7' } },
      { cmd: 'rename-window', throws: renameErr },
      { cmd: 'kill-window' }, // janitor succeeds
    ]);
    const exit = await Effect.runPromiseExit(
      createAndRenameWindow('dup').pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TmuxError/);
      expect(json).toMatch(/duplicate name/);
    }
    expect(calls.map((c) => c.cmd)).toEqual([
      'new-window',
      'rename-window',
      'kill-window',
    ]);
  });

  it('re-raises the original rename error even if cleanup ALSO fails', async () => {
    const renameErr = new TmuxError({
      command: 'rename-window',
      stderr: 'permission denied',
    });
    const cleanupErr = new TmuxError({
      command: 'kill-window',
      stderr: 'window in use',
    });
    const { ctx } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@7' } },
      { cmd: 'rename-window', throws: renameErr },
      { cmd: 'kill-window', throws: cleanupErr },
    ]);
    const exit = await Effect.runPromiseExit(
      createAndRenameWindow('bad').pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      // ORIGINAL error must be what surfaces, not the janitor's
      expect(json).toMatch(/permission denied/);
      expect(json).not.toMatch(/window in use/);
    }
  });

  it('fails with ProtocolError if new-window returns no window_id', async () => {
    const { ctx } = mockCtx([{ cmd: 'new-window', result: { window_id: '' } }]);
    const exit = await Effect.runPromiseExit(
      createAndRenameWindow('foo').pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/ProtocolError/);
      expect(json).toMatch(/window_id/);
    }
  });
});

describe('withTemporaryWindow', () => {
  it('runs use() with the window ID and always kills the window after', async () => {
    const { ctx, calls } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@5' } },
      { cmd: 'rename-window' },
      { cmd: 'kill-window' }, // teardown
    ]);
    const use = vi.fn((windowId: string) => Effect.succeed(windowId.toUpperCase()));
    const exit = await Effect.runPromiseExit(
      withTemporaryWindow('preview', use).pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe('@5');
    expect(use).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.cmd)).toEqual(['new-window', 'rename-window', 'kill-window']);
  });

  it('kills the temporary window even if use() throws', async () => {
    const { ctx, calls } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@5' } },
      { cmd: 'rename-window' },
      { cmd: 'kill-window' },
    ]);
    const useError = new TmuxError({ command: 'inner', stderr: 'use failed' });
    const use = () => Effect.fail(useError);
    const exit = await Effect.runPromiseExit(
      withTemporaryWindow('preview', use).pipe(Effect.provideService(CompoundOps, ctx)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.find((c) => c.cmd === 'kill-window')).toBeDefined();
  });

  it('swallows teardown errors so they do not override use()s result', async () => {
    const { ctx } = mockCtx([
      { cmd: 'new-window', result: { window_id: '@5' } },
      { cmd: 'rename-window' },
      {
        cmd: 'kill-window',
        throws: new TmuxError({ command: 'kill-window', stderr: 'gone' }),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      withTemporaryWindow('preview', () => Effect.succeed('all good')).pipe(
        Effect.provideService(CompoundOps, ctx),
      ),
    );
    // use() succeeded; teardown's failure must not poison the result
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe('all good');
  });
});
