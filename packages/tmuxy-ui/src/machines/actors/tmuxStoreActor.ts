/**
 * tmuxStoreActor — Bridge between the Effect-managed TmuxStore and XState.
 *
 * Responsibilities:
 *  1. Subscribe to the store and forward every model change to the parent as
 *     a TMUX_MODEL_UPDATE event. This is how local optimistic patches and
 *     server reconciliations both reach the XState context.
 *  2. Expose a DISPATCH_COMMAND receiver: the parent's SEND_TMUX_COMMAND
 *     handler relays the final command string here, and the actor runs it
 *     through `store.dispatchCommand`. The store applies the predicted
 *     patch synchronously (caller sees the change before the network
 *     round-trip), then awaits the adapter for the real round-trip.
 *  3. Log dispatched commands and rollback warnings via LOG_APPEND so the
 *     debug log stays populated.
 *
 * Why a callback actor and not direct context access:
 *   The store lives in plain JS-land (Effect.Ref); the bridge actor is the
 *   single place that runs Effect programs against it. Putting all the
 *   `Effect.runFork` / `runSync` calls in one file keeps the XState code
 *   free of Effect imports and makes the actor easy to swap for a mock in
 *   integration tests.
 */

import { Effect, Exit, Cause } from 'effect';
import { fromCallback, type AnyActorRef } from 'xstate';
import type { TmuxStore } from '../../tmux/store';
import type { TmuxOp } from '../../tmux/store/types';
import type { ServerState } from '../../tmux/types';

export type TmuxStoreActorEvent =
  /**
   * Forward a tmux command from SEND_TMUX_COMMAND to the store.
   * `skipPrediction: true` is the escape hatch for code paths that already
   * own the optimistic visual (the drag machine pre-shuffles pane positions
   * for the duration of a drag).
   */
  | { type: 'DISPATCH_COMMAND'; command: string; skipPrediction?: boolean }
  /**
   * Dispatch a TYPED op with an explicit wire command. For ops the command
   * parser cannot express (GroupSwitch rides a run-shell script call) —
   * prediction/reconciliation come from the op, the string goes to tmux.
   */
  | { type: 'DISPATCH_OP'; op: TmuxOp; command: string }
  /** Push a fresh server snapshot into the store's reconciler. */
  | { type: 'RECONCILE_SERVER'; state: ServerState }
  /**
   * Drop every pending op + committed/derived snapshot. Used on SWITCH_SESSION
   * before the new session's first state-update arrives — without this, pending
   * ops from the previous session would attempt to reconcile against the new
   * one (different pane/window ids) and stale-timeout 2 seconds later instead
   * of dropping immediately.
   */
  | { type: 'CLEAR' }
  /** Update the predict context (defaultShell or paneActivationOrder changed). */
  | {
      type: 'UPDATE_PREDICT_CONTEXT';
      defaultShell: string;
      paneActivationOrder: readonly string[];
    };

export interface TmuxStoreActorInput {
  parent: AnyActorRef;
}

/** Op kinds whose rollback visibly reverts the layout (vs. a focus pin). */
const STRUCTURAL_OPS = new Set([
  'Split',
  'NewWindow',
  'KillPane',
  'KillWindow',
  'RenameWindow',
  'ZoomToggle',
  'Swap',
]);

/**
 * Build the bridge actor. The store is captured in a closure; tests can
 * supply a fresh store per test for isolation.
 */
export function createTmuxStoreActor(store: TmuxStore) {
  return fromCallback<TmuxStoreActorEvent, TmuxStoreActorInput>(({ input, receive }) => {
    const { parent } = input;

    const unsubscribe = store.subscribe((model) => {
      parent.send({ type: 'TMUX_MODEL_UPDATE', model });
    });

    const dispatchWithErrorSurface = (
      program: ReturnType<TmuxStore['dispatchCommand']>,
      command: string,
    ): void => {
      void Effect.runPromiseExit(program).then((exit) => {
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          if (failure._tag === 'Some') {
            const e = failure.value;
            const reason =
              e._tag === 'OpRejectedByTmux'
                ? e.stderr
                : String((e as { cause?: unknown }).cause ?? 'transport error');
            parent.send({ type: 'TMUX_ERROR', error: `${command}: ${reason}` });
          }
        }
      });
    };

    receive((event) => {
      if (event.type === 'DISPATCH_OP') {
        parent.send({ type: 'LOG_APPEND', kind: 'command', message: event.command });
        dispatchWithErrorSurface(
          store.dispatch(event.op, { command: event.command }),
          event.command,
        );
        return;
      }

      if (event.type === 'DISPATCH_COMMAND') {
        parent.send({ type: 'LOG_APPEND', kind: 'command', message: event.command });
        // Fire-and-forget — the store handles rollback on its own. We swallow
        // OpError because the store has already updated the model; the next
        // TMUX_MODEL_UPDATE will reflect the rolled-back state. Logged here
        // for debuggability.
        const opts = event.skipPrediction ? { skipPrediction: true } : undefined;
        dispatchWithErrorSurface(store.dispatchCommand(event.command, opts), event.command);
        return;
      }

      if (event.type === 'RECONCILE_SERVER') {
        // Synchronous — Ref ops don't block, listener fires inline.
        const rolledBack = Effect.runSync(store.reconcile(event.state));
        for (const entry of rolledBack) {
          console.warn(
            `[TmuxStore] rolled back ${entry.op._tag} op ${entry.opId}: ${entry.reason}`,
          );
          // A structural op rolling back is a user-visible revert (their split/
          // kill/tab just disappeared) — surface it like a rejection so the
          // status line explains WHY instead of the UI silently snapping back.
          // Focus-op rollbacks are cosmetic supersession noise; keep those
          // console-only.
          // 'previously failed' entries already surfaced their error when
          // dispatchRemote rejected — re-sending here would double-report.
          if (STRUCTURAL_OPS.has(entry.op._tag) && entry.reason !== 'previously failed') {
            parent.send({
              type: 'TMUX_ERROR',
              error: `${entry.op._tag} was not confirmed by tmux (${entry.reason})`,
            });
          }
        }
        return;
      }

      if (event.type === 'CLEAR') {
        Effect.runSync(store.clear());
        return;
      }

      if (event.type === 'UPDATE_PREDICT_CONTEXT') {
        Effect.runSync(
          store.setPredictContext({
            defaultShell: event.defaultShell,
            paneActivationOrder: event.paneActivationOrder,
          }),
        );
        return;
      }
    });

    return () => {
      unsubscribe();
    };
  });
}
