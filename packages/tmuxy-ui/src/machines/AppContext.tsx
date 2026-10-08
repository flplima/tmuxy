/**
 * AppContext - XState machine provider and typed hooks for accessing state.
 *
 * Components use the exported hooks to:
 * - useAppSelector(selector) - derive values from machine context
 * - useAppSend() - get the machine's send function
 * - useAppState('stateName') - check if machine is in a specific state
 * - useIsDragging() - check if drag is in progress
 * - useIsResizing() - check if resize is in progress
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import type { StateValueFrom } from 'xstate';
import { appMachine, type AppMachineActor } from './app';
import type {
  AppMachineContext,
  AppMachineEvent,
  TmuxPane,
  PaneGroup,
  CopyModeState,
} from './types';
import {
  selectPaneById,
  selectIsPaneInActiveWindow as selectIsPaneInActiveWindowFn,
  selectIsSinglePane as selectIsSinglePaneFn,
  selectPaneGroupForPane,
  selectReadOnly,
  selectPaneGroupPanes as selectPaneGroupPanesFn,
  getActivePaneInGroup,
} from './selectors';
import { activeCloseTarget, executeMenuAction } from '../components/menus/menuActions';
import type { Layer } from 'effect';
import type { TmuxTransport } from '../infra/transport/TmuxTransport';
import { transportForEnvironment } from '../infra/transport/layers';
import { makeAppRuntime } from '../infra/runtime';
import { tracer } from '../infra/tracer';
import { createTmuxActor } from './actors/tmuxActor';
import { createKeyboardActor } from './actors/keyboardActor';
import { createLinkModifierActor } from './actors/linkModifierActor';
import { createGestureActor } from './actors/gestureActor';
import { createSizeActor } from './actors/sizeActor';
import { createServersActor } from './actors/serversActor';
import { createTmuxStoreActor } from './actors/tmuxStoreActor';
import { makeTmuxStore } from '../infra/store/TmuxStore';
import { measureCellMetrics } from '../utils/cellMetrics';
import type { PaneId } from '../domain/ids';

// ============================================
// App Config (static flags passed via provider)
// ============================================

export interface AppConfig {
  /** When true, wheel events on panes with no scrollback bubble to the parent page */
  forwardScrollToParent?: boolean;
  /** When true, keyboard capture is gated by click-to-focus on the app container */
  requireFocus?: boolean;
  /** When true, running in demo mode — disables session/host click actions */
  isDemo?: boolean;
}

const AppConfigContext = createContext<AppConfig>({});

// Re-export all selectors
export {
  selectPreviewPanes,
  selectPanes,
  selectSessions,
  selectRepositories,
  selectDraggedPaneId,
  selectTabDrop,
  selectGroupDrop,
  selectDragOffsetX,
  selectDragOffsetY,
  selectDropTarget,
  selectWindows,
  selectVisibleWindows,
  selectLeftSidebarPane,
  selectSidebarLayout,
  selectSettledPaneWidth,
  selectRightSidebarPane,
  selectError,
  selectFatalError,
  selectLog,
  selectGridDimensions,
  selectCharSize,
  selectSidebarCellMetrics,
  selectKeyboardElsewhere,
  selectCellMetrics,
  selectPaneGroupForPane,
  selectPaneGroupPanes,
  getActivePaneInGroup,
  selectVisiblePanes,
  selectVisibleFloats,
  selectMarkedPaneId,
  selectHiddenWindowPanes,
  selectPaneById,
  selectIsPaneInActiveWindow,
  selectIsSinglePane,
  selectContainerSize,
  selectFitScale,
  selectEnableAnimations,
  selectSuppressLayoutTransition,
  selectPaneKeyOverrides,
  selectGroupSwitchPaneIds,
  selectSessionName,
  selectKeyBindings,
  selectCommandMode,
  selectStatusMessage,
  selectNotifications,
  selectAnimationsAllowed,
  selectCursorBlink,
  selectTabOverviewCols,
  selectGesture,
  selectSwipeNeighbor,
  selectSwipeStill,
  selectGesturePaneId,
  selectSidebarFocused,
  selectPrefixActive,
  selectActivePaneCopyMode,
  selectThemeName,
  selectThemeMode,
  selectAvailableThemes,
  selectTraceSettings,
} from './selectors';

