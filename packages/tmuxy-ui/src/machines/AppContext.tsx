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
  selectPaneGroupPanes as selectPaneGroupPanesFn,
  getActivePaneInGroup,
} from './selectors';
import { createAdapter } from '../tmux/adapters';
import { createTmuxActor } from './actors/tmuxActor';
import { createKeyboardActor } from './actors/keyboardActor';
import { createSizeActor } from './actors/sizeActor';

// Re-export all selectors
export {
  selectPreviewPanes,
  selectPanes,
  selectDraggedPaneId,
  selectDragOffsetX,
  selectDragOffsetY,
  selectDragOriginalPosition,
  selectDropTarget,
  selectResize,
  selectResizePixelDelta,
  selectWindows,
  selectVisibleWindows,
  selectActiveWindowId,
  selectIsConnected,
  selectError,
  selectGridDimensions,
  selectCharSize,
  selectPanePixelDimensions,
  selectPaneGroups,
  selectPaneGroupForPane,
  selectPaneGroupPanes,
  getActivePaneInGroup,
  getActiveIndexInGroup,
  selectVisiblePanes,
  selectPaneById,
  selectIsPaneInActiveWindow,
  selectIsSinglePane,
  selectStatusLine,
  selectContainerSize,
  selectEnableAnimations,
  selectHasOptimisticOperation,
  selectGroupSwitchPaneIds,
  selectSessionName,
  selectKeyBindings,
  selectCommandMode,
  selectStatusMessage,
} from './selectors';

// ============================================
// Context
// ============================================

const AppContext = createContext<AppMachineActor | null>(null);

/**
 * Measure char width from rendered monospace font.
 */
function measureCharWidth(): number {
  const testEl = document.createElement('pre');
  testEl.className = 'terminal-content';
  testEl.style.position = 'absolute';
  testEl.style.visibility = 'hidden';
  testEl.style.top = '-9999px';
  testEl.textContent = 'MMMMMMMMMM';
  document.body.appendChild(testEl);
  const width = testEl.getBoundingClientRect().width / 10;
  document.body.removeChild(testEl);
  return width;
}

// ============================================
// Provider
// ============================================

export function AppProvider({ children }: { children: ReactNode }) {
  // Create adapter and actors once
  const actors = useMemo(() => {
    const adapter = createAdapter();
    // Expose adapter for E2E testing (dev mode or CI)
    if (
      typeof window !== 'undefined' &&
      (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true')
    ) {
      (window as unknown as { _adapter: typeof adapter })._adapter = adapter;
    }
    return {
      tmuxActor: createTmuxActor(adapter),
      keyboardActor: createKeyboardActor(),
      sizeActor: createSizeActor(measureCharWidth),
    };
  }, []);

  const actorRef = useActorRef(
    appMachine.provide({
      actors,
    }),
  );

  // Expose XState actor for debugging (dev mode or CI)
  useMemo(() => {
    if (
      typeof window !== 'undefined' &&
      (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true')
    ) {
      (window as unknown as { app: typeof actorRef }).app = actorRef;
    }
  }, [actorRef]);

  return <AppContext.Provider value={actorRef}>{children}</AppContext.Provider>;
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

/** Get the send function for app machine events */
export function useAppSend(): (event: AppMachineEvent) => void {
  const actor = useAppActor();
  return actor.send;
}

/** Check if the machine is in a given state (supports nested states) */
export function useAppState(stateValue: string): boolean {
  const actor = useAppActor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useSelector(actor, (snapshot) => snapshot.matches(stateValue as any));
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

/**
 * Check if a drag operation is in the "committing" phase
 * (after user released mouse, waiting for tmux to confirm swap)
 * TODO: Implement proper committing state in drag machine
 */
export function useIsCommittingDrag(): boolean {
  // For now, always return false - proper implementation would
  // check if drag machine is in a "committing" state
  return false;
}

/**
 * Check if a resize operation is in the "committing" phase
 * (after user released mouse, waiting for tmux to confirm resize)
 * TODO: Implement proper committing state in resize machine
 */
export function useIsCommittingResize(): boolean {
  // For now, always return false - proper implementation would
  // check if resize machine is in a "committing" state
  return false;
}

/** Get a specific pane by ID (with resize preview) */
export function usePane(paneId: string): TmuxPane | undefined {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selectPaneById(snapshot.context, paneId));
}

/** Check if a pane is in the active window */
export function useIsPaneInActiveWindow(paneId: string): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selectIsPaneInActiveWindowFn(snapshot.context, paneId));
}

/** Check if there's only a single visible pane */
export function useIsSinglePane(): boolean {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => selectIsSinglePaneFn(snapshot.context));
}

/** Get the group containing a pane, with resolved pane data and active pane ID */
export function usePaneGroup(paneId: string): {
  group: PaneGroup | undefined;
  groupPanes: TmuxPane[];
  activePaneId: string | null;
} {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => {
    const group = selectPaneGroupForPane(snapshot.context, paneId);
    const groupPanes = group ? selectPaneGroupPanesFn(snapshot.context, group) : [];
    const activePaneId = group ? getActivePaneInGroup(snapshot.context, group) : null;
    return { group, groupPanes, activePaneId };
  });
}

/** Get the copy mode state for a pane (undefined if not in copy mode) */
export function useCopyModeState(paneId: string): CopyModeState | undefined {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => snapshot.context.copyModeStates[paneId]);
}
