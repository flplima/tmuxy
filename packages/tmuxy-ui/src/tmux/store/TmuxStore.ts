/**
 * TmuxStore — the client model, its optimistic dispatch and reconciliation.
 *
 * Responsibilities:
 *  - Hold the model. Subscribers are notified whenever `derived` changes
 *    shape. Everything here is synchronous except the send to tmux, which is
 *    why only `dispatch` is an Effect (it needs the transport).
 *  - `dispatch(op)` runs predict → apply optimistic patch → send command →
 *    on tmux error: rollback. The matching server delta clears the op via
 *    `reconcile`.
 *  - `reconcile(snapshot)` is the entry point for fresh server state. Runs
 *    every pending op's reconciler, drops matched/failed ones, recomputes
 *    `derived`, surfaces rollback warnings to the caller.
 *
 * The store does NOT own React subscriptions directly — it exposes a plain
 * subscribe API; the appMachine bridges them so XState `context` stays the
 * single source consumed by the rest of the codebase. That keeps every
 * existing selector and hook working without modification.
 */

import { Effect } from 'effect';
import { formatAdapterError } from '../effect/AdapterError';
import { TmuxTransport } from '../../infra/transport/TmuxTransport';
import type { ServerState } from '../../domain/wire';
import { preserveSnapshotIdentity, transformServerState } from './adapters';
import { toTmuxCommand, type TmuxOp } from '../../domain/commands';
import {
  addPendingOp,
  applyServerSnapshot,
  dropSupersededFocusOps,
  generateOpId,
  makePendingOp,
  rollbackOp,
  setViewFocus,
  type RollbackEntry,
} from './model';
import type { PredictContext } from './ops';
import { predict } from './ops';
import type { OpError, OpId, TmuxClientModel } from './types';
import { EMPTY_MODEL, OpBlockedReadOnly, OpRejectedByTmux, OpTransportError } from './types';

export interface DispatchOptions {
  /**
   * Override the wire-format command string sent to tmux. Use this when the
   * caller has the full original command (including format strings like
   * `-c "#{pane_current_path}"` or the `select-pane -t %N \;` prefix-pin
   * the keyboardActor injects) and `toTmuxCommand(op)` would lose information.
   * The op is still used for prediction; only the command string changes.
   */
  readonly command?: string;
}

export type StoreListener = (model: TmuxClientModel) => void;

export interface TmuxStore {
  /** Current model snapshot. */
  readonly getModel: () => TmuxClientModel;

  /**
   * Push a typed op through the optimistic dispatch pipeline. Returns the
   * Effect so the caller can fork, race, or compose. The predicted patch
   * applies synchronously when the Effect starts (listeners fire before the
   * adapter call), then the command goes to tmux; if the send fails the op
   * is rolled back from the model.
   */
  readonly dispatch: (
    op: TmuxOp,
    opts?: DispatchOptions,
  ) => Effect.Effect<OpId, OpError, TmuxTransport>;

  /**
   * Apply a fresh server snapshot. Reconciles every pending op, drops
   * matched/stale ones, recomputes `derived`, and returns any rollback
   * entries the caller wants to log. This is the single entry point from
   * the SSE/Tauri state stream.
   */
  readonly reconcile: (state: ServerState) => ReadonlyArray<RollbackEntry>;

  /**
   * Drop everything (committed, ops, paneKeyOverrides). Used on session
   * switch when we don't yet have a new server snapshot to reset against —
   * the store starts empty and rebuilds on the next reconcile.
   */
  readonly clear: () => void;

  /**
   * Subscribe to model changes. The listener fires after every committed
   * mutation — both server reconciliations and local dispatches. Returns
   * an unsubscribe function. Listeners are invoked synchronously by the
   * mutation.
   */
  readonly subscribe: (listener: StoreListener) => () => void;

  /** Update the default PredictContext (called when defaultShell / MRU change). */
  readonly setPredictContext: (ctx: PredictContext) => void;
}

/** The ops that only move focus — all a read-only client can act on, and only locally. */
const VIEW_OPS: ReadonlySet<TmuxOp['_tag']> = new Set(['SelectWindow', 'SelectPane', 'Navigate']);

