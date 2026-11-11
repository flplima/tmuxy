/**
 * In every CLI test file: no child process starts unless its environment is
 * sealed to the run's own socket (`helpers/seal.js`). Taken off again after
 * the file, so nothing of Jest's own is ever refused.
 */

const { sealChildProcesses } = require('../helpers/seal');

const unseal = sealChildProcesses();
afterAll(unseal);
