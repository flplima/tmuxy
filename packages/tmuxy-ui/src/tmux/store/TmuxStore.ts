/**
 * TmuxStore — Effect-managed `Ref<TmuxClientModel>` with typed dispatch.
 *
 * Responsibilities:
 *  - Hold the model in a Ref. Subscribers are notified whenever `derived`
 *    changes shape.
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

import { Effect, Ref } from 'effect';
import type { AdapterError } from '../effect/AdapterError';
import type { EffectTmuxAdapter } from '../effect/EffectTmuxAdapter';
import type { ServerState } from '../types';
import { preserveSnapshotIdentity, transformServerState } from './adapters';
import { parseCommandToOp, toTmuxCommand } from './parseCommand';
import {
  addPendingOp,
  applyServerSnapshot,
  dropSupersededFocusOps,
  generateOpId,
  makePendingOp,
  rollbackOp,
  type RollbackEntry,
} from './model';
import type { PredictContext } from './ops';
import { predict } from './ops';
import type { OpError, OpId, PendingOp, TmuxClientModel, TmuxOp, TmuxSnapshot } from './types';
import { EMPTY_MODEL, OpRejectedByTmux, OpTransportError } from './types';

export interface DispatchOptions {
  /** Override the predict-time context (defaults to last-known values). */
  readonly predictContext?: PredictContext;
  /**
   * If true, skip the optimistic prediction entirely and just forward the
   * command. Useful for drag-time swaps where the dragMachine already owns
   * the optimistic state.
   */
  readonly skipPrediction?: boolean;
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
  /** Current model snapshot. Cheap — synchronous Ref read. */
  readonly getModel: () => TmuxClientModel;

  /**
   * Synchronously apply the predicted patch for `op` to the model.
   * Returns the new opId + the canonical command string. Listeners fire
   * inside this call, so any XState bridge subscribed via `subscribe`
   * already sees the new derived snapshot when this returns.
   *
   * The caller is responsible for running `dispatchRemote(opId, command)`
   * afterwards (or composing both via `dispatch`). This split lets callers
   * that need sync activePaneId updates (the keyboard-routing contract)
   * grab the new derived state in the same macrostep that initiated the
   * dispatch.
   */
  readonly applyOptimistic: (op: TmuxOp, opts?: DispatchOptions) => { opId: OpId; command: string };

  /**
   * Send a previously-applied op's command to tmux and reconcile the
   * result. On TmuxError the op is rolled back from the model. Fire-and-
   * forget via `Effect.runFork` at call sites that don't await the result.
   */
  readonly dispatchRemote: (opId: OpId, command: string) => Effect.Effect<OpId, OpError>;

  /**
   * Push a typed op through the optimistic dispatch pipeline. Returns the
   * Effect so the caller can fork, race, or compose. Equivalent to
   * `applyOptimistic(op)` followed by `dispatchRemote(opId, command)`.
   */
  readonly dispatch: (op: TmuxOp, opts?: DispatchOptions) => Effect.Effect<OpId, OpError>;

  /**
   * Parse a raw tmux command string into an op and dispatch it. Equivalent
   * to `dispatch(parseCommandToOp(cmd), opts)` but more convenient at call
   * sites that only have the string form.
   */
  readonly dispatchCommand: (
    command: string,
    opts?: DispatchOptions,
  ) => Effect.Effect<OpId, OpError>;

  /**
   * Apply a fresh server snapshot. Reconciles every pending op, drops
   * matched/stale ones, recomputes `derived`, and returns any rollback
   * entries the caller wants to log. This is the single entry point from
   * the SSE/Tauri state stream.
   */
  readonly reconcile: (state: ServerState) => Effect.Effect<ReadonlyArray<RollbackEntry>>;

  /**
   * Drop everything (committed, ops, paneKeyOverrides). Used on session
   * switch when we don't yet have a new server snapshot to reset against —
   * the store starts empty and rebuilds on the next reconcile.
   */
  readonly clear: () => Effect.Effect<void>;

  /**
   * Subscribe to model changes. The listener fires after every committed
   * mutation — both server reconciliations and local dispatches. Returns
   * an unsubscribe function. Listeners are invoked synchronously inside
   * the mutating Effect's continuation.
   */
  readonly subscribe: (listener: StoreListener) => () => void;

  /** Update the default PredictContext (called when defaultShell / MRU change). */
  readonly setPredictContext: (ctx: PredictContext) => Effect.Effect<void>;
}

