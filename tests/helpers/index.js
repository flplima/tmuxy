/**
 * Test Helpers Index
 *
 * Every helper module, spread into one namespace for `require('./helpers')`.
 */

const TmuxTestSession = require('./TmuxTestSession');

module.exports = {
  ...require('./config'),
  ...require('./browser'),
  ...require('./keyboard'),
  ...require('./pane-ops'),
  ...require('./window-ops'),
  ...require('./pane-groups'),
  ...require('./copy-mode-ui'),
  ...require('./e2e-context'),
  TmuxTestSession,
  ...require('./glitch-detector'),
  ...require('./cli'),
  ...require('./ui-tmux'),
  ...require('./layout'),
  ...require('./copy-mode'),
  ...require('./cell-grid'),
  ...require('./mouse-capture'),
  ...require('./selection-drag'),
  ...require('./menus'),
};
