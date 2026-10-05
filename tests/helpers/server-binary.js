/**
 * The newest `tmuxy-server` the workspace has built, release or debug.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_ROOT } = require('./config');

function serverBinary() {
  const built = ['release', 'debug']
    .map((profile) => path.join(WORKSPACE_ROOT, 'target', profile, 'tmuxy-server'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (built.length === 0) throw new Error('no tmuxy-server binary under target/');
  return built[0];
}

module.exports = { serverBinary };
