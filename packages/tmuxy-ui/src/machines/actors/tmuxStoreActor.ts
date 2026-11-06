/**
 * The bridge between the TmuxStore and the app machine. Every model change
 * (an optimistic patch or a server reconciliation) reaches the parent as
 * TMUX_MODEL_UPDATE; every op the parent routes (`routeOp` in
 * app/dispatch.ts) runs through `store.dispatch`, which applies its predicted
 * patch at once and then awaits tmux. A failed dispatch, or a structural op
 * tmux never confirmed, is surfaced as TMUX_ERROR. The actor is the one place
 * the store's Effects run on the app runtime, so the machine stays free of
 * Effect.
 */

import { isStructural } from '../../domain/opTraits';
import { Exit } from 'effect';
import { failureText } from './failureText';
import { fromCallback, type AnyActorRef } from 'xstate';
import type { TmuxStore } from '../../infra/store/TmuxStore';
import { toTmuxCommand, type TmuxOp } from '../../domain/commands';
import type { ServerState } from '../../domain/wire';
import { tracer } from '../../infra/tracer';
import type { AppRuntime } from '../../infra/runtime';

/** An op's ids and direction for the trace: never a name or any free text. */
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
   * Dispatch an op: only `routeOp` sends this. `wire`, when given, is the
   * string the op was parsed from, sent in place of the op's own form.
   */
  | { type: 'STORE_DISPATCH'; op: TmuxOp; wire?: string }
  | { type: 'RECONCILE_SERVER'; state: ServerState }
  /**
   * Drop every pending op and snapshot, on SWITCH_SESSION: the old session's
   * ops would otherwise reconcile against the new one's ids until they went
   * stale (OP_STALE_TIMEOUT_MS).
   */
  | { type: 'CLEAR' }
  | { type: 'SET_DEFAULT_SHELL'; shell: string };

export interface TmuxStoreActorInput {
  parent: AnyActorRef;
}

export function createTmuxStoreActor(store: TmuxStore, runtime: AppRuntime) {
  return fromCallback<TmuxStoreActorEvent, TmuxStoreActorInput>(({ input, receive }) => {
    const { parent } = input;

    const unsubscribe = store.subscribe((model) => {
      parent.send({ type: 'TMUX_MODEL_UPDATE', model });
    });

    // Whether a snapshot or the store's idle sweep rolled the op back, the
    // user sees the same thing: their split/kill/tab just disappeared.
    const unsubscribeRollbacks = store.subscribeRollbacks((rolledBack) => {
      for (const entry of rolledBack) {
        console.warn(`[TmuxStore] rolled back ${entry.op._tag} op ${entry.opId}: ${entry.reason}`);
        // A structural op rolling back is a user-visible revert — surface it
        // like a rejection so the status line explains WHY instead of the UI
        // silently snapping back. Focus-op rollbacks are cosmetic
        // supersession noise; keep those console-only.
        // 'previously failed' entries already surfaced their error when
        // dispatchRemote rejected — re-sending here would double-report.
        if (isStructural(entry.op) && entry.reason !== 'previously failed') {
          parent.send({
            type: 'TMUX_ERROR',
            error: `${entry.op._tag} was not confirmed by tmux (${entry.reason})`,
          });
        }
      }
    });

    const dispatchWithErrorSurface = (
      program: ReturnType<TmuxStore['dispatch']>,
      command: string,
    ): void => {
      void runtime.runPromiseExit(program).then((exit) => {
        if (Exit.isSuccess(exit)) return;
        const reason = failureText(exit.cause);
        if (reason !== null) parent.send({ type: 'TMUX_ERROR', error: `${command}: ${reason}` });
      });
    };

    receive((event) => {
      if (event.type === 'STORE_DISPATCH') {
        const command = event.wire ?? toTmuxCommand(event.op);
        parent.send({ type: 'LOG_APPEND', kind: 'command', message: command });
        traceOp(event.op);
        // Fire-and-forget — the store rolls a failed op back on its own (the
        // next TMUX_MODEL_UPDATE reflects it); dispatchWithErrorSurface
        // reports the failure.
        dispatchWithErrorSurface(store.dispatch(event.op, { wire: event.wire }), command);
        return;
      }

      if (event.type === 'RECONCILE_SERVER') {
        // Synchronous — the listeners fire inline.
        store.reconcile(event.state);
        return;
      }

      if (event.type === 'CLEAR') {
        store.clear();
        return;
      }

      if (event.type === 'SET_DEFAULT_SHELL') {
        store.setDefaultShell(event.shell);
        return;
      }
    });

    return () => {
      unsubscribe();
      unsubscribeRollbacks();
    };
  });
}
