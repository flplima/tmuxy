import { Data } from 'effect';
import type { TmuxPane, TmuxWindow } from '../client';
import type { PaneId, WindowId } from '../ids';
import type { TmuxOp } from '../commands';

/** The part of the app's state that comes from tmux; UI-only fields stay in XState. */
export interface TmuxSnapshot {
  readonly panes: ReadonlyArray<TmuxPane>;
  readonly windows: ReadonlyArray<TmuxWindow>;
  readonly activePaneId: PaneId | null;
  readonly activeWindowId: WindowId | null;
  readonly totalWidth: number;
  readonly totalHeight: number;
  readonly sessionName: string;
  /**
   * A one-shot focus request queued by a shell helper (`tmuxy nav` at the edge
   * of the grid): `left` / `right` / `panes`, or `''` when nothing is pending.
   *
   * A SIGNAL, not state: the client that acts on it unsets the tmux option
   * behind it, and no optimistic op predicts it.
   */
  readonly focusRequest: string;
  /**
   * The plugin inventory's revision (`@tmuxy-plugins-rev`), `''` when none
   * was published. Like `focusRequest` a signal rather than layout: a new
   * value has the machine re-read the inventory.
   */
  readonly pluginsRev: string;
  /**
   * The theme and its mode as tmux holds them (`<name>:<mode>`), `''` before
   * they are known. A signal too: a new value has the machine re-read the
   * theme settings, so a theme picked on one client reaches every client.
   */
  readonly themeRev: string;
}

export const EMPTY_SNAPSHOT: TmuxSnapshot = {
  panes: [],
  windows: [],
  activePaneId: null,
  activeWindowId: null,
  totalWidth: 0,
  totalHeight: 0,
  sessionName: '',
  focusRequest: '',
  pluginsRev: '',
  themeRev: '',
};

export type OpId = string & { readonly __brand: 'OpId' };

export type Patch = (s: TmuxSnapshot) => TmuxSnapshot;

export type OpStatus =
  /** Patch applied locally, command not yet handed to the adapter. */
  | 'pending'
  /**
   * Written to the transport, not acknowledged yet. The ack alone can take
   * longer than OP_STALE_TIMEOUT_MS on a slow transport (v86 serial, a loaded
   * server), so in-flight ops get the acked timeout instead.
   */
  | 'in-flight'
  /** Acknowledged; waiting for the matching server delta. */
  | 'awaiting-confirm'
  /** tmux rejected the command; rolled back on the next snapshot. */
  | 'failed';

export interface PendingOp {
  readonly id: OpId;
  readonly op: TmuxOp;
  readonly command: string;
  readonly patch: Patch;
  readonly createdAt: number;
  readonly status: OpStatus;
  /** What the op's reconciler needs from dispatch time (a Split's prior pane IDs). */
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface TmuxClientModel {
  /** The last server-confirmed snapshot. */
  readonly committed: TmuxSnapshot;
  /** Newest last. */
  readonly ops: ReadonlyArray<PendingOp>;
  /** `committed` with every pending op's patch applied in order: what selectors read. */
  readonly derived: TmuxSnapshot;
  /**
   * Real pane id → the placeholder it replaced. PaneLayout keys the pane by it,
   * so the element survives the id swap without a remount flicker.
   */
  readonly paneKeyOverrides: Readonly<Record<PaneId, PaneId>>;
}

export const EMPTY_MODEL: TmuxClientModel = {
  committed: EMPTY_SNAPSHOT,
  ops: [],
  derived: EMPTY_SNAPSHOT,
  paneKeyOverrides: {},
};

export class OpRejectedByTmux extends Data.TaggedError('OpRejectedByTmux')<{
  readonly opId: OpId;
  readonly command: string;
  readonly stderr: string;
}> {}

export class OpTransportError extends Data.TaggedError('OpTransportError')<{
  readonly opId: OpId;
  readonly command: string;
  /** The transport's failure, as the user is shown it. */
  readonly reason: string;
}> {}

export type OpError = OpRejectedByTmux | OpTransportError;

/**
 * `matched`: the server reflects the prediction, drop the op. `pending`: keep
 * it and its patch. `failed`: the server contradicts it, drop it with a warning.
 */
export type ReconcileVerdict =
  /** The real pane a Split, or the real window a NewWindow, turned out to be. */
  | {
      readonly _tag: 'matched';
      readonly realPaneId?: PaneId;
      readonly realWindowId?: WindowId;
    }
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
 * Ops that pin a value (a focus, a zoom, a sidebar's hidden flag) stay in the
 * log this long after the server confirms them: stale snapshots computed
 * before the change (an in-flight periodic list-panes sync, an update batched
 * earlier in a burst, the echo of this client's own previous write) can
 * arrive AFTER the confirmation and would flap the value A → B → A. Sized to
 * outlast the v86 engine's 3s re-sync cadence.
 */
export const CONFIRM_LINGER_MS = 4000;

/**
 * How long an in-flight focus op holds its pin when the server reports focus
 * on some THIRD pane (neither our target nor the pane that was active when we
 * predicted). Below this age the server may simply not have processed our
 * command yet (rapid multi-click); past it, the change is a genuine
 * supersession (another client, a nav alias resolving differently) and the
 * server must win — holding longer would freeze the UI on a stale focus.
 */
export const FOCUS_SUPERSEDE_GRACE_MS = 800;

/**
 * The verdict for an op that pins a value on `target` (a pane's, a window's or
 * a group's focus, a sidebar's hidden flag); `previous` is the value when the
 * op was predicted, `server` the one the server now reports.
 */
export function lingerVerdict<Id>(
  target: Id,
  previous: Id | null | undefined,
  server: Id | null,
  ageMs: number,
): ReconcileVerdict {
  if (server === target) {
    return ageMs >= CONFIRM_LINGER_MS ? { _tag: 'matched' } : { _tag: 'pending' };
  }
  if (server === previous && ageMs < CONFIRM_LINGER_MS) return { _tag: 'pending' };
  if (ageMs < FOCUS_SUPERSEDE_GRACE_MS) return { _tag: 'pending' };
  return { _tag: 'matched' };
}
