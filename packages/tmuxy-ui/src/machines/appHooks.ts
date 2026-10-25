/**
 * Typed hooks over the app machine provided by `AppProvider` (AppContext.tsx).
 *
 * Components use them to:
 * - useAppSelector(selector) - derive values from machine context
 * - useAppSend() - get the machine's send function
 * - useAppState('stateName') - check if machine is in a specific state
 * - useIsDragging() - check if drag is in progress
 * - useIsResizing() - check if resize is in progress
 */

import { useCallback, useContext } from 'react';
import { useSelector } from '@xstate/react';
import type { StateValueFrom } from 'xstate';
import type { appMachine, AppMachineActor } from './app/appMachine';
import type { AppMachineContext } from './types/context';
import type { AppMachineEvent } from './types/events';
import type { TmuxPane } from '../domain/client';
import type { PaneGroup } from './types/domain';
import type { CopyModeState } from '../domain/copyMode';
import {
  selectPaneById,
  selectIsPaneInActiveWindow as selectIsPaneInActiveWindowFn,
  selectIsSinglePane as selectIsSinglePaneFn,
  selectPaneGroupForPane,
  selectPaneGroupPanes as selectPaneGroupPanesFn,
  getActivePaneInGroup,
} from './selectors/panesAndSidebars';
import { selectBindingOwnsKey } from './selectors/ui';
import type { PaneId } from '../domain/ids';
import {
  AppActorContext,
  AppConfigContext,
  AppRuntimeContext,
  type AppConfig,
} from './appContexts';
import type { AppRuntime } from '../infra/runtime';

/** The app's Effect runtime (see `AppRuntimeContext`). */
export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext);
  if (!runtime) throw new Error('useAppRuntime must be used within AppProvider');
  return runtime;
}

export function useAppActor(): AppMachineActor {
  const actor = useContext(AppActorContext);
  if (!actor) throw new Error('useAppActor must be used within AppProvider');
  return actor;
}

/** Type-safe selector hook for app machine context */
export function useAppSelector<T>(selector: (context: AppMachineContext) => T): T {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selector(snapshot.context));
}

/** Selector hook with shallow array comparison (prevents re-renders when array contents unchanged) */
export function useAppSelectorShallow<T extends unknown[]>(
  selector: (context: AppMachineContext) => T,
): T {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selector(snapshot.context), shallowArrayEqual);
}

function shallowArrayEqual<T extends unknown[]>(a: T, b: T): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * `selectBindingOwnsKey` against the live context, for a key listener that is
 * installed once and asked on every key.
 */
export function useBindingOwnsKey(): (key: string) => boolean {
  const actor = useAppActor();
  return useCallback((key) => selectBindingOwnsKey(actor.getSnapshot().context, key), [actor]);
}

/** Get the send function for app machine events */
export function useAppSend(): (event: AppMachineEvent) => void {
  const actor = useAppActor();
  return actor.send;
}

/** Whether the machine is in `stateValue`, one of its top-level states. */
export function useAppState(stateValue: StateValueFrom<typeof appMachine>): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.matches(stateValue));
}

/** Check if a drag operation is in progress */
export function useIsDragging(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.drag !== null);
}

/** Check if a resize operation is in progress */
export function useIsResizing(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.resize !== null);
}

/** Get a specific pane by ID (with resize preview). */
export function usePane(paneId: PaneId | null): TmuxPane | undefined {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) =>
    paneId === null ? undefined : selectPaneById(snapshot.context, paneId),
  );
}

/** Check if a pane is in the active window */
export function useIsPaneInActiveWindow(paneId: PaneId): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selectIsPaneInActiveWindowFn(snapshot.context, paneId));
}

/** Check if there's only a single visible pane */
export function useIsSinglePane(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selectIsSinglePaneFn(snapshot.context));
}

interface PaneGroupResult {
  group: PaneGroup | undefined;
  groupPanes: TmuxPane[];
  activePaneId: PaneId | null;
}

/**
 * Equality for usePaneGroup's derived shape. Without it the selector returns a
 * fresh object every snapshot, so every PaneHeader re-renders on every model
 * update — including 60fps content-only deltas — and the common ungrouped case
 * (`{ undefined, [], null }`) re-renders needlessly too. `group` is ref-stable
 * (selectPaneGroupForPane is memoized on paneGroups) and groupPanes elements are
 * refs into context.panes, so this compares faithfully: any relevant change
 * (membership, a group pane's object, the active pane) still re-renders.
 */
function paneGroupResultEqual(a: PaneGroupResult, b: PaneGroupResult): boolean {
  return (
    a.group === b.group &&
    a.activePaneId === b.activePaneId &&
    shallowArrayEqual(a.groupPanes, b.groupPanes)
  );
}

/** Get the group containing a pane, with resolved pane data and active pane ID */
export function usePaneGroup(paneId: PaneId): PaneGroupResult {
  const actor = useAppActor();
  return useSelector(
    actor,
    (snapshot): PaneGroupResult => {
      const group = selectPaneGroupForPane(snapshot.context, paneId);
      const groupPanes = group ? selectPaneGroupPanesFn(snapshot.context, group) : [];
      const activePaneId = group ? getActivePaneInGroup(snapshot.context, group) : null;
      return { group, groupPanes, activePaneId };
    },
    paneGroupResultEqual,
  );
}

/** Get the copy mode state for a pane (undefined if not in copy mode) */
export function useCopyModeState(paneId: PaneId): CopyModeState | undefined {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.copyModeStates[paneId]);
}

/** Get the app config flags */
export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}

/** Check if the app container is focused (for keyboard capture gating) */
export function useAppFocused(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.appFocused);
}
