import { pushSupported } from '../../infra/pushNotifications';
import type { AppMachineContext } from '../types/context';
import {
  DEFAULT_SESSION_NAME,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_CHAR_WIDTH,
  DEFAULT_CHAR_HEIGHT,
} from '../constants';
import { loadFontSizePref, loadPhoneSplitPref, loadThemePref } from '../../infra/prefs';
import { DEFAULT_SIZE_POLICY } from '../../domain/gridFit';
import { appearancePrefs } from './appearance';

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
  connected: 'connection',
  error: 'connection',
  fatalError: 'connection',
  log: 'connection',
  sessionName: 'connection',
  serverHostname: 'connection',
  keybindings: 'connection',
  appFocused: 'connection',
  sessions: 'connection',
  repositories: 'connection',
  servers: 'connection',
  currentServerId: 'connection',
  restorableSessions: 'connection',

  targetCols: 'viewport',
  targetRows: 'viewport',
  viewportMeasured: 'viewport',
  reportedSize: 'viewport',
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

  totalWidth: 'layout',
  totalHeight: 'layout',
  panes: 'layout',
  windows: 'layout',
  activeWindowId: 'layout',
  activePaneId: 'layout',
  paneKeyOverrides: 'layout',
  drag: 'layout',
  resize: 'layout',
  resizeActive: 'layout',
  suppressLayoutTransition: 'layout',
  lastUpdateAnimated: 'layout',
  groupSwitchPaneIds: 'layout',
  lastUpdateQuiet: 'layout',
  enableAnimations: 'layout',

  askSelections: 'ask',

  copyModeStates: 'copyMode',
  copyModeExitedAt: 'copyMode',

  paneGroups: 'groupsAndFloats',
  floatPanes: 'groupsAndFloats',

  keyboardOwner: 'keyboard',

  sidebars: 'sidebars',
  sidebarColsPreview: 'sidebars',
  dockSizeSent: 'sidebars',
  collapsedTabIds: 'sidebars',
  sidebarPeek: 'sidebars',

  tabOverviewOpen: 'tabOverview',
  tabOverviewSelected: 'tabOverview',
  renamingTab: 'tabOverview',

  phoneZoom: 'phone',
  phoneZoomAt: 'phone',
  phoneCollapsed: 'phone',
  phoneBottomView: 'phone',
  phoneDockView: 'phone',

  commandMode: 'commandUi',
  statusMessage: 'commandUi',
  prefixActive: 'commandUi',
  prefixRepeatOnly: 'commandUi',
  keyTable: 'commandUi',
  keysViewOpen: 'commandUi',
  renamingPaneId: 'commandUi',

  notifications: 'notifications',

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

  plugins: 'plugins',
  pluginsRev: 'plugins',
  gesture: 'gestures',
} as const satisfies Record<keyof AppMachineContext, StateName>;

/**
 * A function, not a constant, so the saved preferences (`loadFontSizePref()`)
 * are read when a machine is made, not at module load: tests stub
 * localStorage in between.
 */
export function createInitialContext(): AppMachineContext {
  const split = loadPhoneSplitPref();
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
    reportedSize: null,
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
    phoneZoom: split.zoom,
    phoneZoomAt: null,
    phoneCollapsed: split.collapsed,
    phoneBottomView: 'tree',
    phoneDockView: null,
    enableAnimations: false,
    ...appearancePrefs(undefined),
    pushState: pushSupported() ? 'unknown' : 'unsupported',
    processIcons: {},
    pinnedOptions: [],
    sizePolicy: DEFAULT_SIZE_POLICY,
    gesture: null,
    keybindings: null,
    copyModeStates: {},
    copyModeExitedAt: {},
    suppressLayoutTransition: false,
    lastUpdateAnimated: false,
    paneKeyOverrides: {},
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
