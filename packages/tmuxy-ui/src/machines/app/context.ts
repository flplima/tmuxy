import { pushSupported } from '../../infra/pushNotifications';
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
import { loadFontSizePref, loadThemePref } from '../../infra/prefs';
import { DEFAULT_SIZE_POLICY } from '../../domain/gridFit';

/** The name of each state slice: its handlers in ./states/<name>.ts, its actions in ./actions/<name>.ts. */
export type StateName =
  | 'connection'
  | 'viewport'
  | 'layout'
  | 'tabOverview'
  | 'phone'
  | 'copyMode'
  | 'groupsAndFloats'
  | 'keyboard'
  | 'sidebars'
  | 'commandUi'
  | 'notifications'
  | 'uiPrefs'
  | 'gestures'
  | 'ask'
  | 'plugins';

/**
 * Maps every AppMachineContext field to the state slice that owns it.
 *
 * The tmuxy/state-field-ownership ESLint rule reads this map from this file
 * (keep it one `field: 'owner',` entry per line) — any `assign({...})` or
 * `assignCtx({...})` in states/<name>.ts or actions/<name>.ts may only mutate
 * fields whose owner is `<name>`, and the other files in machines/app/ own
 * none.
 *
 * The `satisfies` clause guarantees every context field is covered;
 * removing one or adding a new one without updating this map is a type error.
 */
export const FIELD_OWNERS = {
  // ---- connection ----
  connected: 'connection',
  error: 'connection',
  fatalError: 'connection',
  log: 'connection',
  sessionName: 'connection',
  defaultShell: 'connection',
  serverHostname: 'connection',
  keybindings: 'connection',
  appFocused: 'connection',
  sessions: 'connection',
  repositories: 'connection',
  servers: 'connection',
  currentServerId: 'connection',
  restorableSessions: 'connection',

  // ---- viewport ----
  targetCols: 'viewport',
  targetRows: 'viewport',
  viewportMeasured: 'viewport',
  charWidth: 'viewport',
  charHeight: 'viewport',
  cellGap: 'viewport',
  gridFontSize: 'viewport',
  measuredCell: 'viewport',
  phoneLayout: 'viewport',
  phoneLandscape: 'viewport',
  containerWidth: 'viewport',
  containerHeight: 'viewport',
  bodyWidth: 'viewport',

  // ---- layout ----
  totalWidth: 'layout',
  totalHeight: 'layout',
  panes: 'layout',
  windows: 'layout',
  activeWindowId: 'layout',
  activePaneId: 'layout',
  paneActivationOrder: 'layout',
  paneKeyOverrides: 'layout',
  drag: 'layout',
  resize: 'layout',
  resizeActive: 'layout',
  suppressLayoutTransition: 'layout',
  lastUpdateAnimated: 'layout',
  groupSwitchPaneIds: 'layout',
  lastUpdateQuiet: 'layout',
  enableAnimations: 'layout',

  // ---- ask ----
  askSelections: 'ask',

  // ---- copyMode ----
  copyModeStates: 'copyMode',

  // ---- groupsAndFloats ----
  paneGroups: 'groupsAndFloats',
  floatPanes: 'groupsAndFloats',

  // ---- keyboard ----
  keyboardOwner: 'keyboard',

  // ---- sidebars ----
  sidebars: 'sidebars',
  sidebarColsPreview: 'sidebars',
  dockSizeSent: 'sidebars',
  collapsedTabIds: 'sidebars',
  sidebarPeek: 'sidebars',

  // ---- tabOverview ----
  tabOverviewOpen: 'tabOverview',
  tabOverviewSelected: 'tabOverview',
  renamingTab: 'tabOverview',

  // ---- phone ----
  phoneZoom: 'phone',
  phoneBottomView: 'phone',
  phoneDockView: 'phone',

  // ---- commandUi ----
  commandMode: 'commandUi',
  statusMessage: 'commandUi',
  prefixActive: 'commandUi',
  prefixRepeatOnly: 'commandUi',
  keyTable: 'commandUi',
  keysViewOpen: 'commandUi',
  renamingPaneId: 'commandUi',

  // ---- notifications ----
  notifications: 'notifications',

  // ---- uiPrefs ----
  themeName: 'uiPrefs',
  themeMode: 'uiPrefs',
  availableThemes: 'uiPrefs',
  traceSettings: 'uiPrefs',
  baseFontSize: 'uiPrefs',
  animationsAllowed: 'uiPrefs',
  cursorBlink: 'uiPrefs',
  sendAsk: 'uiPrefs',
  notifyAllowed: 'uiPrefs',
  pushState: 'uiPrefs',
  processIcons: 'uiPrefs',
  transparency: 'uiPrefs',
  pinnedOptions: 'uiPrefs',
  tabOverviewCols: 'uiPrefs',
  gestureFlags: 'uiPrefs',
  nativeMenus: 'uiPrefs',
  sizePolicy: 'uiPrefs',
  themeRev: 'uiPrefs',

  // ---- plugins ----
  plugins: 'plugins',
  pluginsRev: 'plugins',
  // ---- gestures ----
  gesture: 'gestures',
} as const satisfies Record<keyof AppMachineContext, StateName>;

