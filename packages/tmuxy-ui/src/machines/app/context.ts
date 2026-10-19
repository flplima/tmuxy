/**
 * Initial context and field-ownership registry for appMachine.
 *
 * The AppMachineContext type itself stays defined in ../types.ts (it's
 * imported across the codebase). This file owns the *initial value* and the
 * runtime mapping of each field to its owning state slice.
 */

import type { AppMachineContext } from '../types/context';
import {
  DEFAULT_SESSION_NAME,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_CHAR_WIDTH,
  DEFAULT_CHAR_HEIGHT,
} from '../constants';
import { loadFontSizeFromStorage } from '../../utils/fontSizeManager';
import { loadSidebarFixed } from '../../utils/sidebarDock';
import { loadThemeFromStorage } from '../../utils/themeManager';

/**
 * The name of each state slice (a root-level `on` block under ./states/)
 * plus 'parent' for fields owned by the machine itself (lifecycle,
 * connection, dimensions).
 */
export type StateName =
  | 'layout'
  | 'tabOverview'
  | 'copyMode'
  | 'browser'
  | 'groupsAndFloats'
  | 'sidebars'
  | 'commandUi'
  | 'notifications'
  | 'uiPrefs'
  | 'gestures'
  | 'ask'
  | 'parent';

/**
 * Maps every AppMachineContext field to the state slice that owns it.
 *
 * The tmuxy/state-field-ownership ESLint rule reads this map from this file
 * (keep it one `field: 'owner',` entry per line) — any `assign({...})` or
 * `assignCtx({...})` in states/<name>.ts or actions/<name>.ts may only mutate
 * fields whose owner is `<name>` ('parent' fields are written by
 * appMachine.ts only).
 *
 * The `satisfies` clause guarantees every context field is covered;
 * removing one or adding a new one without updating this map is a type error.
 */
export const FIELD_OWNERS = {
  // ---- parent (lifecycle, connection, dimensions, dragging proxies) ----
  connected: 'parent',
  error: 'parent',
  fatalError: 'parent',
  log: 'parent',
  sessionName: 'parent',
  defaultShell: 'parent',
  readOnly: 'parent',
  keybindings: 'parent',
  appFocused: 'parent',
  totalWidth: 'parent',
  totalHeight: 'parent',
  targetCols: 'parent',
  targetRows: 'parent',
  charWidth: 'parent',
  charHeight: 'parent',
  cellGap: 'parent',
  gridFontSize: 'parent',
  phoneLayout: 'parent',
  containerWidth: 'parent',
  containerHeight: 'parent',
  bodyWidth: 'parent',
  sessions: 'parent',
  repositories: 'parent',
  servers: 'parent',
  currentServerId: 'parent',
  serverProbe: 'parent',
  restorableSessions: 'parent',

  // ---- layout ----
  panes: 'layout',
  windows: 'layout',
  activeWindowId: 'layout',
  activePaneId: 'layout',
  paneActivationOrder: 'layout',
  unreadPaneIds: 'layout',
  lastActivePaneByWindow: 'layout',
  paneKeyOverrides: 'layout',
  lastLayoutCommandTime: 'layout',
  drag: 'layout',
  resize: 'layout',
  resizeActive: 'layout',
  suppressLayoutTransition: 'layout',
  lastUpdateAnimated: 'layout',
  groupSwitchPaneIds: 'layout',
  lastUpdateQuiet: 'layout',

  // ---- ask ----
  askSelections: 'ask',

  // ---- copyMode ----
  copyModeStates: 'copyMode',

  // ---- groupsAndFloats ----
  paneGroups: 'groupsAndFloats',
  floatPanes: 'groupsAndFloats',
  focusedFloatPaneId: 'groupsAndFloats',

  // ---- sidebars ----
  leftSidebarOpen: 'sidebars',
  leftSidebarFixed: 'sidebars',
  leftSidebarFocused: 'sidebars',
  rightSidebarOpen: 'sidebars',
  rightSidebarFixed: 'sidebars',
  rightSidebarFocused: 'sidebars',
  leftSidebarStartFailed: 'sidebars',
  rightSidebarStartFailed: 'sidebars',
  leftSidebarStarting: 'sidebars',
  rightSidebarStarting: 'sidebars',
  sidebarColsPreview: 'sidebars',
  dockRowsSent: 'sidebars',
  sidebarMotion: 'sidebars',
  leftSidebarClosing: 'sidebars',
  rightSidebarClosing: 'sidebars',
  collapsedTabIds: 'sidebars',

  // ---- tabOverview ----
  tabOverviewOpen: 'tabOverview',
  tabOverviewSelected: 'tabOverview',
  tabRenameRequest: 'tabOverview',

  // ---- commandUi ----
  commandMode: 'commandUi',
  statusMessage: 'commandUi',
  prefixActive: 'commandUi',
  prefixRepeatOnly: 'commandUi',
  keyTable: 'commandUi',
  keysViewOpen: 'commandUi',

  // ---- notifications ----
  notifications: 'notifications',

  // ---- uiPrefs ----
  themeName: 'uiPrefs',
  themeMode: 'uiPrefs',
  availableThemes: 'uiPrefs',
  traceSettings: 'uiPrefs',
  baseFontSize: 'uiPrefs',
  enableAnimations: 'uiPrefs',
  animationsAllowed: 'uiPrefs',
  cursorBlink: 'uiPrefs',
  sendAsk: 'uiPrefs',
  tabOverviewCols: 'uiPrefs',
  gestureFlags: 'uiPrefs',
  nativeMenus: 'uiPrefs',
  gesture: 'gestures',
} as const satisfies Record<keyof AppMachineContext, StateName>;

