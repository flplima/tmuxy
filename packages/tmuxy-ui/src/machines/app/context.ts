/**
 * Initial context and field-ownership registry for appMachine.
 *
 * The AppMachineContext type itself stays defined in ../types.ts (it's
 * imported across the codebase). This file owns the *initial value* and the
 * runtime mapping of each field to its owning parallel state.
 */

import type { AppMachineContext } from '../types';
import {
  DEFAULT_SESSION_NAME,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_CHAR_WIDTH,
  DEFAULT_CHAR_HEIGHT,
} from '../constants';
import { loadFontSizeFromStorage } from '../../utils/fontSizeManager';
import { loadThemeFromStorage } from '../../utils/themeManager';

export type { AppMachineContext };

/**
 * The name of each parallel state plus 'parent' for fields owned by the
 * parent machine itself (lifecycle, connection, dimensions).
 *
 * Keep in sync with the parallel states defined under ./states/.
 */
export type StateName =
  | 'layout'
  | 'copyMode'
  | 'groupsAndFloats'
  | 'commandUi'
  | 'uiPrefs'
  | 'parent';

/**
 * Maps every AppMachineContext field to the parallel state that owns it.
 *
 * This is the source of truth enforced by the tmuxy/state-field-ownership
 * ESLint rule — any `assign({...})` in states/<name>.ts may only mutate
 * fields whose owner is `<name>` (or 'parent', which is rewriteable by
 * the parent machine only).
 *
 * The `satisfies` clause guarantees every context field is covered;
 * removing one or adding a new one without updating this map is a type error.
 */
export const FIELD_OWNERS = {
  // ---- parent (lifecycle, connection, dimensions, dragging proxies) ----
  connected: 'parent',
  error: 'parent',
  fatalError: 'parent',
  reconnectAttempt: 'parent',
  log: 'parent',
  sessionName: 'parent',
  connectionId: 'parent',
  defaultShell: 'parent',
  keybindings: 'parent',
  appFocused: 'parent',
  totalWidth: 'parent',
  totalHeight: 'parent',
  targetCols: 'parent',
  targetRows: 'parent',
  charWidth: 'parent',
  charHeight: 'parent',
  containerWidth: 'parent',
  containerHeight: 'parent',
  lastUpdateTime: 'parent',
  sessions: 'parent',
  serverList: 'parent',
  currentServerId: 'parent',

  // ---- layout ----
  panes: 'layout',
  windows: 'layout',
  activeWindowId: 'layout',
  activePaneId: 'layout',
  paneActivationOrder: 'layout',
  lastActivePaneByWindow: 'layout',
  paneKeyOverrides: 'layout',
  lastLayoutCommandTime: 'layout',
  drag: 'layout',
  resize: 'layout',
  resizeActive: 'layout',
  suppressLayoutTransition: 'layout',
  groupSwitchPaneIds: 'layout',
  lastUpdateQuiet: 'layout',

  // ---- copyMode ----
  copyModeStates: 'copyMode',

  // ---- groupsAndFloats ----
  paneGroups: 'groupsAndFloats',
  floatPanes: 'groupsAndFloats',
  focusedFloatPaneId: 'groupsAndFloats',
  sidebarOpen: 'groupsAndFloats',
  sidebarFocused: 'groupsAndFloats',

  // ---- commandUi ----
  commandMode: 'commandUi',
  statusMessage: 'commandUi',
  statusLine: 'commandUi',
  prefixActive: 'commandUi',

  // ---- uiPrefs ----
  themeName: 'uiPrefs',
  themeMode: 'uiPrefs',
  availableThemes: 'uiPrefs',
  baseFontSize: 'uiPrefs',
  enableAnimations: 'uiPrefs',
} as const satisfies Record<keyof AppMachineContext, StateName>;

/**
 * Build the initial context. Called once at machine setup time.
 *
 * Wrapped in a function (rather than a top-level constant) so that side
 * effects like `loadFontSizeFromStorage()` are deferred to machine creation,
 * not module load — which matters for tests that stub localStorage.
 */
export function createInitialContext(): AppMachineContext {
  return {
    connected: false,
    error: null,
    fatalError: null,
    reconnectAttempt: 0,
    log: [],
    sessionName: DEFAULT_SESSION_NAME,
    activeWindowId: null,
    activePaneId: null,
    panes: [],
    windows: [],
    totalWidth: 0,
    totalHeight: 0,
    paneGroups: {},
    targetCols: DEFAULT_COLS,
    targetRows: DEFAULT_ROWS,
    drag: null,
    resize: null,
    resizeActive: false,
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    connectionId: null,
    defaultShell: 'bash',
    statusLine: '',
    containerWidth: 0,
    containerHeight: 0,
    lastUpdateTime: 0,
    sessions: [],
    serverList: [],
    currentServerId: '',
    floatPanes: {},
    focusedFloatPaneId: null,
    sidebarOpen: false,
    sidebarFocused: false,
    enableAnimations: false,
    keybindings: null,
    copyModeStates: {},
    lastLayoutCommandTime: 0,
    suppressLayoutTransition: false,
    paneKeyOverrides: {},
    lastActivePaneByWindow: {},
    paneActivationOrder: [] as string[],
    groupSwitchPaneIds: [] as string[],
    lastUpdateQuiet: true,
    commandMode: null,
    statusMessage: null,
    themeName: loadThemeFromStorage()?.theme ?? 'default',
    themeMode: loadThemeFromStorage()?.mode ?? ('dark' as const),
    availableThemes: [],
    appFocused: true,
    prefixActive: false,
    baseFontSize: loadFontSizeFromStorage(),
  };
}
