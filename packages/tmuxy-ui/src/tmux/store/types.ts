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
  /** paneId null = the active pane. */
  | { readonly _tag: 'KillPane'; readonly paneId: string | null }
  /** windowId null = the active window. Only `@N`-form targets are predicted. */
  | { readonly _tag: 'KillWindow'; readonly windowId: string | null }
  /** target null = the active window. */
  | { readonly _tag: 'RenameWindow'; readonly target: string | null; readonly name: string }
  /** paneId null = the active pane. Predicts zoom-IN only (see predictZoomToggle). */
  | { readonly _tag: 'ZoomToggle'; readonly paneId: string | null }
  /**
   * Pane-group tab switch: the clicked (parked) group member swaps into the
   * visible slot occupied by `visiblePaneId`. Backed by the guest
   * pane-group-switch script (resize-window ; swap-pane); dispatched with an
   * explicit command string, never parsed from the wire.
   */
  | {
      readonly _tag: 'GroupSwitch';
      readonly clickedPaneId: string;
      readonly visiblePaneId: string;
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

// ============================================
// PendingOp — an op in flight
// ============================================

export type OpStatus =
  /** Patch applied locally, command not yet handed to the adapter. */
  | 'pending'
  /**
   * The adapter call is in flight: the command was written to the transport
   * and its acknowledgement hasn't arrived yet. The ack alone can take longer
   * than OP_STALE_TIMEOUT_MS on a slow transport (v86 serial, loaded server),
   * so in-flight ops are exempt from the quick sweep — the call is guaranteed
   * to settle (resolve → awaiting-confirm, reject → rollback), and the acked
   * timeout still applies as a backstop. Sweeping earlier makes the optimistic
   * UI blink away and remount exactly when the backend is slowest.
   */
  | 'in-flight'
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

export class OpTransportError extends Data.TaggedError('OpTransportError')<{
  readonly opId: OpId;
  readonly command: string;
  readonly cause: unknown;
}> {}

export type OpError = OpRejectedByTmux | OpTransportError;

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
 * Stale-op timeout for UNACKED ops (`pending`): the command may have been
 * lost in transport — give up quickly so the UI can't wedge on a phantom
 * prediction.
 */
export const OP_STALE_TIMEOUT_MS = 2000;

/**
 * Stale-op timeout for ACKED ops (`awaiting-confirm`): tmux confirmed the
 * command executed, so the matching delta IS coming — but possibly slowly
 * (e.g. a new window's `@tmuxy-window-type` tag arrives on a later
 * list-windows sync, seconds behind on the v86 serial transport). Sweeping
 * an acked op early makes the confirmed UI blink away and back.
 */
export const OP_ACKED_STALE_TIMEOUT_MS = 10000;

/**
 * Focus ops (SelectPane / Navigate) stay in the log for this long even after
 * the server confirms them. Stale snapshots computed before the focus change
 * (an in-flight periodic list-panes sync, an update batched earlier in a
 * burst) can arrive AFTER the confirmation — with the op already dropped they
 * would flap the active highlight A → B → A. While the op lingers, its patch
 * keeps pinning the focus over such stragglers. Sized to outlast the v86
 * engine's 3s re-sync cadence; superseded/unconfirmed focus ops fall to the
 * acked-stale sweep.
 */
export const FOCUS_CONFIRM_LINGER_MS = 4000;

/**
 * How long an in-flight focus op holds its pin when the server reports focus
 * on some THIRD pane (neither our target nor the pane that was active when we
 * predicted). Below this age the server may simply not have processed our
 * command yet (rapid multi-click); past it, the change is a genuine
 * supersession (another client, a nav alias resolving differently) and the
 * server must win — holding longer would freeze the UI on a stale focus.
 */
export const FOCUS_SUPERSEDE_GRACE_MS = 800;
