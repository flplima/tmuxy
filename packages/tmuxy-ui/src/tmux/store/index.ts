/**
 * TmuxStore — client-side authoritative model of the tmux world.
 *
 * Public API for the rest of the app. The store wraps a `Ref<TmuxClientModel>`
 * with Effect-managed dispatch and reconciliation. The appMachine bridges
 * model changes into XState context so React selectors stay unchanged.
 */

export type { TmuxSnapshot, TmuxClientModel } from './types';
export type { TmuxStore } from './TmuxStore';
export { makeTmuxStore } from './TmuxStore';
