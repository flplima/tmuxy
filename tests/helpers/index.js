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
  ...require('./test-setup'),
  TmuxTestSession,
  ...require('./glitch-detector'),
  ...require('./consistency'),
  ...require('./cli'),
  ...require('./content-match'),
  ...require('./layout'),
  ...require('./copy-mode'),
  ...require('./cell-grid'),
  ...require('./mouse-capture'),
  ...require('./own-browser'),
  ...require('./selection-drag'),
};
