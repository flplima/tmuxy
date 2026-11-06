// Generated from tmuxy-core by packages/tmuxy-core/tests/generated_constants.rs; do not edit.
// Rewrite with UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants

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
