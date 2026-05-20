/**
 * TmuxClientModel — the client-side authoritative view of the tmux world.
 *
 * The model is the source of truth for what the UI renders. It has two
 * layers: `committed` (last server-confirmed snapshot) and `ops` (an ordered
 * log of optimistic operations applied on top). `derived` is the materialized
 * view selectors read from — `committed` with all `ops` replayed.
 *
 * Why split this out of XState context: XState is a finite-state machine over
 * UI modes; the tmux world is a *data model* with concurrent in-flight
 * mutations, server-side reconciliation, rollback, and replay semantics. Those
 * are not states — they are values, and they belong in a typed reducer that
 * can be unit-tested without a machine harness.
 */

import { Data } from 'effect';
import type { TmuxPane, TmuxWindow } from '../types';

// ============================================
// Snapshot — the data the UI consumes
// ============================================

/**
 * The committed/derived shape. Mirrors the subset of AppMachineContext that
 * comes from the tmux backend. UI-only fields (drag, resize, copy mode,
 * float positions) stay in XState.
 */
export interface TmuxSnapshot {
  readonly panes: ReadonlyArray<TmuxPane>;
  readonly windows: ReadonlyArray<TmuxWindow>;
  readonly activePaneId: string | null;
  readonly activeWindowId: string | null;
  readonly totalWidth: number;
  readonly totalHeight: number;
  readonly statusLine: string;
  readonly sessionName: string;
}

export const EMPTY_SNAPSHOT: TmuxSnapshot = {
  panes: [],
  windows: [],
  activePaneId: null,
  activeWindowId: null,
  totalWidth: 0,
  totalHeight: 0,
  statusLine: '',
  sessionName: '',
};

/** Branded string so a raw string can't be passed where an OpId is expected. */
export type OpId = string & { readonly __brand: 'OpId' };

// ============================================
// TmuxOp — every optimistic user intent as data
// ============================================

/**
 * Tagged union of every user intent the model knows how to predict.
 * Built from parsed commands, semantic events (SELECT_TAB, CREATE_TAB), or
 * direct component invocations. The store turns each op into a tmux command
 * via `toTmuxCommand` and applies a predicted patch via the per-op `predict`
 * function.
 *
 * `RawCommand` is the escape hatch: any string that wasn't recognized as a
 * typed op is forwarded as-is with no optimistic prediction.
 */
export type TmuxOp =
  | { readonly _tag: 'Split'; readonly direction: 'horizontal' | 'vertical' }
  | { readonly _tag: 'Navigate'; readonly direction: 'L' | 'R' | 'U' | 'D' }
  | { readonly _tag: 'SelectPane'; readonly paneId: string }
  | { readonly _tag: 'Swap'; readonly sourcePaneId: string; readonly targetPaneId: string }
  | { readonly _tag: 'NewWindow' }
  | {
      readonly _tag: 'SelectWindow';
      readonly target: number | 'next' | 'previous';
    }
  | { readonly _tag: 'RawCommand'; readonly command: string };

// ============================================
// Patch — a pure transformation of TmuxSnapshot
// ============================================

/**
 * A patch is a pure function `snapshot → snapshot`. Storing patches (not just
 * structural diffs) lets the store replay every pending op on top of a fresh
 * server snapshot to produce `derived` — no special-case merge logic.
 */
export type Patch = (s: TmuxSnapshot) => TmuxSnapshot;

/** A patch that doesn't mutate the snapshot — for ops we send through tmux
 *  but can't (or don't want to) predict locally. */
export const IDENTITY_PATCH: Patch = (s) => s;

// ============================================
// PendingOp — an op in flight
// ============================================

export type OpStatus =
  /** Patch applied locally, command not yet acknowledged by tmux. */
  | 'pending'
  /** Command was sent successfully; waiting for the matching server delta. */
  | 'awaiting-confirm'
  /** Tmux rejected the command. The patch will be rolled back on the next tick. */
  | 'failed';

export interface PendingOp {
  readonly id: OpId;
  readonly op: TmuxOp;
  /** The command string that was sent to tmux (after toTmuxCommand). */
  readonly command: string;
  /** The optimistic patch applied to the snapshot. IDENTITY_PATCH for raw ops. */
  readonly patch: Patch;
  readonly createdAt: number;
  readonly status: OpStatus;
  /**
   * Bookkeeping data captured at dispatch time that the op's reconciler needs
   * later. Examples: for Split, the placeholder pane ID + prior pane IDs;
   * for NewWindow, the prior window IDs; for SelectTab, the target window ID.
   *
   * Kept here (not in the snapshot) because it's purely about *the op*, not
   * about the tmux world.
   */
  readonly meta: Readonly<Record<string, unknown>>;
}

// ============================================
// TmuxClientModel — the whole picture
// ============================================

export interface TmuxClientModel {
  /** The last server-confirmed snapshot. Updated only by `reconcile`. */
  readonly committed: TmuxSnapshot;
  /** Ordered log of in-flight optimistic operations. Newest last. */
  readonly ops: ReadonlyArray<PendingOp>;
  /**
   * `committed` with every pending op's patch applied in order. Memoized —
   * recomputed whenever `committed` or `ops` changes. This is what selectors
   * read.
   */
  readonly derived: TmuxSnapshot;
  /**
   * Maps real pane tmuxId → placeholder ID it morphed from. Populated when a
   * Split op's predicted placeholder is replaced by a real server pane —
   * PaneLayout uses this as the React key so the pane element survives the
   * id swap without unmount/remount flicker.
   */
  readonly paneKeyOverrides: Readonly<Record<string, string>>;
}

export const EMPTY_MODEL: TmuxClientModel = {
  committed: EMPTY_SNAPSHOT,
  ops: [],
  derived: EMPTY_SNAPSHOT,
  paneKeyOverrides: {},
};

// ============================================
// Op errors (Effect-tagged)
// ============================================

/**
 * Failure modes when dispatching an op. Separate from AdapterError because
 * the store layer adds its own concerns (op-already-failed, op-cancelled,
 * predict-rejected).
 */
export class OpRejectedByTmux extends Data.TaggedError('OpRejectedByTmux')<{
  readonly opId: OpId;
  readonly command: string;
  readonly stderr: string;
}> {}

export class OpTimedOut extends Data.TaggedError('OpTimedOut')<{
  readonly opId: OpId;
  readonly command: string;
  readonly elapsedMs: number;
}> {}

export class OpTransportError extends Data.TaggedError('OpTransportError')<{
  readonly opId: OpId;
  readonly command: string;
  readonly cause: unknown;
}> {}

export type OpError = OpRejectedByTmux | OpTimedOut | OpTransportError;

// ============================================
// Op result for the reconciler
// ============================================

/**
 * What an op's reconciler reports after seeing a fresh server snapshot:
 *  - 'matched': the server state already reflects what we predicted → drop
 *    the op from the log.
 *  - 'pending': no new info yet → keep the op, keep its patch in derived.
 *  - 'failed': server state contradicts what we predicted → drop the op,
 *    log a rollback warning (the next `derived` recompute will reflect the
 *    server's reality).
 */
export type ReconcileVerdict =
  | { readonly _tag: 'matched'; readonly realId?: string }
  | { readonly _tag: 'pending' }
  | { readonly _tag: 'failed'; readonly reason: string };

/**
 * Stale-op timeout: how long an op can sit in `pending`/`awaiting-confirm`
 * before the store gives up waiting for a matching delta and forces it
 * through the reconciler as `failed`.
 */
export const OP_STALE_TIMEOUT_MS = 2000;