// ============================================
// Context
// ============================================

const AppContext = createContext<AppMachineActor | null>(null);

// ============================================
// Provider
// ============================================

export function AppProvider({
  children,
  transport,
  config,
}: {
  children: ReactNode;
  /** The backend to run against; the environment's (web, desktop, `?demo`) when omitted. */
  transport?: Layer.Layer<TmuxTransport>;
  config?: AppConfig;
}) {
  // Create the runtime, store, and actors once. The runtime is built from the
  // transport Layer and every actor runs its effects on it. The TmuxStore is
  // the client model — owns optimistic patches and reconciliation; the
  // tmuxStoreActor bridges it into XState so the appMachine context stays a
  // passive mirror of the store's derived snapshot.
  const actors = useMemo(() => {
    const runtime = makeAppRuntime(transport ?? transportForEnvironment());
    const store = makeTmuxStore();
    return {
      tmuxActor: createTmuxActor(runtime),
      tmuxStoreActor: createTmuxStoreActor(store, runtime),
      keyboardActor: createKeyboardActor(),
      linkModifierActor: createLinkModifierActor(),
      gestureActor: createGestureActor(),
      sizeActor: createSizeActor(measureCellMetrics),
      serversActor: createServersActor(runtime),
    };
  }, []);

  const actorRef = useActorRef(
    appMachine.provide({
      actors,
    }),
  );

  // Expose the XState actor for E2E tests, and tap `send` so the action
  // tracer sees every dispatched event.
  useMemo(() => {
    if (typeof window === 'undefined') return;
    const originalSend = actorRef.send.bind(actorRef);
    (actorRef as { send: (event: unknown) => void }).send = (event: unknown) => {
      // Action tracing: record only the event *type* (a variant name like
      // DISPATCH_OP), never its payload — the payload can carry keystrokes.
      // The derived model-update firehose is coalesced to a periodic count so it
      // doesn't drown the trace.
      const type = (event as { type?: string })?.type;
      if (type === 'TMUX_MODEL_UPDATE') tracer.count('xstate', type);
      else if (type) tracer.event({ layer: 'xstate', name: type });
      return originalSend(event as Parameters<typeof originalSend>[0]);
    };
    (window as unknown as { app: typeof actorRef }).app = actorRef;
    // Let the Tauri native menu reuse the exact same action dispatch the
    // in-app menu uses, so its items (including `tab-new`) route through the
    // control-mode-safe adapter path instead of raw external tmux subprocesses.
    (window as unknown as { tmuxyMenuAction: (actionId: string) => void }).tmuxyMenuAction = (
      actionId: string,
    ) => {
      const { activePaneId, focusedFloatPaneId } = actorRef.getSnapshot().context;
      executeMenuAction(
        actorRef.send,
        actionId,
        activeCloseTarget(activePaneId, focusedFloatPaneId),
      );
    };
  }, [actorRef]);

  return (
    <AppConfigContext.Provider value={config ?? {}}>
      <AppContext.Provider value={actorRef}>{children}</AppContext.Provider>
    </AppConfigContext.Provider>
  );
}

// ============================================
// Hooks
// ============================================

export function useAppActor(): AppMachineActor {
  const actor = useContext(AppContext);
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
/** Whether this client is a viewer of a read-only session. */
export function useReadOnly(): boolean {
  return useAppSelector(selectReadOnly);
}

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}

/** Check if the app container is focused (for keyboard capture gating) */
export function useAppFocused(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.appFocused);
}