/**
 * Build the initial context. Called once at machine setup time.
 *
 * Wrapped in a function (rather than a top-level constant) so that side
 * effects like `loadFontSizePref()` are deferred to machine creation,
 * not module load — which matters for tests that stub localStorage.
 */
export function createInitialContext(): AppMachineContext {
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
    viewportMeasured: false,
    drag: null,
    resize: null,
    resizeActive: false,
    charWidth: DEFAULT_CHAR_WIDTH,
    charHeight: DEFAULT_CHAR_HEIGHT,
    cellGap: 0,
    gridFontSize: null,
    measuredCell: {
      charWidth: DEFAULT_CHAR_WIDTH,
      charHeight: DEFAULT_CHAR_HEIGHT,
      cellGap: 0,
      gridFontSize: null,
    },
    phoneLayout: false,
    phoneLandscape: false,
    defaultShell: 'bash',
    serverHostname: null,
    containerWidth: 0,
    containerHeight: 0,
    bodyWidth: 0,
    sessions: [],
    repositories: [],
    servers: [],
    currentServerId: null,
    restorableSessions: [],
    floatPanes: {},
    keyboardOwner: { kind: 'panes' },
    sidebars: {
      left: { open: false, starting: false, startFailed: false },
      right: { open: false, starting: false, startFailed: false },
    },
    sidebarColsPreview: null,
    dockSizeSent: null,
    collapsedTabIds: [],
    sidebarPeek: null,
    tabOverviewOpen: false,
    tabOverviewSelected: 0,
    renamingTab: null,
    phoneZoom: null,
    phoneBottomView: 'tree',
    phoneDockView: null,
    enableAnimations: false,
    animationsAllowed: true,
    cursorBlink: true,
    sendAsk: true,
    notifyAllowed: true,
    pushState: pushSupported() ? 'unknown' : 'unsupported',
    processIcons: {},
    transparency: true,
    pinnedOptions: [],
    tabOverviewCols: 3,
    gestureFlags: { swipeTabs: true, pinchZoom: true, pinchOverview: true },
    nativeMenus: true,
    sizePolicy: DEFAULT_SIZE_POLICY,
    gesture: null,
    keybindings: null,
    copyModeStates: {},
    suppressLayoutTransition: false,
    lastUpdateAnimated: false,
    paneKeyOverrides: {},
    paneActivationOrder: [],
    groupSwitchPaneIds: [],
    lastUpdateQuiet: true,
    commandMode: null,
    statusMessage: null,
    notifications: [],
    themeName: loadThemePref().theme,
    themeMode: loadThemePref().mode,
    availableThemes: [],
    traceSettings: null,
    plugins: [],
    pluginsRev: '',
    themeRev: '',
    appFocused: true,
    prefixActive: false,
    prefixRepeatOnly: null,
    keyTable: null,
    keysViewOpen: false,
    renamingPaneId: null,
    baseFontSize: loadFontSizePref(),
  };
}
