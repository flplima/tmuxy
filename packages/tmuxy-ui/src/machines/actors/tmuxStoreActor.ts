/**
 * tmuxStoreActor — Bridge between the TmuxStore and XState.
 *
 * Responsibilities:
 *  1. Subscribe to the store and forward every model change to the parent as
 *     a TMUX_MODEL_UPDATE event. This is how local optimistic patches and
 *     server reconciliations both reach the XState context.
 *  2. Expose a DISPATCH_OP receiver: the parent routes every op here (see
 *     `routeOp`), and the actor runs it through `store.dispatch`. The store
 *     applies the predicted patch synchronously (caller sees the change
 *     before the network round-trip), then awaits the adapter for the real
 *     round-trip.
 *  3. Log dispatched commands via LOG_APPEND (the debug log), and surface a
 *     failed dispatch — or a structural op tmux never confirmed — as
 *     TMUX_ERROR.
 *
 * Why a callback actor and not direct context access:
 *   The store lives in plain JS-land; the bridge actor is the single place
 *   that runs its dispatch (the one Effect, which needs the transport) on the
 *   app runtime. That keeps the XState code free of Effect and makes the
 *   actor easy to swap for a mock in integration tests.
 */

import { Exit, Cause } from 'effect';
import type { PaneId } from '../../domain/ids';
import { fromCallback, type AnyActorRef } from 'xstate';
import type { TmuxStore } from '../../infra/store/TmuxStore';
import { toTmuxCommand, type TmuxOp } from '../../domain/commands';
import type { ServerState } from '../../domain/wire';
import { tracer } from '../../infra/tracer';
import { isInputCommand, READ_ONLY_NOTICE } from '../../domain/readOnly';
import type { AppRuntime } from '../../infra/runtime';

/** Extract only content-free id/direction fields from a typed op for the trace.
 * Deliberately excludes `RenameWindow.name` and any free text. */
function traceOp(op: TmuxOp): void {
  const o = op as Record<string, unknown>;
  const pane = (o.paneId ?? o.sourcePaneId ?? o.clickedPaneId) as string | null | undefined;
  const window = o.windowId as string | null | undefined;
  const kind = typeof o.direction === 'string' ? o.direction : undefined;
  tracer.event({
    layer: 'store',
    name: op._tag,
    pane: pane ?? undefined,
    window: window ?? undefined,
    kind,
  });
}

export type TmuxStoreActorEvent =
  /**
   * Dispatch an op. `command`, when given, is the exact string to send in
   * place of the op's own form — a parsed binding keeps its pin and flags.
   */
  | { type: 'DISPATCH_OP'; op: TmuxOp; command?: string }
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
      paneActivationOrder: readonly PaneId[];
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
 * supply a fresh store per test for isolation. Dispatches run on the app
 * runtime, which provides the transport they send through.
 */
export function createTmuxStoreActor(store: TmuxStore, runtime: AppRuntime) {
  return fromCallback<TmuxStoreActorEvent, TmuxStoreActorInput>(({ input, receive }) => {
    const { parent } = input;

    const unsubscribe = store.subscribe((model) => {
      parent.send({ type: 'TMUX_MODEL_UPDATE', model });
    });

    const dispatchWithErrorSurface = (
      program: ReturnType<TmuxStore['dispatch']>,
      command: string,
    ): void => {
      void runtime.runPromiseExit(program).then((exit) => {
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          if (failure._tag === 'Some') {
            const e = failure.value;
            if (e._tag === 'OpBlockedReadOnly') {
              if (!isInputCommand(e.command))
                parent.send({ type: 'NOTIFY', text: READ_ONLY_NOTICE });
              return;
            }
            // Trace the failure by its typed code — never the stderr text.
            tracer.event({ layer: 'effect', name: 'fail', code: e._tag });
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
        const command = event.command ?? toTmuxCommand(event.op);
        parent.send({ type: 'LOG_APPEND', kind: 'command', message: command });
        traceOp(event.op);
        // Fire-and-forget — the store rolls a failed op back on its own (the
        // next TMUX_MODEL_UPDATE reflects it); dispatchWithErrorSurface
        // reports the failure.
        dispatchWithErrorSurface(store.dispatch(event.op, { command }), command);
        return;
      }

      if (event.type === 'RECONCILE_SERVER') {
        // Synchronous — the listener fires inline.
        const rolledBack = store.reconcile(event.state);
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
        store.clear();
        return;
      }

      if (event.type === 'UPDATE_PREDICT_CONTEXT') {
        store.setPredictContext({
          defaultShell: event.defaultShell,
          paneActivationOrder: event.paneActivationOrder,
        });
        return;
      }
    });

    return () => {
      unsubscribe();
    };
  });
}
