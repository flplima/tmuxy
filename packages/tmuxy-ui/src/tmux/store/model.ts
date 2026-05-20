/**
 * Pure reducers for TmuxClientModel.
 *
 * Every function in this file is a pure `(model, …args) → model` transition.
 * The store wraps these in a `Ref`; tests can drive them directly without
 * spinning up Effect at all.
 */

import type { TmuxClientModel, TmuxSnapshot, PendingOp, OpId, Patch, TmuxOp } from './types';
import { EMPTY_SNAPSHOT, OP_STALE_TIMEOUT_MS } from './types';
import { reconcile as opReconcile } from './ops';

let opIdCounter = 0;

export function generateOpId(): OpId {
  return `op_${Date.now()}_${++opIdCounter}` as OpId;
}

/**
 * Recompute `derived` by replaying every pending op's patch on top of
 * `committed`. O(ops.length) — usually 0–3 ops in flight, never more than
 * a handful even under fast user input.
 */
export function recomputeDerived(model: TmuxClientModel): TmuxClientModel {
  let derived = model.committed;
  for (const op of model.ops) {
    if (op.status === 'failed') continue;
    derived = op.patch(derived);
  }
  return { ...model, derived };
}

/**
 * Push a freshly-dispatched op into the log and refresh `derived`.
 */
export function addPendingOp(model: TmuxClientModel, op: PendingOp): TmuxClientModel {
  return recomputeDerived({ ...model, ops: [...model.ops, op] });
}

/**
 * Drop one op by id (used after a reconciler verdict of matched/failed).
 * If the op was a Split with a confirmed real pane id, record the
 * `realId → placeholderId` mapping so React keys stay stable when the
 * placeholder element morphs into the real pane.
 */
export function removeOp(model: TmuxClientModel, opId: OpId, realId?: string): TmuxClientModel {
  const op = model.ops.find((o) => o.id === opId);
  let paneKeyOverrides = model.paneKeyOverrides;
  if (op && op.op._tag === 'Split' && realId) {
    const placeholderId = (op.meta as { placeholderId?: string }).placeholderId;
    if (placeholderId) {
      paneKeyOverrides = { ...paneKeyOverrides, [realId]: placeholderId };
    }
  }
  const ops = model.ops.filter((o) => o.id !== opId);
  return recomputeDerived({ ...model, ops, paneKeyOverrides });
}

/**
 * Mark an op as failed without removing it. The op stops contributing to
 * `derived` (so the optimistic patch disappears from the UI) but stays in
 * the log so a follow-up tick can drop it cleanly. Useful when a transport
 * error fires before any server delta arrives — we want the rollback to be
 * visible immediately but the op-failure observable to consumers.
 */
export function markOpFailed(model: TmuxClientModel, opId: OpId): TmuxClientModel {
  const ops = model.ops.map((o) => (o.id === opId ? { ...o, status: 'failed' as const } : o));
  return recomputeDerived({ ...model, ops });
}

export function setOpStatus(
  model: TmuxClientModel,
  opId: OpId,
  status: PendingOp['status'],
): TmuxClientModel {
  const ops = model.ops.map((o) => (o.id === opId ? { ...o, status } : o));
  return recomputeDerived({ ...model, ops });
}

/**
 * Apply a fresh server snapshot to the model:
 *   1. Replace `committed` with the new snapshot.
 *   2. Run each pending op's reconciler.
 *   3. Drop ops that matched / failed; keep ops that are still pending.
 *   4. Stale-expire any op older than OP_STALE_TIMEOUT_MS.
 *   5. Prune `paneKeyOverrides` entries for panes that no longer exist.
 *   6. Recompute `derived`.
 *
 * Returns the new model alongside a list of `RollbackEntry` reports the
 * caller (the store) can forward to logging/UI surfaces.
 */
export interface RollbackEntry {
  readonly opId: OpId;
  readonly op: TmuxOp;
  readonly reason: string;
}

export interface ReconcileResult {
  readonly model: TmuxClientModel;
  readonly matched: ReadonlyArray<{ opId: OpId; op: TmuxOp; realId?: string }>;
  readonly rolledBack: ReadonlyArray<RollbackEntry>;
}

export function applyServerSnapshot(
  model: TmuxClientModel,
  next: TmuxSnapshot,
  now: number = Date.now(),
): ReconcileResult {
  const committed = next;
  const matched: Array<{ opId: OpId; op: TmuxOp; realId?: string }> = [];
  const rolledBack: RollbackEntry[] = [];
  const keepers: PendingOp[] = [];
  let paneKeyOverrides = model.paneKeyOverrides;
  // Track real ids already claimed in this reconcile pass so two in-flight
  // Split / NewWindow ops don't both match against the same new id.
  const claimedPanes = new Set<string>();
  const claimedWindows = new Set<string>();

  for (const op of model.ops) {
    if (op.status === 'failed') {
      // Already failed (from an earlier error tick) — drop now.
      rolledBack.push({ opId: op.id, op: op.op, reason: 'previously failed' });
      continue;
    }
    const verdict = opReconcile(op, committed, {
      panes: claimedPanes,
      windows: claimedWindows,
    });
    if (verdict._tag === 'matched') {
      matched.push({ opId: op.id, op: op.op, realId: verdict.realId });
      if (verdict.realId) {
        if (op.op._tag === 'Split') {
          claimedPanes.add(verdict.realId);
          const placeholderId = (op.meta as { placeholderId?: string }).placeholderId;
          if (placeholderId) {
            paneKeyOverrides = { ...paneKeyOverrides, [verdict.realId]: placeholderId };
          }
        } else if (op.op._tag === 'NewWindow') {
          claimedWindows.add(verdict.realId);
        }
      }
      continue;
    }
    if (verdict._tag === 'failed') {
      rolledBack.push({ opId: op.id, op: op.op, reason: verdict.reason });
      continue;
    }
    // pending: stale check
    if (now - op.createdAt > OP_STALE_TIMEOUT_MS) {
      rolledBack.push({
        opId: op.id,
        op: op.op,
        reason: `op stale after ${now - op.createdAt}ms`,
      });
      continue;
    }
    keepers.push(op);
  }

  // Prune key overrides for panes that no longer exist anywhere.
  const knownPaneIds = new Set(committed.panes.map((p) => p.tmuxId));
  if (Object.keys(paneKeyOverrides).length > 0) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(paneKeyOverrides)) {
      if (knownPaneIds.has(k)) next[k] = v;
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

/**
 * Used by the store when a tmux command rejects before any state update
 * arrives. Drops the op + its patch, returning the model + a rollback entry
 * the caller can surface to the UI.
 */
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

/**
 * Helper for tests: build a model from scratch with a given snapshot.
 */
export function modelFromSnapshot(snapshot: TmuxSnapshot): TmuxClientModel {
  return recomputeDerived({
    committed: snapshot,
    ops: [],
    derived: EMPTY_SNAPSHOT,
    paneKeyOverrides: {},
  });
}

/**
 * Build a PendingOp value. Exported so the store and tests construct it the
 * same way.
 */
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
