/**
 * Per-op predict and reconcile. `predict` returning null means no prediction
 * is possible and the op is fire-and-forget; `reconcile` says whether the
 * server has caught up with the prediction.
 */

import type { TmuxSnapshot, Patch, ReconcileVerdict, PendingOp } from './types';
import { groupMembers, type TmuxPane } from '../client';
import type { TmuxOp, TmuxOpOf } from '../commands';
import type { GroupId, PaneId, WindowId } from '../ids';
import {
  predictKillPane,
  predictNavigate,
  predictSelectPane,
  predictSplit,
  predictSwap,
  predictZoomToggle,
  reconcileFocus,
  reconcileKillPane,
  reconcileSplit,
  reconcileSwap,
  reconcileZoomToggle,
} from './paneOps';
import { predictJoinPane, reconcileJoinPane } from './joinPane';
import {
  predictGroupSwitch,
  predictKillWindow,
  predictMoveWindow,
  predictNewWindow,
  predictRenameWindow,
  predictSelectWindow,
  reconcileGroupSwitch,
  reconcileKillWindow,
  reconcileMoveWindow,
  reconcileNewWindow,
  reconcileRenameWindow,
  reconcileSelectWindow,
} from './windowOps';

/** The shell a predicted pane shows until tmux names its command, before the host has said which. */
export const DEFAULT_SHELL = 'bash';

export interface PredictContext {
  readonly defaultShell: string;
  /** MRU pane order, used by Navigate to break overlap ties (mirrors tmux's
   *  window_pane_choose_best ranking by active_point). */
  readonly paneActivationOrder: ReadonlyArray<PaneId>;
}

export interface PredictResult {
  readonly patch: Patch;
  readonly meta: Readonly<Record<string, unknown>>;
}

export function predict(
  op: TmuxOp,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult | null {
  switch (op._tag) {
    case 'Split':
      return predictSplit(op, snapshot, ctx, opId);
    case 'Navigate':
      return predictNavigate(op, snapshot, ctx);
    case 'SelectPane':
      return predictSelectPane(op, snapshot);
    case 'Swap':
      return predictSwap(op, snapshot);
    case 'NewWindow':
      return predictNewWindow(snapshot, ctx, opId);
    case 'SelectWindow':
      return predictSelectWindow(op, snapshot);
    case 'KillPane':
      return predictKillPane(op, snapshot, ctx);
    case 'KillWindow':
      return predictKillWindow(op, snapshot, ctx);
    case 'JoinPane':
      return predictJoinPane(op, snapshot);
    case 'RenameWindow':
      return predictRenameWindow(op, snapshot);
    case 'MoveWindow':
      return predictMoveWindow(op, snapshot);
    case 'ZoomToggle':
      return predictZoomToggle(op, snapshot);
    case 'GroupSwitch':
      return predictGroupSwitch(op, snapshot);
    case 'GroupMove':
      return predictGroupMove(op, snapshot);
    default:
      // Everything else changes what the client cannot know ahead of tmux
      // (a script's choices, a new session) or what it never draws.
      return null;
  }
}

export function reconcile(
  pending: PendingOp,
  committed: TmuxSnapshot,
  /** Ids claimed by EARLIER ops of this pass, so two in-flight Splits never match one pane. */
  claimed: { panes: ReadonlySet<PaneId>; windows: ReadonlySet<WindowId> } = {
    panes: new Set(),
    windows: new Set(),
  },
  now: number = Date.now(),
): ReconcileVerdict {
  const { op, meta } = pending;
  switch (op._tag) {
    case 'Split':
      return reconcileSplit(meta, committed, claimed.panes);
    case 'Navigate':
      return reconcileFocus(meta, committed.activePaneId, now - pending.createdAt, committed.panes);
    case 'SelectPane':
      return reconcileFocus(meta, committed.activePaneId, now - pending.createdAt, committed.panes);
    case 'Swap':
      return reconcileSwap(meta, committed.panes);
    case 'NewWindow':
      return reconcileNewWindow(meta, committed.windows, committed.panes, claimed.windows);
    case 'SelectWindow':
      return reconcileSelectWindow(
        meta,
        committed.activeWindowId,
        now - pending.createdAt,
        committed.windows,
      );
    case 'KillPane':
      return reconcileKillPane(meta, committed.panes, now - pending.createdAt);
    case 'KillWindow':
      return reconcileKillWindow(meta, committed.windows);
    case 'JoinPane':
      return reconcileJoinPane(meta, committed.panes, now - pending.createdAt);
    case 'RenameWindow':
      return reconcileRenameWindow(meta, committed.windows);
    case 'MoveWindow':
      return reconcileMoveWindow(meta, committed.windows);
    case 'ZoomToggle':
      return reconcileZoomToggle(meta, committed.panes, now - pending.createdAt);
    case 'GroupSwitch':
      return reconcileGroupSwitch(
        meta,
        committed.panes,
        committed.activePaneId,
        now - pending.createdAt,
      );
    case 'GroupMove':
      return reconcileGroupMove(meta, committed.panes);
    default:
      // No prediction, so there's nothing to wait for.
      return { _tag: 'matched' };
  }
}

/**
 * Predicts the group's new order: the member leaves its place and is put
 * back at `index` among the others — what pane-group move does before it
 * writes every member's `@tmuxy-group-pos`.
 */
function predictGroupMove(op: TmuxOpOf<'GroupMove'>, snapshot: TmuxSnapshot): PredictResult | null {
  const groupId = snapshot.panes.find((p) => p.tmuxId === op.paneId)?.groupId;
  if (!groupId) return null;
  const members = groupMembers(snapshot.panes, groupId);
  const others = members.filter((id) => id !== op.paneId);
  const index = Math.max(0, Math.min(op.index, others.length));
  const order = [...others.slice(0, index), op.paneId, ...others.slice(index)];
  if (order.every((id, i) => id === members[i])) return null;
  const position = new Map(order.map((id, i) => [id, i]));

  const patch: Patch = (s) => ({
    ...s,
    panes: s.panes.map((p) => {
      const groupPos = position.get(p.tmuxId);
      return groupPos === undefined || p.groupPos === groupPos ? p : { ...p, groupPos };
    }),
  });
  return { patch, meta: { groupId, order } };
}

function reconcileGroupMove(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
): ReconcileVerdict {
  const order = meta.order as PaneId[];
  const members = groupMembers(panes, meta.groupId as GroupId);
  // A member gone (closed, left) means the order we predicted no longer
  // exists either: the server's is the one to show.
  if (members.length !== order.length) return { _tag: 'matched' };
  return order.every((id, i) => id === members[i]) ? { _tag: 'matched' } : { _tag: 'pending' };
}
