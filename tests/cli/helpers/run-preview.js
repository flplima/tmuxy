/**
 * Run `tmuxy open <file>` the way a pane runs it, and watch what it does
 * with the file: every revision line it prints, and every time it reads the
 * file (it reads through `cksum`, played here by a shim that counts the
 * call and then runs the real one). tmux is the mock.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MOCKS_DIR, scriptEnv } = require('./env');

const CLI_PATH = path.resolve(__dirname, '../../../packages/tmuxy-cli/bin/tmuxy-cli');
const REV = '__REV__:';
/** How long a wait lasts before it fails. */
const WAIT_MS = 15000;

/**
 * @param {string} home - The scratch directory the CLI takes as `HOME`
 * @param {string} file - The document to preview
 * @param {string} pane - The preview's own pane (`TMUX_PANE`)
 * @returns {{ reads: () => number, waitForRevisions: (count: number) => Promise<string[]>, waitUntilNotRead: (ms: number) => Promise<void>, stop: () => void }}
 */
function startPreview(home, file, pane) {
  const shims = path.join(home, `shims-${pane.slice(1)}`);
  const reads = path.join(home, `reads-${pane.slice(1)}`);
  fs.mkdirSync(shims);
  fs.writeFileSync(
    path.join(shims, 'cksum'),
    '#!/bin/bash\necho >>"$PREVIEW_READS"\nPATH="${PATH#*:}" exec cksum "$@"\n',
    { mode: 0o755 },
  );
  // In a terminal of its own, as in a pane: the preview reads the terminal
  // between two looks at the file. `script` gives it one, spelled the
  // util-linux way or the BSD way.
  const inTerminal =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', CLI_PATH, 'open', file]
      : ['-qfc', `'${CLI_PATH}' open '${file}'`, '/dev/null'];
  const child = spawn('script', inTerminal, {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: scriptEnv(home, {
      PATH: `${shims}:${MOCKS_DIR}:${process.env.PATH}`,
      PREVIEW_READS: reads,
      TMUXY_STATE_DIR: path.join(home, 'state'),
      MOCK_TMUX_PANE_PID: String(process.pid),
      MOCK_TMUX_SOCKET_PATH: '/tmp/tmux-1000/tmuxy%dev',
      TMUX_PANE: pane,
    }),
  });
  let printed = '';
  child.stdout.on('data', (chunk) => {
    printed += chunk.toString();
  });
  const revisions = () =>
    printed
      .split(/\r?\n/)
      .filter((line) => line.startsWith(REV))
      .map((line) => line.slice(REV.length));
  const readCount = () => (fs.existsSync(reads) ? fs.readFileSync(reads, 'utf8').length : 0);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    /** How many times the file has been read. */
    reads: readCount,
    /** Resolves with the revisions once `count` were printed, one per change the preview saw. */
    async waitForRevisions(count) {
      const deadline = Date.now() + WAIT_MS;
      while (revisions().length < count) {
        if (Date.now() > deadline) {
          throw new Error(`the preview printed ${revisions().length} revisions, not ${count}`);
        }
        await pause(50);
      }
      return revisions();
    },
    /** Resolves once the file has not been read for `ms`: the preview found it still. */
    async waitUntilNotRead(ms) {
      const deadline = Date.now() + WAIT_MS;
      let seen = readCount();
      let since = Date.now();
      while (Date.now() - since < ms) {
        if (Date.now() > deadline) {
          throw new Error(`the file is still being read: ${seen} times so far`);
        }
        await pause(50);
        if (readCount() !== seen) {
          seen = readCount();
          since = Date.now();
        }
      }
    },
    /** The preview and everything it started, gone. */
    stop() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
  };
}

module.exports = { startPreview };
