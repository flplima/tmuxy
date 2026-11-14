/**
 * In every CLI test file: no child process starts unless its environment is
 * sealed to the run's own socket (`helpers/seal.js`).
 *
 * The seal stays on to the end of the process's run. In a worker the process
 * runs test files and nothing else. Run in band, the process is Jest's own,
 * which starts workers of its own later (watch mode), so the global teardown
 * takes the seal off there, after every file's last hook has run.
 */

const { sealChildProcesses } = require('../helpers/seal');

sealChildProcesses();
