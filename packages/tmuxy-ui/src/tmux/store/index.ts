/**
 * TmuxStore — client-side authoritative model of the tmux world.
 *
 * Public API for the rest of the app. The store wraps a `Ref<TmuxClientModel>`
 * with Effect-managed dispatch and reconciliation. The appMachine bridges
 * model changes into XState context so React selectors stay unchanged.
 */

export type {
  TmuxSnapshot,
  TmuxOp,
  Patch,
  PendingOp,
  OpStatus,
  TmuxClientModel,
  OpId,
  OpError,
  ReconcileVerdict,
} from './types';
export {
  EMPTY_SNAPSHOT,
  EMPTY_MODEL,
  OP_STALE_TIMEOUT_MS,
  OpRejectedByTmux,
  OpTransportError,
} from './types';

export type { TmuxStore, TmuxStoreConfig, StoreListener, DispatchOptions } from './TmuxStore';
export { makeTmuxStore } from './TmuxStore';

export type { PredictContext, PredictResult } from './ops';
export { predict, reconcile } from './ops';

export {
  recomputeDerived,
  addPendingOp,
  rollbackOp,
  applyServerSnapshot,
  modelFromSnapshot,
  makePendingOp,
  generateOpId,
} from './model';
export type { ReconcileResult, RollbackEntry } from './model';

export { parseCommandToOp, toTmuxCommand } from './parseCommand';

export { transformServerState as serverStateToSnapshot } from './adapters';
