import { Effect } from 'effect';
import { formatAdapterError } from '../transport/AdapterError';
import { TmuxTransport } from '../transport/TmuxTransport';
import type { ServerState } from '../../domain/wire';
import { preserveSnapshotIdentity, transformServerState } from '../../domain/store/snapshot';
import { toTmuxCommand, TmuxOp } from '../../domain/commands';
import {
  addPendingOp,
  applyServerSnapshot,
  dropSupersededFocusOps,
  generateOpId,
  makePendingOp,
  rollbackOp,
  type RollbackEntry,
} from '../../domain/store/model';
import { DEFAULT_SHELL, predict } from '../../domain/store/ops';
import type { PaneId } from '../../domain/ids';
import {
  type OpError,
  type OpId,
  type TmuxClientModel,
  EMPTY_MODEL,
  OpRejectedByTmux,
  OpTransportError,
} from '../../domain/store/types';

export interface DispatchOptions {
  /**
   * The exact string to send in place of the op's own form, when the op was
   * parsed from one: a binding keeps its pin and flags, `-c
   * "#{pane_current_path}"` its format. The op is still what is predicted.
   * Without it the op itself goes to the lane, which batches keystrokes.
   */
  readonly wire?: string;
}

export type StoreListener = (model: TmuxClientModel) => void;
export type RollbackListener = (entries: ReadonlyArray<RollbackEntry>) => void;

export interface TmuxStore {
  readonly getModel: () => TmuxClientModel;

  /**
   * The sequence number of the server state last reconciled (`seq` on the
   * wire's state, stamped by the stream's sequencer), or null before one
   * arrived or when the stream numbers nothing. Against the sequencer's own
   * position it says whether the store has caught up with the stream.
   */
  readonly getAppliedSeq: () => number | null;

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
   * matched/stale ones, recomputes `derived`. The single entry point from
   * the state stream.
   */
  readonly reconcile: (state: ServerState) => void;

  /**
   * Drop everything (committed, ops, paneKeyOverrides). Used on session
   * switch when we don't yet have a new server snapshot to reset against —
   * the store starts empty and rebuilds on the next reconcile.
   */
  readonly clear: () => void;

  /**
   * The listener fires at once with the current model, then synchronously
   * after every committed mutation — server reconciliations and local
   * dispatches alike.
   */
  readonly subscribe: (listener: StoreListener) => () => void;

  /** The host's default shell (its greeting): what a predicted pane runs. */
  readonly setDefaultShell: (shell: string) => void;

  /**
   * Hear every op a reconcile pass rolled back, whether the pass was driven
   * by a server snapshot or by the idle sweep. Fires after the subscribers
   * have seen the model it rolled back from; never with an empty list.
   */
  readonly subscribeRollbacks: (listener: RollbackListener) => () => void;
}

