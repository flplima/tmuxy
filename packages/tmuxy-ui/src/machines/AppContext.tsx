import { createContext, useContext, ReactNode } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { appMachine, AppMachineActor } from './appMachine';
import type { AppMachineContext, AppMachineEvent } from './types';

// ============================================
// Context
// ============================================

const AppActorContext = createContext<AppMachineActor | null>(null);

// ============================================
// Provider
// ============================================

interface AppProviderProps {
  children: ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
  const actorRef = useActorRef(appMachine);

  return <AppActorContext.Provider value={actorRef}>{children}</AppActorContext.Provider>;
}

// ============================================
// Core Hooks
// ============================================

/**
 * Get the app machine actor ref
 * Use this to send events to the machine
 */
export function useAppActor(): AppMachineActor {
  const actorRef = useContext(AppActorContext);
  if (!actorRef) {
    throw new Error('useAppActor must be used within AppProvider');
  }
  return actorRef;
}

/**
 * Send events to the app machine
 */
export function useAppSend(): (event: AppMachineEvent) => void {
  const actorRef = useAppActor();
  return actorRef.send;
}

/**
 * Select state from the app machine context with auto-subscription
 */
export function useAppSelector<T>(selector: (context: AppMachineContext) => T): T {
  const actorRef = useAppActor();
  return useSelector(actorRef, (snapshot) => selector(snapshot.context));
}

// ============================================
// State Matching Hooks
// ============================================

type TopLevelState = 'connecting' | 'idle' | 'dragging' | 'committingDrag' | 'resizing' | 'committingResize';
type IdleSubState = 'normal' | 'prefixWait' | 'commandMode';

/**
 * Check if machine matches a top-level state
 */
export function useAppState(stateValue: TopLevelState): boolean {
  const actorRef = useAppActor();
  return useSelector(actorRef, (snapshot) => snapshot.matches(stateValue));
}

/**
 * Check if machine matches a nested idle state (e.g., 'idle.prefixWait')
 */
export function useIdleSubState(subState: IdleSubState): boolean {
  const actorRef = useAppActor();
  return useSelector(actorRef, (snapshot) => snapshot.matches({ idle: subState }));
}

/**
 * Check if currently dragging (active drag, not committing)
 */
export function useIsDragging(): boolean {
  return useAppState('dragging');
}

/**
 * Check if drag is being committed (waiting for server)
 */
export function useIsCommittingDrag(): boolean {
  return useAppState('committingDrag');
}

/**
 * Check if currently resizing (active resize, not committing)
 */
export function useIsResizing(): boolean {
  return useAppState('resizing');
}

/**
 * Check if resize is being committed (waiting for server)
 */
export function useIsCommittingResize(): boolean {
  return useAppState('committingResize');
}

/**
 * Check if in prefix key wait mode
 */
export function useIsPrefixMode(): boolean {
  return useIdleSubState('prefixWait');
}

/**
 * Check if in command mode
 */
export function useIsCommandMode(): boolean {
  return useIdleSubState('commandMode');
}

// Re-export selectors for convenience
export * from './selectors';
export type { TmuxPane, TmuxWindow } from './types';
