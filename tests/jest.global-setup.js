/**
 * Once per jest run: decides what the run owns (helpers/run-ownership.js), and
 * builds what the E2E suites run against.
 *
 * The server embeds the UI's `dist` at compile time, so the UI is built first,
 * then the server on the `ci` cargo profile (Cargo.toml): release optimisation
 * without the fat-LTO link, the profile CI's per-PR job tests too. The path is
 * handed to every suite through `TMUXY_E2E_SERVER_BIN` (helpers/config.js).
 *
 * Nothing is built when the run already has its server:
 *  - `TMUXY_E2E_SERVER_BIN` names a binary (the developer's own, or a harness's);
 *  - a server answers on `TMUXY_URL`, as in CI, which starts the prebuilt one
 *    before Jest. The per-file setup (jest.setup.js) then checks it is on this
 *    run's tmux socket.
 *
 * Both builds are incremental, so a second run with no source change costs a
 * no-op `cargo build` and one UI build.
 */
const { execSync } = require('child_process');
const path = require('path');

const { TMUXY_URL, WORKSPACE_ROOT } = require('./helpers/config');
const { claimRun, releaseOnSignal } = require('./helpers/run-ownership');
const { tmuxSocket } = require('./helpers/tmux-socket');

async function serverAnswers() {
  try {
    return (await fetch(TMUXY_URL)).ok;
  } catch {
    return false;
  }
}

module.exports = async function globalSetup() {
  const reused = await serverAnswers();
  const run = claimRun({ serverAnswers: reused, socket: tmuxSocket(), url: TMUXY_URL });
  // For jest.global-teardown.js, which shares this process and its globals.
  globalThis.tmuxyE2ERun = run;
  releaseOnSignal(run);

  if (reused || process.env.TMUXY_E2E_SERVER_BIN) return;

  console.warn('[setup] Building the frontend and the server (ci profile), once for this run...');
  execSync('npm run build -w tmuxy-ui', { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
  execSync('cargo build --profile ci -p tmuxy-server', { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
  const targetDir = process.env.CARGO_TARGET_DIR || path.join(WORKSPACE_ROOT, 'target');
  process.env.TMUXY_E2E_SERVER_BIN = path.join(targetDir, 'ci', 'tmuxy-server');
};