/** Per-store config the appMachine wires in. */
export interface TmuxStoreConfig {
  readonly adapter: EffectTmuxAdapter;
}

export function makeTmuxStore(config: TmuxStoreConfig): Effect.Effect<TmuxStore> {
  return Effect.gen(function* () {
    const ref = yield* Ref.make<TmuxClientModel>(EMPTY_MODEL);
    const ctxRef = yield* Ref.make<PredictContext>({
      defaultShell: 'bash',
      paneActivationOrder: [],
    });
    const listeners = new Set<StoreListener>();

    const notify = (model: TmuxClientModel): void => {
      for (const l of listeners) {
        try {
          l(model);
        } catch (err) {
          console.error('[TmuxStore] listener threw:', err);
        }
      }
      scheduleIdleReconcile(model);
    };

    const getModel = () => Effect.runSync(Ref.get(ref));

    // Age-based verdicts (stale sweeps, focus-linger release, supersession)
    // are computed inside reconcile passes — which are normally driven by
    // server snapshots. On an IDLE control stream no snapshot ever arrives,
    // so a wrong pin (a zoomed-geometry patch after a rapid re-toggle, a
    // superseded focus op) would wedge forever. While ops are pending,
    // re-reconcile against the unchanged committed snapshot on a timer so
    // time-based verdicts fire even with nothing on the wire.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const IDLE_RECONCILE_MS = 500;
    const scheduleIdleReconcile = (model: TmuxClientModel): void => {
      if (model.ops.length === 0) return;
      if (idleTimer !== null) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        const current = getModel();
        if (current.ops.length === 0) return;
        const result = applyServerSnapshot(current, current.committed, Date.now());
        Effect.runSync(Ref.set(ref, result.model));
        for (const entry of result.rolledBack) {
          console.warn(`[TmuxStore] idle-swept ${entry.op._tag} op ${entry.opId}: ${entry.reason}`);
        }
        notify(result.model);
      }, IDLE_RECONCILE_MS);
    };

    const applyOptimistic = (
      op: TmuxOp,
      opts?: DispatchOptions,
    ): { opId: OpId; command: string } => {
      const opId = generateOpId();
      // Prefer the caller's explicit command string (preserves keyboardActor's
      // `select-pane -t %N \;` prefix-pin and tmux format strings like
      // `-c "#{pane_current_path}"`). Fall back to the op's canonical form
      // only for ops constructed in-code (SELECT_TAB → SelectWindow{target}).
      const command = opts?.command ?? toTmuxCommand(op);
      const ctx = opts?.predictContext ?? Effect.runSync(Ref.get(ctxRef));

      let pending: PendingOp;
      if (opts?.skipPrediction) {
        pending = makePendingOp({ id: opId, op, command, patch: (s) => s, meta: {} });
      } else {
        const currentModel = Effect.runSync(Ref.get(ref));
        const result = predict(op, currentModel.derived, ctx, opId);
        pending = result
          ? makePendingOp({ id: opId, op, command, patch: result.patch, meta: result.meta })
          : makePendingOp({ id: opId, op, command, patch: (s) => s, meta: {} });
      }

      const next = Effect.runSync(
        Ref.updateAndGet(ref, (m) => addPendingOp(dropSupersededFocusOps(m, op), pending)),
      );
      notify(next);
      return { opId, command };
    };

    const dispatchRemote = (opId: OpId, command: string): Effect.Effect<OpId, OpError> =>
      Effect.gen(function* () {
        // Mark in-flight BEFORE the adapter call: the ack can take longer than
        // the quick stale sweep, and a swept op would blink the optimistic UI
        // away and remount when the confirm finally lands. Status-only change —
        // derived is unaffected, so listeners are not notified here.
        yield* Ref.update(ref, (m) => ({
          ...m,
          ops: m.ops.map((o) => (o.id === opId ? { ...o, status: 'in-flight' as const } : o)),
        }));
        const sendResult = yield* Effect.either(
          config.adapter.invoke<unknown>('run_tmux_command', { command }),
        );
        if (sendResult._tag === 'Left') {
          const err = sendResult.left;
          const { model: rolledBackModel, entry } = rollbackOp(
            yield* Ref.get(ref),
            opId,
            describeAdapterError(err),
          );
          yield* Ref.set(ref, rolledBackModel);
          notify(rolledBackModel);
          if (entry) {
            console.warn(`[TmuxStore] rolled back op ${opId} (${entry.op._tag}): ${entry.reason}`);
          }
          if (err._tag === 'TmuxError') {
            return yield* Effect.fail(new OpRejectedByTmux({ opId, command, stderr: err.stderr }));
          }
          return yield* Effect.fail(new OpTransportError({ opId, command, cause: err }));
        }
        // Mark sent — reconcile() will drop it when a matching delta arrives,
        // or the stale-timeout will sweep it.
        const updated = yield* Ref.updateAndGet(ref, (m) => {
          const ops = m.ops.map((o) =>
            o.id === opId ? { ...o, status: 'awaiting-confirm' as const } : o,
          );
          return { ...m, ops };
        });
        notify(updated);
        return opId;
      });

    const dispatch = (op: TmuxOp, opts?: DispatchOptions): Effect.Effect<OpId, OpError> =>
      Effect.suspend(() => {
        const { opId, command } = applyOptimistic(op, opts);
        return dispatchRemote(opId, command);
      });

    const dispatchCommand = (
      command: string,
      opts?: DispatchOptions,
    ): Effect.Effect<OpId, OpError> => dispatch(parseCommandToOp(command), { ...opts, command });

    const reconcile = (state: ServerState): Effect.Effect<ReadonlyArray<RollbackEntry>> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(ref);
        // Reuse previous objects for anything value-equal — wire snapshots are
        // fresh object graphs, and without identity preservation every tick
        // re-renders every pane (see preserveSnapshotIdentity).
        const snapshot = preserveSnapshotIdentity(current.committed, serverStateToSnapshot(state));
        const result = applyServerSnapshot(current, snapshot, Date.now());
        yield* Ref.set(ref, result.model);
        notify(result.model);
        return result.rolledBack;
      });

    const clear = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(ref, EMPTY_MODEL);
        notify(EMPTY_MODEL);
      });

    const subscribe = (listener: StoreListener): (() => void) => {
      listeners.add(listener);
      // Fire once on subscribe so the bridge can sync immediately.
      try {
        listener(Effect.runSync(Ref.get(ref)));
      } catch (err) {
        console.error('[TmuxStore] initial listener call threw:', err);
      }
      return () => {
        listeners.delete(listener);
      };
    };

    const setPredictContext = (ctx: PredictContext): Effect.Effect<void> => Ref.set(ctxRef, ctx);

    return {
      getModel,
      applyOptimistic,
      dispatchRemote,
      dispatch,
      dispatchCommand,
      reconcile,
      clear,
      subscribe,
      setPredictContext,
    };
  });
}

function serverStateToSnapshot(state: ServerState): TmuxSnapshot {
  return transformServerState(state);
}

function describeAdapterError(err: AdapterError): string {
  switch (err._tag) {
    case 'TmuxError':
      return `tmux rejected: ${err.stderr}`;
    case 'TransportError':
      return `transport: ${String(err.cause)}`;
    case 'ProtocolError':
      return `protocol: ${err.reason}`;
    case 'Cancelled':
      return 'cancelled';
  }
}
