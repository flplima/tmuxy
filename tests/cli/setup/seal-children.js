/**
 * In every CLI test file: no child process starts unless its environment is
 * sealed to the run's own socket (`helpers/seal.js`).
 *
 * In a worker the seal stays on for good: the process runs test files and
 * nothing else. Run in band, the process is Jest's own, which starts
 * workers of its own later (watch mode), so there the seal comes off after
 * each file. Hooks of one block run in the order they were defined and this
 * one is first: an in-band file's own top-level `afterAll` runs unsealed.
 */

const { sealChildProcesses } = require('../helpers/seal');

const unseal = sealChildProcesses();
// A worker is Jest's own child script; `process.send` would not tell, since
// any Node started with an IPC channel has it.
const inAWorker = /[\\/]jest-worker[\\/]/.test(process.argv[1] ?? '');
if (!inAWorker) afterAll(unseal);
