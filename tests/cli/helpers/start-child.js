/**
 * Start a child process each way Node offers, for `harness-seal.test.js`:
 * the seal sits on `child_process` itself (`./seal.js`), and the test meets
 * it there, as any helper that starts a child does.
 */

const childProcess = require('child_process');
const util = require('util');

/**
 * @param {'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'exec' | 'execSync' | 'fork'} how
 * @param {...unknown} args - What that function takes
 */
function startChild(how, ...args) {
  return childProcess[how](...args);
}

/** {@link startChild} through `util.promisify`, as code that awaits a child does. */
function startChildPromised(how, ...args) {
  return util.promisify(childProcess[how])(...args);
}

module.exports = { startChild, startChildPromised };
