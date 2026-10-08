/**
 * The app machine's action builders, bound once to its context and events.
 *
 * An action file's named actions are implemented outside `setup()`, so xstate
 * cannot infer the machine's types for them and each builder would have to be
 * given all of them by hand. `act` and `assignCtx` are `enqueueActions` and
 * `assign` with that done; `Enqueue` is the `enqueue` an `act` callback
 * receives (xstate does not export it), for helpers an action hands it to.
 *
 * `assignCtx` is `assign` under another name, and the
 * `tmuxy/state-field-ownership` ESLint rule reads its payload the same way.
 */

import { assign, enqueueActions } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../types';

export type Ctx = AppMachineContext;
export type Evt = AllAppMachineEvents;

export const act = enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>;
export const assignCtx = assign<Ctx, Evt, undefined, Evt, never>;

export type Enqueue = Parameters<Parameters<typeof act>[0]>[0]['enqueue'];
