/** Typed hooks over the app machine provided by `AppProvider` (AppContext.tsx). */

import { useCallback, useContext } from 'react';
import { useSelector } from '@xstate/react';
import type { StateValueFrom } from 'xstate';
import type { appMachine, AppMachineActor } from './app/appMachine';
import type { AppMachineContext } from './types/context';
import type { AppMachineEvent } from './types/events';
import type { TmuxPane, PaneGroup } from '../domain/client';
import type { CopyModeState } from '../domain/copyMode';
import {
  selectPaneById,
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

export function useAppSelector<T>(selector: (context: AppMachineContext) => T): T {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selector(snapshot.context));
}

/** A selector whose array result re-renders only when its elements change. */
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

export function useAppSend(): (event: AppMachineEvent) => void {
  const actor = useAppActor();
  return actor.send;
}

/** Whether the machine is in `stateValue`, one of its top-level states. */
export function useAppState(stateValue: StateValueFrom<typeof appMachine>): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.matches(stateValue));
}

export function useIsDragging(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.drag !== null);
}

export function useIsResizing(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.resize !== null);
}

/** A pane as drawn, with the resize preview. */
export function usePane(paneId: PaneId | null): TmuxPane | undefined {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) =>
    paneId === null ? undefined : selectPaneById(snapshot.context, paneId),
  );
}

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
 * Equality for usePaneGroup's derived shape, which is a fresh object every
 * snapshot: without it every PaneHeader re-renders on every model update,
 * content-only deltas included. `group` is ref-stable (selectPaneGroupForPane
 * is memoized on paneGroups) and groupPanes holds refs into context.panes.
 */
function paneGroupResultEqual(a: PaneGroupResult, b: PaneGroupResult): boolean {
  return (
    a.group === b.group &&
    a.activePaneId === b.activePaneId &&
    shallowArrayEqual(a.groupPanes, b.groupPanes)
  );
}

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

export function useCopyModeState(paneId: PaneId): CopyModeState | undefined {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.copyModeStates[paneId]);
}

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}

export function useAppFocused(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.appFocused);
}