export function makeTmuxStore(): TmuxStore {
  let model: TmuxClientModel = EMPTY_MODEL;
  let defaultShell = DEFAULT_SHELL;
  // Panes most recently active first, for the predictions that pick a pane as
  // tmux would (Navigate's tie-break, where KillPane/KillWindow land).
  let activation: PaneId[] = [];
  const listeners = new Set<StoreListener>();
  const rollbackListeners = new Set<RollbackListener>();

  const commit = (next: TmuxClientModel): void => {
    model = next;
    const active = next.derived.activePaneId;
    if (active && activation[0] !== active) {
      activation = [active, ...activation.filter((id) => id !== active)];
    }
    for (const l of listeners) {
      try {
        l(next);
      } catch (err) {
        console.error('[TmuxStore] listener threw:', err);
      }
    }
    scheduleIdleReconcile(next);
  };

  const commitReconciled = (result: ReturnType<typeof applyServerSnapshot>): void => {
    commit(result.model);
    if (result.rolledBack.length === 0) return;
    for (const l of rollbackListeners) {
      try {
        l(result.rolledBack);
      } catch (err) {
        console.error('[TmuxStore] rollback listener threw:', err);
      }
    }
  };

  /** Change an op's status only: derived is unaffected, so nobody is told. */
  const setStatus = (opId: OpId, status: 'in-flight' | 'awaiting-confirm'): TmuxClientModel => {
    model = { ...model, ops: model.ops.map((o) => (o.id === opId ? { ...o, status } : o)) };
    return model;
  };

  // Age-based verdicts (stale sweeps, focus-linger release, supersession)
  // run inside reconcile passes, normally driven by server snapshots. An
  // idle control stream sends none, so a wrong pin would wedge forever:
  // while ops are pending, re-reconcile against the unchanged committed
  // snapshot on a timer.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const IDLE_RECONCILE_MS = 500;
  const scheduleIdleReconcile = (current: TmuxClientModel): void => {
    if (current.ops.length === 0) return;
    if (idleTimer !== null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (model.ops.length === 0) return;
      commitReconciled(applyServerSnapshot(model, model.committed, Date.now()));
    }, IDLE_RECONCILE_MS);
  };

  const applyOptimistic = (op: TmuxOp, command: string): OpId => {
    const opId = generateOpId();
    const result = predict(
      op,
      model.derived,
      { defaultShell, paneActivationOrder: activation },
      opId,
    );
    const pending = result
      ? makePendingOp({ id: opId, op, command, patch: result.patch, meta: result.meta })
      : makePendingOp({ id: opId, op, command, patch: (s) => s, meta: {} });
    commit(addPendingOp(dropSupersededFocusOps(model, op), pending));
    return opId;
  };

  const dispatchRemote = (
    transport: TmuxTransport['Type'],
    opId: OpId,
    sent: TmuxOp,
    command: string,
  ): Effect.Effect<OpId, OpError> =>
    Effect.suspend(() => {
      // Mark in-flight BEFORE the adapter call: the ack can take longer than
      // the quick stale sweep, and a swept op would blink the optimistic UI
      // away and remount when the confirm finally lands.
      setStatus(opId, 'in-flight');
      return transport.run(sent);
    }).pipe(
      Effect.matchEffect({
        onFailure: (err) => {
          const reason = formatAdapterError(err);
          const { model: rolledBack, entry } = rollbackOp(model, opId, reason);
          commit(rolledBack);
          if (entry) {
            console.warn(`[TmuxStore] rolled back op ${opId} (${entry.op._tag}): ${entry.reason}`);
          }
          return Effect.fail(
            err._tag === 'TmuxError'
              ? new OpRejectedByTmux({ opId, command, stderr: err.stderr })
              : new OpTransportError({ opId, command, reason }),
          );
        },
        onSuccess: () =>
          Effect.sync(() => {
            commit(setStatus(opId, 'awaiting-confirm'));
            return opId;
          }),
      }),
    );

  let appliedSeq: number | null = null;

  return {
    getModel: () => model,
    getAppliedSeq: () => appliedSeq,

    dispatch: (op, opts) =>
      Effect.flatMap(TmuxTransport, (transport) => {
        const command = opts?.wire ?? toTmuxCommand(op);
        // Nothing to send (a paste that was all controls): an empty line on
        // the control-mode connection detaches it, and a pending op for it
        // would only wait out the stale sweep. Done before it starts; its id
        // is never recorded.
        if (command.trim() === '') return Effect.succeed(generateOpId());
        const sent = opts?.wire === undefined ? op : TmuxOp.RawCommand({ command });
        return dispatchRemote(transport, applyOptimistic(op, command), sent, command);
      }),

    reconcile: (state) => {
      // Reuse previous objects for anything value-equal — wire snapshots are
      // fresh object graphs, and without identity preservation every tick
      // re-renders every pane (see preserveSnapshotIdentity).
      const snapshot = preserveSnapshotIdentity(model.committed, transformServerState(state));
      const result = applyServerSnapshot(model, snapshot, Date.now());
      appliedSeq = state.seq ?? null;
      commitReconciled(result);
    },

    clear: () => {
      appliedSeq = null;
      activation = [];
      commit(EMPTY_MODEL);
    },

    subscribe: (listener) => {
      listeners.add(listener);
      try {
        listener(model);
      } catch (err) {
        console.error('[TmuxStore] initial listener call threw:', err);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    setDefaultShell: (shell) => {
      defaultShell = shell;
    },

    subscribeRollbacks: (listener) => {
      rollbackListeners.add(listener);
      return () => {
        rollbackListeners.delete(listener);
      };
    },
  };
}
