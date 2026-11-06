// Generated from tmuxy-core by packages/tmuxy-core/tests/generated_constants.rs; do not edit.
// Rewrite with UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants

/** What a script run that settles or re-lists is marked with (`tmux_compat::SETTLE_TAG`, `RELIST_TAG`). */
export const SCRIPT_EFFECT_TAGS = {
  settle: 'TMUXY_EFFECT=settle',
  'relist-windows': 'TMUXY_EFFECT=relist-windows',
} as const;

/** The session parked pane-group members live in (`STASH_SESSION`). */
export const STASH_SESSION = '__tmuxy_stash';

/** A pane's title with tmux's host-name seed filtered out (`tmux_formats::APP_PANE_TITLE`). */
export const APP_PANE_TITLE = '#{?#{==:#{pane_title},#{host}},,#{pane_title}}';

/** The window types tmuxy's chrome is tagged with (`WindowType`); an untagged window is a tab. */
export const CHROME_WINDOW_TYPES = ['float', 'sidebar-left', 'sidebar-right'] as const;

/** Sidebar column widths and drag bounds, in cells (`sidebar_dock`). */
export const SIDEBAR_DOCK = {
  leftCols: 30,
  rightCols: 35,
  minCols: 16,
  maxCols: 120,
} as const;

/** The options a menu changes, by what the client calls them (`session::ManagedOption`). */
export const MANAGED_OPTIONS = {
  theme: '@tmuxy-theme',
  themeMode: '@tmuxy-theme-mode',
  cursorBlink: '@tmuxy-cursor-blink',
  sendAsk: '@tmuxy-send-ask',
  transparency: '@tmuxy-transparency',
} as const;

/** What a left sidebar runs, and a restore recognises (`session_snapshot::LEFT_SIDEBAR_WIDGET`). */
export const LEFT_SIDEBAR_WIDGET = '$TMUXY_DATA_DIR/bin/tmuxy/tmuxy-widget-tree';

/** The name prefix a sidebar window is recognised by (`constants::SIDEBAR_WINDOW_PREFIX`). */
export const SIDEBAR_WINDOW_PREFIX = '__sidebar-';

/** What marks a key binding as a plugin key's (`plugins::keys::MARKER`). */
export const PLUGIN_KEY_MARKER = '--trigger key';

/** The CLI dispatcher in the data dir's `bin/` (`paths::CLI_DISPATCHER`). */
export const CLI_DISPATCHER = 'tmuxy-cli';

/** The appearance options before a config has said (`theme::Appearance::default()`, tmuxy.defaults.conf's). */
export const DEFAULT_APPEARANCE = {
  activePaneOpacity: 1,
  activeTextOpacity: 1,
  animations: true,
  blur: true,
  cursorBlink: true,
  gesturePinchOverview: true,
  gesturePinchZoom: true,
  gestureSwipeTabs: true,
  inactivePaneOpacity: 0.7,
  inactiveTextOpacity: 0.7,
  nativeMenus: true,
  notify: true,
  opacity: 0.7,
  sendAsk: true,
  size: { mode: 'smallest' },
  tabOverviewCols: 3,
  transparency: true,
} as const;

/** The prefix key tmuxy.defaults.conf sets. */
export const DEFAULT_PREFIX = 'C-a';

/** What `tmuxy-widget` prints before a widget's name (`constants::WIDGET_MARKER`). */
export const WIDGET_MARKER = '__TMUXY_WIDGET__:';

/** The buffer the client stages a paste in (`constants::PASTE_BUFFER`). */
export const PASTE_BUFFER = 'tmuxy-paste';

/** Which links a pane printed may be opened (`host::command::is_openable_url`). */
export const OPENABLE_URL = {
  schemes: ['http://', 'https://', 'mailto:'],
  forbidden: ['"', "'", '<', '>', '^', '`', '{', '}', '|', '\\'],
} as const;

/** The themes the app ships, as the server lists them (`theme::get_themes_list`). */
export const BUNDLED_THEMES = [
  { displayName: 'Catppuccin', modes: ['dark', 'light'], name: 'catppuccin' },
  { displayName: 'Default', modes: ['dark', 'light'], name: 'default' },
  { displayName: 'Dracula', modes: ['dark', 'light'], name: 'dracula' },
  { displayName: 'Fallout', modes: ['dark', 'light'], name: 'fallout' },
  { displayName: 'Gruvbox', modes: ['dark', 'light'], name: 'gruvbox' },
  { displayName: 'Nord', modes: ['dark', 'light'], name: 'nord' },
  { displayName: 'Solarized', modes: ['dark', 'light'], name: 'solarized' },
  { displayName: 'Tokyonight', modes: ['dark', 'light'], name: 'tokyonight' },
];
