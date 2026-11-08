import {
  type TmuxClientModel,
  type TmuxSnapshot,
  type PendingOp,
  type OpId,
  type Patch,
  OP_STALE_TIMEOUT_MS,
  OP_ACKED_STALE_TIMEOUT_MS,
} from './types';
import type { TmuxOp } from '../commands';
import { reconcile as opReconcile } from './ops';
import { supersedesPin } from '../opTraits';
import type { PaneId, WindowId } from '../ids';

let opIdCounter = 0;

export function generateOpId(): OpId {
  return `op_${Date.now()}_${++opIdCounter}` as OpId;
}

export function recomputeDerived(model: TmuxClientModel): TmuxClientModel {
  let derived = model.committed;
  for (const op of model.ops) {
    if (op.status === 'failed') continue;
    derived = op.patch(derived);
  }
  return { ...model, derived };
}

export function addPendingOp(model: TmuxClientModel, op: PendingOp): TmuxClientModel {
  return recomputeDerived({ ...model, ops: [...model.ops, op] });
}

export interface RollbackEntry {
  readonly opId: OpId;
  readonly op: TmuxOp;
  readonly reason: string;
}

export interface ReconcileResult {
  readonly model: TmuxClientModel;
  readonly matched: ReadonlyArray<{ opId: OpId; op: TmuxOp; realId?: PaneId | WindowId }>;
  readonly rolledBack: ReadonlyArray<RollbackEntry>;
}

export function applyServerSnapshot(
  model: TmuxClientModel,
  next: TmuxSnapshot,
  now: number = Date.now(),
): ReconcileResult {
  const committed = next;
  const matched: Array<{ opId: OpId; op: TmuxOp; realId?: PaneId | WindowId }> = [];
  const rolledBack: RollbackEntry[] = [];
  const keepers: PendingOp[] = [];
  let paneKeyOverrides = model.paneKeyOverrides;
  // Two in-flight Split / NewWindow ops must not both match the same new id.
  const claimedPanes = new Set<PaneId>();
  const claimedWindows = new Set<WindowId>();

  for (const op of model.ops) {
    if (op.status === 'failed') {
      rolledBack.push({ opId: op.id, op: op.op, reason: 'previously failed' });
      continue;
    }
    const verdict = opReconcile(
      op,
      committed,
      {
        panes: claimedPanes,
        windows: claimedWindows,
      },
      now,
    );
    if (verdict._tag === 'matched') {
      const { realPaneId, realWindowId } = verdict;
      matched.push({ opId: op.id, op: op.op, realId: realPaneId ?? realWindowId });
      if (realPaneId) {
        claimedPanes.add(realPaneId);
        const placeholderId = (op.meta as { placeholderId?: PaneId }).placeholderId;
        if (placeholderId) {
          paneKeyOverrides = { ...paneKeyOverrides, [realPaneId]: placeholderId };
        }
      } else if (realWindowId) {
        claimedWindows.add(realWindowId);
        // The new window's pane keeps the placeholder's React key, so the
        // optimistic→real swap does not remount it (a flicker).
        const placeholderPaneId = (op.meta as { placeholderPaneId?: PaneId }).placeholderPaneId;
        if (placeholderPaneId) {
          const newPane = committed.panes.find(
            (p) => p.windowId === realWindowId && !claimedPanes.has(p.tmuxId),
          );
          if (newPane) {
            paneKeyOverrides = {
              ...paneKeyOverrides,
              [newPane.tmuxId]: placeholderPaneId,
            };
            claimedPanes.add(newPane.tmuxId);
          }
        }
      }
      continue;
    }
    if (verdict._tag === 'failed') {
      rolledBack.push({ opId: op.id, op: op.op, reason: verdict.reason });
      continue;
    }
    // Only an op whose dispatch has not started gets the quick sweep: it may be
    // a phantom prediction with nothing coming. An in-flight call is guaranteed
    // to settle (resolve or reject → rollback), and sweeping it early blinks the
    // optimistic UI away exactly when the transport is slow.
    const staleAfter = op.status === 'pending' ? OP_STALE_TIMEOUT_MS : OP_ACKED_STALE_TIMEOUT_MS;
    if (now - op.createdAt > staleAfter) {
      rolledBack.push({
        opId: op.id,
        op: op.op,
        reason: `op stale after ${now - op.createdAt}ms (${op.status})`,
      });
      continue;
    }
    keepers.push(op);
  }

  if (Object.keys(paneKeyOverrides).length > 0) {
    const next: Record<PaneId, PaneId> = {};
    for (const { tmuxId } of committed.panes) {
      const key = paneKeyOverrides[tmuxId];
      if (key) next[tmuxId] = key;
    }
    paneKeyOverrides = next;
  }

  const newModel: TmuxClientModel = {
    committed,
    ops: keepers,
    derived: committed,
    paneKeyOverrides,
  };
  return { model: recomputeDerived(newModel), matched, rolledBack };
}

/** For a tmux command that rejects before any state update arrives. */
export function rollbackOp(
  model: TmuxClientModel,
  opId: OpId,
  reason: string,
): { model: TmuxClientModel; entry: RollbackEntry | null } {
  const op = model.ops.find((o) => o.id === opId);
  if (!op) return { model, entry: null };
  const next = recomputeDerived({
    ...model,
    ops: model.ops.filter((o) => o.id !== opId),
  });
  return { model: next, entry: { opId, op: op.op, reason } };
}

export function makePendingOp(args: {
  id: OpId;
  op: TmuxOp;
  command: string;
  patch: Patch;
  meta: Readonly<Record<string, unknown>>;
  now?: number;
}): PendingOp {
  return {
    id: args.id,
    op: args.op,
    command: args.command,
    patch: args.patch,
    meta: args.meta,
    createdAt: args.now ?? Date.now(),
    status: 'pending',
  };
}

/**
 * Drop pending focus pins that a NEWER user intent supersedes. Without this,
 * a lingering confirmed SelectPane op (kept alive to absorb stale snapshots)
 * re-pins the OLD focus the moment a later op — e.g. a Split whose placeholder
 * became the active pane — reconciles out of the log: the user sees focus
 * flap back to the pre-split pane for up to a second.
 */
export function dropSupersededFocusOps(model: TmuxClientModel, newOp: TmuxOp): TmuxClientModel {
  const ops = model.ops.filter((o) => !supersedesPin(newOp, o.op));
  if (ops.length === model.ops.length) return model;
  return recomputeDerived({ ...model, ops });
}