export function makeTmuxStore(): TmuxStore {
  let model: TmuxClientModel = EMPTY_MODEL;
  let predictContext: PredictContext = { defaultShell: 'bash', paneActivationOrder: [] };
  const listeners = new Set<StoreListener>();

  /** Replace the model and tell every subscriber. */
  const commit = (next: TmuxClientModel): void => {
    model = next;
    for (const l of listeners) {
      try {
        l(next);
      } catch (err) {
        console.error('[TmuxStore] listener threw:', err);
      }
    }
    scheduleIdleReconcile(next);
  };

  /** Change an op's status only: derived is unaffected, so nobody is told. */
  const setStatus = (opId: OpId, status: 'in-flight' | 'awaiting-confirm'): TmuxClientModel => {
    model = { ...model, ops: model.ops.map((o) => (o.id === opId ? { ...o, status } : o)) };
    return model;
  };

  // Age-based verdicts (stale sweeps, focus-linger release, supersession)
  // are computed inside reconcile passes — which are normally driven by
  // server snapshots. On an IDLE control stream no snapshot ever arrives,
  // so a wrong pin (a zoomed-geometry patch after a rapid re-toggle, a
  // superseded focus op) would wedge forever. While ops are pending,
  // re-reconcile against the unchanged committed snapshot on a timer so
  // time-based verdicts fire even with nothing on the wire.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const IDLE_RECONCILE_MS = 500;
  const scheduleIdleReconcile = (current: TmuxClientModel): void => {
    if (current.ops.length === 0) return;
    if (idleTimer !== null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (model.ops.length === 0) return;
      const result = applyServerSnapshot(model, model.committed, Date.now());
      for (const entry of result.rolledBack) {
        console.warn(`[TmuxStore] idle-swept ${entry.op._tag} op ${entry.opId}: ${entry.reason}`);
      }
      commit(result.model);
    }, IDLE_RECONCILE_MS);
  };

  const applyOptimistic = (op: TmuxOp, opts?: DispatchOptions): { opId: OpId; command: string } => {
    const opId = generateOpId();
    // Prefer the caller's explicit command string (preserves keyboardActor's
    // `select-pane -t %N \;` prefix-pin and tmux format strings like
    // `-c "#{pane_current_path}"`). Fall back to the op's canonical form
    // only for ops constructed in-code (SELECT_TAB → SelectWindow{target}).
    const command = opts?.command ?? toTmuxCommand(op);
    const result = predict(op, model.derived, predictContext, opId);
    const pending = result
      ? makePendingOp({ id: opId, op, command, patch: result.patch, meta: result.meta })
      : makePendingOp({ id: opId, op, command, patch: (s) => s, meta: {} });
    commit(addPendingOp(dropSupersededFocusOps(model, op), pending));
    return { opId, command };
  };

  const dispatchRemote = (
    transport: TmuxTransport['Type'],
    opId: OpId,
    command: string,
  ): Effect.Effect<OpId, OpError> =>
    Effect.suspend(() => {
      // Mark in-flight BEFORE the adapter call: the ack can take longer than
      // the quick stale sweep, and a swept op would blink the optimistic UI
      // away and remount when the confirm finally lands.
      setStatus(opId, 'in-flight');
      return transport.invoke('run_tmux_command', { command });
    }).pipe(
      Effect.matchEffect({
        onFailure: (err) => {
          const { model: rolledBack, entry } = rollbackOp(model, opId, formatAdapterError(err));
          commit(rolledBack);
          if (entry) {
            console.warn(`[TmuxStore] rolled back op ${opId} (${entry.op._tag}): ${entry.reason}`);
          }
          return Effect.fail(
            err._tag === 'TmuxError'
              ? new OpRejectedByTmux({ opId, command, stderr: err.stderr })
              : new OpTransportError({ opId, command, cause: err }),
          );
        },
        // Sent — reconcile() drops it when a matching delta arrives, or the
        // stale-timeout sweeps it.
        onSuccess: () =>
          Effect.sync(() => {
            commit(setStatus(opId, 'awaiting-confirm'));
            return opId;
          }),
      }),
    );

  /**
   * Read-only focus: where `op` would move the focus becomes this client's
   * view. A pane in another tab takes the view to that tab; a pane in a
   * float or a sidebar leaves it alone, since those take the keyboard
   * without tmux's focus moving at all.
   */
  const moveView = (op: TmuxOp): void => {
    const predicted = predict(op, model.derived, predictContext, generateOpId());
    if (!predicted) return;
    const target = predicted.patch(model.derived);
    const pane = target.panes.find((p) => p.tmuxId === target.activePaneId);
    const paneWindow = target.windows.find((w) => w.id === pane?.windowId);
    let windowId = target.activeWindowId;
    if (paneWindow && paneWindow.id !== windowId) {
      if (paneWindow.windowType !== 'tab') return;
      windowId = paneWindow.id;
    }
    if (!windowId) return;
    commit(setViewFocus(model, { windowId, paneId: target.activePaneId }));
  };

  return {
    getModel: () => model,

    /**
     * A read-only session (asked at each dispatch: the transport only learns
     * it once connected) sends tmux nothing: a focus op moves this client's
     * own view, and every other op is refused unpredicted.
     */
    dispatch: (op, opts) =>
      Effect.flatMap(TmuxTransport, (transport) => {
        if (transport.isReadOnly()) {
          const command = opts?.command ?? toTmuxCommand(op);
          if (!VIEW_OPS.has(op._tag)) return Effect.fail(new OpBlockedReadOnly({ command }));
          moveView(op);
          return Effect.succeed(generateOpId());
        }
        const { opId, command } = applyOptimistic(op, opts);
        return dispatchRemote(transport, opId, command);
      }),

    reconcile: (state) => {
      // Reuse previous objects for anything value-equal — wire snapshots are
      // fresh object graphs, and without identity preservation every tick
      // re-renders every pane (see preserveSnapshotIdentity).
      const snapshot = preserveSnapshotIdentity(model.committed, transformServerState(state));
      const result = applyServerSnapshot(model, snapshot, Date.now());
      commit(result.model);
      return result.rolledBack;
    },

    clear: () => commit(EMPTY_MODEL),

    subscribe: (listener) => {
      listeners.add(listener);
      // Fire once on subscribe so the bridge can sync immediately.
      try {
        listener(model);
      } catch (err) {
        console.error('[TmuxStore] initial listener call threw:', err);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    setPredictContext: (ctx) => {
      predictContext = ctx;
    },
  };
}
