import type { AppMachineContext } from '../types/context';
import type { GitRepository, LogEntry, SessionTreeNode, TraceSettings } from '../types/domain';
import type { KeyBindings } from '../../domain/wire';
import type { WindowId } from '../../domain/ids';
import type { ThemeInfo, ThemeMode } from '../../utils/themeManager';
import { selectVisibleWindows } from './panesAndSidebars';

// ============================================
// Session & Connection Selectors
// ============================================

export function selectSessions(context: AppMachineContext): SessionTreeNode[] {
  return context.sessions;
}

export function selectRepositories(context: AppMachineContext): GitRepository[] {
  return context.repositories;
}

export function selectError(context: AppMachineContext): string | null {
  return context.error;
}

export function selectFatalError(context: AppMachineContext): string | null {
  return context.fatalError;
}

export function selectLog(context: AppMachineContext): LogEntry[] {
  return context.log;
}

export function selectReadOnly(context: AppMachineContext): boolean {
  return context.readOnly;
}

export function selectSessionName(context: AppMachineContext): string {
  return context.sessionName;
}

export function selectKeyBindings(context: AppMachineContext): KeyBindings | null {
  return context.keybindings;
}

// ============================================
// Animation & Gesture Selectors
// ============================================

/** Layout animations right now: settled after a change, and allowed by the config. */
export function selectEnableAnimations(context: AppMachineContext): boolean {
  return context.enableAnimations && context.animationsAllowed;
}

/** The config's `@tmuxy-animations` switch. */
export function selectAnimationsAllowed(context: AppMachineContext): boolean {
  return context.animationsAllowed;
}

/** Whether the keyboard is in one of the sidebar columns rather than the panes. */
export function selectSidebarFocused(context: AppMachineContext): boolean {
  return context.leftSidebarFocused || context.rightSidebarFocused;
}

/** The config's `@tmuxy-cursor-blink` switch. */
export function selectCursorBlink(context: AppMachineContext): boolean {
  return context.cursorBlink;
}

/** The config's `@tmuxy-tab-overview-cols`: cards per row in the "all tabs" view. */
export function selectTabOverviewCols(context: AppMachineContext): number {
  return context.tabOverviewCols;
}

/** The trackpad gesture being drawn right now, or null. */
export function selectGesture(context: AppMachineContext): AppMachineContext['gesture'] {
  return context.gesture;
}

/**
 * The tab a slide is pulling in and the side it comes from, as `windowId:side`
 * (1 from the right, -1 from the left), or null.
 */
export function selectSwipeNeighbor(context: AppMachineContext): string | null {
  const g = context.gesture;
  if (g?.kind !== 'swipe' || !g.neighborId) return null;
  const tabs = selectVisibleWindows(context);
  const at = (id: WindowId | null) => tabs.findIndex((w) => w.id === id);
  return `${g.neighborId}:${at(g.neighborId) > at(context.activeWindowId) ? 1 : -1}`;
}

export function selectSwipeStill(context: AppMachineContext): boolean {
  return context.gesture?.kind === 'swipe';
}

/** The pane a pinch draws: growing out of its slot, or held until its unzoom lands. */
export function selectGesturePaneId(context: AppMachineContext): string | null {
  const g = context.gesture;
  if (g?.kind !== 'pinch') return null;
  return g.mode === 'zoom' || (g.mode === 'unzoom' && g.phase === 'handoff') ? g.paneId : null;
}

export function selectSuppressLayoutTransition(context: AppMachineContext): boolean {
  return context.suppressLayoutTransition;
}

export function selectPaneKeyOverrides(context: AppMachineContext): Record<string, string> {
  return context.paneKeyOverrides;
}

// ============================================
// Command Mode, Notifications & Focus Selectors
// ============================================

export function selectCommandMode(context: AppMachineContext) {
  return context.commandMode;
}

export function selectStatusMessage(context: AppMachineContext) {
  return context.statusMessage;
}

export function selectNotifications(context: AppMachineContext) {
  return context.notifications;
}

export function selectPrefixActive(context: AppMachineContext): boolean {
  return context.prefixActive;
}

/** The sticky key table in force (`pane`, `tab`), or null. */
export function selectKeyTable(context: AppMachineContext): string | null {
  return context.keyTable;
}

/**
 * The keyboard is somewhere other than the tiled panes: a focused float, the
 * dock or the tree take it without changing tmux's active pane.
 */
export function selectKeyboardElsewhere(context: AppMachineContext): boolean {
  return (
    Boolean(context.focusedFloatPaneId) || context.leftSidebarFocused || context.rightSidebarFocused
  );
}

/**
 * Whether the active pane is in tmux's copy mode — the one with a cursor, vi
 * keys and hints worth showing on the status line.
 */
export function selectActivePaneCopyMode(context: AppMachineContext): boolean {
  if (!context.activePaneId) return false;
  const pane = context.panes.find((p) => p.tmuxId === context.activePaneId);
  if (pane?.inMode) return true;
  return context.copyModeStates[context.activePaneId]?.mode === 'copy';
}

// ============================================
// Theme & Trace Selectors
// ============================================

export function selectThemeName(context: AppMachineContext): string {
  return context.themeName;
}

export function selectThemeMode(context: AppMachineContext): ThemeMode {
  return context.themeMode;
}

export function selectAvailableThemes(context: AppMachineContext): ThemeInfo[] {
  return context.availableThemes;
}

/** Local action tracing as the backend reports it, or null before it is read. */
export function selectTraceSettings(context: AppMachineContext): TraceSettings | null {
  return context.traceSettings;
}