/**
 * Build the initial context. Called once at machine setup time.
 *
 * Wrapped in a function (rather than a top-level constant) so that side
 * effects like `loadFontSizeFromStorage()` are deferred to machine creation,
 * not module load — which matters for tests that stub localStorage.
 */
export function createInitialContext(): AppMachineContext {
  const sidebarFixed = loadSidebarFixed();
  return {
    connected: false,
    error: null,
    fatalError: null,
    log: [],
    sessionName: DEFAULT_SESSION_NAME,
    activeWindowId: null,
    activePaneId: null,
    panes: [],
    windows: [],
    totalWidth: 0,
    totalHeight: 0,
    paneGroups: {},
    askSelections: {},
    targetCols: DEFAULT_COLS,
    targetRows: DEFAULT_ROWS,
    drag: null,
    resize: null,
    resizeActive: false,
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    cellGap: 0,
    gridFontSize: null,
    phoneLayout: false,
    defaultShell: 'bash',
    readOnly: false,
    containerWidth: 0,
    containerHeight: 0,
    bodyWidth: 0,
    sessions: [],
    repositories: [],
    servers: [],
    currentServerId: null,
    serverProbe: null,
    restorableSessions: [],
    floatPanes: {},
    focusedFloatPaneId: null,
    leftSidebarOpen: false,
    leftSidebarFixed: sidebarFixed.left,
    leftSidebarFocused: false,
    rightSidebarOpen: false,
    rightSidebarFixed: sidebarFixed.right,
    rightSidebarFocused: false,
    leftSidebarStartFailed: false,
    rightSidebarStartFailed: false,
    leftSidebarStarting: false,
    rightSidebarStarting: false,
    sidebarColsPreview: null,
    dockRowsSent: null,
    sidebarMotion: false,
    leftSidebarClosing: false,
    rightSidebarClosing: false,
    collapsedTabIds: [],
    tabOverviewOpen: false,
    tabOverviewSelected: 0,
    tabRenameRequest: null,
    enableAnimations: false,
    animationsAllowed: true,
    cursorBlink: true,
    sendAsk: true,
    tabOverviewCols: 3,
    gestureFlags: { swipeTabs: true, pinchZoom: true, pinchOverview: true },
    nativeMenus: true,
    gesture: null,
    keybindings: null,
    copyModeStates: {},
    lastLayoutCommandTime: 0,
    suppressLayoutTransition: false,
    lastUpdateAnimated: false,
    paneKeyOverrides: {},
    lastActivePaneByWindow: {},
    paneActivationOrder: [],
    unreadPaneIds: [],
    groupSwitchPaneIds: [],
    lastUpdateQuiet: true,
    commandMode: null,
    statusMessage: null,
    notifications: [],
    themeName: loadThemeFromStorage()?.theme ?? 'default',
    themeMode: loadThemeFromStorage()?.mode ?? 'dark',
    availableThemes: [],
    traceSettings: null,
    appFocused: true,
    prefixActive: false,
    prefixRepeatOnly: null,
    keyTable: null,
    keysViewOpen: false,
    baseFontSize: loadFontSizeFromStorage(),
  };
}
