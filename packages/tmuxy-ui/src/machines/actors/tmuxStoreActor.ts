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
import type { ServerState } from '../../tmux/types';

export type TmuxStoreActorEvent =
  /**
   * Forward a tmux command from SEND_TMUX_COMMAND to the store.
   * `skipPrediction: true` is the escape hatch for code paths that already
   * own the optimistic visual (the drag machine pre-shuffles pane positions
   * for the duration of a drag).
   */
  | { type: 'DISPATCH_COMMAND'; command: string; skipPrediction?: boolean }
  /** Push a fresh server snapshot into the store's reconciler. */
  | { type: 'RECONCILE_SERVER'; state: ServerState }
  /** Reset the store after a session-changed or initial-state full snapshot. */
  | { type: 'RESET_TO_SERVER'; state: ServerState }
  /** Update the predict context (defaultShell or paneActivationOrder changed). */
  | {
      type: 'UPDATE_PREDICT_CONTEXT';
      defaultShell: string;
      paneActivationOrder: readonly string[];
    };

export interface TmuxStoreActorInput {
  parent: AnyActorRef;
}

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

    receive((event) => {
      if (event.type === 'DISPATCH_COMMAND') {
        parent.send({ type: 'LOG_APPEND', kind: 'command', message: event.command });
        // Fire-and-forget — the store handles rollback on its own. We swallow
        // OpError because the store has already updated the model; the next
        // TMUX_MODEL_UPDATE will reflect the rolled-back state. Logged here
        // for debuggability.
        const opts = event.skipPrediction ? { skipPrediction: true } : undefined;
        void Effect.runPromiseExit(store.dispatchCommand(event.command, opts)).then((exit) => {
          if (Exit.isFailure(exit)) {
            const failure = Cause.failureOption(exit.cause);
            if (failure._tag === 'Some') {
              const e = failure.value;
              const reason =
                e._tag === 'OpRejectedByTmux'
                  ? e.stderr
                  : e._tag === 'OpTimedOut'
                    ? `timed out after ${e.elapsedMs}ms`
                    : String((e as { cause?: unknown }).cause ?? 'transport error');
              parent.send({
                type: 'TMUX_ERROR',
                error: `${event.command}: ${reason}`,
              });
            }
          }
        });
        return;
      }

      if (event.type === 'RECONCILE_SERVER') {
        // Synchronous — Ref ops don't block, listener fires inline.
        const rolledBack = Effect.runSync(store.reconcile(event.state));
        for (const entry of rolledBack) {
          console.warn(
            `[TmuxStore] rolled back ${entry.op._tag} op ${entry.opId}: ${entry.reason}`,
          );
        }
        return;
      }

      if (event.type === 'RESET_TO_SERVER') {
        Effect.runSync(store.resetToServer(event.state));
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
