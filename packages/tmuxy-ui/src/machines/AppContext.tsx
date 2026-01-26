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
import type { AppMachineContext, AppMachineEvent, TmuxPane, PaneStack } from './types';
import {
  selectPaneById,
  selectIsPaneInActiveWindow as selectIsPaneInActiveWindowFn,
  selectIsSinglePane as selectIsSinglePaneFn,
  selectStackForPane,
  selectStackPanes as selectStackPanesFn,
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
  selectDragTargetNewWindow,
  selectDragOffsetX,
  selectDragOffsetY,
  selectDragOriginalPosition,
  selectDropTarget,
  selectResize,
  selectResizePixelDelta,
  selectWindows,
  selectActiveWindowId,
  selectIsConnected,
  selectError,
  selectIsPrimary,
  selectGridDimensions,
  selectCharSize,
  selectPanePixelDimensions,
  selectStacks,
  selectStackForPane,
  selectStackPanes,
  selectVisiblePanes,
  selectPaneById,
  selectIsPaneInActiveWindow,
  selectIsSinglePane,
  selectStatusLine,
  selectContainerSize,
  selectPopup,
  selectHasPopup,
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
    return {
      tmuxActor: createTmuxActor(adapter),
      keyboardActor: createKeyboardActor(),
      sizeActor: createSizeActor(measureCharWidth),
    };
  }, []);

  const actorRef = useActorRef(
    appMachine.provide({
      actors,
    })
  );

  return <AppContext.Provider value={actorRef}>{children}</AppContext.Provider>;
}

// ============================================
// Hooks
// ============================================

function useAppActor(): AppMachineActor {
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

/** Get the stack containing a pane, with resolved pane data */
export function usePaneStack(paneId: string): { stack: PaneStack | undefined; stackPanes: TmuxPane[] } {
  const actor = useAppActor();
  return useSelector(actor, (snapshot) => {
    const stack = selectStackForPane(snapshot.context, paneId);
    const stackPanes = stack ? selectStackPanesFn(snapshot.context, stack) : [];
    return { stack, stackPanes };
  });
}
