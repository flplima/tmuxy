/**
 * UI Helpers (barrel re-export)
 *
 * Re-exports all UI helper modules for backwards compatibility.
 * Individual modules can also be imported directly:
 *   - ./keyboard    - Focus, key combos, tmux prefix, typing
 *   - ./pane-ops    - Pane info, split, navigate, swap, zoom, kill, layout, resize
 *   - ./window-ops  - Window create, navigate, rename, kill
 *   - ./pane-groups - Pane group tab operations
 *   - ./copy-mode-ui - Copy mode enter/exit, paste
 */

const keyboard = require('./keyboard');
const paneOps = require('./pane-ops');
const windowOps = require('./window-ops');
const paneGroups = require('./pane-groups');
const copyModeUi = require('./copy-mode-ui');

module.exports = {
  ...keyboard,
  ...paneOps,
  ...windowOps,
  ...paneGroups,
  ...copyModeUi,
};
