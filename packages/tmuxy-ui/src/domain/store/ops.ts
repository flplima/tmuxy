/**
 * Per-op predict and reconcile. `predict` returning null means no prediction
 * is possible and the op is fire-and-forget; `reconcile` says whether the
 * server has caught up with the prediction.
 */

import type { TmuxSnapshot, Patch, ReconcileVerdict, PendingOp } from './types';
import { groupMembers, type TmuxPane } from '../client';
import type { TmuxOp, TmuxOpOf } from '../commands';
import type { PredictedTag } from '../opTraits';
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
  predictWindowTag,
  reconcileGroupSwitch,
  reconcileKillWindow,
  reconcileMoveWindow,
  reconcileNewWindow,
  reconcileRenameWindow,
  reconcileSelectWindow,
  reconcileWindowTag,
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

type Meta = Readonly<Record<string, unknown>>;
type Claimed = { panes: ReadonlySet<PaneId>; windows: ReadonlySet<WindowId> };

interface Predictor<O extends TmuxOp> {
  predict(op: O, snapshot: TmuxSnapshot, ctx: PredictContext, opId: string): PredictResult | null;
  /** Whether the server has caught up; `ageMs` is the op's age. */
  reconcile(meta: Meta, committed: TmuxSnapshot, claimed: Claimed, ageMs: number): ReconcileVerdict;
}

const reconcileFocusOf: Predictor<TmuxOp>['reconcile'] = (meta, s, _claimed, ageMs) =>
  reconcileFocus(meta, s.activePaneId, ageMs, s.panes);

/**
 * One predictor per op `OP_TRAITS` says predicts something (its
 * `PredictedTag`), and none for the rest: every other op changes what the
 * client cannot know ahead of tmux (a script's choices, a new session) or
 * what it never draws.
 */
const PREDICTORS: { readonly [T in PredictedTag]: Predictor<TmuxOpOf<T>> } = {
  Split: {
    predict: predictSplit,
    reconcile: (meta, s, claimed) => reconcileSplit(meta, s, claimed.panes),
  },
  Navigate: { predict: predictNavigate, reconcile: reconcileFocusOf },
  SelectPane: { predict: predictSelectPane, reconcile: reconcileFocusOf },
  Swap: { predict: predictSwap, reconcile: (meta, s) => reconcileSwap(meta, s.panes) },
  NewWindow: {
    predict: (_op, s, ctx, opId) => predictNewWindow(s, ctx, opId),
    reconcile: (meta, s, claimed) => reconcileNewWindow(meta, s.windows, s.panes, claimed.windows),
  },
  SelectWindow: {
    predict: predictSelectWindow,
    reconcile: (meta, s, _claimed, ageMs) =>
      reconcileSelectWindow(meta, s.activeWindowId, ageMs, s.windows),
  },
  KillPane: {
    predict: predictKillPane,
    reconcile: (meta, s, _claimed, ageMs) => reconcileKillPane(meta, s.panes, ageMs),
  },
  KillWindow: {
    predict: predictKillWindow,
    reconcile: (meta, s) => reconcileKillWindow(meta, s.windows),
  },
  JoinPane: {
    predict: predictJoinPane,
    reconcile: (meta, s, _claimed, ageMs) => reconcileJoinPane(meta, s.panes, ageMs),
  },
  RenameWindow: {
    predict: predictRenameWindow,
    reconcile: (meta, s) => reconcileRenameWindow(meta, s.windows),
  },
  MoveWindow: {
    predict: predictMoveWindow,
    reconcile: (meta, s) => reconcileMoveWindow(meta, s.windows),
  },
  ZoomToggle: {
    predict: predictZoomToggle,
    reconcile: (meta, s, _claimed, ageMs) => reconcileZoomToggle(meta, s.panes, ageMs),
  },
  GroupSwitch: {
    predict: predictGroupSwitch,
    reconcile: (meta, s, _claimed, ageMs) =>
      reconcileGroupSwitch(meta, s.panes, s.activePaneId, ageMs),
  },
  GroupMove: {
    predict: predictGroupMove,
    reconcile: (meta, s) => reconcileGroupMove(meta, s.panes),
  },
  SetWindowTag: {
    predict: predictWindowTag,
    reconcile: (meta, s, _claimed, ageMs) => reconcileWindowTag(meta, s.windows, ageMs),
  },
};

function predictorOf(op: TmuxOp): Predictor<TmuxOp> | undefined {
  return (PREDICTORS as Partial<Record<TmuxOp['_tag'], Predictor<TmuxOp>>>)[op._tag];
}

/** The op's predicted patch, or null when it is fire-and-forget. */
export function predict(
  op: TmuxOp,
  snapshot: TmuxSnapshot,
  ctx: PredictContext,
  opId: string,
): PredictResult | null {
  return predictorOf(op)?.predict(op, snapshot, ctx, opId) ?? null;
}

export function reconcile(
  pending: PendingOp,
  committed: TmuxSnapshot,
  /** Ids claimed by EARLIER ops of this pass, so two in-flight Splits never match one pane. */
  claimed: Claimed = { panes: new Set(), windows: new Set() },
  now: number = Date.now(),
): ReconcileVerdict {
  const predictor = predictorOf(pending.op);
  // No prediction, so there's nothing to wait for.
  if (!predictor) return { _tag: 'matched' };
  return predictor.reconcile(pending.meta, committed, claimed, now - pending.createdAt);
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

function reconcileGroupMove(meta: Meta, panes: ReadonlyArray<TmuxPane>): ReconcileVerdict {
  const order = meta.order as PaneId[];
  const members = groupMembers(panes, meta.groupId as GroupId);
  // A member gone (closed, left) means the order we predicted no longer
  // exists either: the server's is the one to show.
  if (members.length !== order.length) return { _tag: 'matched' };
  return order.every((id, i) => id === members[i]) ? { _tag: 'matched' } : { _tag: 'pending' };
}
