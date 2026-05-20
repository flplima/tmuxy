/**
 * Compound operations: multi-step Effect programs with structured rollback.
 *
 * What these solve that ad-hoc `await a(); await b()` chains don't:
 *
 * 1. **Rollback on partial failure.** If step 2 of a 2-step operation
 *    fails, we explicitly undo step 1 (kill the just-created window,
 *    restore the prior pane focus, etc.) instead of leaving the world in
 *    an inconsistent state.
 *
 * 2. **Cancellation.** Forking the program returns a Fiber that can be
 *    interrupted. If the user kicks off another conflicting operation
 *    mid-flight, the prior one is dropped cleanly.
 *
 * 3. **Single error channel.** Every step returns Effect<_, AdapterError>,
 *    so callers pattern-match one ADT instead of three try/catches.
 *
 * The operations themselves are pure data describing the work — they
 * accept an Effect-based invoke function as input so they're trivially
 * testable with a mock.
 */

import { Context, Effect } from 'effect';
import { ProtocolError, type AdapterError } from './AdapterError';

/**
 * The thin slice of EffectTmuxAdapter that compound operations need.
 * Passing this in (rather than the full adapter) keeps the operations
 * unit-testable with a one-method mock.
 */
export interface CompoundOpsContext {
  readonly invoke: <T>(
    cmd: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<T, AdapterError>;
}

/**
 * Single-quote an arg for tmux command strings. tmux's quote-handling is
 * shell-like, so escape any embedded single quotes by closing-quoting-
 * escaping-reopening.
 */
function tmuxQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Tag for the CompoundOps context — supplied via Effect.provideService
 * at the call site so the operations themselves stay testable.
 */
export class CompoundOps extends Context.Tag('tmuxy/CompoundOps')<
  CompoundOps,
  CompoundOpsContext
>() {}

/**
 * Create a new tmux window and rename it in one transaction.
 *
 * If the rename fails, the new window is killed so we don't leave a
 * misnamed orphan. If the kill itself fails, the original rename error
 * is still what surfaces — the user sees the actual problem, not the
 * janitor's secondary failure.
 *
 * Returns the new window's tmux ID (e.g. "@7") on success.
 */
export function createAndRenameWindow(
  name: string,
): Effect.Effect<string, AdapterError, CompoundOps> {
  return Effect.gen(function* () {
    const ctx = yield* CompoundOps;

    // Step 1: create the window and capture its tmux ID via -P -F.
    const created = yield* ctx.invoke<{ window_id?: string } | string>('run_tmux_command', {
      command: 'new-window -P -F "#{window_id}"',
    });
    const windowId =
      typeof created === 'string' ? created.trim() : (created?.window_id ?? '').trim();
    if (!windowId) {
      // The Rust backend should always return a window_id; if it doesn't,
      // there's nothing to clean up since we don't know what was created.
      return yield* Effect.fail(
        new ProtocolError({ reason: 'new-window did not return a window_id' }),
      );
    }

    // Step 2: rename. On failure, kill the just-created window — but
    // always preserve and re-raise the ORIGINAL rename error so the user
    // sees the real cause, not the janitor's exit code.
    yield* ctx
      .invoke<void>('run_tmux_command', {
        command: `rename-window -t ${windowId} ${tmuxQuote(name)}`,
      })
      .pipe(
        Effect.catchAll((renameErr) =>
          ctx
            .invoke<void>('run_tmux_command', {
              command: `kill-window -t ${windowId}`,
            })
            // Always re-raise the rename error, whether cleanup succeeded
            // or also failed.
            .pipe(
              Effect.flatMap(() => Effect.fail(renameErr)),
              Effect.catchAll(() => Effect.fail(renameErr)),
            ),
        ),
      );

    return windowId;
  });
}

/**
 * Acquire-use-release window: like a try/finally but the cleanup runs
 * even on Effect interruption.
 *
 * Use case: an optimistic preview that needs a dedicated tmux window
 * during its display, and that window MUST be killed when the preview
 * ends — whether the preview completes normally, errors, or the user
 * cancels mid-flight.
 */
export function withTemporaryWindow<A, E>(
  name: string,
  use: (windowId: string) => Effect.Effect<A, E, CompoundOps>,
): Effect.Effect<A, E | AdapterError, CompoundOps> {
  return Effect.gen(function* () {
    const ctx = yield* CompoundOps;
    return yield* Effect.acquireUseRelease(createAndRenameWindow(name), use, (windowId) =>
      ctx
        .invoke<void>('run_tmux_command', { command: `kill-window -t ${windowId}` })
        // Cleanup failure is logged but never overrides the use-block's
        // outcome — the operation succeeded or failed for its own reason.
        .pipe(Effect.catchAll(() => Effect.void)),
    );
  });
}
